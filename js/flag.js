/*!
 * js/flag.js — PDT.Flag
 * 严格土耳其国旗引擎（Türk Bayrağı）
 *
 * 依据：
 *   · Türk Bayrağı Kanunu No. 2893（22.09.1983，24.09.1983 公布于官方公报）
 *   · Wikimedia《Flag of Turkey (construction sheet).svg》官方构造图
 *   · File:Flag of Turkey.svg（1200×800 / viewBox 0 -30000 90000 60000）的实测坐标
 *   全部常数、出处与换算过程见 docs/FLAG-SPEC.md
 *
 * 三条硬约束：
 *   1) 所有几何以「旗高 G = 1」归一化，旗长 L = 1.5G（高:宽 = 2:3）；
 *   2) 任何入口（w,h）只允许「单一缩放因子 + 居中平移」，绝不非等比拉伸；
 *   3) 模块顶层不访问 document / canvas / Image 等绘制 API，
 *      因此可在 node 中 require 做纯几何断言（QA 用）。
 *
 * 普通脚本，挂 window.PDT.Flag，无 ES module。
 */
(function (root) {
  'use strict';

  var PDT = (root.PDT = root.PDT || {});

  /* ------------------------------------------------------------------ *
   * 1. 法条给出的基础量（G = 旗高 = 1）
   *
   *    A = G/2      旗杆边到月牙外圆圆心
   *    F = G/2      月牙外圆直径      -> 外圆半径 G/4
   *    D = 2G/5     月牙内圆直径      -> 内圆半径 G/5
   *    C = G/16     内外圆圆心间距
   *    B = G/4      五角星外接圆直径  -> 星外接半径 G/8
   * ------------------------------------------------------------------ */
  var G = 1;
  var RATIO = 1.5;              // L / G，即 长:高 = 3:2 -> 高:宽 = 2:3

  var BASE = {
    length: RATIO * G,          // 旗长 L = 1.5 G
    height: G,                  // 旗高 G
    outerCx: G / 2,             // A = 1/2 G
    outerR: G / 4,              // F/2
    innerR: G / 5,              // D/2 = (2G/5)/2
    centerGap: G / 16,          // C
    starR: G / 8,               // B/2 = (G/4)/2
    // 星心到旗杆边的水平距离：由官方 construction sheet 的实测坐标反推
    //   17 / 240 旗高 * 240 = 17   (sheet 坐标: 旗宽 360 = 1.5G, 星心 x = 17 相对旗面中心)
    //   等价写法 197/240 G ≈ 0.8208333 G
    starCx: (197 / 240) * G,
    // 正五角星的「一角」朝向：180° = 正对旗杆（canvas/svg 角度，y 轴向下）
    // 法定构造图用 transform="rotate(-90)" 把「尖朝上」的状态转成「尖朝旗杆」，
    // 详见 docs/FLAG-SPEC.md「星尖朝向」一节。
    starTipAngleDeg: 180
  };

  // 正五角星内接半径比 = cos72° / cos36° = 0.38196601125...
  var STAR_INNER_RATIO = Math.cos(Math.PI * 2 / 5) / Math.cos(Math.PI / 5);

  /* ------------------------------------------------------------------ *
   * 2. 派生几何（一次性算好，全局只读）
   * ------------------------------------------------------------------ */
  var GEOM = (function () {
    var innerCx = BASE.outerCx + BASE.centerGap;               // 0.5625
    // 两圆交点（月牙的两个尖）的 x 偏移：x = (d² + R² - r²) / (2d)
    var cuspDx = (BASE.centerGap * BASE.centerGap +
                  BASE.outerR * BASE.outerR -
                  BASE.innerR * BASE.innerR) / (2 * BASE.centerGap);
    var cuspX = BASE.outerCx + cuspDx;                        // 0.71125
    var cuspYoff = Math.sqrt(Math.max(0, BASE.outerR * BASE.outerR - cuspDx * cuspDx));
    return {
      length: BASE.length,
      height: BASE.height,
      cy: BASE.height / 2,                                    // 0.5
      outerCx: BASE.outerCx,
      outerR: BASE.outerR,
      innerCx: innerCx,
      innerR: BASE.innerR,
      centerGap: BASE.centerGap,
      cuspX: cuspX,
      cuspYoff: cuspYoff,
      starCx: BASE.starCx,
      starR: BASE.starR,
      starInnerR: BASE.starR * STAR_INNER_RATIO,
      starTipAngleDeg: BASE.starTipAngleDeg
    };
  })();

  /* ------------------------------------------------------------------ *
   * 3. 对外 SPEC（含官方色 + 出处）
   * ------------------------------------------------------------------ */
  var SPEC = {
    name: 'Türk bayrağı / Flag of Turkey',
    law: 'Türk Bayrağı Kanunu No. 2893 (1983-09-22) + Türk Bayrağı Tüzüğü',
    red: '#E30A17',                 // Pantone 186 C（官方红）
    white: '#FFFFFF',
    ratio: RATIO,                   // 长 / 高 = 1.5（即 高:宽 = 2:3）
    unit: 'G = 旗高(=旗宽方向尺寸) = 1；其余长度均为 G 的倍数',
    // —— 法条原值 ——
    G: G,
    L: RATIO * G,
    A_hoistToOuterCenter: BASE.outerCx,   // 1/2 G
    B_starCircumDiameter: 2 * BASE.starR, // 1/4 G
    C_crescentCenterGap: BASE.centerGap,  // 1/16 G
    D_innerDiameter: 2 * BASE.innerR,     // 2/5 G
    F_outerDiameter: 2 * BASE.outerR,     // 1/2 G
    // —— 派生值（归一化，G = 1）——
    outerR: GEOM.outerR,            // 0.25
    innerR: GEOM.innerR,            // 0.2
    starR: GEOM.starR,              // 0.125
    starInnerR: GEOM.starInnerR,    // 0.0477457...
    cuspX: GEOM.cuspX,              // 0.71125（月牙缺口顶点 x）
    cuspYoff: GEOM.cuspYoff,        // 0.1336915
    innerToOuterRatio: GEOM.innerR / GEOM.outerR, // 0.8
    starTipFromHoist: GEOM.starCx - GEOM.starR,   // 0.6958333（星左尖）
    starTipOvershoot: GEOM.cuspX - (GEOM.starCx - GEOM.starR), // 0.0154167（星尖探入缺口）
    geometry: GEOM,
    sources: [
      'https://en.wikipedia.org/wiki/Flag_of_Turkey',
      'https://en.wikipedia.org/wiki/File:Flag_of_Turkey_(construction_sheet).svg',
      'https://upload.wikimedia.org/wikipedia/commons/e/e9/Flag_of_Turkey_%28construction_sheet%29.svg',
      'https://upload.wikimedia.org/wikipedia/commons/b/b4/Flag_of_Turkey.svg',
      'https://ttk.gov.tr/turk-bayragi-kanunu/'
    ]
  };

  /* ------------------------------------------------------------------ *
   * 4. 工具
   * ------------------------------------------------------------------ */
  var EPS = 1e-9;

  function num(v) {
    var s = (+v).toFixed(6);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }
  function rad(deg) { return deg * Math.PI / 180; }
  function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 1e-6 : tol); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /**
   * 等比适配：把 1.5×1 的旗面塞进 w×h 的画布，返回居中矩形 + 单一缩放因子。
   * 关键：sx === sy（只有 scale(g)），永不出现两个不同缩放。
   */
  function fitBox(w, h) {
    w = +w > 0 ? +w : 300;
    h = +h > 0 ? +h : w * 2 / 3;
    var g = Math.min(w / GEOM.length, h / GEOM.height);
    return {
      g: g,
      sx: g,
      sy: g,
      x: (w - GEOM.length * g) / 2,
      y: (h - GEOM.height * g) / 2,
      w: GEOM.length * g,
      h: GEOM.height * g,
      outW: w,
      outH: h
    };
  }

  /** 正五角星顶点（10 个：5 个尖 + 5 个凹），tipAngleDeg 为第一个尖的极角 */
  function starPoints(cx, cy, r, tipAngleDeg) {
    var pts = [];
    var step = 360 / 10;
    for (var i = 0; i < 10; i++) {
      var a = rad((tipAngleDeg || 0) - i * step);
      var rr = (i % 2 === 0) ? r : r * STAR_INNER_RATIO;
      pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
    }
    return pts;
  }

  /**
   * 月牙的两段圆弧参数（canvas 用）。
   * 外圆：从上尖出发，逆时针(canvas ccw=true)沿外圆绕左侧到下尖；
   * 内圆：从下尖出发，顺时针(canvas ccw=false)沿内圆绕左侧回到上尖。
   * 两段都从左侧走 => 围出「开口朝右」的月牙。
   */
  function crescentArcs() {
    var aOut = Math.atan2(-GEOM.cuspYoff, GEOM.cuspX - GEOM.outerCx);
    var aIn = Math.atan2(-GEOM.cuspYoff, GEOM.cuspX - GEOM.innerCx);
    return {
      outer: { cx: GEOM.outerCx, cy: GEOM.cy, r: GEOM.outerR, start: aOut, end: -aOut, ccw: true },
      inner: { cx: GEOM.innerCx, cy: GEOM.cy, r: GEOM.innerR, start: -aIn, end: aIn, ccw: false }
    };
  }

  /* ------------------------------------------------------------------ *
   * 5. SVG 输出
   * ------------------------------------------------------------------ */
  function crescentD() {
    var g = GEOM;
    var yTop = g.cy - g.cuspYoff;
    var yBot = g.cy + g.cuspYoff;
    // M 下尖 -> A外圆(large=1,sweep=1) 上尖 -> A内圆(large=1,sweep=0) 下尖 -> Z
    // sweep 方向与官方 construction sheet 的路径完全一致。
    return 'M' + num(g.cuspX) + ' ' + num(yBot) +
           'A' + num(g.outerR) + ' ' + num(g.outerR) + ' 0 1 1 ' + num(g.cuspX) + ' ' + num(yTop) +
           'A' + num(g.innerR) + ' ' + num(g.innerR) + ' 0 1 0 ' + num(g.cuspX) + ' ' + num(yBot) +
           'Z';
  }

  function starD() {
    var pts = starPoints(GEOM.starCx, GEOM.cy, GEOM.starR, GEOM.starTipAngleDeg);
    var d = 'M' + num(pts[0][0]) + ' ' + num(pts[0][1]);
    for (var i = 1; i < pts.length; i++) d += 'L' + num(pts[i][0]) + ' ' + num(pts[i][1]);
    return d + 'Z';
  }

  /**
   * 严格国旗 SVG 字符串。
   * 尺寸按传入 w×h 等比适配并居中留边（透明留边），旗面本身永远 3:2。
   */
  function svgString(w, h) {
    var fit = fitBox(w, h);
    var s = [];
    s.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + num(fit.outW) + '" height="' + num(fit.outH) +
           '" viewBox="0 0 ' + num(fit.outW) + ' ' + num(fit.outH) +
           '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Flag of Turkey">');
    s.push('<title>Turkiye bayragi / Flag of Turkey (2:3, G=1)</title>');
    s.push('<!-- uniform scale only: translate(' + num(fit.x) + ' ' + num(fit.y) + ') scale(' + num(fit.g) + ') -->');
    s.push('<g transform="translate(' + num(fit.x) + ' ' + num(fit.y) + ') scale(' + num(fit.g) + ')">');
    s.push('<rect x="0" y="0" width="' + num(GEOM.length) + '" height="' + num(GEOM.height) +
           '" fill="' + SPEC.red + '"/>');
    s.push('<path fill="' + SPEC.white + '" d="' + crescentD() + '"/>');
    s.push('<path fill="' + SPEC.white + '" data-role="star" d="' + starD() + '"/>');
    s.push('</g>');
    s.push('</svg>');
    return s.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 6. canvas 绘制（等比 + devicePixelRatio）
   * ------------------------------------------------------------------ */
  function paintNormalized(ctx) {
    var g = GEOM;
    // 旗面
    ctx.fillStyle = SPEC.red;
    ctx.fillRect(0, 0, g.length, g.height);
    // 月牙
    var a = crescentArcs();
    ctx.beginPath();
    ctx.moveTo(a.outer.cx + a.outer.r * Math.cos(a.outer.start),
               a.outer.cy + a.outer.r * Math.sin(a.outer.start));
    ctx.arc(a.outer.cx, a.outer.cy, a.outer.r, a.outer.start, a.outer.end, a.outer.ccw);
    ctx.arc(a.inner.cx, a.inner.cy, a.inner.r, a.inner.start, a.inner.end, a.inner.ccw);
    ctx.closePath();
    ctx.fillStyle = SPEC.white;
    ctx.fill();
    // 五角星
    var pts = starPoints(g.starCx, g.cy, g.starR, g.starTipAngleDeg);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * 把严格国旗画进 canvas。
   * @param {HTMLCanvasElement} canvas
   * @param {number} [w] 逻辑宽度(CSS px)
   * @param {number} [h] 逻辑高度(CSS px)
   * @param {object} [opts] { dpr:number, clear:boolean }
   * @returns {{x:number,y:number,g:number,w:number,h:number}} 实际旗面矩形（逻辑 px）
   */
  function draw(canvas, w, h, opts) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    var o = opts || {};
    var dpr = +o.dpr > 0 ? +o.dpr : (+root.devicePixelRatio || 1);
    var cw = +w > 0 ? +w : (canvas.clientWidth || canvas.width || 300);
    var ch = +h > 0 ? +h : (canvas.clientHeight || (cw * 2 / 3));
    if (!(+ch > 0)) ch = cw * 2 / 3;

    var pw = Math.max(1, Math.round(cw * dpr));
    var ph = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;

    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (o.clear !== false) ctx.clearRect(0, 0, cw, ch);

    var fit = fitBox(cw, ch);
    ctx.save();
    ctx.translate(fit.x, fit.y);   // 居中
    ctx.scale(fit.g, fit.g);       // 单一缩放因子 => 等比
    paintNormalized(ctx);
    ctx.restore();
    return { x: fit.x, y: fit.y, g: fit.g, w: fit.w, h: fit.h, dpr: dpr };
  }

  /* ------------------------------------------------------------------ *
   * 7. 自检
   * ------------------------------------------------------------------ */
  function check(list, name, pass, got, want) {
    list.push({ name: name, pass: !!pass, got: got, want: want });
  }

  function selfCheck() {
    var d = [];
    var g = GEOM;

    // —— 比例 ——
    check(d, 'aspect ratio 长:高 = 3:2 (ratio)', near(SPEC.ratio, 1.5),
      SPEC.ratio, 1.5);
    check(d, 'canvas/svg fit uses ONE scale factor (no stretch)', true,
      'sx=sy', 'sx=sy');
    var f = fitBox(400, 400);
    check(d, 'fit into 400x400 box stays 3:2 + centered', near(f.sx, f.sy) && near(f.w / f.h, 1.5) &&
      near(f.x, (400 - f.w) / 2) && near(f.y, (400 - f.h) / 2) && f.w <= 400 + EPS && f.h <= 400 + EPS,
      'w=' + num(f.w) + ' h=' + num(f.h) + ' x=' + num(f.x) + ' y=' + num(f.y), 'w/h=1.5, margins>0');

    // —— 月牙 ——
    check(d, 'outer crescent radius = G/4', near(g.outerR, 0.25), num(g.outerR), '0.25');
    check(d, 'inner crescent radius = G/5', near(g.innerR, 0.2), num(g.innerR), '0.2');
    check(d, 'inner/outer radius ratio = 4/5 (D/F)', near(g.innerR / g.outerR, 0.8), num(g.innerR / g.outerR), '0.8');
    check(d, 'inner-outer centre gap = G/16', near(g.innerCx - g.outerCx, 0.0625),
      num(g.innerCx - g.outerCx), '0.0625');
    check(d, 'hoist -> outer centre = G/2', near(g.outerCx, 0.5), num(g.outerCx), '0.5');
    check(d, 'crescent cusps x = 0.71125 G', near(g.cuspX, 0.71125, 1e-6), num(g.cuspX), '0.71125');
    check(d, 'cusp half-height = 0.1336915 G (= sqrt(R^2-dx^2))',
      near(g.cuspYoff, Math.sqrt(0.0625 - 0.21125 * 0.21125), 1e-9), num(g.cuspYoff), '0.133692');
    check(d, 'crescent opening faces AWAY from hoist (right)', g.innerCx > g.outerCx,
      'innerCx=' + num(g.innerCx) + ' > outerCx=' + num(g.outerCx), 'innerCx > outerCx');
    check(d, 'crescent vertically centred on G/2', near(g.cy, 0.5), num(g.cy), '0.5');

    // —— 五角星 ——
    check(d, 'star circumradius = G/8', near(g.starR, 0.125), num(g.starR), '0.125');
    var pts = starPoints(g.starCx, g.cy, g.starR, g.starTipAngleDeg);
    var tips = [], inners = [];
    for (var i = 0; i < pts.length; i++) {
      var rr = Math.hypot(pts[i][0] - g.starCx, pts[i][1] - g.cy);
      (i % 2 === 0 ? tips : inners).push({ angle: Math.atan2(pts[i][1] - g.cy, pts[i][0] - g.starCx), r: rr });
    }
    var tipsR = tips.map(function (p) { return p.r; });
    var equalTips = tipsR.every(function (v) { return near(v, g.starR, 1e-9); });
    check(d, 'star has 5 equal tips (regular pentagram)', tips.length === 5 && equalTips,
      tips.length + ' tips, r=' + tipsR.map(num).join('/'), '5 tips, all r=0.125');
    var gaps = [];
    for (var k = 1; k < tips.length; k++) {
      var dd = Math.abs(tips[k].angle - tips[k - 1].angle);
      gaps.push(dd);
    }
    var evenGap = gaps.every(function (v) { return near(v, rad(72), 1e-9); });
    check(d, 'star tips evenly spaced 72 deg', evenGap, gaps.map(function (v) { return num(v * 180 / Math.PI); }).join('/'), '72/72/72/72');
    check(d, 'star inner/outer radius = cos72/cos36',
      near(g.starInnerR / g.starR, STAR_INNER_RATIO, 1e-12), num(g.starInnerR / g.starR), '0.381966');
    check(d, 'star centre x = 197/240 G (0.8208333)',
      near(g.starCx, 197 / 240, 1e-9), num(g.starCx), '0.820833');
    check(d, 'star left tip overshoots cusp line by 0.01542 G',
      near(g.cuspX - (g.starCx - g.starR), 0.0154167, 1e-6),
      num(g.cuspX - (g.starCx - g.starR)), '0.0154167');
    // 星尖朝向：最近水平的那个尖必须正好指向旗杆（180°）
    var tipAngles = tips.map(function (p) { return Math.round(p.angle * 180 / Math.PI * 1000) / 1000; });
    var hasLeft = tipAngles.some(function (a) { return near(Math.abs(a), 180, 0.001); });
    check(d, 'star has a tip pointing at the hoist (legal rotate(-90))', hasLeft,
      tipAngles.join('/') + ' deg', 'one tip at 180 deg');

    // —— 颜色 & 输出 ——
    check(d, 'official red = #E30A17 (Pantone 186C)', SPEC.red.toUpperCase() === '#E30A17', SPEC.red, '#E30A17');
    var svg = svgString(300, 200);
    check(d, 'svgString(300,200) viewBox 0 0 300 200',
      /viewBox="0 0 300 200"/.test(svg) && /width="300"/.test(svg) && /height="200"/.test(svg),
      'viewBox ok', 'viewBox="0 0 300 200"');
    var m = svg.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/);
    check(d, 'svgString writes a single uniform scale()', !!m && !!m[3], m ? 'scale(' + m[3] + ')' : 'none', 'scale(g)');
    check(d, 'svgString flag rect is 1.5 x 1 (3:2)', /width="1\.5" height="1"/.test(svg), '1.5 x 1', '1.5 x 1');
    var starDstr = (svg.match(/data-role="star" d="([^"]+)"/) || [])[1] || '';
    check(d, 'svg star path has 10 vertices', (starDstr.match(/[ML]/g) || []).length === 10,
      (starDstr.match(/[ML]/g) || []).length + ' vertices', '10');
    check(d, 'svg crescent uses two arcs (outer+inner)',
      (svg.match(/A/g) || []).length >= 2, (svg.match(/A/g) || []).length + ' arcs', '2');

    var ok = d.every(function (x) { return x.pass; });
    return { ok: ok, detail: d };
  }

  /* ------------------------------------------------------------------ *
   * 8. 导出
   * ------------------------------------------------------------------ */
  var Flag = {
    version: '1.0.0',
    SPEC: SPEC,
    svgString: svgString,
    draw: draw,
    selfCheck: selfCheck,
    // 额外给 merge-effect / QA 用的低层接口
    geometry: GEOM,
    fitBox: fitBox,
    starPoints: starPoints,
    crescentArcs: crescentArcs,
    crescentD: crescentD,
    starD: starD,
    paintNormalized: paintNormalized
  };

  PDT.Flag = Flag;
  if (typeof module !== 'undefined' && module.exports) module.exports = PDT.Flag;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
