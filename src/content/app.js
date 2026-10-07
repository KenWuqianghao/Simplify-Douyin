// The Calm interface: top bar, home gallery, filtered panel, player tools,
// toast and the mindful-pause screen. It draws inside a closed shadow root.
// It keeps no data of its own: content.js gives it a view through update()
// and receives the user's intent through the `actions` callbacks.

const REASONS = globalThis.CalmClassifier.REASONS;

const ICONS = {
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  back: 'M15 5l-7 7 7 7',
  hide: 'M4 4l16 16M9.9 5.2A9.6 9.6 0 0 1 12 5c5 0 8.5 4.4 9.5 7a12 12 0 0 1-2.6 3.8M6.3 6.6A12.4 12.4 0 0 0 2.5 12c1 2.6 4.5 7 9.5 7a9 9 0 0 0 4-.9',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 2-4-4',
  play: 'M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z',
};

const TABS = [
  { key: 'home', label: '精选' },
  { key: 'foryou', label: '推荐' },
  { key: 'following', label: '关注' },
];

const EMPTY = {
  foryou: '没有加载到视频',
  following: '没有视频。登录抖音后才能看到关注的作者。',
};

const EASE = 'cubic-bezier(0.2, 0, 0, 1)';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', name === 'play' ? 'currentColor' : 'none');
  svg.setAttribute('stroke', name === 'play' ? 'none' : 'currentColor');
  svg.setAttribute('stroke-width', name === 'dots' ? '2.6' : '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function still() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function clock(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function titleOf(item) {
  const text = item.desc.split('#')[0].replace(/\s+/g, ' ').trim();
  if (text) return text;
  if (item.tags.length) return item.tags.slice(0, 4).join(' ');
  return item.creator || '无标题';
}

function topicOf(item) {
  return item.cats[1] || item.cats[0] || '';
}

