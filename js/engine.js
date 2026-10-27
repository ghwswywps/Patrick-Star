/*!
 * 派大星的衣柜 · 游戏逻辑引擎  (PDT.Engine)
 * 契约：docs/CONTRACT.md §5.2 —— 本文件的公开 API 严格按契约实现，不改签名。
 *
 * 纯普通脚本（非 ES module），可 file:// 直接加载，也可在 node 里 require()。
 * 模块顶层**不访问** document / window 的 DOM 能力，只做命名空间挂载。
 *
 * 牌表：24 张 = 6 种 type（flag / parachute / trunks / kebab / balloon / grin）各 4 张 = 12 对。
 * 特殊规则：flag + parachute 跨类「合并」（status:'merge'，基础分 300），其余同 type 才消除。
 */
(function () {
  'use strict';

  /* global window, globalThis, module */
  var g = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  var PDT = (g.PDT = g.PDT || {});

  /* ------------------------------------------------------------------ *
   * 常量（契约 §3 类型表，路径写死，UI 直接用 card.art）
   * ------------------------------------------------------------------ */

  /** 6 种牌型，顺序与契约 §3 表格一致 */
  var TYPES = ['flag', 'parachute', 'trunks', 'kebab', 'balloon', 'grin'];

  /** 每种牌的张数（24 = 6 × 4） */
  var COPIES_PER_TYPE = 4;

  /** type -> 卡面图片相对路径；flag 为 null（由 UI 用 PDT.Flag 矢量绘制，契约 §3） */
  var ART = {
    flag: null,
    parachute: 'assets/img/cards/parachute.png',
    trunks: 'assets/img/cards/trunks.png',
    kebab: 'assets/img/cards/kebab.png',
    balloon: 'assets/img/cards/balloon.png',
    grin: 'assets/img/cards/grin.png'
  };

  /** 星级阈值（基于步数，见 stars() 注释） */
  var STAR_THRESHOLDS = { three: 12, two: 17 };

  /** 计分基础分 */
  var SCORE_MATCH = 100; // 同 type 配对：100 × (1 + combo × 0.25)
  var SCORE_MERGE = 300; // flag + parachute 合并：300 × (1 + combo × 0.25)
  var COMBO_STEP = 0.25; // 每层连击 +25%

  /** 合法 state 值 */
  var STATE_DOWN = 'down';
  var STATE_UP = 'up';
  var STATE_MATCHED = 'matched';
  var STATE_MERGED = 'merged';

  var CLEARED = { matched: true, merged: true };

  /* ------------------------------------------------------------------ *
   * 小工具（全部无副作用、不抛异常）
   * ------------------------------------------------------------------ */

  function artFor(type) {
    if (Object.prototype.hasOwnProperty.call(ART, type)) return ART[type];
    if (typeof type === 'string' && type) return 'assets/img/cards/' + type + '.png';
    return null;
  }

  /** 取整：契约说「取整」，用 Math.round（本游戏所有取值都是 25 的整数倍，floor/round 等价） */
  function intScore(n) {
    return Math.round(n);
  }

  /** 把入参安全地转成整数下标；非法返回 null（绝不抛异常） */
  function toIndex(raw) {
    if (typeof raw === 'number') {
      if (!isFinite(raw)) return null;
      if (Math.floor(raw) !== raw) return null;
      return raw;
    }
    // UI 侧 dataset 拿到的是字符串，宽松接受纯数字串
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return parseInt(raw, 10);
    return null;
  }

  /** 归一化一份牌堆描述：字符串 type，或 {type:'...'} 对象 */
  function normalizeSpec(entry) {
    if (typeof entry === 'string' && entry) return entry;
    if (entry && typeof entry === 'object' && typeof entry.type === 'string' && entry.type) return entry.type;
    // 非法条目降级成一个不可能成对的占位 type，而不是抛异常
    return 'unknown';
  }

  /**
   * Fisher-Yates 洗牌（原地）。
   * rng 必须返回 [0,1)；越界/非数值一律兜回 Math.random，保证不会死循环也不会偏斜。
   */
  function shuffleInPlace(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var r = rng();
      if (typeof r !== 'number' || !isFinite(r)) r = Math.random();
      if (r < 0) r = 0;
      if (r >= 1) r = 0.9999999999;
      var j = Math.floor(r * (i + 1));
      if (j < 0) j = 0;
      if (j > i) j = i;
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /* ------------------------------------------------------------------ *
   * 构造函数
   * ------------------------------------------------------------------ */

  /**
   * new PDT.Engine(opts?) —— 默认 24 张、每种 4 张、随机洗牌。
   *
   * opts（全部可选，只为测试方便，业务代码不传即可）：
   *   deck:    Array< string | {type:string} >  自定义牌堆（按给定顺序，默认不洗牌）
   *   rng:     () => number                     洗牌随机源，默认 Math.random
   *   now:     () => number                     时钟，默认 Date.now
   *   shuffle: boolean                          强制开/关洗牌
   */
  function Engine(opts) {
    opts = opts && typeof opts === 'object' ? opts : {};

    this._rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
    this._now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };

    var custom = Array.isArray(opts.deck) && opts.deck.length > 0;
    if (custom) {
      this._spec = opts.deck.map(normalizeSpec);
      // 传了自定义牌堆 → 默认保持顺序（便于断言）；opts.shuffle === true 时才洗
      this._shuffle = opts.shuffle === true;
    } else {
      this._spec = [];
      for (var t = 0; t < TYPES.length; t++) {
        for (var c = 0; c < COPIES_PER_TYPE; c++) this._spec.push(TYPES[t]);
      }
      this._shuffle = opts.shuffle !== false;
    }

    this.reset();
  }

  /* ------------------------------------------------------------------ *
   * 生命周期 / 查询
   * ------------------------------------------------------------------ */

  /** 重新洗牌 + 清空计时、分数、步数、连击、合并次数。返回 this（可链式）。 */
  Engine.prototype.reset = function () {
    var spec = this._spec || [];
    var cards = [];
    for (var i = 0; i < spec.length; i++) {
      cards.push({ index: i, type: spec[i], art: artFor(spec[i]), state: STATE_DOWN });
    }
    if (this._shuffle) shuffleInPlace(cards, this._rng);

    // 洗牌后重排 index：**index 恒等于数组位置**，
    // 这样 getCards()[i].index === i，UI 的 data-index 与网格顺序、flip(i) 三者永远一致。
    for (var n = 0; n < cards.length; n++) cards[n].index = n;

    this._cards = cards;
    this._pending = [];        // 当前等待判定的下标（0 / 1 / 2 张）
    this._moves = 0;           // 步数 = 凑成两张并判定过的次数
    this._score = 0;
    this._combo = 0;           // 当前连击层数
    this._bestCombo = 0;
    this._mergeCount = 0;      // flag+parachute 合并次数（最多 2）
    this._clearedPairs = 0;    // 已清除的对数（同 type 对 + 合并），0..totalPairs
    this._t = { start: null, end: 0, pausedAt: null, pausedTotal: 0 };
    return this;
  };

  /** 返回牌面**副本**数组 [{index, type, art, state}]，外部随便改不影响引擎。 */
  Engine.prototype.getCards = function () {
    var out = new Array(this._cards.length);
    for (var i = 0; i < this._cards.length; i++) {
      var c = this._cards[i];
      out[i] = { index: c.index, type: c.type, art: c.art, state: c.state };
    }
    return out;
  };

  /** 单张牌当前状态的浅查询（防御式：越界返回 null） */
  Engine.prototype.cardAt = function (index) {
    var i = toIndex(index);
    if (i === null || i < 0 || i >= this._cards.length) return null;
    var c = this._cards[i];
    return { index: c.index, type: c.type, art: c.art, state: c.state };
  };

  /* ------------------------------------------------------------------ *
   * 核心：翻牌状态机
   * ------------------------------------------------------------------ */

  /**
   * flip(index) -> {status, indices, type, points, combo, ...}
   *
   * status（严格 5 种，与契约 §5.2 一致）：
   *   'ignore'   非法下标 / 已翻开 / 已消除 / 上一次 mismatch 尚未 resolve（此时额外带 locked:true）
   *   'flipped'  翻开了本次的第一张
   *   'match'    两张同 type —— 引擎已自动标记为 matched，并加分
   *   'merge'    flag + parachute 跨类合并 —— 引擎已自动标记为 merged，并加分
   *   'mismatch' 两张不同且非合并组合 —— 两张保持 'up'，等 UI 播完动画调 unflipPending()
   *
   * 计分：points = BASE × (1 + comboBefore × 0.25) 取整，
   *       comboBefore 是「这次配对之前」已连续成功的次数，成功后再 combo++。
   */
  Engine.prototype.flip = function (index) {
    var i = toIndex(index);
    if (i === null || i < 0 || i >= this._cards.length) {
      return this._makeResult('ignore', [], null, 0, null, 'bad-index');
    }
    // mismatch 未 resolve：锁住，不破坏任何状态。
    // 契约 §5.2 的 status 只有 5 种，所以这里状态上并回 'ignore'，
    // 另外用 locked:true 标记原因（UI 若想区分可读 r.locked / e.isLocked()）。
    if (this._pending.length >= 2) {
      var lr = this._makeResult('ignore', this._pending.slice(), null, 0, null, 'pending-unresolved');
      lr.locked = true;
      return lr;
    }

    var card = this._cards[i];
    if (!card || card.state !== STATE_DOWN) {
      return this._makeResult('ignore', [i], card ? card.type : null, 0, null, 'not-down');
    }

    // 计时从「第一次成功翻开第一张牌」开始（ignore / locked 都不启动计时）
    if (this._t.start === null) this._t.start = this._now();

    card.state = STATE_UP;
    this._pending.push(i);

    if (this._pending.length === 1) {
      return this._makeResult('flipped', [i], card.type, 0, null, 'first');
    }

    return this._resolvePair();
  };

  /** 内部：判定手上这两张牌 */
  Engine.prototype._resolvePair = function () {
    var ia = this._pending[0];
    var ib = this._pending[1];
    var a = this._cards[ia];
    var b = this._cards[ib];
    var pair = [ia, ib];
    var comboBefore = this._combo;              // 本次配对**之前**的连击层数
    var multiplier = 1 + comboBefore * COMBO_STEP; // 用于计分的倍率

    this._moves++; // 凑成两张 = 一步（无论对错，memory 游戏的标准步数口径）

    if (a.type === b.type) {
      // —— 普通配对 ——
      a.state = STATE_MATCHED;
      b.state = STATE_MATCHED;
      this._pending = [];
      var pts = intScore(SCORE_MATCH * multiplier);
      this._score += pts;
      this._combo++;
      if (this._combo > this._bestCombo) this._bestCombo = this._combo;
      this._clearedPairs++;
      this._maybeFinish();
      var r = this._makeResult('match', pair, a.type, pts, multiplier, 'same-type');
      r.comboBefore = comboBefore;
      r.combo = this._combo;
      return r;
    }

    if (isMergePair(a.type, b.type)) {
      // —— 跨类特殊合并：flag + parachute ——
      a.state = STATE_MERGED;
      b.state = STATE_MERGED;
      this._pending = [];
      var ptsM = intScore(SCORE_MERGE * multiplier);
      this._score += ptsM;
      this._combo++;
      if (this._combo > this._bestCombo) this._bestCombo = this._combo;
      this._clearedPairs++;
      this._mergeCount++;
      this._maybeFinish();
      var rm = this._makeResult('merge', pair, 'flag+parachute', ptsM, multiplier, 'cross-merge');
      rm.comboBefore = comboBefore;
      rm.combo = this._combo;
      return rm;
    }

    // —— 配错：两张保持 'up'，连击清零，等 UI 调 unflipPending() ——
    this._combo = 0;
    var rx = this._makeResult('mismatch', pair, null, 0, multiplier, 'different-type');
    rx.comboBefore = comboBefore;
    rx.combo = 0;
    return rx;
  };

  /** 内部：刚好清空时冻结计时 */
  Engine.prototype._maybeFinish = function () {
    if (this.isWon() && !this._t.end) this._t.end = this._now();
  };

  /** 内部：构造返回值（统一带上快照字段，UI 想读什么都够） */
  Engine.prototype._makeResult = function (status, indices, type, points, multiplier, reason) {
    var stats = this.stats();
    return {
      status: status,
      indices: indices || [],
      type: type === undefined ? null : type,
      points: points || 0,
      combo: stats.combo,
      locked: false,
      comboBefore: typeof multiplier === 'number' ? Math.max(0, Math.round((multiplier - 1) / COMBO_STEP)) : stats.combo,
      multiplier: typeof multiplier === 'number' ? multiplier : 1,
      score: stats.score,
      moves: stats.moves,
      matchedPairs: stats.matchedPairs,
      totalPairs: stats.totalPairs,
      mergeCount: stats.mergeCount,
      elapsedMs: stats.elapsedMs,
      reason: reason || ''
    };
  };

  /**
   * mismatch 动画播完后由 UI 调用：把等待中的两张翻回 'down'。
   * 没有待处理的两张时安全空操作。返回 {status:'unflipped'|'none', indices:[...]}
   */
  Engine.prototype.unflipPending = function () {
    if (this._pending.length !== 2) {
      return { status: 'none', indices: [] };
    }
    var flipped = [];
    for (var k = 0; k < 2; k++) {
      var c = this._cards[this._pending[k]];
      if (c && c.state === STATE_UP) {
        c.state = STATE_DOWN;
        flipped.push(c.index);
      }
    }
    this._pending = [];
    return { status: flipped.length ? 'unflipped' : 'none', indices: flipped };
  };

  /** 是否正卡在 mismatch 待翻回的状态（UI 可据此禁点） */
  Engine.prototype.isLocked = function () {
    return this._pending.length >= 2;
  };

  /* ------------------------------------------------------------------ *
   * 统计 / 胜负
   * ------------------------------------------------------------------ */

  /**
   * stats() 实时快照：
   *   moves       步数（每凑成两张并判定一次 +1）
   *   matchedPairs 已清除对数（含合并），0..totalPairs
   *   totalPairs  总对数（默认 12）
   *   score       总分（只增不减，无扣分）
   *   combo       当前连击层数
   *   bestCombo   本局最高连击层数
   *   elapsedMs   从第一次翻牌起的实时毫秒（暂停时冻结）
   *   mergeCount  flag+parachute 合并次数
   */
  Engine.prototype.stats = function () {
    return {
      moves: this._moves,
      matchedPairs: this._clearedPairs,
      totalPairs: this.totalPairs(),
      score: this._score,
      combo: this._combo,
      bestCombo: this._bestCombo,
      elapsedMs: this.elapsedMs(),
      mergeCount: this._mergeCount
    };
  };

  /** 总对数（默认 12；自定义牌堆时 = 张数 / 2） */
  Engine.prototype.totalPairs = function () {
    return Math.floor(this._cards.length / 2);
  };

  /** 实时已用时（毫秒）。未开始 => 0；结束后冻结；暂停中冻结。 */
  Engine.prototype.elapsedMs = function () {
    var t = this._t;
    if (t.start === null) return 0;
    var endRef;
    if (t.end) endRef = t.end;
    else if (t.pausedAt !== null) endRef = t.pausedAt;
    else endRef = this._now();
    var ms = endRef - t.start - (t.pausedTotal || 0);
    return ms > 0 ? Math.round(ms) : 0;
  };

  /** 12 对（含最多 2 次合并）全部清空即通关 */
  Engine.prototype.isWon = function () {
    if (!this._cards || this._cards.length === 0) return false;
    for (var i = 0; i < this._cards.length; i++) {
      if (!CLEARED[this._cards[i].state]) return false;
    }
    return true;
  };

  /**
   * stars() 1~3 星，按步数（steps = moves，每次判定两张算一步，理论最少 12 步通关）：
   *   moves <= 12           => 3 星（一局不配错，理想局）
   *   13 <= moves <= 17     => 2 星（≤ 5 次失误）
   *   moves >= 18           => 1 星
   */
  Engine.prototype.stars = function () {
    if (this._moves <= STAR_THRESHOLDS.three) return 3;
    if (this._moves <= STAR_THRESHOLDS.two) return 2;
    return 1;
  };

  /* ------------------------------------------------------------------ *
   * 可选：暂停 / 恢复（UI 可以不用）
   * ------------------------------------------------------------------ */

  /** 暂停计时；返回当前是否处于暂停态 */
  Engine.prototype.pause = function () {
    var t = this._t;
    if (t.start === null || t.end || t.pausedAt !== null) return this.isPaused();
    t.pausedAt = this._now();
    return true;
  };

  /** 恢复计时；重复调用安全 */
  Engine.prototype.resume = function () {
    var t = this._t;
    if (t.pausedAt === null) return false;
    t.pausedTotal += Math.max(0, this._now() - t.pausedAt);
    t.pausedAt = null;
    return true;
  };

  Engine.prototype.isPaused = function () {
    return this._t.start !== null && !this._t.end && this._t.pausedAt !== null;
  };

  /** flag 与 parachute 的组合（顺序无关）是否构成特殊合并 */
  function isMergePair(a, b) {
    return (a === 'flag' && b === 'parachute') || (a === 'parachute' && b === 'flag');
  }

  /* ------------------------------------------------------------------ *
   * 挂载（静态常量也挂上，方便 UI / QA 复用，不影响契约签名）
   * ------------------------------------------------------------------ */

  Engine.TYPES = TYPES.slice();
  Engine.ART = {};
  for (var k = 0; k < TYPES.length; k++) Engine.ART[TYPES[k]] = ART[TYPES[k]];
  Engine.COPIES_PER_TYPE = COPIES_PER_TYPE;
  Engine.STAR_THRESHOLDS = { three: STAR_THRESHOLDS.three, two: STAR_THRESHOLDS.two };
  Engine.SCORE = { match: SCORE_MATCH, merge: SCORE_MERGE, comboStep: COMBO_STEP };
  Engine.isMergePair = isMergePair;

  PDT.Engine = Engine;

  // 契约 §5.2 / §7：node require 可直接拿到构造函数
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PDT.Engine;
  }
})();
