// Settings schema shared by every extension context (page MAIN world,
// content script, popup). Plain global, no modules: content scripts in the
// MAIN world cannot import ES modules.
(function (root) {
  'use strict';

  const STORAGE_KEY = 'calmDouyin';
  const PAGE_CACHE_KEY = 'calm-douyin:settings';

  const DEFAULTS = Object.freeze({
    enabled: true,
    filters: Object.freeze({
      ads: true,       // sponsored items
      live: true,      // live-stream cards inside feeds
      ai: true,        // AI-generated video (AIGC)
      recap: true,     // movie / TV recap and re-cut channels
      drama: true,     // serialized short drama and 漫剧
      staged: true,    // scripted skits that the author declares as fiction
      commerce: true,  // shopping and group-buy promotion
      clickbait: true, // bait captions and hashtag spam
      images: false,   // photo slideshows
    }),
    // Strictness tunes two soft signals: engagement depth (saves, shares and
    // comments relative to likes) and mild clickbait wording.
    strictness: 'balanced', // off | relaxed | balanced | strict
    minSeconds: 0,
    blockedWords: Object.freeze([]),
    blockedCreators: Object.freeze([]),
    blockedCategories: Object.freeze([]), // Douyin category names, for example 电影剧情解说
    blockedTags: Object.freeze([]),       // whole hashtags, without the #
    // Filters that grow from the user's habits. The content script adds a
    // hashtag, category or caption word after the user skipped it many times.
    // `ignored` holds what the user removed, so it is not learned again.
    learn: Object.freeze({
      enabled: true,
      tags: Object.freeze([]),
      categories: Object.freeze([]),
      words: Object.freeze([]),
      ignored: Object.freeze([]),
    }),
    trustedCreators: Object.freeze([]),
    focusMode: false,
    focusTopics: Object.freeze(['科普', '历史', '人文', '科技', '纪录片', '旅行', '自然']),
    ui: Object.freeze({
      calmTheme: true,   // replace Douyin's interface with the Calm one
      hideCounts: false,
      autoSkip: true,
      danmaku: false,    // bullet comments over the video
    }),
    breakMinutes: 0, // 0 = no mindful break
  });

  const STRICTNESS = ['off', 'relaxed', 'balanced', 'strict'];
  const BREAKS = [0, 20, 40, 60];

  function bool(v, fallback) {
    return typeof v === 'boolean' ? v : fallback;
  }

  function list(v, fallback) {
    if (!Array.isArray(v)) return fallback.slice();
    const seen = new Set();
    const out = [];
    for (const item of v) {
      if (typeof item !== 'string') continue;
      const s = item.trim().slice(0, 60);
      const key = s.toLowerCase();
      if (!s || seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= 200) break;
    }
    return out;
  }

  function normalize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const rf = r.filters && typeof r.filters === 'object' ? r.filters : {};
    const ru = r.ui && typeof r.ui === 'object' ? r.ui : {};
    const rl = r.learn && typeof r.learn === 'object' ? r.learn : {};
    const filters = {};
    for (const k of Object.keys(DEFAULTS.filters)) filters[k] = bool(rf[k], DEFAULTS.filters[k]);
    const min = Number(r.minSeconds);
    return {
      enabled: bool(r.enabled, DEFAULTS.enabled),
      filters,
      strictness: STRICTNESS.includes(r.strictness) ? r.strictness : DEFAULTS.strictness,
      minSeconds: Number.isFinite(min) ? Math.min(Math.max(Math.round(min), 0), 120) : DEFAULTS.minSeconds,
      blockedWords: list(r.blockedWords, DEFAULTS.blockedWords),
      blockedCreators: list(r.blockedCreators, DEFAULTS.blockedCreators),
      blockedCategories: list(r.blockedCategories, DEFAULTS.blockedCategories),
      blockedTags: list(r.blockedTags, DEFAULTS.blockedTags).map((t) => t.replace(/^#+/, '')).filter(Boolean),
      learn: {
        enabled: bool(rl.enabled, DEFAULTS.learn.enabled),
        tags: list(rl.tags, DEFAULTS.learn.tags),
        categories: list(rl.categories, DEFAULTS.learn.categories),
        words: list(rl.words, DEFAULTS.learn.words),
        ignored: list(rl.ignored, DEFAULTS.learn.ignored),
      },
      trustedCreators: list(r.trustedCreators, DEFAULTS.trustedCreators),
      focusMode: bool(r.focusMode, DEFAULTS.focusMode),
      focusTopics: list(r.focusTopics, DEFAULTS.focusTopics),
      ui: {
        calmTheme: bool(ru.calmTheme, DEFAULTS.ui.calmTheme),
        hideCounts: bool(ru.hideCounts, DEFAULTS.ui.hideCounts),
        autoSkip: bool(ru.autoSkip, DEFAULTS.ui.autoSkip),
        danmaku: bool(ru.danmaku, DEFAULTS.ui.danmaku),
      },
      breakMinutes: BREAKS.includes(r.breakMinutes) ? r.breakMinutes : DEFAULTS.breakMinutes,
    };
  }

  root.CalmSettings = Object.freeze({ STORAGE_KEY, PAGE_CACHE_KEY, DEFAULTS, STRICTNESS, BREAKS, normalize });
})(globalThis);
