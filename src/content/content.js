// Isolated-world content script, loaded as an ES module by boot.js.
// It owns all mutable state for one tab: settings, the items the interceptor
// has seen, today's filter stats and the watch time. It decides what the Calm
// interface (app.js) shows, and it drives Douyin's own page underneath:
// opening the native player, asking for more items, skipping filtered videos.
//
// Chrome injects a given file into only one world per page, so the shared
// scripts come in here through module imports, not through the manifest.
import '../shared/settings.js';
import '../shared/classifier.js';
import { createApp } from './app.js';

const { STORAGE_KEY, PAGE_CACHE_KEY, normalize } = globalThis.CalmSettings;
const { REASONS, lite, judge } = globalThis.CalmClassifier;
const FROM_MAIN = 'calm-douyin/main';
const FROM_CONTENT = 'calm-douyin/content';
const STATS_KEY = 'calmStats';
const WATCH_KEY = 'calmWatch';
const LEARN_KEY = 'calmLearn';
const html = document.documentElement;

const HOME_PATH = '/jingxuan';
const ROUTES = {
  home: { href: 'jingxuan', url: '/jingxuan' },
  foryou: { href: 'recommend=1', url: '/?recommend=1' },
  following: { href: '/follow', url: '/follow' },
  me: { href: '/user/self', url: '/user/self' },
};
const MIN_FEED = 18;      // ask Douyin for more until the gallery has this many
const MAX_DRY_PUMPS = 10; // then rest, and offer a manual retry
const REST_MS = 20000;    // an automatic retry follows after this rest

// Extras inside the native player. Anchored on purpose: markByText climbs
// while a parent's whole text still matches.
const PLAYER_CLUTTER = /^(听抖音|AI抖音|消息|通知|私信|相关搜索[:：].*)$/;
const COUNT_TEXT = /^[\d.,]+\s*[万wWkK亿]?$/;
const COUNT_SCOPES = [
  '[data-e2e="video-player-digg"]',
  '[data-e2e="feed-comment-icon"]',
  '[data-e2e="video-player-collect"]',
  '[data-e2e="video-player-share"]',
  '.discover-video-card-item',
].join(',');

let settings = readPageCache();
const known = new Map();   // id -> { item, grid, verdict }
const gridOrder = [];      // ids in the order the 精选 feed gave them
const domTries = new Map();
let stats = null;
let activeId = '';
let lastDirection = 1;     // 1 = the user moved forward in the player
let skipTimes = [];
let skipPausedUntil = 0;
const dismissed = new Set(); // ids the user sent away with "less like this"
let noPlayerSince = 0;    // when a player tab first showed no player
let dryPumps = 0;
let lastPump = 0;
let exhausted = false;

const app = createApp({ open, more, block, less, go, search, back, done, snooze, reload: () => location.reload() });

// ---- helpers ---------------------------------------------------------------

