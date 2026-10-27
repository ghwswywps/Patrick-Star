/*!
 * js/merge-effect.js — PDT.Merge
 * 全屏「星月 × 派大星 · 完美重合」彩蛋特效
 *
 * 主体是重绘版梗图 assets/img/merge/easter-egg.png（960×1280）。
 * 严格国旗的白色月牙 / 五角星全部来自 PDT.Flag 的同一套法条几何，
 * 只做「等比缩放 + 旋转 + 平移」，绝不非等比变形。
 *
 * 四幕（默认 2700ms，可被 opts.duration 覆盖，幕边界按时长比例缩放）：
 *   幕1 0 → 0.222  梗图卡从下方带 overshoot 弹入居中（高约视口 72%），青蓝柔光包裹
 *   幕2 0.222 → 0.555  白月牙从左侧飞入 → 旋转对齐、扣进伞冠弧线内缘；
 *                      五角星随后飞入，落到月牙右侧（国旗里的相对位置/大小比例）；
 *                      落定瞬间：白闪 + 2px 震屏 + 金色光斑
 *   幕3 0.555 → 0.852  金粒子爆开（spark.png 加法混合）+ 红金暗角把画面染成旗色
 *                      + 底部文字「星月 × 派大星 · 完美重合」+ 飘出「+300」
 *   幕4 0.852 → 1      整体淡出 → 清 DOM、注销 resize、resolve
 *
 * 约定：只在 play() 内部访问 DOM；图片加载失败/超时一律回退到程序化粉色伞，Promise 不卡住。
 */
