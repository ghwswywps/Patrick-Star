/* ==========================================================================
 * 派大星的衣柜 · js/audio.js
 * 音频层：window.PDT.Audio
 * 契约：docs/CONTRACT.md §5.3
 *
 *   PDT.Audio.init()        // 首次用户手势里调用；WebAudio unlock + 预加载；返回 Promise
 *   PDT.Audio.play(name)    // 'flip'|'match'|'merge'|'win'|'mismatch'|'click'；缺文件用合成音兜底
 *   PDT.Audio.musicPlay()   // BGM 循环播放（淡入）
 *   PDT.Audio.musicStop()   // BGM 淡出停止
 *   PDT.Audio.musicToggle() // 返回当前是否正在播放
 *   PDT.Audio.setMuted(b)   // 停 BGM + 静音音效；状态存 localStorage['pdt_muted_v1']
 *   PDT.Audio.isMuted()
 *
 * 设计约束（重要，别改坏）：
 *  1) 普通脚本，不是 ES module，不引任何第三方库；必须能直接 file:// 双击打开。
 *  2) 音源只用 `new Audio(相对路径)`，绝不用 fetch/XHR（file:// 下 XHR 会被拦）。
 *     —— 浏览器自己负责解码与缓存，file:// 下也可靠。
 *  3) 候选路径 .ogg -> .mp3 -> .wav，靠 Audio 的 'error' 事件逐级后退。
 *  4) 音量 / 淡入淡出用「元素 volume 步进 + WebAudio 合成兜底」实现：
 *     不把 <audio> 接到 MediaElementAudioSourceNode 上 —— Chromium 对 file://
 *     媒体做 CORS 判定，接进 WebAudio 图会静音（且不报错），双击打开就哑巴了。
 *     WebAudio 只负责 unlock 与「文件缺失时的合成音」，这条路任何情况下都出声。
 *  5) 所有方法永不抛异常、可重复调用（渲染循环/事件回调里随手调用都安全）。
 * ========================================================================== */
