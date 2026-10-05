(() => {
  'use strict';

  const { STORAGE_KEY, normalize } = globalThis.CalmSettings;
  const { REASONS } = globalThis.CalmClassifier;
  const STATS_KEY = 'calmStats';
  const WATCH_KEY = 'calmWatch';
  const LEARN_KEY = 'calmLearn';
  const DOUYIN = /^https?:\/\/www\.douyin\.com\//;

  const STRICTNESS_HINTS = {
    off: '只使用上面的开关。不考虑互动深度和轻度标题党用词。',
    relaxed: '只隐藏最空洞的视频：点赞很多，但几乎没有人收藏或分享。',
    balanced: '隐藏点赞多、但很少被收藏、分享或讨论的视频。',
    strict: '只保留经常被收藏和分享的视频。信息流会短很多。',
  };

  let settings = normalize(null);
  let saveTimer = 0;
  const $ = (sel) => document.querySelector(sel);

  // ---- settings model ------------------------------------------------------

  function get(path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), settings);
  }

  function set(path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let target = settings;
    for (const k of keys) target = target[k];
    target[last] = value;
    settings = normalize(settings);
    render();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => chrome.storage.local.set({ [STORAGE_KEY]: settings }), 120);
  }

  // ---- controls ------------------------------------------------------------

  for (const input of document.querySelectorAll('input[data-path]')) {
    input.addEventListener('change', () => set(input.dataset.path, input.checked));
  }

  for (const seg of document.querySelectorAll('.seg[data-seg]')) {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (!btn) return;
      const key = seg.dataset.seg;
      const value = typeof get(key) === 'number' ? Number(btn.dataset.value) : btn.dataset.value;
      set(key, value);
    });
  }

  for (const box of document.querySelectorAll('.chips[data-list]')) {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = box.dataset.placeholder || '';
    input.setAttribute('aria-label', box.dataset.placeholder || '添加');
    box.append(input);
    box.addEventListener('click', (e) => { if (e.target === box) input.focus(); });

    const commit = () => {
      const parts = input.value.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
      if (!parts.length) return;
      set(box.dataset.list, get(box.dataset.list).concat(parts));
      input.value = '';
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Backspace' && !input.value) {
        const list = get(box.dataset.list);
        if (list.length) removeChip(box, list[list.length - 1]);
      }
    });
    input.addEventListener('blur', commit);
  }

  function removeChip(box, value) {
    const chip = [...box.querySelectorAll('.chip')].find((c) => c.dataset.value === value);
    const finish = () => {
      // A learned filter that the user removes must not come back.
      if (/^learn\.(tags|categories|words)$/.test(box.dataset.list)) settings.learn.ignored = settings.learn.ignored.concat(value);
      set(box.dataset.list, get(box.dataset.list).filter((v) => v !== value));
    };
    if (!chip) return finish();
    chip.classList.add('leaving');
    chip.addEventListener('animationend', finish, { once: true });
  }

  function renderChips(box) {
    const list = get(box.dataset.list);
    const key = JSON.stringify(list);
    if (box.dataset.rendered === key) return;
    const before = new Set(JSON.parse(box.dataset.rendered || '[]'));
    box.dataset.rendered = key;
    box.querySelectorAll('.chip').forEach((c) => c.remove());
    const input = box.querySelector('input');
    for (const value of list) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.dataset.value = value;
      if (before.has(value)) chip.style.animation = 'none';
      chip.append(document.createTextNode(value));
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', `移除 ${value}`);
      x.addEventListener('click', () => removeChip(box, value));
      chip.append(x);
      box.insertBefore(chip, input);
    }
  }

  function placeGlow(seg) {
    const buttons = [...seg.querySelectorAll('button[data-value]')];
    const current = String(get(seg.dataset.seg));
    const index = Math.max(0, buttons.findIndex((b) => b.dataset.value === current));
    buttons.forEach((b, i) => {
      b.classList.toggle('on', i === index);
      b.setAttribute('aria-pressed', String(i === index));
    });
    const glow = seg.querySelector('.seg-glow');
    glow.style.width = `calc(100% / ${buttons.length})`;
    glow.style.transform = `translateX(${index * 100}%)`;
  }

  function render() {
    document.body.classList.toggle('off', !settings.enabled);
    $('#status-line').textContent = settings.enabled ? '过滤已开启' : '已暂停。抖音恢复原样。';
    for (const input of document.querySelectorAll('input[data-path]')) input.checked = !!get(input.dataset.path);
    document.querySelectorAll('.seg[data-seg]').forEach(placeGlow);
    document.querySelectorAll('.chips[data-list]').forEach(renderChips);
    $('#strictness-hint').textContent = STRICTNESS_HINTS[settings.strictness];
  }

  // ---- stats ---------------------------------------------------------------

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function countUp(el, to) {
    const from = Number(el.dataset.value || 0);
    el.dataset.value = String(to);
    if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = String(to);
      return;
    }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min((now - start) / 700, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = String(Math.round(from + (to - from) * eased));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderStats(raw) {
    const s = raw && raw.day === today() ? raw : { seen: 0, hidden: 0, byReason: {} };
    countUp($('#hidden-count'), s.hidden);
    countUp($('#seen-count'), s.seen);
    $('#bar-fill').style.width = s.seen ? `${Math.round((s.hidden / s.seen) * 100)}%` : '0';

    const chips = $('#reason-chips');
    chips.replaceChildren();
    const entries = Object.entries(s.byReason || {}).filter(([k]) => REASONS[k]).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      const none = document.createElement('span');
      none.className = 'none';
      none.textContent = '打开抖音后，被过滤的视频会在这里计数。';
      chips.append(none);
    }
    entries.forEach(([reason, n], i) => {
      const chip = document.createElement('span');
      chip.className = 'r';
      chip.style.animationDelay = `${i * 40}ms`;
      const b = document.createElement('b');
      b.textContent = String(n);
      chip.append(document.createTextNode(REASONS[reason]), b);
      chips.append(chip);
    });
  }

  function renderWatch(raw) {
    const seconds = raw && raw.day === today() ? raw.seconds : 0;
    const minutes = Math.floor(seconds / 60);
    const line = $('#watch-line');
    if (minutes < 1) {
      line.textContent = '';
      return;
    }
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    line.textContent = `今天已观看 ${h ? `${h} 小时 ` : ''}${m} 分钟`;
  }

  // ---- refresh -------------------------------------------------------------

  $('#reload').addEventListener('click', async () => {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabs = active && DOUYIN.test(active.url || '') ? [active] : await chrome.tabs.query({ url: '*://www.douyin.com/*' });
    for (const tab of tabs) chrome.tabs.reload(tab.id);
    $('#reload').textContent = tabs.length ? '已刷新' : '没有抖音标签页';
    setTimeout(() => { $('#reload').textContent = '刷新抖音'; }, 1600);
  });

  $('#forget').addEventListener('click', async () => {
    await chrome.storage.local.remove(LEARN_KEY);
    settings.learn = { enabled: settings.learn.enabled, tags: [], categories: [], words: [], ignored: [] };
    set('learn.enabled', settings.learn.enabled);
    $('#forget').textContent = '已清除';
    setTimeout(() => { $('#forget').textContent = '清除学习记录'; }, 1600);
  });

  // ---- boot ----------------------------------------------------------------

  chrome.storage.local.get([STORAGE_KEY, STATS_KEY, WATCH_KEY]).then((r) => {
    settings = normalize(r[STORAGE_KEY]);
    render();
    renderStats(r[STATS_KEY]);
    renderWatch(r[WATCH_KEY]);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEY]) {
      settings = normalize(changes[STORAGE_KEY].newValue);
      render();
    }
    if (changes[STATS_KEY]) renderStats(changes[STATS_KEY].newValue);
    if (changes[WATCH_KEY]) renderWatch(changes[WATCH_KEY].newValue);
  });

  render();
})();