function alive() {
  try { return !!chrome.runtime && !!chrome.runtime.id; } catch (_) { return false; }
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function label(reasons) {
  return reasons.map((r) => REASONS[r] || r).join('、');
}

function readPageCache() {
  try { return normalize(JSON.parse(localStorage.getItem(PAGE_CACHE_KEY))); } catch (_) { return normalize(null); }
}

function calmUi() {
  return settings.enabled && settings.ui.calmTheme;
}

function modalOpen() {
  return /[?&]modal_id=/.test(location.search);
}

// Following, Friends and profile pages hold creators that the user chose.
function chosenSurface() {
  return /^\/(follow|friend|user)(\/|$)/.test(location.pathname);
}

function shown(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function shownOne(selector) {
  for (const el of document.querySelectorAll(selector)) if (shown(el)) return el;
  return null;
}

// Douyin keeps the player of the route that you left in the DOM with
// display: none. Only a slide with a size is the one on the screen.
function activeVideo() {
  const inModal = document.querySelector('[data-e2e="modal-video-container"] [data-e2e="feed-active-video"]');
  if (inModal && shown(inModal)) return inModal;
  return shownOne('[data-e2e="feed-active-video"]');
}

// A live room in a swipe feed is a link to live.douyin.com that covers the
// slide. A small link of that kind is only the creator's avatar.
function liveLink(active) {
  const box = active.getBoundingClientRect();
  for (const a of active.querySelectorAll('a[href*="live.douyin.com"]')) {
    const r = a.getBoundingClientRect();
    if (r.width * r.height > box.width * box.height * 0.3) return a;
  }
  return null;
}

// The identity of a slide. Live rooms have no video id.
function slideKey(active) {
  const id = active.getAttribute('data-e2e-vid');
  if (id) return id;
  const live = liveLink(active);
  return live ? `live:${live.getAttribute('href').slice(0, 120)}` : '';
}

// ---- settings --------------------------------------------------------------

function setSettings(raw) {
  settings = normalize(raw);
  try { localStorage.setItem(PAGE_CACHE_KEY, JSON.stringify(settings)); } catch (_) { /* storage blocked */ }
  window.postMessage({ source: FROM_CONTENT, type: 'settings', settings }, location.origin);
  for (const entry of known.values()) entry.verdict = judge(entry.item, settings);
  scan();
}

function saveSettings(change) {
  const next = normalize(settings);
  change(next);
  if (alive()) chrome.storage.local.set({ [STORAGE_KEY]: normalize(next) }).catch(() => {});
}

chrome.storage.local.get([STORAGE_KEY, STATS_KEY]).then((r) => {
  stats = r[STATS_KEY] && r[STATS_KEY].day === today() ? r[STATS_KEY] : null;
  setSettings(r[STORAGE_KEY]);
}, () => setSettings(null));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STATS_KEY]) {
    const s = changes[STATS_KEY].newValue;
    stats = s && s.day === today() ? s : null;
    refresh();
  }
  if (changes[STORAGE_KEY]) setSettings(changes[STORAGE_KEY].newValue);
});

// ---- items from the interceptor --------------------------------------------

// The message comes from the page's world. Rebuild it field by field.
function clean(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const list = (v, n, len) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, n).map((x) => x.slice(0, len)) : []);
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const url = (v) => (typeof v === 'string' && v.startsWith('https://') ? v.slice(0, 1000) : '');
  return {
    id: raw.id.slice(0, 32),
    desc: s(raw.desc, 600),
    tags: list(raw.tags, 30, 40),
    cats: list(raw.cats, 4, 30),
    ad: raw.ad === true, live: raw.live === true, ai: raw.ai === true, staged: raw.staged === true,
    goods: raw.goods === true, slides: raw.slides === true,
    ms: num(raw.ms), likes: num(raw.likes), saves: num(raw.saves), shares: num(raw.shares), comments: num(raw.comments),
    creator: s(raw.creator, 40),
    creatorIds: list(raw.creatorIds, 4, 80),
    avatar: url(raw.avatar),
    cover: url(raw.cover),
    wide: raw.wide !== false,
    time: num(raw.time),
  };
}

window.addEventListener('message', (e) => {
  const d = e.data;
  if (e.source !== window || !d || d.source !== FROM_MAIN || d.type !== 'items' || !Array.isArray(d.items)) return;
  const grid = d.surface === 'grid';
  let seen = 0;
  const hidden = [];
  for (const raw of d.items.slice(0, 200)) {
    const item = clean(raw);
    if (!item) continue;
    let entry = known.get(item.id);
    if (!entry) {
      entry = { item, grid: false, verdict: judge(item, settings) };
      known.set(item.id, entry);
      seen += 1;
      if (!entry.verdict.keep) hidden.push(entry);
    }
    if (grid && !entry.grid) {
      entry.grid = true;
      gridOrder.push(item.id);
    }
  }

  if (seen && settings.enabled) record(seen, hidden);
  scan();
});

let pending = null;
let flushTimer = 0;

function record(seen, hidden) {
  pending = pending || { seen: 0, hidden: [] };
  pending.seen += seen;
  pending.hidden.push(...hidden);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 500);
}