(function (root) {
  'use strict';

  var PDT = (root.PDT = root.PDT || {});

  var DEFAULTS = {
    duration: 2700,                 // 总时长 ms（约 2.6~2.7s）
    caption: '星月 × 派大星 · 完美重合',
    bonus: '+300',
    showCaption: true,
    eggUrl: 'assets/img/merge/easter-egg.png',
    eggUrlAlt: 'assets/img/merge/easter-egg.webp',
    sparkUrl: 'assets/img/merge/spark.png',
    imageTimeout: 700,              // 图片预载上限，超时就用程序化兜底
    seed: 0
  };

  /* 月牙外圆落点 —— 由 PIL 实测 easter-egg.png 的伞冠带拟合而来：
   *   伞冠带外缘圆心 (485,388) r=375；内缘圆心 (465,577) r=384
   *   月牙外圆定在 (387,350) r=200：上弧落进伞冠带内侧、下弧不压到派大星
   * 全部写成「图片宽高的比例」，任何尺寸下自动等比跟随。                 */
  var EGG_GEO = {
    cx: 387 / 960,      // 0.403125  相对图片宽
    cy: 350 / 1280,     // 0.273438  相对图片高
    r: 200 / 960,       // 0.208333  相对图片宽（= 月牙外圆半径）
    // 伞冠带内缘的真实圆弧（实测拟合），落位后光沿它铺开 —— 这就是「月牙 = 伞冠的弧」
    arc: {
      cx: 465 / 960,    // 0.484375
      cy: 577 / 1280,   // 0.450781
      r: 384 / 960,     // 0.4
      a0: -146.4,       // 左端
      a1: -27.2         // 右端
    }
  };

  // 幕边界（相对总时长的比例；基准 600 / 1500 / 2300 / 2700 ms）
  var ACT = {
    cardEnd: 600 / 2700,        // 0.2222 卡片弹入完成
    appear: 0.060,
    crescentIn: 0.238,          // 月牙起飞
    crescentLand: 0.455,        // 月牙落定
    starIn: 0.380,              // 星起飞
    starLand: 1500 / 2700,      // 0.5556 星落定 = 撞击帧
    burst: 2300 / 2700,         // 0.8519
    fadeStart: 2300 / 2700
  };

  var active = null;

  /* ---------------- 纯函数小工具 ---------------- */
  function rad(d) { return d * Math.PI / 180; }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function seg(p, a, b) { return b <= a ? (p >= b ? 1 : 0) : clamp01((p - a) / (b - a)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function easeOutQuint(t) { return 1 - Math.pow(1 - t, 5); }
  function easeOutBack(t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  function nowMs() {
    return (root.performance && typeof root.performance.now === 'function')
      ? root.performance.now() : Date.now();
  }

  /** 与 js/flag.js 完全同源的几何；flag.js 缺失时用它兜底 */
  function getGeom() {
    if (PDT.Flag && PDT.Flag.geometry) return PDT.Flag.geometry;
    var innerR = 0.2, outerR = 0.25, gap = 0.0625;
    var cuspDx = (gap * gap + outerR * outerR - innerR * innerR) / (2 * gap);
    var STAR_INNER = Math.cos(Math.PI * 2 / 5) / Math.cos(Math.PI / 5);
    return {
      length: 1.5, height: 1, cy: 0.5,
      outerCx: 0.5, outerR: outerR,
      innerCx: 0.5 + gap, innerR: innerR, centerGap: gap,
      cuspX: 0.5 + cuspDx, cuspYoff: Math.sqrt(outerR * outerR - cuspDx * cuspDx),
      starCx: 197 / 240, starR: 0.125, starInnerR: 0.125 * STAR_INNER,
      starTipAngleDeg: 180
    };
  }

  /* ---------------- 严格月牙 / 五角星 ---------------- */
  function crescentPath(ctx, g) {
    var aOut = Math.atan2(-g.cuspYoff, g.cuspX - g.outerCx);
    var aIn = Math.atan2(-g.cuspYoff, g.cuspX - g.innerCx);
    ctx.beginPath();
    ctx.moveTo(g.cuspX, g.cy - g.cuspYoff);
    ctx.arc(g.outerCx, g.cy, g.outerR, aOut, -aOut, true);
    ctx.arc(g.innerCx, g.cy, g.innerR, -aIn, aIn, false);
    ctx.closePath();
  }

  function starPath(ctx, g, tipAngleDeg) {
    var step = 36, a0 = tipAngleDeg;
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var a = rad(a0 - i * step);
      var r = (i % 2 === 0) ? g.starR : g.starInnerR;
      var px = g.starCx + r * Math.cos(a);
      var py = g.cy + r * Math.sin(a);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  /** 月牙：局部原点 = 月牙外圆圆心，只有 translate/rotate/单一 scale(k) */
  function drawCrescent(ctx, g, k, cx, cy, rot, alpha, glowPx) {
    if (alpha <= 0.003) return;
    ctx.save();
    ctx.translate(cx, cy);
    if (rot) ctx.rotate(rot);
    ctx.scale(k, k);
    ctx.translate(-g.outerCx, -g.cy);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#FFFFFF';
    if (glowPx > 0) { ctx.shadowColor = 'rgba(255,255,255,0.95)'; ctx.shadowBlur = glowPx; }
    crescentPath(ctx, g);
    ctx.fill();
    ctx.restore();
  }

  /** 五角星：局部原点 = 星心 */
  function drawStar(ctx, g, k, cx, cy, rot, alpha, glowPx) {
    if (alpha <= 0.003) return;
    ctx.save();
    ctx.translate(cx, cy);
    if (rot) ctx.rotate(rot);
    ctx.scale(k, k);
    ctx.translate(-g.starCx, -g.cy);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#FFFFFF';
    if (glowPx > 0) { ctx.shadowColor = 'rgba(255,255,255,0.95)'; ctx.shadowBlur = glowPx; }
    starPath(ctx, g, g.starTipAngleDeg);
    ctx.fill();
    ctx.restore();
  }

  /* ---------------- 圆角矩形 ---------------- */
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /* ---------------- 程序化兜底伞（图片缺失时） ----------------
   * 内缘正好压在月牙外圆上，所以即使兜底，「月牙 = 伞冠的弧」依旧成立。 */
  function drawFallbackParachute(ctx, st, lx, ly, R) {
    var inner = R, outer = R * 1.62;
    ctx.save();
    ctx.translate(lx, ly);
    var grad = ctx.createLinearGradient(0, -outer, 0, outer * 0.7);
    grad.addColorStop(0, '#FFD3E4');
    grad.addColorStop(0.5, '#FF86B7');
    grad.addColorStop(1, '#EC3A85');
    ctx.beginPath();
    ctx.arc(0, 0, outer, rad(155), rad(385), false);
    ctx.arc(0, 0, inner, rad(385), rad(155), true);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = Math.max(2, outer * 0.03);
    ctx.strokeStyle = '#4A2238';
    ctx.stroke();
    // 伞绳 + 挂点小派大星
    var ky = outer * 1.55;
    ctx.strokeStyle = 'rgba(74,34,56,0.7)';
    ctx.lineWidth = Math.max(1.4, outer * 0.022);
    for (var i = -1; i <= 1; i += 1) {
      ctx.beginPath();
      ctx.moveTo(i * inner * 0.86, inner * 0.42);
      ctx.quadraticCurveTo(i * inner * 0.30, outer * 1.1, 0, ky);
      ctx.stroke();
    }
    var pr = outer * 0.20;
    ctx.save();
    ctx.translate(0, ky + pr * 0.6);
    ctx.beginPath();
    for (var q = 0; q < 10; q++) {
      var ang = rad(-90 - q * 36);
      var rr = (q % 2 === 0) ? pr : pr * 0.56;
      var bx = Math.cos(ang) * rr, by = Math.sin(ang) * rr;
      if (q === 0) ctx.moveTo(bx, by); else ctx.lineTo(bx, by);
    }
    ctx.closePath();
    ctx.fillStyle = '#FFB3D1';
    ctx.fill();
    ctx.lineWidth = Math.max(1.8, pr * 0.14);
    ctx.strokeStyle = '#4A2238';
    ctx.stroke();
    ctx.fillStyle = '#2E1626';
    ctx.beginPath();
    ctx.arc(-pr * 0.26, -pr * 0.10, Math.max(1, pr * 0.09), 0, Math.PI * 2);
    ctx.arc(pr * 0.26, -pr * 0.10, Math.max(1, pr * 0.09), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.restore();
    void st;
  }

  /* ---------------- 梗图卡片 ---------------- */
  function drawEggCard(ctx, st, alpha) {
    var c = st.card;
    alpha = (alpha == null ? 1 : alpha) * (st.cardAlpha == null ? 1 : st.cardAlpha);
    if (alpha <= 0.003) return;
    ctx.save();
    // 青蓝柔光
    var gl = ctx.createRadialGradient(0, 0, c.w * 0.30, 0, 0, c.w * 0.92);
    gl.addColorStop(0, 'rgba(120,240,255,' + (0.40 * alpha) + ')');
    gl.addColorStop(0.55, 'rgba(70,190,230,' + (0.18 * alpha) + ')');
    gl.addColorStop(1, 'rgba(30,120,200,0)');
    ctx.fillStyle = gl;
    ctx.beginPath();
    ctx.arc(0, 0, c.w * 0.92, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = alpha;
    var r = c.w * 0.055;
    ctx.save();
    roundRect(ctx, -c.w / 2, -c.h / 2, c.w, c.h, r);
    ctx.clip();
    if (st.egg) {
      ctx.drawImage(st.egg, -c.w / 2, -c.h / 2, c.w, c.h);
    } else {
      var bg = ctx.createLinearGradient(0, -c.h / 2, 0, c.h / 2);
      bg.addColorStop(0, '#25C9D6');
      bg.addColorStop(1, '#1B5FB0');
      ctx.fillStyle = bg;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      // 兜底伞画在卡片局部坐标里（emblem 也在同一坐标系）
      drawFallbackParachute(ctx, st, st.emblem.cx - st.w / 2, st.emblem.cy - st.h / 2, st.emblem.r);
    }
    ctx.restore();

    roundRect(ctx, -c.w / 2, -c.h / 2, c.w, c.h, r);
    ctx.lineWidth = Math.max(2, c.w * 0.008);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------- 光斑 ---------------- */
  function drawSparks(ctx, st) {
    if (!st.sparks.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < st.sparks.length; i++) {
      var sp = st.sparks[i];
      if (sp.life <= 0) continue;
      var a = clamp01(sp.life / sp.max) * st.fade;
      if (a <= 0.004) continue;
      var size = sp.size * (0.35 + 0.65 * (sp.life / sp.max));
      ctx.globalAlpha = a;
      if (st.sprite) {
        ctx.drawImage(st.sprite, sp.x - size / 2, sp.y - size / 2, size, size);
      } else {
        var rg = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, size / 2);
        rg.addColorStop(0, 'rgba(255,236,170,1)');
        rg.addColorStop(0.35, 'rgba(255,190,62,0.8)');
        rg.addColorStop(1, 'rgba(255,140,20,0)');
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /* ---------------- 布局 ---------------- */
  function layout(st) {
    var w = st.w, h = st.h, p = st.p;
    // 卡片：高 = 视口 72%，3:4；宽/高超限再回退
    var ch = h * 0.72, cw = ch * 0.75;
    if (cw > w * 0.92) { cw = w * 0.92; ch = cw / 0.75; }
    if (ch > h * 0.88) { ch = h * 0.88; cw = ch * 0.75; }
    st.card = { w: cw, h: ch };

    var t1 = seg(p, 0, ACT.cardEnd);
    var e1 = easeOutBack(t1);
    st.cardScale = 0.58 + 0.42 * e1;
    st.cardDy = (1 - easeOutCubic(t1)) * h * 0.52;
    st.cardRot = lerp(-0.07, 0, easeOutCubic(t1));
    st.cardAlpha = clamp01(seg(p, 0, ACT.appear * 1.6));

    st.cardRectX = (w - cw) / 2;
    st.cardRectY = (h - ch) / 2;
    st.emblem = {
      cx: st.cardRectX + EGG_GEO.cx * cw,
      cy: st.cardRectY + EGG_GEO.cy * ch,
      r: EGG_GEO.r * cw
    };
    st.emblem.k = st.emblem.r / st.g.outerR;

    // 撞击震屏（2px，衰减）
    var tSh = seg(p, ACT.starLand, ACT.starLand + 0.085);
    st.shakeX = 0; st.shakeY = 0;
    if (tSh > 0 && tSh < 1) {
      var amp = 2 * (1 - tSh);
      st.shakeX = Math.sin(tSh * 47) * amp;
      st.shakeY = Math.cos(tSh * 61) * amp * 0.8;
    }
  }

  /* ---------------- 主渲染 ---------------- */
  function render(st) {
    var ctx = st.ctx, w = st.w, h = st.h, g = st.g, p = st.p;
    layout(st);

    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.translate(st.shakeX, st.shakeY);

    var cx = w / 2, cy = h / 2;

    /* ---- 幕1：梗图卡 ---- */
    ctx.save();
    ctx.globalAlpha = st.cardAlpha;
    ctx.translate(cx, cy + st.cardDy);
    ctx.rotate(st.cardRot);
    ctx.scale(st.cardScale, st.cardScale);      // 等比
    drawEggCard(ctx, st, 1);
    ctx.restore();

    /* ---- 幕2：月牙 + 五角星 ---- */
    var em = st.emblem, kF = em.k;
    var glow = Math.max(6, em.r * 0.16) * (1 + 0.25 * Math.sin(p * 42));

    // 月牙（从左侧飞入，旋转对齐到 0°）
    var tC = seg(p, ACT.crescentIn, ACT.crescentLand);
    var uC = easeOutQuint(tC);
    var cSX = st.cardRectX - st.card.w * 0.60;
    var cSY = st.cardRectY + st.card.h * 0.48;
    var cCX = st.cardRectX + st.card.w * 0.06;
    var cCY = st.cardRectY + st.card.h * 0.04;
    function crescentAt(u) {
      var iu = 1 - u;
      return {
        x: iu * iu * cSX + 2 * iu * u * cCX + u * u * em.cx,
        y: iu * iu * cSY + 2 * iu * u * cCY + u * u * em.cy,
        k: lerp(kF * 0.52, kF, u),
        rot: lerp(-0.52, 0, u)
      };
    }
    var crescentLanded = tC >= 1;
    if (tC > 0) {
      if (!crescentLanded) {
        for (var g1 = 3; g1 >= 1; g1--) {
          var f1 = crescentAt(clamp01(uC - g1 * 0.05));
          drawCrescent(ctx, g, f1.k, f1.x, f1.y, f1.rot, 0.30 * (1 - g1 / 4) * (1 - uC) * st.fade, 0);
        }
      }
      var fc = crescentAt(uC);
      drawCrescent(ctx, g, fc.k, fc.x, fc.y, fc.rot,
        (crescentLanded ? 1 : clamp01(tC * 2.4)) * st.fade, glow);
    }

    // 五角星：落点严格按国旗相对位置（星心 = 月牙心 + 0.320833k，同一 y）
    var starX = em.cx + (g.starCx - g.outerCx) * kF;
    var starY = em.cy;
    var tS = seg(p, ACT.starIn, ACT.starLand);
    var uS = easeOutQuint(tS);
    var sSX = st.cardRectX + st.card.w * 1.18;
    var sSY = st.cardRectY - st.card.h * 0.10;
    var sCX = st.cardRectX + st.card.w * 0.88;
    var sCY = st.cardRectY + st.card.h * 0.18;
    function starAt(u) {
      var iu = 1 - u;
      return {
        x: iu * iu * sSX + 2 * iu * u * sCX + u * u * starX,
        y: iu * iu * sSY + 2 * iu * u * sCY + u * u * starY,
        k: lerp(kF * 0.45, kF, u),
        rot: lerp(0.9, 0, u)
      };
    }
    var starLanded = tS >= 1;
    if (tS > 0) {
      if (!starLanded) {
        for (var g2 = 3; g2 >= 1; g2--) {
          var f2 = starAt(clamp01(uS - g2 * 0.05));
          drawStar(ctx, g, f2.k, f2.x, f2.y, f2.rot, 0.28 * (1 - g2 / 4) * (1 - uS) * st.fade, 0);
        }
      }
      var fs = starAt(uS);
      drawStar(ctx, g, fs.k, fs.x, fs.y, fs.rot,
        (starLanded ? 1 : clamp01(tS * 2.4)) * st.fade, glow * 1.1);
    }

    /* ---- 撞击：白闪 + 沿月牙外圆的封弧（同圆心同半径） ---- */
    if (p >= ACT.starLand) {
      var tf = seg(p, ACT.starLand, ACT.starLand + 0.045);
      if (tf > 0 && tf < 1) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = (1 - tf) * 0.24 * st.fade;
        ctx.fillStyle = '#FFF6DA';
        ctx.fillRect(-6, -6, w + 12, h + 12);
        ctx.restore();
      }
      var halfGapDeg = Math.atan2(g.cuspYoff, g.cuspX - g.outerCx) * 180 / Math.PI;
      var spanDeg = 360 - 2 * halfGapDeg;
      var tt = seg(p, ACT.starLand, ACT.starLand + 0.10);
      var ta = seg(p, ACT.starLand, ACT.starLand + 0.30);
      if (ta < 0.999) {
        ctx.save();
        ctx.globalAlpha = (1 - ta) * 0.9 * st.fade;
        ctx.strokeStyle = 'rgba(255,255,255,1)';
        ctx.lineWidth = Math.max(1.6, em.r * 0.055);
        ctx.lineCap = 'round';
        ctx.shadowColor = 'rgba(255,255,255,0.9)';
        ctx.shadowBlur = em.r * 0.35;
        ctx.beginPath();
        ctx.arc(em.cx, em.cy, em.r, rad(halfGapDeg), rad(halfGapDeg + spanDeg * tt), false);
        ctx.stroke();
        ctx.restore();
      }

      // 光沿着「伞冠带内缘的真实圆弧」从月牙贴合处向两端铺开 —— 一眼看出月牙 = 伞冠的弧
      var tW = seg(p, ACT.starLand + 0.02, ACT.starLand + 0.24);
      if (tW > 0 && tW < 1) {
        var A = EGG_GEO.arc;
        var acx = st.cardRectX + A.cx * st.card.w;
        var acy = st.cardRectY + A.cy * st.card.h;
        var ar = A.r * st.card.w;
        var mid = (A.a0 + A.a1) / 2;
        var half = (A.a1 - A.a0) / 2 * tW;
        ctx.save();
        ctx.globalAlpha = (1 - tW) * 0.88 * st.fade;
        ctx.strokeStyle = 'rgba(255,242,196,1)';
        ctx.lineWidth = Math.max(2, ar * 0.024);
        ctx.lineCap = 'round';
        ctx.shadowColor = 'rgba(255,232,160,0.95)';
        ctx.shadowBlur = ar * 0.10;
        ctx.beginPath();
        ctx.arc(acx, acy, ar, rad(mid - half), rad(mid + half), false);
        ctx.stroke();
        ctx.restore();
      }
    }

    /* ---- 幕3：暗角染旗色 ---- */
    var tV = seg(p, ACT.starLand, ACT.starLand + 0.14);
    if (tV > 0) {
      ctx.save();
      var vg = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.26, cx, cy, Math.max(w, h) * 0.80);
      vg.addColorStop(0, 'rgba(190,24,42,0)');
      vg.addColorStop(0.62, 'rgba(176,18,38,' + (0.30 * tV) + ')');
      vg.addColorStop(1, 'rgba(96,6,20,' + (0.62 * tV) + ')');
      ctx.fillStyle = vg;
      ctx.fillRect(-6, -6, w + 12, h + 12);
      var wg = ctx.createLinearGradient(0, h * 0.62, 0, h);
      wg.addColorStop(0, 'rgba(255,190,70,0)');
      wg.addColorStop(1, 'rgba(255,176,50,' + (0.16 * tV) + ')');
      ctx.fillStyle = wg;
      ctx.fillRect(-6, h * 0.62, w + 12, h * 0.38 + 8);
      ctx.restore();
    }

    st.sparkAlpha = st.fade;
    drawSparks(ctx, st);

    /* ---- 文字 ---- */
    if (st.caption && st.capAlpha > 0.002) {
      var size = Math.max(14, Math.min(w, h) * 0.036);
      ctx.save();
      ctx.globalAlpha = st.capAlpha * st.fade;
      ctx.font = '700 ' + size.toFixed(1) + 'px "Microsoft YaHei","PingFang SC","Noto Sans SC","Hiragino Sans GB",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(70,6,20,0.75)';
      ctx.shadowBlur = size * 0.7;
      ctx.fillStyle = '#FFF6E8';
      ctx.fillText(st.caption, cx, h * 0.905);
      ctx.restore();
    }
    if (st.bonus && st.bonusAlpha > 0.002) {
      var bs = Math.max(16, Math.min(w, h) * 0.044);
      var bx2 = Math.min(w - bs * 1.8, Math.max(bs * 1.8, cx + st.card.w * 0.42));
      ctx.save();
      ctx.globalAlpha = st.bonusAlpha * st.fade;
      ctx.font = '800 ' + bs.toFixed(1) + 'px "Microsoft YaHei","PingFang SC",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(2, bs * 0.14);
      ctx.strokeStyle = 'rgba(96,10,26,0.9)';
      ctx.strokeText(st.bonus, bx2, st.bonusY);
      ctx.fillStyle = '#FFD34D';
      ctx.fillText(st.bonus, bx2, st.bonusY);
      ctx.restore();
    }

    /* ---- 幕4：淡出 ---- */
    if (st.fade < 0.999) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = 1 - st.fade;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, st.cw, st.ch);
      ctx.restore();
    }
  }

  /**
   * 把光斑贴图染成金色。
   * spark.png 是「深色底的亮斑」（不透明，靠加法混合出光），
   * 所以必须用 multiply 保亮度，不能用 source-in（那会把深色底也染亮成方块）。
   */
  function tintSprite(doc, img, color) {
    try {
      var c = doc.createElement('canvas');
      c.width = img.width || 0;
      c.height = img.height || 0;
      if (!c.width || !c.height) return null;
      var g2 = c.getContext('2d');
      g2.drawImage(img, 0, 0);
      g2.globalCompositeOperation = 'multiply';
      g2.fillStyle = color;
      g2.fillRect(0, 0, c.width, c.height);
      return c;
    } catch (e) { return null; }
  }

  /* ---------------- 图片预载（失败/超时都不卡住 Promise） ---------------- */
  function resolveUrl(doc, url) {
    if (!url) return '';
    if (/^[a-z]+:/i.test(url) || url.charAt(0) === '/') return url;
    return String(doc.baseURI || '').replace(/[^/]*$/, '') + url;
  }

  function preload(doc, urls, timeoutMs, done) {
    var finished = false, timer = 0, i = 0;
    function finish(img) {
      if (finished) return;
      finished = true;
      if (timer) { clearTimeout(timer); timer = 0; }
      done(img || null);
    }
    function tryNext() {
      if (finished) return;
      if (i >= urls.length || !root.Image) return finish(null);
      var url = urls[i++];
      if (!url) return tryNext();
      var img;
      try { img = new root.Image(); } catch (e) { return finish(null); }
      img.onload = function () {
        if (img.width > 0 && img.height > 0) finish(img); else tryNext();
      };
      img.onerror = tryNext;
      try { img.src = resolveUrl(doc, url); } catch (e) { tryNext(); }
    }
    timer = setTimeout(function () { finish(null); }, Math.max(80, timeoutMs));
    tryNext();
  }

  /* ---------------- 生命周期 ---------------- */
  function play(hostEl, opts) {
    var o = {}, kk;
    for (kk in DEFAULTS) if (DEFAULTS.hasOwnProperty(kk)) o[kk] = DEFAULTS[kk];
    if (opts) for (kk in opts) if (opts.hasOwnProperty(kk)) o[kk] = opts[kk];

    var doc = root.document;
    if (!doc || typeof doc.createElement !== 'function') {
      return Promise.resolve({ ok: false, reason: 'no-dom' });
    }
    var host = hostEl || doc.getElementById('overlay-layer');
    if (!host) return Promise.resolve({ ok: false, reason: 'no-host' });
    if (typeof Promise !== 'function') return null;
    if (active && active.cancel) active.cancel();

    var duration = Math.max(600, +o.duration || DEFAULTS.duration);
    var canvas = doc.createElement('canvas');
    canvas.className = 'pdt-merge-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText =
      'position:absolute;left:0;top:0;width:100%;height:100%;display:block;' +
      'pointer-events:none;z-index:2;';
    var ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve({ ok: false, reason: 'no-2d' });

    var dpr = Math.max(1, Math.min(+root.devicePixelRatio || 1, 3));
    var resolved = false, alive = true, rafId = 0, timerId = 0, t0 = 0, started = false;

    var st = {
      ctx: ctx, dpr: dpr, cw: 1, ch: 1, w: 0, h: 0,
      p: 0, fade: 1, capAlpha: 0, bonusAlpha: 0, bonusRise: 0,
      card: { w: 100, h: 133 }, cardRectX: 0, cardRectY: 0,
      cardScale: 1, cardDy: 0, cardRot: 0, cardAlpha: 1,
      emblem: { cx: 0, cy: 0, r: 50, k: 200 },
      shakeX: 0, shakeY: 0,
      egg: null, sprite: null,
      sparks: [], _spawned: false, _lastEl: 0,
      caption: o.showCaption ? String(o.caption || '') : '',
      bonus: String(o.bonus || ''),
      g: getGeom()
    };

    var resolveFn = null;
    var promise = new Promise(function (res) { resolveFn = res; });

    function measure() {
      var w = host.clientWidth || root.innerWidth || 800;
      var h = host.clientHeight || root.innerHeight || 600;
      if (w <= 1 || h <= 1) { w = root.innerWidth || 800; h = root.innerHeight || 600; }
      st.w = w; st.h = h;
      st.cw = Math.max(1, Math.round(w * dpr));
      st.ch = Math.max(1, Math.round(h * dpr));
      canvas.width = st.cw;
      canvas.height = st.ch;
    }

    function onResize() {
      if (!alive) return;
      try { measure(); } catch (e) { /* 不崩即可 */ }
    }

    /** 统一收尾：拆 DOM + 注销监听，再 resolve（kind='superseded' = 被下一次播放顶掉） */
    function finish(kind) {
      if (!alive) return;
      alive = false;
      if (rafId && root.cancelAnimationFrame) root.cancelAnimationFrame(rafId);
      if (timerId) clearTimeout(timerId);
      try { if (root.removeEventListener) root.removeEventListener('resize', onResize); } catch (e) {}
      try { if (canvas.parentNode) canvas.parentNode.removeChild(canvas); } catch (e) {}
      if (active && active.cancel === cancel) active = null;
      if (!resolved) {
        resolved = true;
        resolveFn(kind === 'superseded'
          ? { ok: false, reason: 'superseded' }
          : { ok: true, duration: duration, usedEgg: !!st.egg });
      }
    }
    function cleanup() { finish('done'); }
    function cancel() { finish('superseded'); }

    function spawnSparks() {
      var n = 34, base = st.emblem.r * 1.55;
      var ax = st.emblem.cx, ay = st.emblem.cy;
      var seed = (+o.seed || 7654321);
      function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
      for (var i = 0; i < n; i++) {
        var ang = rnd() * Math.PI * 2;
        var rr = st.emblem.r * (1.10 + rnd() * 0.85);
        var spd = base * (1.2 + rnd() * 2.4);
        st.sparks.push({
          x: ax + Math.cos(ang) * rr,
          y: ay + Math.sin(ang) * rr,
          vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - base * 0.25,
          size: base * (0.14 + rnd() * 0.20),
          life: 1, max: 1, age: 0,
          dur: 0.40 + rnd() * 0.35
        });
      }
    }

    function frame() {
      if (!alive) return;
      var el = nowMs() - t0;
      st.p = clamp01(el / duration);

      var dtSec = Math.min(0.05, Math.max(0.001, (el - (st._lastEl || 0)) / 1000));
      st._lastEl = el;

      var p = st.p;
      st.fade = 1 - easeInOutCubic(seg(p, ACT.fadeStart, 1));
      st.capAlpha = clamp01(seg(p, ACT.starLand + 0.03, ACT.starLand + 0.14)) *
                    (1 - seg(p, ACT.fadeStart - 0.02, ACT.fadeStart + 0.08));
      var tb = seg(p, ACT.starLand + 0.02, ACT.fadeStart + 0.02);
      st.bonusAlpha = clamp01(tb * 3) * (1 - seg(p, ACT.burst - 0.01, ACT.burst + 0.10));
      st.bonusRise = easeOutCubic(tb) * (st.h * 0.070);
      st.bonusY = st.h * 0.885 - st.bonusRise;

      if (p >= ACT.starLand) {
        if (!st._spawned) { st._spawned = true; spawnSparks(); }
        for (var i = 0; i < st.sparks.length; i++) {
          var s = st.sparks[i];
          s.age += dtSec;
          s.x += s.vx * dtSec;
          s.y += s.vy * dtSec;
          s.vx *= 0.962; s.vy *= 0.962;
          s.life = clamp01(1 - s.age / s.dur);
        }
      }

      try { render(st); } catch (e) { cleanup(); return; }
      if (st.p >= 1) { cleanup(); return; }
      rafId = root.requestAnimationFrame ? root.requestAnimationFrame(frame)
        : (timerId = setTimeout(frame, 16));
    }

    // 挂载
    try {
      var pos = (root.getComputedStyle ? root.getComputedStyle(host).position : '') || '';
      if (pos === 'static' || pos === '') host.style.position = 'relative';
    } catch (e) { /* 忽略 */ }
    host.appendChild(canvas);
    measure();
    if (root.addEventListener) root.addEventListener('resize', onResize, { passive: true });
    active = { cancel: cancel };

    // 兜底：无论 rAF / 图片加载出什么问题，到这个点一定收尾 resolve
    timerId = setTimeout(function () {
      if (!alive) return;
      try { render(st); } catch (e) {}
      cleanup();
    }, duration + (+o.imageTimeout || DEFAULTS.imageTimeout) + 1400);

    // 光斑贴图（失败就用径向渐变兜底）
    (function loadSprite() {
      if (!root.Image) return;
      try {
        var img = new root.Image();
        img.onload = function () {
          if (!alive) return;
          // spark.png 偏白，染成金色再走加法混合，才是「金色粒子」
          st.sprite = tintSprite(doc, img, '#FFC24A') || img;
        };
        img.onerror = function () { st.sprite = null; };
        img.src = resolveUrl(doc, o.sparkUrl);
      } catch (e) { st.sprite = null; }
    })();

    // 梗图预载完成（或超时/失败）后再启动时间轴：保证月牙落点与画面一致
    preload(doc, [o.eggUrl, o.eggUrlAlt], +o.imageTimeout || DEFAULTS.imageTimeout, function (img) {
      if (!alive) return;
      st.egg = img;
      if (!started) { started = true; t0 = nowMs(); }
      frame();
    });

    return promise;
  }

  function stop() { if (active && active.cancel) active.cancel(); }

  PDT.Merge = {
    play: play,
    stop: stop,
    version: '2.0.0',
    EGG_GEO: EGG_GEO,
    acts: ACT
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = PDT.Merge;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
