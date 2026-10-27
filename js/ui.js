/* ==========================================================================
 * 派大星的衣柜 · js/ui.js
 * 界面层：DOM 挂载、牌桌渲染、3D 翻牌、HUD、结算、特效编排。
 *
 * 契约：docs/CONTRACT.md §5.5（DOM 契约 + boot() 幂等）
 * 依赖（全部可选，缺失时优雅降级，页面绝不崩）：
 *   PDT.Flag.svgString(w,h)  — 严格国旗矢量（缺失则用 CSS 兜底国旗）
 *   PDT.Engine               — 游戏引擎（缺失则显示「正在加载引擎…」并禁止开局）
 *   PDT.Audio.init/play/...  — 音频（缺失则静默）
 *   PDT.Merge.play(hostEl)   — 重合特效（缺失则用本地光爆兜底）
 * ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;
  var PDT = (global.PDT = global.PDT || {});

  /* ---------------------------------------------------------------- 常量 */

  var CARD_COUNT = 24;
  var BEST_KEY = 'pdt_best_v1';
  var MUTE_KEY = 'pdt_muted_v1';   // 与 js/audio.js 统一（audio-design 用这个键）

  var T_MISMATCH_RECOVER = 760;   // 翻错：停留 → 翻回
  var T_MATCH_FLASH = 380;        // 配对：金闪 + 弹跳
  var T_MATCH_FADE = 340;         // 配对：缩放淡出
  var T_SUCK = 520;               // 合并：吸到屏幕中央
  var T_MERGE_SETTLE = 340;       // 合并：特效结束 → 收尾
  var T_MERGE_MAX = 5600;         // 合并特效最长等待（防卡死）
  var T_WIN_DELAY = 520;          // 清空后 → 弹结算

  var TYPE_ORDER = ['flag', 'parachute', 'trunks', 'kebab', 'balloon', 'grin'];

  var META = {
    flag:      { label: '土耳其国旗',      emoji: '🌙', img: '' },
    parachute: { label: '派大星降落伞',    emoji: '🪂', img: 'assets/img/cards/parachute.png' },
    trunks:    { label: '粉色大裤衩',      emoji: '🩲', img: 'assets/img/cards/trunks.png' },
    kebab:     { label: '土耳其烤肉',      emoji: '🥙', img: 'assets/img/cards/kebab.png' },
    balloon:   { label: '卡帕多奇亚热气球', emoji: '🎈', img: 'assets/img/cards/balloon.png' },
    grin:      { label: '派大星憨笑',      emoji: '😁', img: 'assets/img/cards/grin.png' }
  };

  var CARD_BACK_IMG = 'assets/img/scene/cardback.png';

  /* ---------------------------------------------------------------- 状态 */

  var S = {
    booted: false,
    started: false,          // 是否已开局（开始界面关掉）
    finished: false,         // 是否已通关
    busy: false,             // 结算动画期间锁输入（与引擎 status 双重保护）
    engine: null,
    cards: [],
    pending: [],             // 已翻开、尚未结算的牌 index
    touch: {},               // index -> 最近一次处理时间戳（防连点重复处理）
    shownScore: 0,
    scoreRaf: 0,
    timerId: 0,
    engineWatch: 0,
    audioPromise: null,
    muted: false,
    lastToastAt: 0,
    dom: {}
  };

  var dom = S.dom;

  /* ------------------------------------------------------------ 小工具 */

  function byId(id) { return doc ? doc.getElementById(id) : null; }

  function txt(el, v) { if (el) { el.textContent = String(v); } }

  function num(v) {
    v = Number(v);
    return isFinite(v) && v > 0 ? Math.round(v) : 0;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { global.setTimeout(resolve, ms); });
  }

  function fmtTime(ms) {
    ms = Number(ms);
    if (!isFinite(ms) || ms < 0) { ms = 0; }
    var total = Math.floor(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* --------------------------------------------------------- 牌面渲染 */

  function cardBackHTML() {
    return '<span class="back-glyph" aria-hidden="true">' +
             '<span class="bk-moon"></span><span class="bk-star"></span>' +
           '</span>' +
           '<img class="back-img" alt="" draggable="false" src="' + CARD_BACK_IMG + '">';
  }

  /* 严格国旗优先（PDT.Flag），缺失则用纯 CSS 兜底（3:2 红底 + 月牙 + 正五角星） */
  function flagHTML() {
    var svg = '';
    try {
      if (PDT.Flag && typeof PDT.Flag.svgString === 'function') {
        svg = PDT.Flag.svgString(120, 80);
      }
    } catch (e) {
      svg = '';
    }
    if (typeof svg === 'string' && svg.indexOf('<svg') !== -1) {
      return '<span class="art art-flag"><span class="flag-svg">' + svg + '</span></span>';
    }
    return '<span class="art art-flag">' +
             '<span class="flag-field">' +
               '<span class="flag-moon"></span><span class="flag-star"></span>' +
             '</span>' +
           '</span>';
  }

  function cardFrontHTML(type) {
    if (type === 'flag') { return flagHTML(); }
    var meta = META[type] || { emoji: '❔', img: '' };
    return '<span class="art art-' + type + '">' +
             '<img class="art-img" alt="" draggable="false" src="' + meta.img + '">' +
             '<span class="art-fallback" aria-hidden="true">' + meta.emoji + '</span>' +
           '</span>';
  }

  /* 图片加载成功才淡入，失败就保留 CSS 渐变 + emoji 兜底（不出现破图标） */
  function wireArt(img) {
    if (!img || img.getAttribute('data-wired') === '1') { return; }
    img.setAttribute('data-wired', '1');

    function ok() {
      img.classList.add('is-ready');
      var wrap = img.parentNode;
      if (wrap) {
        var fb = wrap.querySelector('.art-fallback');
        if (fb) { fb.style.opacity = '0'; }
      }
    }
    function fail() {
      img.classList.remove('is-ready');
      img.style.display = 'none';
      if (img.parentNode) { img.parentNode.classList.add('no-img'); }
    }

    img.addEventListener('load', ok);
    img.addEventListener('error', fail);
    if (img.complete) {
      if (img.naturalWidth > 0) { ok(); } else { fail(); }
    }
  }

  /* --------------------------------------------------------- 牌桌 DOM */

  function refreshCards() {
    S.cards = dom.board
      ? Array.prototype.slice.call(dom.board.querySelectorAll('.card'))
      : [];
    return S.cards;
  }

  function cardByIndex(i) { return S.cards[i] || null; }

  function ensureCards() {
    if (!dom.board) { return; }
    var list = refreshCards();
    for (var i = list.length; i < CARD_COUNT; i++) {
      var card = doc.createElement('div');
      card.className = 'card';
      card.setAttribute('data-index', String(i));
      card.setAttribute('data-type', '');
      card.setAttribute('data-state', 'down');
      var inner = doc.createElement('div');
      inner.className = 'card-inner';
      var back = doc.createElement('div');
      back.className = 'card-back';
      var front = doc.createElement('div');
      front.className = 'card-front';
      inner.appendChild(back);
      inner.appendChild(front);
      card.appendChild(inner);
      dom.board.appendChild(card);
    }
    list = refreshCards();
    list.forEach(function (card, i) {
      card.setAttribute('data-index', String(i));
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      if (!card.getAttribute('aria-label')) {
        card.setAttribute('aria-label', '第 ' + (i + 1) + ' 张牌，未翻开');
      }
    });
  }

  function setCardLabel(card, idx, state, type) {
    if (!card) { return; }
    var head = '第 ' + (idx + 1) + ' 张牌';
    if (state === 'up' && META[type]) {
      card.setAttribute('aria-label', head + '，已翻开：' + META[type].label);
    } else if (state === 'gone') {
      card.setAttribute('aria-label', head + '，已消除');
    } else {
      card.setAttribute('aria-label', head + '，未翻开');
    }
  }

  /* 把引擎的牌序同步到 DOM（新开一局 / 引擎后到 时调用） */
  function syncBoardFromEngine() {
    if (!dom.board) { return; }
    ensureCards();
    var cards = refreshCards();
    var data = [];
    try {
      if (S.engine && typeof S.engine.getCards === 'function') {
        data = S.engine.getCards() || [];
      }
    } catch (e) {
      console.warn('[PDT.UI] engine.getCards() 出错：', e);
      data = [];
    }

    cards.forEach(function (card, i) {
      var item = data[i] || null;
      var type = (item && item.type) ? item.type : TYPE_ORDER[i % TYPE_ORDER.length];

      card.setAttribute('data-index', String(i));
      card.setAttribute('data-type', type);
      card.setAttribute('data-state', 'down');
      card.classList.remove('up', 'matched', 'gone', 'sucking');
      card.removeAttribute('aria-hidden');
      card.style.removeProperty('--suck-x');
      card.style.removeProperty('--suck-y');
      setCardLabel(card, i, 'down', type);

      var inner = card.querySelector('.card-inner');
      if (!inner) {
        inner = doc.createElement('div');
        inner.className = 'card-inner';
        card.appendChild(inner);
      }

      var back = inner.querySelector('.card-back');
      if (!back) {
        back = doc.createElement('div');
        back.className = 'card-back';
        inner.insertBefore(back, inner.firstChild);
      }
      if (back.getAttribute('data-built') !== '1') {
        back.innerHTML = cardBackHTML();
        back.setAttribute('data-built', '1');
        wireArt(back.querySelector('.back-img'));
      }

      var front = inner.querySelector('.card-front');
      if (!front) {
        front = doc.createElement('div');
        front.className = 'card-front';
        inner.appendChild(front);
      }
      front.innerHTML = cardFrontHTML(type);
      front.setAttribute('data-type', type);
      wireArt(front.querySelector('.art-img'));
    });
  }

  /* ------------------------------------------------------------ 引擎 */

  function engineReady() {
    return !!(PDT.Engine && typeof PDT.Engine === 'function');
  }

  function makeEngine() {
    if (!engineReady()) { return null; }
    try {
      return new PDT.Engine();
    } catch (e) {
      console.warn('[PDT.UI] new PDT.Engine() 失败：', e);
      return null;
    }
  }

  function showWarning(message) {
    if (!dom.warning) { return; }
    dom.warning.textContent = message;
    dom.warning.hidden = false;
  }

  function hideWarning() {
    if (!dom.warning) { return; }
    dom.warning.hidden = true;
  }

  function disableStart(flag) {
    if (!dom.btnStart) { return; }
    if (flag) {
      dom.btnStart.disabled = true;
      dom.btnStart.setAttribute('aria-disabled', 'true');
    } else {
      dom.btnStart.disabled = false;
      dom.btnStart.removeAttribute('aria-disabled');
    }
  }

  /* 引擎缺失：显示「正在加载引擎…」、禁止开局，但不崩；等它出现就自动接上 */
  function requireEngine() {
    if (S.engine) { return true; }
    if (engineReady()) {
      S.engine = makeEngine();
      if (S.engine) { hideWarning(); disableStart(false); return true; }
    }
    showWarning('正在加载引擎…');
    disableStart(true);
    watchEngine();
    return false;
  }

  function watchEngine() {
    if (S.engineWatch) { return; }
    var tries = 0;
    S.engineWatch = global.setInterval(function () {
      tries += 1;
      if (engineReady()) {
        global.clearInterval(S.engineWatch);
        S.engineWatch = 0;
        S.engine = makeEngine();
        if (S.engine) {
          hideWarning();
          disableStart(false);
          syncBoardFromEngine();
          updateHud(true);
          console.info('[PDT.UI] 引擎已就绪，可以开局。');
          return;
        }
      }
      if (tries >= 60) {
        global.clearInterval(S.engineWatch);
        S.engineWatch = 0;
        showWarning('引擎未加载（js/engine.js 缺失或报错），请刷新页面。');
      }
    }, 500);
  }

  /* ------------------------------------------------------------ 开局 */

  function startGame() {
    if (!requireEngine()) { return; }
    if (!S.engine) { return; }

    S.started = true;
    S.finished = false;
    S.busy = false;
    S.pending = [];
    S.touch = {};
    S.shownScore = 0;

    clearFx();

    try { S.engine.reset(); } catch (e) { console.warn('[PDT.UI] engine.reset() 出错：', e); }

    syncBoardFromEngine();
    hideScreen('start');
    hideScreen('win');

    txt(dom.score, '0');
    setTime(0);
    updateHud(true);
    startTimer();

    sfx('click');
    audioInit().then(function () { if (!S.muted) { music(); } });
  }

  function restartGame() {
    hideScreen('win');
    startGame();
  }

  /* --------------------------------------------------------- 翻牌主流程 */

  function readStats() {
    var out = {
      moves: 0, matchedPairs: 0, totalPairs: 12, score: 0,
      combo: 0, bestCombo: 0, elapsedMs: 0, mergeCount: 0
    };
    try {
      if (S.engine && typeof S.engine.stats === 'function') {
        var st = S.engine.stats() || {};
        Object.keys(out).forEach(function (k) {
          if (typeof st[k] === 'number' && isFinite(st[k])) { out[k] = st[k]; }
        });
      }
    } catch (e) { /* 引擎报错也不能影响界面 */ }
    return out;
  }

  function checkWin() {
    try {
      return !!(S.engine && typeof S.engine.isWon === 'function' && S.engine.isWon());
    } catch (e) {
      return false;
    }
  }

  /* 拿到本次结算涉及的牌（优先用引擎返回的 indices，兜底用本地 pending） */
  function pairOf(res, idx) {
    var out = [];
    function push(v) {
      if (typeof v === 'number' && v >= 0 && v < CARD_COUNT && out.indexOf(v) === -1) {
        out.push(v);
      }
    }
    if (res && Object.prototype.toString.call(res.indices) === '[object Array]') {
      res.indices.forEach(push);
    }
    S.pending.forEach(push);
    push(idx);
    return out;
  }

  function flipUp(idx) {
    var card = cardByIndex(idx);
    if (!card || card.classList.contains('up')) { return; }
    card.classList.add('up');
    card.setAttribute('data-state', 'up');
    setCardLabel(card, idx, 'up', card.getAttribute('data-type'));
  }

  function flipBackAll() {
    S.cards.forEach(function (card, i) {
      if (!card.classList.contains('up')) { return; }
      if (card.classList.contains('matched') || card.classList.contains('gone')) { return; }
      card.classList.remove('up');
      card.setAttribute('data-state', 'down');
      setCardLabel(card, i, 'down', card.getAttribute('data-type'));
    });
  }

  function markMatched(idx) {
    var card = cardByIndex(idx);
    if (!card) { return; }
    card.classList.add('matched');
    card.setAttribute('data-state', 'matched');
  }

  function markGone(idx) {
    var card = cardByIndex(idx);
    if (!card) { return; }
    card.classList.add('gone');
    card.setAttribute('data-state', 'cleared');
    setCardLabel(card, idx, 'gone', card.getAttribute('data-type'));
  }

  function handleCardClick(card) {
    if (!card || !S.started || S.finished || S.busy) { return; }
    if (!S.engine) { return; }
    if (!card.classList.contains('card')) { return; }
    if (card.classList.contains('up') || card.classList.contains('gone') ||
        card.classList.contains('matched') || card.classList.contains('sucking')) {
      return;
    }
    if (S.pending.length >= 2) { return; }

    var idx = parseInt(card.getAttribute('data-index'), 10);
    if (isNaN(idx)) { return; }

    /* 同一张牌连点：本地时间戳 + 视觉状态 + 引擎 ignore 三重保护 */
    var now = Date.now();
    if (S.touch[idx] && now - S.touch[idx] < 260) { return; }
    S.touch[idx] = now;

    var res;
    try {
      res = S.engine.flip(idx);
    } catch (e) {
      console.warn('[PDT.UI] engine.flip() 出错：', e);
      return;
    }
    if (!res || !res.status) { return; }

    switch (res.status) {
      case 'ignore':
        return;

      case 'flipped': {
        S.pending.push(idx);
        flipUp(idx);
        sfx('flip');
        updateHud();
        startTimer();
        break;
      }

      case 'mismatch': {
        var pairM = pairOf(res, idx);
        S.pending = [];
        pairM.forEach(flipUp);
        sfx('flip');
        sfx('mismatch');
        S.busy = true;
        updateHud();
        global.setTimeout(function () {
          try { S.engine.unflipPending(); } catch (e) { /* 忽略 */ }
          flipBackAll();
          S.busy = false;
          updateHud();
        }, T_MISMATCH_RECOVER);
        break;
      }

      case 'match': {
        var pair = pairOf(res, idx);
        S.pending = [];
        S.busy = true;
        pair.forEach(flipUp);
        sfx('flip');
        sfx('match');
        updateHud();
        pair.forEach(markMatched);
        floatScore(res.points, pair);

        global.setTimeout(function () {
          pair.forEach(markGone);
        }, T_MATCH_FLASH);

        global.setTimeout(function () {
          S.busy = false;
          afterResolve();
        }, T_MATCH_FLASH + T_MATCH_FADE);
        break;
      }

      case 'merge': {
        var pairX = pairOf(res, idx);
        S.pending = [];
        S.busy = true;
        pairX.forEach(flipUp);
        sfx('flip');
        updateHud();
        runMerge(pairX, res);
        break;
      }

      default:
        /* 未知状态：只翻面，不锁死 */
        flipUp(idx);
        updateHud();
        break;
    }
  }

  /* --------------------------------------------------------- 特殊合并 */

  function suckToCenter(pair) {
    var cx = (global.innerWidth || 0) / 2;
    var cy = (global.innerHeight || 0) / 2;

    pair.forEach(function (idx, n) {
      var card = cardByIndex(idx);
      if (!card) { return; }
      var r = card.getBoundingClientRect();
      var offX = pair.length > 1 ? (n === 0 ? -0.1 : 0.1) * r.width : 0;
      card.style.setProperty('--suck-x', Math.round(cx + offX - (r.left + r.width / 2)) + 'px');
      card.style.setProperty('--suck-y', Math.round(cy - (r.top + r.height / 2)) + 'px');
      card.classList.add('sucking');
    });
  }

  /* 本地光爆兜底：PDT.Merge 缺失时也别让合并显得空 */
  function localGlow() {
    var host = dom.overlay;
    if (!host) { return sleep(320); }
    var g = doc.createElement('div');
    g.className = 'local-glow';
    host.appendChild(g);
    global.setTimeout(function () {
      if (g.parentNode) { g.parentNode.removeChild(g); }
    }, 1400);
    return sleep(1180);
  }

  /* 调 PDT.Merge.play 并等它结束；模块缺失 / 报错 / 卡住都不会阻塞流程 */
  function playMergeFx() {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = 0;

      function done() {
        if (settled) { return; }
        settled = true;
        if (timer) { global.clearTimeout(timer); }
        resolve();
      }

      timer = global.setTimeout(function () {
        console.warn('[PDT.UI] PDT.Merge 超时未结束，继续流程。');
        done();
      }, T_MERGE_MAX);

      var used = false;
      try {
        if (PDT.Merge && typeof PDT.Merge.play === 'function' && dom.overlay) {
          var ret = PDT.Merge.play(dom.overlay, { duration: 2600 });
          if (ret && typeof ret.then === 'function') {
            used = true;
            ret.then(done, function () { done(); });
          }
        }
      } catch (e) {
        console.warn('[PDT.UI] PDT.Merge.play 出错，改用本地光爆：', e);
        used = false;
      }

      if (!used) {
        localGlow().then(done);
      }
    });
  }

  function runMerge(pair, res) {
    var points = (res && typeof res.points === 'number') ? res.points : 300;

    suckToCenter(pair);
    updateHud();

    global.setTimeout(function () {
      sfx('merge');
      playMergeFx().then(function () {
        pair.forEach(markGone);
        toast('星月 × 派大星 · 完美重合！', 2000);
        floatScore(points, null, true);
        global.setTimeout(function () {
          S.busy = false;
          afterResolve();
        }, T_MERGE_SETTLE);
      });
    }, T_SUCK);
  }

  function afterResolve() {
    updateHud();
    if (S.finished || !checkWin()) { return; }
    S.finished = true;
    stopTimer();
    sfx('win');
    global.setTimeout(showWin, T_WIN_DELAY);
  }

  /* ------------------------------------------------------------ 结算 */

  function loadBest() {
    var out = { score: 0, moves: 0, timeMs: 0, plays: 0 };
    try {
      var raw = global.localStorage ? global.localStorage.getItem(BEST_KEY) : null;
      if (raw) {
        var o = JSON.parse(raw);
        if (o && typeof o === 'object') {
          out.score = num(o.score);
          out.moves = num(o.moves);
          out.timeMs = num(o.timeMs);
          out.plays = num(o.plays);
        }
      }
    } catch (e) { /* file:// 或隐私模式可能禁 localStorage */ }
    return out;
  }

  function saveBest(best) {
    try {
      if (global.localStorage) {
        global.localStorage.setItem(BEST_KEY, JSON.stringify(best));
      }
    } catch (e) { /* 存不了就只保留内存里的 */ }
  }

  function renderStars(count) {
    if (!dom.winStars) { return; }
    var stars = dom.winStars.querySelectorAll('.star');
    Array.prototype.forEach.call(stars, function (el, i) {
      el.classList.toggle('on', i < count);
    });
    dom.winStars.setAttribute('aria-label', '星级：' + count + ' / 3');
  }

  function updateBestLine() {
    if (!dom.best) { return; }
    var best = loadBest();
    if (!best.score && !best.moves) {
      dom.best.hidden = true;
      return;
    }
    dom.best.hidden = false;
    dom.best.textContent = '最佳成绩：' + best.score + ' 分 · 最少 ' +
      (best.moves || '—') + ' 步' + (best.timeMs ? ' · ' + fmtTime(best.timeMs) : '');
  }

  function showWin() {
    var st = readStats();

    var stars = 1;
    try {
      if (S.engine && typeof S.engine.stars === 'function') {
        stars = Number(S.engine.stars()) || 1;
      }
    } catch (e) { /* 用默认 1 星 */ }
    stars = Math.max(1, Math.min(3, Math.round(stars)));

    renderStars(stars);
    txt(dom.winTime, fmtTime(st.elapsedMs));
    txt(dom.winMoves, st.moves);
    txt(dom.winCombo, '×' + (st.bestCombo || 0));
    txt(dom.winScore, st.score);

    var best = loadBest();
    var newScore = st.score > (best.score || 0);
    var newMoves = st.moves > 0 && (!best.moves || st.moves < best.moves);

    if (newScore) { best.score = st.score; }
    if (newMoves) { best.moves = st.moves; }
    if (st.elapsedMs > 0 && (!best.timeMs || st.elapsedMs < best.timeMs)) {
      best.timeMs = st.elapsedMs;
    }
    best.plays += 1;
    saveBest(best);

    if (dom.winBest) {
      dom.winBest.textContent = '最佳：' + best.score + ' 分 · 最少 ' +
        (best.moves || '—') + ' 步';
    }
    if (dom.winBadge) {
      dom.winBadge.hidden = !(newScore || newMoves);
    }

    updateBestLine();
    showScreen('win');
  }

  /* -------------------------------------------------------------- HUD */

  function setTime(ms) { txt(dom.time, fmtTime(ms)); }

  function popScore() {
    var el = dom.score;
    if (!el) { return; }
    el.classList.remove('pop');
    /* 强制回流，让动画可以重新播放 */
    void el.offsetWidth;
    el.classList.add('pop');
  }

  function animateScore(target) {
    var el = dom.score;
    if (!el) { return; }
    var from = S.shownScore;
    if (from === target) {
      el.textContent = String(target);
      return;
    }
    if (S.scoreRaf) {
      global.cancelAnimationFrame(S.scoreRaf);
      S.scoreRaf = 0;
      from = S.shownScore;
    }
    var now = (global.performance && global.performance.now)
      ? global.performance.now() : Date.now();
    var dur = 320;

    function step(t) {
      var p = Math.min(1, (t - now) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      var v = Math.round(from + (target - from) * eased);
      S.shownScore = v;
      el.textContent = String(v);
      if (p < 1) {
        S.scoreRaf = global.requestAnimationFrame(step);
      } else {
        S.shownScore = target;
        el.textContent = String(target);
        S.scoreRaf = 0;
      }
    }

    S.scoreRaf = global.requestAnimationFrame(step);
    popScore();
  }

  function updateHud(immediate) {
    var st = readStats();
    txt(dom.moves, st.moves);
    if (immediate) {
      S.shownScore = st.score;
      txt(dom.score, st.score);
    } else {
      animateScore(st.score);
    }
    setTime(st.elapsedMs);
  }

  function startTimer() {
    if (S.timerId) { return; }
    S.timerId = global.setInterval(function () {
      if (S.finished) { return; }
      setTime(readStats().elapsedMs);
    }, 200);
  }

  function stopTimer() {
    if (S.timerId) {
      global.clearInterval(S.timerId);
      S.timerId = 0;
    }
  }

  /* ------------------------------------------------------------ 界面层 */

  function showScreen(name) {
    var el = name === 'win' ? dom.win : dom.start;
    if (!el) { return; }
    el.classList.add('is-visible');
    el.setAttribute('aria-hidden', 'false');
  }

  function hideScreen(name) {
    var el = name === 'win' ? dom.win : dom.start;
    if (!el) { return; }
    el.classList.remove('is-visible');
    el.setAttribute('aria-hidden', 'true');
  }

  /* ------------------------------------------------------------ 飘字 */

  function fxHost() { return dom.fx || dom.overlay || null; }

  function clearFx() {
    if (dom.fx) { dom.fx.innerHTML = ''; }
    if (dom.toast) { dom.toast = null; }
  }

  function toast(text, ms) {
    var host = fxHost();
    if (!host) { return; }
    ms = ms || 1800;
    var t = doc.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    host.appendChild(t);
    S.lastToastAt = Date.now();
    global.setTimeout(function () { t.classList.add('out'); }, Math.max(400, ms - 380));
    global.setTimeout(function () {
      if (t.parentNode) { t.parentNode.removeChild(t); }
    }, ms);
  }

  function floatScore(points, pair, big) {
    var host = fxHost();
    if (!host) { return; }
    var n = typeof points === 'number' && points > 0 ? Math.round(points) : 0;
    if (!n) { return; }

    var el = doc.createElement('div');
    el.className = 'float-score' + (big ? ' big' : '');
    el.textContent = '+' + n;

    var cx = (global.innerWidth || 0) / 2;
    var cy = (global.innerHeight || 0) / 2;
    if (pair && pair.length) {
      var card = cardByIndex(pair[0]);
      if (card) {
        var r = card.getBoundingClientRect();
        cx = r.left + r.width / 2;
        cy = r.top + r.height / 2;
      }
    }
    el.style.left = Math.round(cx) + 'px';
    el.style.top = Math.round(cy) + 'px';
    host.appendChild(el);

    global.setTimeout(function () {
      if (el.parentNode) { el.parentNode.removeChild(el); }
    }, 1400);
  }

  /* ------------------------------------------------------------ 音频 */

  function audioInit() {
    if (S.audioPromise) { return S.audioPromise; }
    S.audioPromise = new Promise(function (resolve) {
      var pending = null;
      try {
        if (PDT.Audio && typeof PDT.Audio.init === 'function') {
          pending = PDT.Audio.init();
        }
      } catch (e) {
        console.warn('[PDT.UI] PDT.Audio.init() 出错（忽略）：', e);
      }
      if (pending && typeof pending.then === 'function') {
        pending.then(resolve, resolve);
      } else {
        resolve();
      }
    });
    S.audioPromise.then(function () {
      try {
        if (S.muted && PDT.Audio && typeof PDT.Audio.setMuted === 'function') {
          PDT.Audio.setMuted(true);
        }
      } catch (e) { /* 忽略 */ }
    });
    return S.audioPromise;
  }

  function music() {
    try {
      if (PDT.Audio && typeof PDT.Audio.musicPlay === 'function') {
        PDT.Audio.musicPlay();
      }
    } catch (e) { /* 忽略 */ }
  }

  function sfx(name) {
    try {
      if (PDT.Audio && typeof PDT.Audio.play === 'function') {
        PDT.Audio.play(name);
      }
    } catch (e) { /* 缺音效也不能影响游戏 */ }
  }

  function refreshMuteButton() {
    if (!dom.mute) { return; }
    dom.mute.textContent = S.muted ? '🔇' : '🔊';
    dom.mute.setAttribute('aria-pressed', S.muted ? 'true' : 'false');
    dom.mute.setAttribute('aria-label', S.muted ? '取消静音' : '静音');
    dom.mute.classList.toggle('is-muted', S.muted);
  }

  function setMuted(flag) {
    S.muted = !!flag;
    try {
      if (PDT.Audio && typeof PDT.Audio.setMuted === 'function') {
        PDT.Audio.setMuted(S.muted);
      }
    } catch (e) { /* 忽略 */ }
    refreshMuteButton();
    try {
      if (global.localStorage) {
        global.localStorage.setItem(MUTE_KEY, S.muted ? '1' : '0');
      }
    } catch (e) { /* 忽略 */ }
  }

  function toggleMute() {
    setMuted(!S.muted);
    if (!S.muted) {
      audioInit().then(function () { music(); });
    }
    sfx('click');
  }

  function loadMuted() {
    try {
      S.muted = !!(global.localStorage && global.localStorage.getItem(MUTE_KEY) === '1');
    } catch (e) {
      S.muted = false;
    }
    refreshMuteButton();
  }

  /* ------------------------------------------------------------ 事件 */

  function closestCard(node) {
    while (node && node !== dom.board) {
      if (node.classList && node.classList.contains('card')) { return node; }
      node = node.parentNode;
    }
    return null;
  }

  function bindBoard() {
    if (!dom.board || dom.board.getAttribute('data-bound') === '1') { return; }
    dom.board.setAttribute('data-bound', '1');

    dom.board.addEventListener('click', function (ev) {
      var card = closestCard(ev.target);
      if (!card) { return; }
      ev.preventDefault();
      handleCardClick(card);
    });

    dom.board.addEventListener('keydown', function (ev) {
      var key = ev.key;
      if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') { return; }
      var card = closestCard(ev.target);
      if (!card) { return; }
      ev.preventDefault();
      handleCardClick(card);
    });
  }

  function bindButtons() {
    if (dom.btnStart && dom.btnStart.getAttribute('data-bound') !== '1') {
      dom.btnStart.setAttribute('data-bound', '1');
      dom.btnStart.addEventListener('click', function (ev) {
        ev.preventDefault();
        audioInit();
        startGame();
      });
    }
    if (dom.btnRestart && dom.btnRestart.getAttribute('data-bound') !== '1') {
      dom.btnRestart.setAttribute('data-bound', '1');
      dom.btnRestart.addEventListener('click', function (ev) {
        ev.preventDefault();
        audioInit();
        restartGame();
      });
    }
    if (dom.mute && dom.mute.getAttribute('data-bound') !== '1') {
      dom.mute.setAttribute('data-bound', '1');
      dom.mute.addEventListener('click', function (ev) {
        ev.preventDefault();
        audioInit();
        toggleMute();
      });
    }
  }

  /* 首次用户手势里解锁音频 + 起 BGM（浏览器自动播放策略） */
  function bindFirstGesture() {
    var fired = false;
    var events = ['pointerdown', 'touchstart', 'mousedown', 'keydown'];

    function once() {
      if (fired) { return; }
      fired = true;
      events.forEach(function (name) {
        doc.removeEventListener(name, once, true);
      });
      audioInit().then(function () {
        if (!S.muted && S.started) { music(); }
      });
    }

    events.forEach(function (name) {
      doc.addEventListener(name, once, true);
    });
  }

  /* 大图（bg / bg-win）加载成功才淡入 */
  function bindArt(img) {
    if (!img || img.getAttribute('data-wired') === '1') { return; }
    img.setAttribute('data-wired', '1');
    img.addEventListener('load', function () { img.classList.add('is-ready'); });
    img.addEventListener('error', function () {
      img.classList.remove('is-ready');
      img.style.display = 'none';
    });
    if (img.complete) {
      if (img.naturalWidth > 0) { img.classList.add('is-ready'); }
      else { img.style.display = 'none'; }
    }
  }

  /* -------------------------------------------------------------- boot */

  function boot() {
    if (S.booted) { return; }          // 幂等：重复调用不重复挂载
    if (!doc) { return; }

    var app = byId('app');
    if (!app) {
      /* HTML 被裁剪时的兜底：就地搭一个根容器，页面依然能跑 */
      app = doc.createElement('div');
      app.id = 'app';
      app.className = 'app';
      (doc.body || doc.documentElement).appendChild(app);
    }
    S.booted = true;
    app.setAttribute('data-booted', '1');

    dom.app = app;
    dom.board = byId('board');
    dom.hud = byId('hud');
    dom.moves = byId('hud-moves');
    dom.time = byId('hud-time');
    dom.score = byId('hud-score');
    dom.mute = byId('btn-mute');
    dom.start = byId('screen-start');
    dom.win = byId('screen-win');
    dom.btnStart = byId('btn-start');
    dom.btnRestart = byId('btn-restart');
    dom.overlay = byId('overlay-layer');
    dom.fx = byId('fx-layer');
    dom.warning = byId('engine-warning');
    dom.best = byId('best-line');
    dom.winStars = byId('win-stars');
    dom.winTime = byId('win-time');
    dom.winMoves = byId('win-moves');
    dom.winCombo = byId('win-combo');
    dom.winScore = byId('win-score');
    dom.winBest = byId('win-best');
    dom.winBadge = byId('win-badge');

    bindArt(byId('bg-art'));
    bindArt(byId('win-bg-art'));

    if (!dom.board) {
      /* 没有 #board 也不能白屏：补一个 */
      dom.board = doc.createElement('div');
      dom.board.id = 'board';
      dom.board.className = 'board';
      var stage = doc.createElement('main');
      stage.className = 'stage';
      stage.appendChild(dom.board);
      app.appendChild(stage);
    }

    loadMuted();
    ensureCards();
    bindBoard();
    bindButtons();
    bindFirstGesture();
    updateBestLine();

    /* 引擎：有就立刻建；没有就显示提示、禁开局，等它出现 */
    if (requireEngine()) {
      try { S.engine.reset(); } catch (e) { /* 忽略 */ }
      syncBoardFromEngine();
    } else {
      syncBoardFromEngine();   // 用兜底牌序先画出 24 张牌背
    }

    updateHud(true);
    setTime(0);

    console.info('[PDT.UI] boot 完成：' + (S.engine ? '引擎已就绪' : '等待引擎') +
      '，牌数 ' + refreshCards().length);
  }

  /* -------------------------------------------------------------- 导出 */

  PDT.UI = {
    boot: boot,
    restart: restartGame,
    version: '1.0.0',
    /* 调试/QA 用（只读） */
    inspect: function () {
      return {
        booted: S.booted,
        started: S.started,
        finished: S.finished,
        busy: S.busy,
        cards: refreshCards().length,
        engine: !!S.engine,
        stats: readStats()
      };
    }
  };

})(typeof window !== 'undefined' ? window : this);