async function flush() {
  const batch = pending;
  pending = null;
  if (!batch || !alive()) return;
  const day = today();
  try {
    const prev = (await chrome.storage.local.get(STATS_KEY))[STATS_KEY];
    const s = prev && prev.day === day ? prev : { day, seen: 0, hidden: 0, byReason: {}, recent: [] };
    s.seen += batch.seen;
    s.hidden += batch.hidden.length;
    for (const h of batch.hidden) for (const r of h.verdict.reasons) s.byReason[r] = (s.byReason[r] || 0) + 1;
    const now = Date.now();
    const fresh = batch.hidden.map((h) => ({
      id: h.item.id,
      desc: h.item.desc.replace(/\s+/g, ' ').slice(0, 90),
      creator: h.item.creator,
      category: h.item.cats[1] || h.item.cats[0] || '',
      reasons: h.verdict.reasons,
      at: now,
    }));
    s.recent = fresh.reverse().concat(s.recent || []).slice(0, 30);
    await chrome.storage.local.set({ [STATS_KEY]: s });
    if (batch.hidden.length) app.bump();
  } catch (_) { /* extension reloaded */ }
}

// ---- view ------------------------------------------------------------------

function feed() {
  const out = [];
  for (const id of gridOrder) {
    const entry = known.get(id);
    if (entry.verdict.keep && !dismissed.has(id)) out.push(entry.item);
  }
  return out;
}

function tabOf(path) {
  if (path === HOME_PATH) return 'home';
  if (path === '/') return 'foryou';
  if (path.startsWith('/follow')) return 'following';
  return '';
}

function playerInfo(active) {
  if (!active) return null;
  const id = active.getAttribute('data-e2e-vid') || '';
  const entry = known.get(id);
  const canHide = !chosenSurface(); // no filter on Following and profile pages
  if (entry) {
    return { id, canHide, creator: entry.item.creator, topic: entry.item.cats[1] || entry.item.cats[0] || '', tags: entry.item.tags.slice(0, 3) };
  }
  const nick = ((active.querySelector('[data-e2e="feed-video-nickname"]') || {}).textContent || '').replace(/^@/, '').trim();
  return { id, canHide, creator: nick, topic: '', tags: [] };
}

let lastFeedCount = 0;

function refresh() {
  const ui = calmUi();
  const path = location.pathname;
  const modal = modalOpen();
  const home = ui && path === HOME_PATH;
  const active = activeVideo();
  const tab = tabOf(path);
  const list = home ? feed() : [];

  // A player tab with no player for 8 s gets a message, not a blank screen.
  let empty = false;
  if (ui && !modal && !active && (tab === 'foryou' || tab === 'following')) {
    noPlayerSince = noPlayerSince || Date.now();
    empty = Date.now() - noPlayerSince > 8000;
  } else {
    noPlayerSince = 0;
  }

  html.classList.toggle('calm-on', settings.enabled);
  html.classList.toggle('calm-ui', ui);
  html.classList.toggle('calm-home', home);
  html.classList.toggle('calm-danmaku', settings.ui.danmaku);
  html.classList.toggle('calm-hide-counts', settings.enabled && settings.ui.hideCounts);

  app.update({
    on: ui,
    home,
    immersive: modal,
    tab,
    empty,
    player: ui && active ? playerInfo(active) : null,
    feed: list,
    seen: gridOrder.length,
    stats,
    exhausted,
  });
  return { home, modal, active, count: list.length };
}

// ---- page shaping ----------------------------------------------------------

let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => requestAnimationFrame(scan), 200);
}

function scan() {
  scheduled = false;
  app.mount();
  const state = refresh();
  if (!settings.enabled) return;

  dismissGuide();
  if (state.active) {
    markByText(state.active, PLAYER_CLUTTER);
    checkActiveVideo(state.active);
  } else {
    activeId = '';
  }
  track(state.active);
  if (settings.ui.hideCounts) markCounts();
  if (!calmUi()) removeFilteredCards();
  if (state.home && !state.modal) {
    // Douyin's hidden grid starts muted hover previews by itself.
    for (const v of document.querySelectorAll('.discover-video-card-item video')) if (!v.paused) v.pause();
    if (state.count < MIN_FEED) more(false, true);
  }
}

// Classic view only: take filtered cards out of Douyin's own 精选 grid.
function removeFilteredCards() {
  for (const card of document.querySelectorAll('.discover-video-card-item[data-aweme-id]')) {
    const entry = known.get(card.getAttribute('data-aweme-id'));
    card.classList.toggle('calm-gone', !!entry && !entry.verdict.keep);
  }
}