export function createApp(actions) {
  let host = null;
  let shadow = null;
  let root = null;
  const refs = {};
  const cards = new Map(); // id -> card element
  let topic = '';          // selected level-1 category, '' = all
  let panelOpen = false;
  let stage = null;        // the cover that grows into the player
  let stageAt = 0;
  let stageTimer = 0;
  let veilTimer = 0;
  let pauseEl = null;
  let pauseTimer = 0;
  let toastTimer = 0;
  let view = {
    on: false, home: false, immersive: false, tab: '', empty: false, player: null,
    feed: [], seen: 0, stats: null, exhausted: false,
  };

  // ---- construction --------------------------------------------------------

  function mount() {
    if (host && host.isConnected) return;
    host = document.createElement('calm-douyin-app');
    shadow = host.attachShadow({ mode: 'closed' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('src/content/app.css');
    root = el('div', 'root');
    root.style.display = 'none'; // until the stylesheet is in
    link.addEventListener('load', () => { root.style.display = ''; placeLine(); });
    shadow.append(link, root);

    refs.veil = el('div', 'veil');
    refs.toast = el('div', 'toast');
    refs.toast.setAttribute('role', 'status');
    root.append(buildBar(), buildHome(), refs.veil, buildEmpty(), buildPanel(), buildPlayerTools(), refs.toast);
    root.addEventListener('click', onRootClick);
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      closeMenus();
      if (panelOpen) togglePanel(false);
    });
    window.addEventListener('resize', placeLine);
    document.documentElement.appendChild(host);
    render();
  }

  function buildBar() {
    const bar = el('header', 'bar');
    const brand = el('button', 'brand');
    brand.textContent = 'Calm';
    brand.addEventListener('click', () => go('home'));

    const nav = (refs.nav = el('nav', 'nav'));
    for (const tab of TABS) {
      const b = el('button', '', tab.label);
      b.dataset.tab = tab.key;
      b.addEventListener('click', () => go(tab.key));
      nav.append(b);
    }
    nav.append((refs.line = el('span', 'line')));

    const tools = el('div', 'tools');
    const search = el('label', 'search');
    const input = el('input');
    input.type = 'search';
    input.placeholder = '搜索';
    input.setAttribute('aria-label', '搜索抖音');
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // Douyin binds page-wide shortcut keys
      if (e.key === 'Enter' && input.value.trim()) actions.search(input.value.trim());
      if (e.key === 'Escape') input.blur();
    });
    for (const type of ['keyup', 'keypress']) input.addEventListener(type, (e) => e.stopPropagation());
    search.append(icon('search'), input);

    const count = (refs.count = el('button', 'count'));
    count.title = '查看今天过滤掉的视频';
    count.append(document.createTextNode('已过滤 '), (refs.countNum = el('b', '', '0')));
    count.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel(!panelOpen);
    });

    const me = el('button', 'icon-btn');
    me.title = '我的主页';
    me.setAttribute('aria-label', '我的主页');
    me.append(icon('user'));
    me.addEventListener('click', () => go('me'));

    tools.append(search, count, me);
    bar.append(brand, nav, tools);
    return bar;
  }

  function buildPanel() {
    return (refs.panel = el('aside', 'panel'));
  }

  function buildHome() {
    const home = (refs.home = el('main', 'home'));
    const wrap = el('div', 'wrap');
    const head = el('div', 'head');
    head.append(el('p', 'date', new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })),
      el('h1', '', '精选'));
    refs.hero = el('section', 'hero');
    refs.hero.hidden = true;
    refs.topics = el('div', 'topics');
    refs.grid = el('div', 'grid');
    refs.status = el('div', 'status');
    wrap.append(head, refs.hero, refs.topics, refs.grid, refs.status);
    home.append(wrap);
    // The bar gets its hairline when content moves under it.
    home.addEventListener('scroll', () => root.classList.toggle('scrolled', home.scrollTop > 4), { passive: true });

    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && view.home && !view.immersive) actions.more(false);
    }, { root: home, rootMargin: '600px' }).observe(refs.status);
    return home;
  }

  function buildEmpty() {
    const box = (refs.empty = el('div', 'empty'));
    const btns = el('div', 'btns');
    const again = el('button', 'text-btn', '重新加载');
    again.addEventListener('click', () => actions.reload());
    const home = el('button', 'text-btn', '打开精选');
    home.addEventListener('click', () => go('home'));
    btns.append(again, home);
    box.append((refs.emptyText = el('p')), btns);
    return box;
  }

  function buildPlayerTools() {
    const box = (refs.playerTools = el('div', 'player-tools'));
    const back = el('button', 'over back');
    back.append(icon('back'), document.createTextNode('返回'));
    back.addEventListener('click', () => actions.back());
    const not = (refs.notForMe = el('button', 'over'));
    not.append(icon('hide'), document.createTextNode('不感兴趣'));
    not.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !box.querySelector('.menu');
      closeMenus();
      if (open && view.player) {
        box.append(buildMenu(view.player, true));
        box.classList.add('open');
      }
    });
    box.append(back, not);
    return box;
  }

  // info: { id, creator, topic, tags }
  function buildMenu(info, inPlayer) {
    const menu = el('div', 'menu');
    const add = (label, value, fn) => {
      const b = el('button');
      b.append(document.createTextNode(label));
      if (value) b.append(document.createTextNode(' '), el('span', '', value));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenus();
        if (shadow.activeElement) shadow.activeElement.blur();
        fn();
      });
      menu.append(b);
    };
    add('减少这类视频', '', () => actions.less(info.id, inPlayer));
    if (info.creator) add('隐藏作者', info.creator, () => actions.block('creator', info.creator, inPlayer));
    if (info.topic) add('隐藏话题', info.topic, () => actions.block('category', info.topic, inPlayer));
    for (const tag of info.tags) add('屏蔽标签', `#${tag}`, () => actions.block('tag', tag, inPlayer));
    return menu;
  }

  function closeMenus() {
    for (const m of root.querySelectorAll('.menu')) m.remove();
    for (const c of root.querySelectorAll('.menu-open')) c.classList.remove('menu-open');
    refs.playerTools.classList.remove('open');
  }

  function onRootClick(e) {
    if (!e.target.closest('.menu')) closeMenus();
    if (panelOpen && !e.target.closest('.panel') && !e.target.closest('.count')) togglePanel(false);
  }

  function togglePanel(open) {
    panelOpen = open;
    renderPanel();
  }

  // A tab change makes Douyin swap its page under the bar. The veil covers
  // that swap, then lifts when the new page is there.
  function go(name) {
    // Douyin's player shortcuts (next, previous, like) need the focus on the page.
    if (shadow.activeElement) shadow.activeElement.blur();
    if (name !== view.tab && view.on) {
      refs.veil.classList.add('on');
      clearTimeout(veilTimer);
      veilTimer = setTimeout(() => refs.veil.classList.remove('on'), 1400);
    }
    actions.go(name);
  }

  // ---- rendering -----------------------------------------------------------

  function update(next) {
    const tab = view.tab;
    Object.assign(view, next);
    if (view.tab !== tab && refs.veil && refs.veil.classList.contains('on')) {
      clearTimeout(veilTimer);
      veilTimer = setTimeout(() => refs.veil.classList.remove('on'), 200);
    }
    render();
  }

  function render() {
    if (!root) return;
    host.style.display = view.on ? '' : 'none';
    root.classList.toggle('home-on', view.home);
    root.classList.toggle('immersive', view.immersive);
    root.classList.toggle('player-on', !!view.player);
    refs.notForMe.hidden = !(view.player && view.player.canHide);
    root.classList.toggle('empty-on', !!view.empty);
    if (view.empty) refs.emptyText.textContent = EMPTY[view.tab] || EMPTY.foryou;
    if (!view.player) closePlayerMenu();
    if (stage && view.immersive && view.player && Date.now() - stageAt > 450) dropStage();
    const n = String(view.stats ? view.stats.hidden : 0);
    if (refs.countNum.textContent !== n) refs.countNum.textContent = n;
    placeLine();
    renderHome();
    if (panelOpen) renderPanel();
  }

  function closePlayerMenu() {
    const m = refs.playerTools.querySelector('.menu');
    if (m) m.remove();
    refs.playerTools.classList.remove('open');
  }

  // The line under the current tab. It moves from one word to the next.
  function placeLine() {
    if (!refs.nav) return;
    let active = null;
    for (const b of refs.nav.querySelectorAll('button')) {
      const on = b.dataset.tab === view.tab;
      b.classList.toggle('on', on);
      if (on) active = b;
    }
    if (!active || !active.offsetWidth) {
      refs.line.style.opacity = '0';
      return;
    }
    refs.line.style.opacity = '1';
    refs.line.style.width = `${active.offsetWidth}px`;
    refs.line.style.transform = `translateX(${active.offsetLeft}px)`;
  }

  // Cards that stay on the screen move to their new place, they do not jump.
  function settle(change) {
    const before = new Map();
    if (view.home && !view.immersive && !still() && cards.size < 200) {
      for (const card of cards.values()) before.set(card, card.getBoundingClientRect());
    }
    change();
    for (const [card, a] of before) {
      if (!card.isConnected || card.classList.contains('leaving')) continue;
      const b = card.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 320, easing: EASE });
    }
  }

  // Take a card out of the flow at once, so that the others can close the gap
  // while it fades.
  function dismiss(card) {
    if (!view.home || still()) return card.remove();
    card.style.left = `${card.offsetLeft}px`;
    card.style.top = `${card.offsetTop}px`;
    card.style.width = `${card.offsetWidth}px`;
    card.classList.add('leaving');
    setTimeout(() => card.remove(), 200);
  }

  function renderTopics(feed) {
    // Douyin's level-1 categories of the kept videos.
    const counts = new Map();
    for (const item of feed) if (item.cats[0]) counts.set(item.cats[0], (counts.get(item.cats[0]) || 0) + 1);
    if (topic && !counts.has(topic)) topic = '';
    const names = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n]) => n);
    const sig = names.join(',');
    if (refs.topics.dataset.sig !== sig) {
      refs.topics.dataset.sig = sig;
      refs.topics.replaceChildren();
      if (names.length > 1) {
        for (const name of [''].concat(names)) {
          const b = el('button', 'topic', name || '全部');
          b.dataset.topic = name;
          b.addEventListener('click', () => {
            if (topic === name) return;
            topic = name;
            refs.home.scrollTo({ top: 0, behavior: 'smooth' });
            renderHome();
          });
          refs.topics.append(b);
        }
      }
    }
    for (const b of refs.topics.children) {
      b.classList.toggle('on', b.dataset.topic === topic);
      b.setAttribute('aria-pressed', String(b.dataset.topic === topic));
    }
  }

  function renderHome() {
    const feed = view.feed;
    renderTopics(feed);

    const all = topic ? feed.filter((i) => i.cats[0] === topic) : feed;
    // The first video gets the large place at the top. The grid shows the others.
    const first = all.length >= 4 && all[0].cover ? all[0] : null;
    renderHero(first);
    const list = first ? all.slice(1) : all;
    const wanted = new Set(list.map((i) => i.id));
    const gone = [...cards.keys()].filter((id) => !wanted.has(id));
    const fresh = list.filter((i) => !cards.has(i.id));
    if (gone.length || fresh.length) {
      settle(() => {
        for (const id of gone) {
          dismiss(cards.get(id));
          cards.delete(id);
        }
        // Keep the order of the feed: a card that comes back after a topic
        // change goes to its own place, not to the end.
        let prev = null;
        for (const item of list) {
          let card = cards.get(item.id);
          if (!card) {
            card = makeCard(item);
            card.classList.add('fade');
            cards.set(item.id, card);
          }
          const next = prev ? prev.nextElementSibling : refs.grid.firstElementChild;
          if (next !== card) refs.grid.insertBefore(card, next);
          prev = card;
        }
      });
    }

    const sig = `${view.exhausted}|${list.length > 0}|${view.seen > 0}`;
    if (refs.status.dataset.sig === sig) return;
    refs.status.dataset.sig = sig;
    refs.status.replaceChildren();
    if (view.exhausted) {
      refs.status.append(el('p', '', list.length
        ? '没有更多了'
        : '这一批视频全部被过滤了'));
      const again = el('button', 'text-btn', '继续加载');
      again.addEventListener('click', () => actions.more(true));
      refs.status.append(again);
    } else if (list.length) {
      refs.status.append(el('span', 'spinner'));
    } else {
      // Placeholders in the shape of the cards that come next.
      const ghost = el('div', 'grid ghost');
      for (let i = 0; i < 8; i++) {
        const g = el('div', 'card');
        g.append(el('div', 'cover'), el('div', 'bone'), el('div', 'bone short'));
        ghost.append(g);
      }
      refs.status.append(ghost);
    }
    refs.status.classList.toggle('wide', !view.exhausted && !list.length);
  }

  function renderHero(item) {
    refs.hero.hidden = !item;
    const id = item ? item.id : '';
    if (refs.hero.dataset.id === id) return;
    refs.hero.dataset.id = id;
    refs.hero.replaceChildren();
    if (!item) return;
    // A soft, large copy of the cover gives the panel its colour.
    const glow = el('img', 'glow');
    glow.alt = '';
    glow.src = item.cover;
    const cover = el('button', 'cover');
    cover.setAttribute('aria-label', titleOf(item));
    const img = el('img');
    img.alt = '';
    img.addEventListener('load', () => img.classList.add('ready'));
    img.src = item.cover;
    cover.append(img);
    const play = () => {
      if (shadow.activeElement) shadow.activeElement.blur();
      lift(refs.hero);
      actions.open(item.id);
    };
    cover.addEventListener('click', play);
    const text = el('div', 'text');
    const meta = el('p', 'who');
    meta.append(el('span', '', item.creator));
    if (item.ms) meta.append(el('span', '', clock(item.ms)));
    const button = el('button', 'play');
    button.append(icon('play'), document.createTextNode('播放'));
    button.addEventListener('click', play);
    text.append(el('h2', '', titleOf(item)), meta, button);
    refs.hero.append(glow, cover, text);
    refs.hero.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, easing: 'ease-out' });
  }

  function makeCard(item) {
    const card = el('article', 'card');

    const cover = el('button', 'cover');
    cover.setAttribute('aria-label', titleOf(item));
    if (item.cover) {
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('load', () => {
        // A tall cover keeps its shape. A soft copy fills the sides.
        if (img.naturalWidth < img.naturalHeight) {
          const back = el('img', 'soft');
          back.alt = '';
          back.src = img.src;
          cover.prepend(back);
          cover.classList.add('tall');
        }
        img.classList.add('ready');
      });
      img.src = item.cover;
      cover.append(img);
    }
    if (item.ms) cover.append(el('span', 'length', clock(item.ms)));
    const play = () => {
      cover.blur(); // Douyin's player shortcuts need the focus back on the page
      lift(card);
      actions.open(item.id);
    };
    cover.addEventListener('click', play);

    const info = el('div', 'info');
    if (item.avatar) {
      const a = el('img', 'avatar');
      a.alt = '';
      a.loading = 'lazy';
      a.src = item.avatar;
      info.append(a);
    } else {
      info.append(el('span', 'avatar'));
    }
    const text = el('div', 'text');
    const title = el('div', 'title', titleOf(item));
    title.addEventListener('click', play);
    text.append(title, el('div', 'who', item.creator));

    const more = el('button', 'more');
    more.title = '不感兴趣';
    more.setAttribute('aria-label', '不感兴趣');
    more.append(icon('dots'));
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !card.querySelector('.menu');
      closeMenus();
      if (open) {
        card.append(buildMenu({ id: item.id, creator: item.creator, topic: topicOf(item), tags: item.tags.slice(0, 3) }, false));
        card.classList.add('menu-open');
      }
    });
    info.append(text, more);

    card.append(cover, info);
    return card;
  }

  // The cover grows from its card to the middle of the screen while Douyin
  // opens its player behind it. Then it fades and the video is there.
  function lift(card) {
    const img = card.querySelector('.cover img.ready:not(.soft)');
    if (!img || still()) return;
    dropStage(true);
    const from = img.getBoundingClientRect();
    const ratio = from.width / from.height;
    let w = Math.min(innerWidth, innerHeight * ratio);
    const h = w / ratio;
    const left = (innerWidth - w) / 2;
    const top = (innerHeight - h) / 2;

    stage = el('div', 'stage');
    const pic = el('img');
    pic.alt = '';
    pic.src = img.currentSrc || img.src;
    Object.assign(pic.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
    stage.append(pic);
    root.append(stage);
    pic.animate([
      { transform: `translate(${from.left - left}px, ${from.top - top}px) scale(${from.width / w}, ${from.height / h})` },
      { transform: 'none' },
    ], { duration: 420, easing: EASE, fill: 'both' });
    stage.animate([{ backgroundColor: 'rgba(0, 0, 0, 0)' }, { backgroundColor: '#000' }], { duration: 300, easing: 'ease-out', fill: 'both' });
    stageAt = Date.now();
    stageTimer = setTimeout(dropStage, 4500);
  }

  function dropStage(now) {
    clearTimeout(stageTimer);
    const gone = stage;
    stage = null;
    if (!gone) return;
    if (now === true) return gone.remove();
    gone.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 280, easing: 'ease-out', fill: 'both' })
      .finished.then(() => gone.remove(), () => gone.remove());
  }

  function renderPanel() {
    refs.panel.classList.toggle('open', panelOpen);
    refs.count.classList.toggle('open', panelOpen);
    refs.count.setAttribute('aria-expanded', String(panelOpen));
    if (!panelOpen) return;
    const s = view.stats;
    const sig = s ? `${s.hidden}|${s.seen}` : '';
    if (refs.panel.dataset.sig === sig && refs.panel.firstChild) return;
    refs.panel.dataset.sig = sig;
    refs.panel.replaceChildren(el('h2', '', '今日过滤'));
    if (!s || !s.hidden) {
      refs.panel.append(el('p', 'lead', '今天还没有过滤任何视频。'));
      return;
    }
    refs.panel.append(el('p', 'lead', `检查了 ${s.seen} 个视频，过滤了 ${s.hidden} 个。规则在浏览器工具栏的扩展图标里修改。`));

    const rows = Object.entries(s.byReason || {}).filter(([r]) => REASONS[r]).sort((a, b) => b[1] - a[1]);
    const top = rows.length ? rows[0][1] : 1;
    const tally = el('ul', 'tally');
    rows.forEach(([reason, n], i) => {
      const row = el('li');
      row.style.setProperty('--share', String(n / top));
      row.style.setProperty('--i', String(i));
      row.append(el('span', '', REASONS[reason]), el('b', '', String(n)));
      tally.append(row);
    });
    refs.panel.append(tally);

    const recent = (s.recent || []).slice(0, 12);
    if (!recent.length) return;
    refs.panel.append(el('h3', '', '最近过滤'));
    for (const r of recent) {
      const item = el('div', 'item');
      item.append(el('div', 'desc', r.desc || r.creator || '无文案'),
        el('div', 'why', r.reasons.map((x) => REASONS[x] || x).join('、')));
      refs.panel.append(item);
    }
  }

  // ---- transient pieces ----------------------------------------------------

  function bump() {
    if (!root) return;
    refs.count.classList.remove('bump');
    void refs.count.offsetWidth;
    refs.count.classList.add('bump');
  }

  function toast(text) {
    if (!root) return;
    refs.toast.textContent = text;
    refs.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => refs.toast.classList.remove('show'), 2600);
  }

  function pauseOpen() {
    return !!pauseEl;
  }

  function showPause(seconds) {
    if (!root || pauseEl) return;
    const minutes = Math.round(seconds / 60);
    pauseEl = el('div', 'pause');
    const sheet = el('div', 'sheet');
    const btns = el('div', 'btns');
    const done = el('button', 'primary', '关闭抖音');
    const moreBtn = el('button', 'text-btn', '再看 10 分钟');
    btns.append(moreBtn, done);
    sheet.append(el('h2', '', `今天已经看了 ${minutes} 分钟`),
      el('p', '', '这是你设置的休息提醒。'), btns);
    pauseEl.append(sheet);
    root.append(pauseEl);
    requestAnimationFrame(() => pauseEl && pauseEl.classList.add('show'));
    const hold = () => document.querySelectorAll('video').forEach((v) => { if (!v.paused) v.pause(); });
    hold();
    pauseTimer = setInterval(hold, 500);
    done.addEventListener('click', () => actions.done());
    moreBtn.addEventListener('click', async () => {
      await actions.snooze(10);
      clearInterval(pauseTimer);
      const gone = pauseEl;
      pauseEl = null;
      gone.classList.remove('show');
      setTimeout(() => gone.remove(), 300);
    });
  }

  return { mount, update, bump, toast, showPause, pauseOpen };
}