(function (global) {
  'use strict';

  var PDT = global.PDT = global.PDT || {};
  if (PDT.Audio && PDT.Audio.__pdtAudio) { return; } // 防止重复加载

  /* ------------------------------- 常量 --------------------------------- */

  var MUTE_KEY = 'pdt_muted_v1';
  var AUDIO_DIR = 'assets/audio/';
  var BGM_NAME = 'bgm';
  var EXTS = ['ogg', 'mp3', 'wav'];

  var SFX_NAMES = ['flip', 'match', 'merge', 'win', 'mismatch', 'click'];

  // 每个音效同时最多叠几个实例（快速连翻时不互相打断）
  var POOL_SIZE = 3;

  // 音效默认音量（0~1）
  // 注意：click 是最高频触发的一个，用户反馈「点击噪音刺耳」，所以压到 0.34；
  // flip 也跟着降一档，避免连翻时低频段的躁感。
  var SFX_VOL = {
    flip: 0.62,
    match: 0.82,
    merge: 0.92,
    win: 0.88,
    mismatch: 0.55,
    click: 0.34
  };

  // BGM 目标音量
  var BGM_VOL = 0.55;
  var FADE_IN_MS = 700;
  var FADE_OUT_MS = 420;

  // 文件全缺失时的 WebAudio 兜底音：约 300ms，不同 name 不同频率
  var SYNTH = {
    flip:     { type: 'triangle', from: 720,  to: 980,  vol: 0.22 },
    match:    { type: 'sine',     from: 990,  to: 1480, vol: 0.26 },
    merge:    { type: 'sine',     from: 440,  to: 1760, vol: 0.24 },
    win:      { type: 'triangle', from: 660,  to: 1320, vol: 0.26 },
    mismatch: { type: 'square',   from: 330,  to: 196,  vol: 0.14 },
    click:    { type: 'square',   from: 1300, to: 1000, vol: 0.12 },
    _default: { type: 'sine',     from: 600,  to: 880,  vol: 0.20 }
  };
  var SYNTH_MS = 300;

  /* ------------------------------- 状态 --------------------------------- */

  var state = {
    booted: false,
    inited: false,
    initPromise: null,
    ctx: null,
    muted: false,
    musicWanted: false,
    visBound: false,
    gestureBound: false,
    bgm: {
      el: null,
      extIdx: 0,
      dead: false,
      pausedByHidden: false
    },
    pools: {} // name -> { name, els:[], extIdx, dead }
  };

  /* ----------------------------- 小工具 --------------------------------- */

  function clamp01(v) {
    v = Number(v);
    if (!isFinite(v)) { return 0; }
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  function hasDoc() {
    return typeof global.document !== 'undefined' && global.document !== null;
  }

  function readMuted() {
    try {
      if (!global.localStorage) { return false; }
      var v = global.localStorage.getItem(MUTE_KEY);
      // 兼容 ui-shell 自己那份静音标记（js/ui.js 用 'pdt_mute_v1'）：
      // 只是只读镜像，写永远写契约规定的 MUTE_KEY。
      if (v === null) { v = global.localStorage.getItem('pdt_mute_v1'); }
      return v === '1' || v === 'true';
    } catch (e) { return false; }
  }

  function writeMuted(m) {
    try {
      if (!global.localStorage) { return; }
      global.localStorage.setItem(MUTE_KEY, m ? '1' : '0');
    } catch (e) { /* 隐私模式 / file:// 限制：忽略即可 */ }
  }

  function candidate(name, idx) {
    var ext = EXTS[idx] || EXTS[0];
    return AUDIO_DIR + name + '.' + ext;
  }

  function makeAudio(src) {
    try {
      if (typeof global.Audio === 'undefined') { return null; }
      var el = new global.Audio();
      el.preload = 'auto';
      el.setAttribute('playsinline', '');
      el.src = src;
      try { el.load(); } catch (e0) { /* 某些浏览器 load 会抛，忽略 */ }
      return el;
    } catch (e) {
      return null;
    }
  }

  function safePlay(el) {
    try {
      var pr = el.play();
      if (pr && typeof pr.catch === 'function') {
        pr.catch(function () { /* 自动播放策略拒绝：静默失败即可 */ });
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearFade(el) {
    try {
      if (el && el.__pdtFade) {
        clearInterval(el.__pdtFade);
        el.__pdtFade = 0;
      }
    } catch (e) { /* ignore */ }
  }

  /**
   * 把元素的 volume 从当前值步进到 to（毫秒级），结束回调 done。
   * 用 volume 而不是 WebAudio 增益：见文件头第 4 条。
   */
  function fadeTo(el, to, ms, done) {
    var finished = false;
    function finish() {
      if (finished) { return; }
      finished = true;
      if (typeof done === 'function') {
        try { done(); } catch (e) { /* ignore */ }
      }
    }
    try {
      clearFade(el);
      to = clamp01(to);
      if (!ms || ms <= 0) {
        try { el.volume = to; } catch (e) { /* ignore */ }
        finish();
        return;
      }
      var from = clamp01(el.volume);
      var steps = Math.max(1, Math.round(ms / 40));
      var i = 0;
      el.__pdtFade = setInterval(function () {
        try {
          i++;
          var k = i / steps;
          el.volume = clamp01(from + (to - from) * k);
          if (i >= steps) {
            clearFade(el);
            finish();
          }
        } catch (e) {
          clearFade(el);
          finish();
        }
      }, 40);
    } catch (e) {
      try { el.volume = clamp01(to); } catch (e2) { /* ignore */ }
      finish();
    }
  }

  /* --------------------------- WebAudio 部分 ---------------------------- */

  function ensureCtx() {
    if (state.ctx) { return state.ctx; }
    try {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) { return null; }
      state.ctx = new AC();
    } catch (e) {
      state.ctx = null;
    }
    return state.ctx;
  }

  // 首次手势里做 unlock：resume + 播一个 1 sample 的静音 buffer
  function unlock() {
    var ctx = ensureCtx();
    if (!ctx) { return Promise.resolve(false); }
    var jobs = [];
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        var p = ctx.resume();
        if (p && typeof p.then === 'function') { jobs.push(p); }
      }
    } catch (e) { /* ignore */ }
    try {
      var buf = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g);
      g.connect(ctx.destination);
      src.start(0);
      src.stop ? src.stop((ctx.currentTime || 0) + 0.01) : null;
    } catch (e) { /* ignore */ }
    if (!jobs.length) { return Promise.resolve(true); }
    return Promise.race([
      Promise.all(jobs).then(function () { return true; }).catch(function () { return false; }),
      new Promise(function (resolve) { setTimeout(function () { resolve(true); }, 800); })
    ]).catch(function () { return false; });
  }

  /**
   * 合成兜底音（文件缺失时）。始终返回 boolean，永不抛。
   */
  function synth(name, opts) {
    try {
      if (state.muted) { return false; }
      var ctx = ensureCtx();
      if (!ctx) { return false; }
      try {
        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
          var pr = ctx.resume();
          if (pr && typeof pr.catch === 'function') { pr.catch(function () {}); }
        }
      } catch (e) { /* ignore */ }

      var cfg = SYNTH[name] || SYNTH._default;
      var dur = (opts && opts.dur) || (SYNTH_MS / 1000);
      var vol = clamp01((opts && opts.vol) || cfg.vol);
      var t0 = ctx.currentTime || 0;

      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      try { osc.type = cfg.type; } catch (e) { /* ignore */ }
      try { osc.frequency.setValueAtTime(cfg.from, t0); } catch (e) { /* ignore */ }
      try {
        osc.frequency.exponentialRampToValueAtTime(Math.max(40, cfg.to), t0 + dur);
      } catch (e) { /* ignore */ }

      try {
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      } catch (e) { /* ignore */ }

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
      try {
        osc.onended = function () {
          try { osc.disconnect(); gain.disconnect(); } catch (e) { /* ignore */ }
        };
      } catch (e) { /* ignore */ }
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ----------------------------- 音效池 -------------------------------- */

  function getPool(name) {
    if (state.pools[name]) { return state.pools[name]; }
    var p = { name: name, els: [], extIdx: 0, dead: false };
    state.pools[name] = p;
    buildPool(p);
    return p;
  }

  function killPool(p) {
    var list = p.els || [];
    p.els = [];
    for (var i = 0; i < list.length; i++) {
      try {
        list[i].__pdtDead = true;
        clearFade(list[i]);
        list[i].pause();
        list[i].removeAttribute('src');
      } catch (e) { /* ignore */ }
    }
  }

  function buildPool(p) {
    killPool(p);
    if (p.extIdx >= EXTS.length) {
      p.dead = true;
      return;
    }
    var src = candidate(p.name, p.extIdx);
    var vol = SFX_VOL[p.name] != null ? SFX_VOL[p.name] : 0.85;
    for (var i = 0; i < POOL_SIZE; i++) {
      var el = makeAudio(src);
      if (!el) {
        p.dead = true;
        return;
      }
      el.volume = clamp01(vol);
      (function (elem, idx) {
        elem.addEventListener('error', function () {
          onPoolError(p, idx);
        });
      })(el, p.extIdx);
      p.els.push(el);
    }
  }

  // 某候选扩展名加载失败 -> 换下一个；全失败 -> 标记 dead（走合成音）
  function onPoolError(p, idx) {
    try {
      if (p.dead || idx !== p.extIdx) { return; }
      p.extIdx++;
      if (p.extIdx >= EXTS.length) {
        killPool(p);
        p.dead = true;
        return;
      }
      buildPool(p);
    } catch (e) { /* ignore */ }
  }

  function pickEl(p) {
    var els = p.els || [];
    var i, el;
    for (i = 0; i < els.length; i++) {
      el = els[i];
      if (!el || el.__pdtDead || el.error) { continue; }
      if (el.paused || el.ended) { return el; }
    }
    for (i = 0; i < els.length; i++) {
      el = els[i];
      if (!el || el.__pdtDead || el.error) { continue; }
      return el; // 全忙：抢第一个（重置 currentTime）
    }
    return null;
  }

  function playSfx(name) {
    var p = getPool(name);
    if (!p || p.dead) { return synth(name); }
    var el = pickEl(p);
    if (!el) { return synth(name); }
    var vol = SFX_VOL[name] != null ? SFX_VOL[name] : 0.85;
    try {
      clearFade(el);
      el.volume = clamp01(vol);
    } catch (e) { /* ignore */ }
    try { el.currentTime = 0; } catch (e) { /* 未就绪时可能抛 */ }
    if (!safePlay(el)) { return synth(name); }
    return true;
  }

  /* ------------------------------- BGM --------------------------------- */

  function ensureBgm() {
    var b = state.bgm;
    if (b.dead) { return null; }
    if (b.el) { return b.el; }
    var el = makeAudio(candidate(BGM_NAME, b.extIdx));
    if (!el) {
      b.dead = true;
      return null;
    }
    el.loop = true;
    el.volume = 0;
    try { el.setAttribute('loop', 'loop'); } catch (e) { /* ignore */ }
    el.addEventListener('error', function () {
      try {
        if (b.el !== el) { return; }
        clearFade(el);
        b.el = null;
        b.extIdx++;
        try { el.pause(); el.removeAttribute('src'); } catch (e2) { /* ignore */ }
        if (b.extIdx >= EXTS.length) {
          b.dead = true; // 全部候选都缺：静默失败，不报错
          return;
        }
        // 若用户本来想听音乐，换到下一个候选后自动续上
        if (state.musicWanted && !state.muted && !b.pausedByHidden) {
          try { api.musicPlay(); } catch (e3) { /* ignore */ }
        }
      } catch (e4) { /* ignore */ }
    });
    b.el = el;
    return el;
  }

  function bgmPlaying() {
    var el = state.bgm.el;
    if (!el) { return false; }
    try { return !el.paused && !el.ended; } catch (e) { return false; }
  }

  function bgmHardPause() {
    var el = state.bgm.el;
    if (!el) { return; }
    try {
      clearFade(el);
      el.pause();
      el.volume = 0;
    } catch (e) { /* ignore */ }
  }

  function visible() {
    try {
      if (!hasDoc() || typeof global.document.visibilityState === 'undefined') { return true; }
      return global.document.visibilityState !== 'hidden';
    } catch (e) { return true; }
  }

  /* --------------------------- 初始化 / 绑定 ---------------------------- */

  function bindVisibility() {
    if (state.visBound || !hasDoc()) { return; }
    state.visBound = true;
    try {
      global.document.addEventListener('visibilitychange', function () {
        try {
          if (global.document.hidden) {
            // 页面不可见：BGM 自动暂停（记住是"被隐藏暂停的"，不是用户停的）
            if (bgmPlaying()) {
              state.bgm.pausedByHidden = true;
              clearFade(state.bgm.el);
              state.bgm.el.pause();
            }
          } else if (state.bgm.pausedByHidden) {
            state.bgm.pausedByHidden = false;
            if (state.musicWanted && !state.muted) {
              try { api.musicPlay(); } catch (e2) { /* ignore */ }
            }
          }
        } catch (e3) { /* ignore */ }
      }, false);
    } catch (e) { /* ignore */ }
  }

  // 额外保险：任何第一次手势都顺手 unlock（UI 忘了调 init 也有声）
  function bindFirstGesture() {
    if (state.gestureBound || !hasDoc()) { return; }
    state.gestureBound = true;
    var evts = ['pointerdown', 'touchstart', 'mousedown', 'keydown'];
    var handler = function () {
      try {
        unlock();
        for (var i = 0; i < evts.length; i++) {
          try { global.document.removeEventListener(evts[i], handler, true); } catch (e2) { /* ignore */ }
        }
      } catch (e3) { /* ignore */ }
    };
    for (var i = 0; i < evts.length; i++) {
      try { global.document.addEventListener(evts[i], handler, true); } catch (e) { /* ignore */ }
    }
  }

  function preloadAll() {
    try {
      for (var i = 0; i < SFX_NAMES.length; i++) {
        getPool(SFX_NAMES[i]);
      }
    } catch (e) { /* ignore */ }
    try { ensureBgm(); } catch (e) { /* ignore */ }
  }

  /* -------------------------------- API -------------------------------- */

  var api = {
    __pdtAudio: true,

    /**
     * 首次用户手势里调用。WebAudio unlock + 预加载音频。
     * 永远 resolve（不 reject），重复调用返回同一个 Promise。
     */
    init: function () {
      if (state.initPromise) {
        try { unlock(); } catch (e) { /* ignore */ }
        return state.initPromise;
      }
      state.inited = true;
      state.muted = readMuted();
      try {
        state.initPromise = new Promise(function (resolve) {
          var done = false;
          function finish(v) {
            if (done) { return; }
            done = true;
            resolve(v);
          }
          try { preloadAll(); } catch (e) { /* ignore */ }
          var p;
          try { p = unlock(); } catch (e2) { p = null; }
          if (p && typeof p.then === 'function') {
            p.then(function (v) { finish(v); }).catch(function () { finish(false); });
          } else {
            finish(false);
          }
          // 兜底：任何情况下 1.2s 内一定 resolve
          try { setTimeout(function () { finish(true); }, 1200); } catch (e3) { finish(true); }
        });
      } catch (e) {
        state.initPromise = Promise.resolve(false);
      }
      try { bindVisibility(); } catch (e) { /* ignore */ }
      try { bindFirstGesture(); } catch (e) { /* ignore */ }
      return state.initPromise;
    },

    /**
     * 播放音效。'flip'|'match'|'merge'|'win'|'mismatch'|'click'（也接受其它文件名）。
     * 文件缺失 -> WebAudio 合成约 300ms 兜底音。永不抛异常。
     */
    play: function (name) {
      try {
        if (state.muted) { return false; }
        var n = String(name == null ? '' : name).toLowerCase();
        if (!n) { return false; }
        return playSfx(n) === true;
      } catch (e) {
        return false;
      }
    },

    /** 播放 BGM（loop + 淡入）。文件缺失时静默失败。返回 boolean。 */
    musicPlay: function () {
      try {
        state.musicWanted = true;
        if (state.muted) { return false; }
        var b = state.bgm;
        if (b.dead) { return false; }
        var el = ensureBgm();
        if (!el) { return false; }
        if (!el.paused && !el.ended) {
          // 已在播：仅确保音量到位
          fadeTo(el, BGM_VOL, 200);
          return true;
        }
        try {
          if (el.error) { return false; }
        } catch (e) { /* ignore */ }
        clearFade(el);
        try { el.volume = 0; } catch (e2) { /* ignore */ }
        try { if (el.ended || el.duration === 0) { el.currentTime = 0; } } catch (e3) { /* ignore */ }
        if (!safePlay(el)) { return false; }
        fadeTo(el, BGM_VOL, FADE_IN_MS);
        return true;
      } catch (e) {
        return false;
      }
    },

    /** 停止 BGM（淡出后暂停）。幂等。 */
    musicStop: function () {
      try {
        state.musicWanted = false;
        var b = state.bgm;
        if (!b || !b.el) { return false; }
        var el = b.el;
        clearFade(el);
        if (el.paused) { try { el.volume = 0; } catch (e) { /* ignore */ } return false; }
        fadeTo(el, 0, FADE_OUT_MS, function () {
          try { el.pause(); } catch (e) { /* ignore */ }
        });
        return true;
      } catch (e) {
        return false;
      }
    },

    /** 切换 BGM。返回切换后是否正在播放。 */
    musicToggle: function () {
      try {
        if (state.muted) {
          // 静音状态下不允许开音乐，避免"开关看着开了但没声"
          if (bgmPlaying()) { api.musicStop(); }
          return false;
        }
        if (bgmPlaying() || state.bgm.pausedByHidden) {
          api.musicStop();
          return false;
        }
        var ok = api.musicPlay();
        return ok === true && bgmPlaying();
      } catch (e) {
        return false;
      }
    },

    /** 静音 / 取消静音：停 BGM + 禁用音效；状态持久化到 localStorage。 */
    setMuted: function (m) {
      try {
        var next = !!m;
        state.muted = next;
        writeMuted(next);
        if (next) {
          // 停 BGM 但保留 musicWanted，方便取消静音后自动续上
          bgmHardPause();
          state.bgm.pausedByHidden = false;
        } else if (state.musicWanted && visible()) {
          try { api.musicPlay(); } catch (e) { /* ignore */ }
        }
        return next;
      } catch (e) {
        return false;
      }
    },

    /** 当前是否静音。 */
    isMuted: function () {
      try { return state.muted === true; } catch (e) { return false; }
    }
  };

  // 启动时同步一次静音状态（此后以 setMuted 为准）
  try { state.muted = readMuted(); } catch (e) { state.muted = false; }
  try { bindVisibility(); } catch (e) { /* ignore */ }

  PDT.Audio = api;

  // 方便 node 里 require（虽然契约只要求 flag/engine 能 require）
  if (typeof module !== 'undefined' && module.exports) {
    try { module.exports = api; } catch (e) { /* ignore */ }
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