// Hide a label that matches `re`, together with the wrappers that add an icon
// but no other text. The climb stops at the first parent that holds more
// text or any media, so it can never take a player with it.
// Works without Douyin's hashed class names.
function markByText(container, re) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode()) {
    const text = walker.currentNode.nodeValue.trim();
    if (text && re.test(text)) hits.push(walker.currentNode.parentElement);
  }
  for (let el of hits) {
    if (!el || el === container || el.closest('.calm-gone')) continue;
    const text = el.textContent.trim();
    while (el.parentElement && el.parentElement !== container
      && el.parentElement.textContent.trim() === text
      && !el.parentElement.querySelector('video, canvas, xg-video-container')) {
      el = el.parentElement;
    }
    if (!el.querySelector('video, canvas, xg-video-container')) el.classList.add('calm-gone');
  }
}

function markCounts() {
  for (const scope of document.querySelectorAll(COUNT_SCOPES)) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      if (el && !el.classList.contains('calm-count') && COUNT_TEXT.test(walker.currentNode.nodeValue.trim())) {
        el.classList.add('calm-count');
      }
    }
  }
}

// ---- native player ---------------------------------------------------------

// Douyin's first-use tutorial covers the player and holds its shortcut keys
// until the user confirms. theme.css hides it; confirm it here.
function dismissGuide() {
  const mask = document.querySelector('[data-e2e="recommend-guide-mask"]');
  if (!mask || mask.dataset.calmDone) return;
  mask.dataset.calmDone = '1';
  const ok = [...mask.querySelectorAll('button, div, span')].find((e) => e.children.length === 0 && /我知道了|知道了|Got it/i.test(e.textContent));
  if (ok) ok.click();
}


function checkActiveVideo(active) {
  const id = slideKey(active);
  if (!id || id === activeId) return;
  if (chosenSurface()) { // no filter here, so no skip
    activeId = id;
    return;
  }

  const entry = known.get(id);
  let reasons = entry && !entry.verdict.keep ? entry.verdict.reasons : null;
  if (id.startsWith('live:')) {
    if (settings.filters.live) reasons = ['live'];
  } else if (!entry) {
    // Server-rendered item that never passed the interceptor: judge it from
    // its caption. Category and engagement data are not in the DOM.
    const desc = (active.querySelector('[data-e2e="video-desc"]') || {}).textContent || '';
    const tries = (domTries.get(id) || 0) + 1;
    domTries.set(id, tries);
    if (!desc && tries < 6) return; // caption not rendered yet
    const nickname = ((active.querySelector('[data-e2e="feed-video-nickname"]') || {}).textContent || '').replace(/^@/, '');
    const verdict = judge(lite({ aweme_id: id, desc, author: { nickname } }), settings);
    const visible = verdict.reasons.filter((r) => r !== 'focus' && r !== 'shallow');
    if (visible.length) reasons = visible;
  }
  activeId = id;
  if (reasons && settings.ui.autoSkip) skipActive(active, `已跳过：${label(reasons)}`);
}

function skipActive(active, message) {
  const now = Date.now();
  if (now < skipPausedUntil) return;
  skipTimes = skipTimes.filter((t) => now - t < 5000);
  skipTimes.push(now);
  if (skipTimes.length > 8) {
    skipPausedUntil = now + 15000;
    app.toast('连续出现很多被过滤的视频。自动跳过暂停 15 秒。');
    return;
  }
  const video = active.querySelector('video');
  if (video) video.pause();
  if (watch) watch.auto = true; // the extension moved on, not the user
  app.toast(message);
  switchVideo(slideKey(active), lastDirection >= 0, 0);
}

// Douyin ignores a switch while its slide animation runs, so check that the
// video changed and try again when it did not.
function switchVideo(fromId, forward, attempt) {
  const active = activeVideo();
  if (!active || slideKey(active) !== fromId || attempt > 6) return;
  const arrow = shownOne(`[data-e2e="video-switch-${forward ? 'next' : 'prev'}-arrow"]`);
  if (arrow) arrow.click();
  setTimeout(() => switchVideo(fromId, forward, attempt + 1), 800);
}

