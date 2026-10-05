// Runs in the page's MAIN world at document_start, before Douyin's own code.
// It reads every feed response, sends the items to the content script, and
// removes the filtered items, so that they never reach Douyin's grid or its
// player queue. Douyin loads feeds with XMLHttpRequest; fetch is covered too.
//
// Two kinds of surface, which only tells the content script where an item
// came from:
//   grid   精选. The Calm home screen draws its own cards from these items.
//   swipe  推荐, related videos, search.
(function () {
  'use strict';

  const { normalize, PAGE_CACHE_KEY } = globalThis.CalmSettings;
  const { lite, judge } = globalThis.CalmClassifier;
  const FROM_CONTENT = 'calm-douyin/content';
  const FROM_MAIN = 'calm-douyin/main';

  // Discovery surfaces only. Following, profile and history pages stay as they are.
  const GRID = /\/aweme\/v\d+\/web\/module\/feed\/?$/;
  const SWIPE = /\/aweme\/v\d+\/web\/(?:tab\/feed|channel\/feed|aweme\/related|general\/search\/single|search\/item)\/?$/;

  let settings = readCachedSettings();

  function readCachedSettings() {
    try {
      return normalize(JSON.parse(localStorage.getItem(PAGE_CACHE_KEY)));
    } catch (_) {
      return normalize(null);
    }
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== FROM_CONTENT || d.type !== 'settings') return;
    settings = normalize(d.settings);
  });

  // Returns 'grid', 'swipe' or ''.
  function surfaceOf(url) {
    if (!url) return '';
    let path;
    try { path = new URL(String(url), location.href).pathname; } catch (_) { return ''; }
    if (GRID.test(path)) return 'grid';
    return SWIPE.test(path) ? 'swipe' : '';
  }

  // ---- filtering -----------------------------------------------------------

  // Returns the list to give to the page, or null to leave it as it is.
  function scanList(list, pick, rewrite, items) {
    const kept = [];
    const dropped = [];
    for (const entry of list) {
      const aweme = pick(entry);
      if (!aweme || typeof aweme !== 'object') {
        kept.push(entry);
        continue;
      }
      const item = lite(aweme);
      items.push(item);
      if (!rewrite) continue;
      const verdict = judge(item, settings);
      if (verdict.keep) kept.push(entry);
      else dropped.push({ entry, weight: verdict.reasons.length });
    }
    if (!rewrite || !dropped.length) return null;
    // An empty page can stall Douyin's loader. Keep the mildest item; the
    // content script leaves it out of the gallery and skips past it.
    if (!kept.length) {
      dropped.sort((a, b) => a.weight - b.weight);
      kept.push(dropped[0].entry);
    }
    return kept;
  }

  // Mutates json in place. Returns true when something was removed.
  function scanPayload(json, surface) {
    if (!json || typeof json !== 'object') return false;
    const rewrite = settings.enabled;
    const items = [];
    let changed = false;

    if (Array.isArray(json.aweme_list)) {
      const next = scanList(json.aweme_list, (x) => x, rewrite, items);
      if (next) { json.aweme_list = next; changed = true; }
    }
    if (Array.isArray(json.data)) {
      const next = scanList(json.data, (x) => x && x.aweme_info, rewrite, items);
      if (next) { json.data = next; changed = true; }
    }
    if (items.length) window.postMessage({ source: FROM_MAIN, type: 'items', surface, items }, location.origin);
    return changed;
  }

  // Douyin sends 64-bit integer IDs as bare numbers. Keep their source text so
  // that a re-serialized payload does not round them (Chrome 114+ APIs).
  const keepBigInts = typeof JSON.rawJSON === 'function'
    ? (key, value, ctx) => (typeof value === 'number' && !Number.isSafeInteger(value)
      && ctx && /^-?\d+$/.test(ctx.source) ? JSON.rawJSON(ctx.source) : value)
    : undefined;

  function scanText(text, surface) {
    if (typeof text !== 'string' || !text || text[0] !== '{') return text;
    let json;
    try { json = JSON.parse(text, keepBigInts); } catch (_) { return text; }
    return scanPayload(json, surface) ? JSON.stringify(json) : text;
  }

  // ---- XMLHttpRequest ------------------------------------------------------

  const XHR = XMLHttpRequest.prototype;
  const nativeOpen = XHR.open;
  const textDesc = Object.getOwnPropertyDescriptor(XHR, 'responseText');
  const respDesc = Object.getOwnPropertyDescriptor(XHR, 'response');
  const urls = new WeakMap();
  const textCache = new WeakMap(); // xhr -> { raw, out }
  const jsonDone = new WeakSet();

  XHR.open = function (method, url) {
    urls.set(this, url);
    textCache.delete(this);
    return nativeOpen.apply(this, arguments);
  };

  function scannedTextFor(xhr, raw, surface) {
    const hit = textCache.get(xhr);
    if (hit && hit.raw === raw) return hit.out;
    const out = scanText(raw, surface);
    textCache.set(xhr, { raw, out });
    return out;
  }

  function surfaceWhenDone(xhr) {
    return xhr.readyState === 4 ? surfaceOf(urls.get(xhr)) : '';
  }

  Object.defineProperty(XHR, 'responseText', {
    configurable: true,
    enumerable: textDesc.enumerable,
    get() {
      const raw = textDesc.get.call(this);
      const surface = surfaceWhenDone(this);
      return surface ? scannedTextFor(this, raw, surface) : raw;
    },
  });

  Object.defineProperty(XHR, 'response', {
    configurable: true,
    enumerable: respDesc.enumerable,
    get() {
      const raw = respDesc.get.call(this);
      const surface = surfaceWhenDone(this);
      if (!surface) return raw;
      const type = this.responseType;
      if (type === '' || type === 'text') return scannedTextFor(this, raw, surface);
      if (type === 'json' && raw && typeof raw === 'object' && !jsonDone.has(raw)) {
        jsonDone.add(raw);
        scanPayload(raw, surface);
      }
      return raw;
    },
  });

  // ---- fetch ---------------------------------------------------------------

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
    const pending = nativeFetch.apply(this, arguments);
    const surface = surfaceOf(url);
    if (!surface) return pending;
    return pending.then(async (res) => {
      if (!res.ok) return res;
      try {
        const raw = await res.clone().text();
        const out = scanText(raw, surface);
        if (out === raw) return res;
        const headers = new Headers(res.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        const copy = new Response(out, { status: res.status, statusText: res.statusText, headers });
        Object.defineProperty(copy, 'url', { value: res.url });
        return copy;
      } catch (_) {
        return res;
      }
    });
  };
})();
