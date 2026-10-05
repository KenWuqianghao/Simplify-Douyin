// Quality classifier for Douyin feed items.
// Pure, no state. Two steps:
//   lite(aweme)           raw API item -> small, safe-to-message item
//   judge(item, settings) lite item -> { keep, reasons }
// The MAIN world judges while it rewrites responses. The content script
// judges the same lite items again when the settings change.
// Signals were checked against live /aweme/v2/web/module/feed/ responses.
(function (root) {
  'use strict';

  const REASONS = Object.freeze({
    ad: '广告',
    live: '直播',
    ai: 'AI 生成',
    recap: '解说 / 混剪',
    drama: '短剧',
    staged: '摆拍演绎',
    commerce: '带货',
    clickbait: '标题党',
    images: '图文',
    short: '时长太短',
    word: '屏蔽词',
    creator: '已屏蔽作者',
    category: '已隐藏话题',
    tag: '屏蔽标签',
    learned: '自动学习',
    focus: '不在专注话题内',
    shallow: '互动深度低',
  });

  // Douyin's own content categories (related_video_extra.tags) name AI work
  // directly: "AI原生影像", "AI创作剧场", "AI原创短片".
  const AI_CATEGORY = /\bai|aigc|数字人/i;
  const AI_TEXT = new RegExp([
    'aigc',
    'ai\\s*(生成|创作|制作|辅助|原创|原生|动画|动漫|漫剧|短剧|短片|绘画|视频|翻唱|配音|歌曲|音乐|数字人|写真|影像|电影|剧场)',
    '数字人', '即梦', '可灵', 'libtv', '海螺ai', 'sora', 'midjourney', 'stable\\s?diffusion', 'vidu',
    '用ai打开',
  ].join('|'), 'i');

  // Film / TV recap farms. Documentary, game and celebrity commentary stay.
  const RECAP_CATEGORY = /剧情解说|剧场解说|动画解说|混剪|二创/;
  const RECAP_TEXT = /电影解说|影视解说|影视混剪|电影混剪|剧情解说|美剧解说|好剧推荐|一口气看完|二创/;

  const DRAMA_CATEGORY = /短剧|漫剧|小剧场/;
  const DRAMA_TEXT = /短剧|漫剧/;
  // Trope words also appear inside normal phrases (征战神话 holds 战神), so
  // they count only as whole hashtags.
  const DRAMA_TROPES = /^(霸总|战神|赘婿|团宠|先婚后爱|萌宝|甜宠|虐恋|追妻火葬场|重生|豪门|总裁|逆袭)$/;

  const COMMERCE_TEXT = /小黄车|购物车|点击链接|同款链接|橱窗|下单|团购|优惠券|领券|秒杀|带货|好物推荐|好物分享/;

  const BAIT_STRONG = /震惊|看到最后|最后一个|家人们|速看|赶紧收藏|99%的人|90%的人|不看后悔|一定要看完|千万不要|千万别|天塌了|细思极恐|颠覆认知/g;
  const BAIT_WEAK = /竟然|居然|炸裂|封神|泪目|破防|绝了|爆火|离谱|太牛了|逆天/g;

  // Soft-signal tuning per strictness level.
  //   depth: minimum (saves + shares/2 + comments/2) / likes
  //   weakBait: weak bait words needed to flag a caption
  //   tags: hashtag count that counts as spam
  const LEVELS = Object.freeze({
    off: { depth: 0, weakBait: Infinity, tags: Infinity },
    relaxed: { depth: 0.06, weakBait: 3, tags: 10 },
    balanced: { depth: 0.1, weakBait: 2, tags: 8 },
    strict: { depth: 0.16, weakBait: 1, tags: 6 },
  });
  const DEPTH_MIN_LIKES = 300;

  function categories(aweme) {
    const raw = aweme.related_video_extra && aweme.related_video_extra.tags;
    if (!raw) return [];
    let tags = raw;
    if (typeof raw === 'string') {
      try { tags = JSON.parse(raw); } catch (_) { return []; }
    }
    const out = [];
    for (const key of ['level1', 'level2', 'level3', 'level4']) {
      const name = tags && tags[key] && tags[key].tag_name;
      if (typeof name === 'string' && name) out.push(name);
    }
    return out;
  }

  function hashtags(aweme) {
    const extra = Array.isArray(aweme.text_extra) ? aweme.text_extra : [];
    return extra.map((t) => t && t.hashtag_name).filter((h) => typeof h === 'string' && h);
  }

  function count(re, text) {
    const m = text.match(re);
    return m ? m.length : 0;
  }

  function isLive(aweme) {
    return aweme.aweme_type === 101 || !!aweme.cell_room || !!aweme.live_type;
  }

  function isAd(aweme) {
    return aweme.is_ads === true || !!aweme.raw_ad_data || !!aweme.link_ad_data
      || !!(aweme.author && aweme.author.is_ad_fake);
  }

  // Douyin's own notice under a video, for example
  // "作者声明：内容由 AI 生成" or "疑似使用了 AI 生成技术，请谨慎甄别".
  function riskNotice(aweme) {
    const r = aweme.risk_infos;
    return r && typeof r.content === 'string' ? r.content : '';
  }

  function isAiFlagged(aweme) {
    const info = aweme.aigc_info;
    return aweme.is_aigc_media === true
      || !!(aweme.video_control && aweme.video_control.show_ai_corner)
      || !!(info && typeof info === 'object' && (info.aigc_label_type > 0 || info.created_by_ai))
      || /AI/i.test(riskNotice(aweme));
  }

  function firstUrl(image) {
    const url = image && Array.isArray(image.url_list) ? image.url_list[0] : '';
    return typeof url === 'string' && url.startsWith('https://') ? url : '';
  }

  function str(v, max) {
    return typeof v === 'string' ? v.slice(0, max) : '';
  }

  // Raw API item -> the small item that the rest of the extension uses.
  function lite(aweme) {
    const a = aweme && typeof aweme === 'object' ? aweme : {};
    const author = a.author || {};
    const video = a.video || {};
    const stats = a.statistics || {};
    return {
      id: str(String(a.aweme_id || a.group_id || ''), 32),
      desc: str(a.desc, 600),
      tags: hashtags(a).slice(0, 30).map((t) => str(t, 40)),
      cats: categories(a).map((c) => str(c, 30)),
      ad: isAd(a),
      live: isLive(a),
      ai: isAiFlagged(a),
      staged: /虚构演绎/.test(riskNotice(a)),
      goods: a.has_ecom_goods_card === true,
      slides: a.media_type === 2 || (Array.isArray(a.images) && a.images.length > 0),
      ms: Number(a.duration) || Number(video.duration) || 0,
      likes: Number(stats.digg_count) || 0,
      saves: Number(stats.collect_count) || 0,
      shares: Number(stats.share_count) || 0,
      comments: Number(stats.comment_count) || 0,
      creator: str(author.nickname, 40),
      creatorIds: [author.unique_id, author.short_id, author.sec_uid, author.uid]
        .filter((v) => typeof v === 'string' && v).map((v) => str(v, 80)),
      avatar: firstUrl(author.avatar_thumb),
      cover: firstUrl(video.cover) || firstUrl(video.origin_cover),
      wide: (Number(video.width) || 16) >= (Number(video.height) || 9),
      time: Number(a.create_time) || 0,
    };
  }

  function inList(list, values) {
    if (!list.length) return false;
    const lower = values.map((v) => v.toLowerCase());
    return list.some((entry) => lower.includes(entry.toLowerCase()));
  }

  function depthRatio(item) {
    if (item.likes < DEPTH_MIN_LIKES) return null;
    return (item.saves + 0.5 * item.shares + 0.5 * item.comments) / item.likes;
  }

  function judge(item, s) {
    const reasons = [];
    if (!item || typeof item !== 'object') return { keep: true, reasons };
    const f = s.filters;
    const level = LEVELS[s.strictness] || LEVELS.balanced;

    if (f.ads && item.ad) reasons.push('ad');
    if (f.live && item.live) reasons.push('live');
    // Live cards carry almost no text; the rules below need a real item.
    if (item.live) return { keep: reasons.length === 0, reasons };

    const who = [item.creator].concat(item.creatorIds).filter(Boolean);
    if (inList(s.trustedCreators, who)) return { keep: reasons.length === 0, reasons };

    const catText = item.cats.join(' ');
    const text = (item.desc + ' ' + item.tags.join(' ')).toLowerCase();

    if (f.ai && (item.ai || AI_CATEGORY.test(catText) || AI_TEXT.test(text))) reasons.push('ai');
    if (f.recap && (RECAP_CATEGORY.test(catText) || RECAP_TEXT.test(text))) reasons.push('recap');
    if (f.drama && (DRAMA_CATEGORY.test(catText) || DRAMA_TEXT.test(text) || item.tags.some((t) => DRAMA_TROPES.test(t)))) reasons.push('drama');
    if (f.staged && item.staged) reasons.push('staged');
    if (f.commerce && (item.goods || COMMERCE_TEXT.test(text))) reasons.push('commerce');
    if (f.clickbait) {
      const bait = count(BAIT_STRONG, item.desc) > 0 || count(BAIT_WEAK, item.desc) >= level.weakBait || item.tags.length >= level.tags;
      if (bait) reasons.push('clickbait');
    }
    if (f.images && item.slides) reasons.push('images');
    if (s.minSeconds > 0 && !item.slides && item.ms > 0 && item.ms < s.minSeconds * 1000) reasons.push('short');

    if (s.blockedWords.length) {
      const hay = text + ' ' + catText.toLowerCase() + ' ' + item.creator.toLowerCase();
      if (s.blockedWords.some((w) => hay.includes(w.toLowerCase()))) reasons.push('word');
    }
    if (inList(s.blockedCreators, who)) reasons.push('creator');
    if (inList(s.blockedCategories, item.cats)) reasons.push('category');
    if (inList(s.blockedTags, item.tags)) reasons.push('tag');
    if (s.learn.enabled && (inList(s.learn.tags, item.tags) || inList(s.learn.categories, item.cats)
      || s.learn.words.some((w) => text.includes(w.toLowerCase())))) reasons.push('learned');

    if (s.focusMode && s.focusTopics.length) {
      const hay = text + ' ' + catText.toLowerCase();
      if (!s.focusTopics.some((t) => hay.includes(t.toLowerCase()))) reasons.push('focus');
    }

    const ratio = depthRatio(item);
    if (level.depth > 0 && ratio !== null && ratio < level.depth) reasons.push('shallow');

    return { keep: reasons.length === 0, reasons };
  }

  root.CalmClassifier = Object.freeze({ REASONS, lite, judge });
})(globalThis);