// Remember which way the user moves, so a skip continues in that direction.
window.addEventListener('keydown', (e) => {
  if (!e.isTrusted) return;
  if (e.key === 'ArrowDown') lastDirection = 1;
  if (e.key === 'ArrowUp') lastDirection = -1;
}, true);
window.addEventListener('wheel', (e) => {
  if (e.isTrusted && e.deltaY) lastDirection = e.deltaY > 0 ? 1 : -1;
}, { capture: true, passive: true });
document.addEventListener('click', (e) => {
  const arrow = e.isTrusted && e.target instanceof Element && e.target.closest('[data-e2e^="video-switch-"]');
  if (arrow) lastDirection = arrow.getAttribute('data-e2e').includes('prev') ? -1 : 1;
}, true);

// ---- actions from the Calm interface ---------------------------------------

// Play a video in Douyin's own player, so that likes, saves and watch time
// still reach Douyin's recommendation system.
function open(id) {
  const card = document.querySelector(`.discover-video-card-item[data-aweme-id="${CSS.escape(id)}"]`);
  const opened = () => modalOpen() || !!document.querySelector('[data-e2e="modal-video-container"]');
  const fallback = () => { if (!opened()) location.assign(`/video/${encodeURIComponent(id)}`); };
  if (!card) return fallback();
  lastDirection = 1;
  (card.querySelector('img') || card.firstElementChild || card).click();
  setTimeout(fallback, 3500);
}

function scrollers() {
  const found = new Set(document.querySelectorAll('.route-scroll-container'));
  let el = document.querySelector('.discover-video-card-item');
  for (el = el && el.parentElement; el && el !== document.body; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) found.add(el);
  }
  return [...found];
}

// Ask Douyin's own page for the next batch: move its hidden 精选 list to the
// end, which fires its infinite loader.
function more(manual, background) {
  if (manual) {
    dryPumps = 0;
    exhausted = false;
  }
  const now = Date.now();
  // After a rest, the user's own scrolling may try a few more times. The
  // background top-up may not: it would request without end.
  if (exhausted && !background && now - lastPump > REST_MS) {
    dryPumps = MAX_DRY_PUMPS - 3;
    exhausted = false;
  }
  if (exhausted || now - lastPump < 1800) return;
  lastPump = now;
  dryPumps += 1;
  if (dryPumps > MAX_DRY_PUMPS) {
    exhausted = true;
    refresh();
    return;
  }
  for (const sc of scrollers()) {
    sc.scrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight - 600);
    requestAnimationFrame(() => {
      sc.scrollTop = sc.scrollHeight;
      sc.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  }
  if (manual) refresh();
}

function block(kind, value, inPlayer) {
  const key = { creator: 'blockedCreators', category: 'blockedCategories', tag: 'blockedTags' }[kind];
  saveSettings((next) => { next[key] = next[key].concat(value); });
  app.toast(`已隐藏：${value}`);
  const active = inPlayer && activeVideo();
  if (active) skipActive(active, `已隐藏：${value}`);
}

function go(name) {
  const route = ROUTES[name];
  if (!route) return;
  if (modalOpen()) return location.assign(route.url);
  const link = [...document.querySelectorAll('#douyin-navigation a[href]')].find((a) => a.getAttribute('href').includes(route.href));
  if (link) link.click(); // Douyin's router: no page reload
  else location.assign(route.url);
}

function search(query) {
  location.assign(`/search/${encodeURIComponent(query)}?type=video`);
}

// Close the player modal. Douyin opens it with replaceState, so history.back()
// would leave the site. Its own close button sits beside the modal container
// (theme.css keeps it invisible); click that one.
function back() {
  const modal = document.querySelector('[data-e2e="modal-video-container"]');
  const scope = modal && modal.parentElement;
  const close = scope && [...scope.querySelectorAll('svg')]
    .map((svg) => svg.parentElement)
    .find((el) => el && !modal.contains(el) && !el.querySelector('input') && el.getBoundingClientRect().width <= 90);
  if (close) close.click();
  setTimeout(() => { if (modalOpen()) location.assign(HOME_PATH); }, 900);
}

function done() {
  if (alive()) chrome.runtime.sendMessage({ type: 'calm:close-tab' }).catch(() => {});
}

// "Less like this": a strong vote against the tags, topic and words of one
// video. The video goes away now; its kind goes away when the votes add up.
// In the player it also tells Douyin, so that its recommendations change too.
function less(id, inPlayer) {
  const entry = known.get(id);
  const active = inPlayer && activeVideo();
  const item = entry ? entry.item : active && domItem(active);
  if (item) vote(item, 'neg', 2);
  dismissed.add(id);
  if (!active) {
    app.toast('会减少这类视频');
    return refresh();
  }
  if (watch) watch.auto = true; // already counted above
  nativeDislike(active).then((told) => {
    if (told) app.toast('已告诉抖音不感兴趣'); // Douyin moves to the next video itself
    else skipActive(active, '会减少这类视频');
  });
}

// Douyin's own "不感兴趣". Its button is in the "more" menu of the action
// column, and it renders only while the pointer is on that control.
// theme.css hides the control; events and click() still reach it.
async function nativeDislike(active) {
  const more = active.querySelector('[data-e2e="video-play-more"]');
  if (!more) return false;
  for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
    more.dispatchEvent(new MouseEvent(type, { bubbles: !type.endsWith('enter'), cancelable: true, view: window }));
  }
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const button = active.querySelector('[data-e2e="video-player-no-like"]');
    if (button) {
      button.click();
      return true;
    }
  }
  return false;
}

// ---- learning from habits --------------------------------------------------

// The user's own moves in the player are the signal:
//   left a video within 3 s, before 30 % of it     one vote against
//   watched 70 % of it or 30 s, or liked / saved   votes for
// Votes go to the video's hashtags, its categories and the words of its
// caption. A feature with enough votes against, and almost none for, becomes
// a learned filter in the settings. The user sees and removes them in the popup.
const LEARN_RULES = {
  tags: { min: 3, share: 0.75 },
  categories: { min: 4, share: 0.8 },
  words: { min: 8, share: 0.9 },
};
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh-CN', { granularity: 'word' }) : null;
let watch = null; // { key, item, start, last, seconds, max, liked, auto }
let learnQueue = Promise.resolve();

function domItem(active) {
  const desc = (active.querySelector('[data-e2e="video-desc"]') || {}).textContent || '';
  return { desc, tags: [...desc.matchAll(/#([^\s#@]+)/g)].map((m) => m[1]).slice(0, 30), cats: [] };
}

function wordsOf(desc) {
  if (!segmenter) return [];
  const text = desc.replace(/[#@][^\s#@]+/g, ' ');
  const out = new Set();
  for (const part of segmenter.segment(text)) {
    const w = part.segment.toLowerCase();
    if (part.isWordLike && w.length >= 2 && w.length <= 8 && !/^[\d.]+$/.test(w)) out.add(w);
    if (out.size >= 12) break;
  }
  return [...out];
}

function featuresOf(item) {
  return {
    tags: item.tags.slice(0, 12),
    // Level 1 (游戏, 体育) is too wide to learn from one creator's videos.
    categories: item.cats.length > 1 ? item.cats.slice(1) : item.cats,
    words: wordsOf(item.desc),
  };
}

function vote(item, side, weight) {
  if (!settings.learn.enabled || !alive()) return;
  const features = featuresOf(item);
  learnQueue = learnQueue.then(async () => {
    const store = (await chrome.storage.local.get(LEARN_KEY))[LEARN_KEY] || {};
    const fresh = { tags: [], categories: [], words: [] };
    for (const kind of Object.keys(LEARN_RULES)) {
      const bucket = (store[kind] = store[kind] || {});
      for (const name of features[kind]) {
        const v = (bucket[name] = bucket[name] || [0, 0]);
        v[side === 'neg' ? 0 : 1] += weight;
        const rule = LEARN_RULES[kind];
        const have = settings.learn[kind].concat(settings.learn.ignored).some((x) => x.toLowerCase() === name.toLowerCase());
        if (side === 'neg' && !have && v[0] >= rule.min && v[0] / (v[0] + v[1]) >= rule.share) fresh[kind].push(name);
      }
      const names = Object.keys(bucket);
      if (names.length > 3000) for (const n of names) if (bucket[n][0] + bucket[n][1] <= 1) delete bucket[n];
    }
    await chrome.storage.local.set({ [LEARN_KEY]: store });
    const all = fresh.tags.map((t) => `#${t}`).concat(fresh.categories, fresh.words);
    if (!all.length) return;
    saveSettings((next) => {
      for (const kind of Object.keys(fresh)) next.learn[kind] = next.learn[kind].concat(fresh[kind]);
    });
    app.toast(`已学会过滤：${all.slice(0, 4).join('、')}`);
  }).catch(() => {});
}

// Follow the slide on the screen. When it changes, judge how the last one went.
function track(active) {
  const now = Date.now();
  const key = active && settings.enabled && !chosenSurface() ? slideKey(active) : '';
  if (watch && watch.key !== key) {
    const w = watch;
    watch = null;
    if (!w.auto && w.item) {
      if (w.liked) vote(w.item, 'pos', 2);
      else if (now - w.start < 3000 && w.max < 0.3) vote(w.item, 'neg', 1);
      else if (w.max >= 0.7 || w.seconds >= 30) vote(w.item, 'pos', 1);
    }
  }
  if (!key || key.startsWith('live:')) return;
  if (!watch) {
    const entry = known.get(key);
    watch = { key, item: entry ? entry.item : null, start: now, last: now, seconds: 0, max: 0, liked: false, auto: false };
  }
  if (!watch.item) { // server-rendered slide: its caption comes in late
    const item = domItem(active);
    if (item.desc) watch.item = item;
  }
  const video = active.querySelector('video');
  if (video && video.duration > 0) {
    watch.max = Math.max(watch.max, video.currentTime / video.duration);
    if (!video.paused) watch.seconds += Math.min(now - watch.last, 2000) / 1000;
  }
  watch.last = now;
}

document.addEventListener('click', (e) => {
  if (!watch || !e.isTrusted || !(e.target instanceof Element)) return;
  if (e.target.closest('[data-e2e="video-player-digg"], [data-e2e="video-player-collect"]')) watch.liked = true;
}, true);

// ---- mindful pause ---------------------------------------------------------

const TICK = 5;
let unsaved = 0;

function playing() {
  for (const v of document.querySelectorAll('video')) {
    if (!v.paused && !v.ended && v.readyState > 2) return true;
  }
  return false;
}

async function tick() {
  if (!alive() || !settings.enabled || document.visibilityState !== 'visible' || app.pauseOpen() || !playing()) return;
  unsaved += TICK;
  if (unsaved < 30 && !settings.breakMinutes) return;
  const day = today();
  try {
    const prev = (await chrome.storage.local.get(WATCH_KEY))[WATCH_KEY];
    const w = prev && prev.day === day ? prev : { day, seconds: 0, snoozeUntil: 0 };
    w.seconds += unsaved;
    unsaved = 0;
    await chrome.storage.local.set({ [WATCH_KEY]: w });
    const limit = settings.breakMinutes * 60;
    if (limit && w.seconds >= limit && w.seconds >= w.snoozeUntil) app.showPause(w.seconds);
  } catch (_) { /* extension reloaded */ }
}

async function snooze(minutes) {
  try {
    const w = (await chrome.storage.local.get(WATCH_KEY))[WATCH_KEY];
    if (w) await chrome.storage.local.set({ [WATCH_KEY]: Object.assign(w, { snoozeUntil: w.seconds + minutes * 60 }) });
  } catch (_) { /* extension reloaded */ }
}

// ---- start -----------------------------------------------------------------

html.classList.toggle('calm-on', settings.enabled);
html.classList.toggle('calm-ui', calmUi());
html.classList.toggle('calm-home', calmUi() && location.pathname === HOME_PATH);

new MutationObserver(schedule).observe(html, { childList: true, subtree: true });
window.addEventListener('popstate', schedule);
setInterval(scan, 1500); // route changes through pushState make no DOM event of their own
setInterval(tick, TICK * 1000);
