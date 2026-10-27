#!/usr/bin/env node
/**
 * tools/verify.mjs — 「派大星的衣柜」QA 全量校验 harness
 *
 * 零依赖，node ESM（node >= 18）。用法：
 *   node tools/verify.mjs            # 常规校验；缺失的「图片」记为 MISSING（红字）但不让 exit code = 1
 *   node tools/verify.mjs --strict   # MISSING 也算失败（美术收工后跑这个）
 *   node tools/verify.mjs --json     # 只输出机器可读汇总（给轮询脚本用）
 *
 * 退出码：任何 FAIL（strict 下含 MISSING）=> 1，否则 0。
 *
 * 唯一事实来源：docs/CONTRACT.md（本脚本不自作主张改契约，只按它断言）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARGV = process.argv.slice(2);
const OPT = {
  strict: ARGV.includes('--strict'),
  json: ARGV.includes('--json'),
};

const isTTY = !!process.stdout.isTTY && !process.env.NO_COLOR;
const C = isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

/* ────────────────────────── 结果收集 ────────────────────────── */

const results = [];
let currentGroup = '(未分组)';
const GROUP_ORDER = [
  '1. 静态语法 node --check',
  '2. 国旗几何 PDT.Flag',
  '3. 引擎规则 PDT.Engine',
  '4. HTML / DOM 契约',
  '5. 资源文件',
  '6. 禁止项（外链 / ES module）',
  '7. 运行入口与命名空间',
];
function group(title) { currentGroup = title; }
function add(kind, name, detail) {
  results.push({ group: currentGroup, kind, name: String(name), detail: detail == null ? '' : String(detail) });
}
const pass = (n, d) => add('pass', n, d);
const fail = (n, d) => add('fail', n, d);
const missing = (n, d) => add('missing', n, d);

function must(cond, msg) { if (!cond) throw new Error(msg); }
/** 备注：不计入 PASS/FAIL，只提示（如「出处 URL 字面量，未加载」） */
function note(n, d) { add('note', n, d); }
function short(e) {
  const s = (e && e.message) ? e.message : String(e);
  return s.split('\n').slice(0, 3).join(' | ').slice(0, 360);
}
function check(name, fn) {
  try { const d = fn(); pass(name, d); }
  catch (e) { fail(name, short(e)); }
}
async function checkAsync(name, fn) {
  try { const d = await fn(); pass(name, d); }
  catch (e) { fail(name, short(e)); }
}

const readText = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; }
};
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
function listDir(rel, filter) {
  try {
    const d = path.join(ROOT, rel);
    if (!fs.statSync(d).isDirectory()) return [];
    return fs.readdirSync(d).filter(filter).sort();
  } catch { return []; }
}

/* ────────────────────────── JS 加载垫片 ────────────────────────── */

// 契约 §7：flag.js / engine.js 必须能被 node require，且模块顶层不得访问 document/canvas。
// 这里给 window/globalThis 垫片，但故意不提供 document —— 顶层乱用 DOM 就会 require 失败。
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
if (!globalThis.PDT) globalThis.PDT = {};

const req = createRequire(import.meta.url);
function loadJs(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${rel}`);
  try { if (req.cache) delete req.cache[abs]; } catch { /* ignore */ }
  return req(abs);
}
function resolveFlag(mod) {
  const cands = [
    mod, mod && mod.Flag, mod && mod.default,
    globalThis.PDT && globalThis.PDT.Flag,
    globalThis.window && globalThis.window.PDT && globalThis.window.PDT.Flag,
  ];
  for (const c of cands) {
    if (c && typeof c === 'object' && (typeof c.svgString === 'function' || typeof c.selfCheck === 'function')) return c;
  }
  return null;
}
function resolveEngine(mod) {
  const cands = [
    mod && mod.Engine, mod, mod && mod.default,
    globalThis.PDT && globalThis.PDT.Engine,
    globalThis.window && globalThis.window.PDT && globalThis.window.PDT.Engine,
  ];
  for (const c of cands) if (typeof c === 'function') return c;
  return null;
}

/* ────────────────────────── 注释遮罩（区分注释/代码） ────────────────────────── */

function lastNonSpace(text, i) {
  for (let k = i - 1; k >= 0; k--) {
    const ch = text[k];
    if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') return ch;
  }
  return '';
}

/**
 * 把注释内容替换成空格（保留换行，字符偏移不变）。
 * 支持 // 、 /* *\/ 、HTML <!-- -->，并正确跳过字符串字面量内部的 "//"。
 * 目的：注释里的出处 URL 属于白名单，代码/字符串里的外链才是违规。
 */
function maskComments(text, isHtml) {
  const n = text.length;
  const out = new Array(n);
  let state = 'code'; // code | line | block | html | ' | " | `
  for (let i = 0; i < n; i++) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : '';
    out[i] = c;

    if (state === 'code') {
      if (c === '/' && c2 === '/' ) {
        const prev = lastNonSpace(text, i);
        if (prev !== ':' && prev !== '(' && prev !== '=' && prev !== '/' && prev !== ';' && prev !== '"' && prev !== "'") {
          state = 'line';
          out[i] = ' ';
        }
        continue;
      }
      if (c === '/' && c2 === '*') { state = 'block'; out[i] = ' '; continue; }
      if (isHtml && c === '<' && text.startsWith('<!--', i)) { state = 'html'; out[i] = ' '; continue; }
      if (c === "'" || c === '"' || c === '`') { state = c; }
      continue;
    }
    if (state === 'line') {
      if (c === '\n') state = 'code'; else out[i] = ' ';
      continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { out[i] = ' '; out[i + 1] = ' '; i++; state = 'code'; }
      else if (c !== '\n') out[i] = ' ';
      continue;
    }
    if (state === 'html') {
      if (text.startsWith('-->', i)) { out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '; i += 2; state = 'code'; }
      else if (c !== '\n') out[i] = ' ';
      continue;
    }
    // 字符串内部：保留原字符（外链写在字符串里依然要抓），只处理转义
    if (c === '\\') { if (i + 1 < n) { i++; out[i] = text[i]; } continue; }
    if (c === state) state = 'code';
  }
  return out.join('');
}

function lineIndexer(masked) {
  const starts = [0];
  for (let i = 0; i < masked.length; i++) if (masked[i] === '\n') starts.push(i + 1);
  return (idx) => {
    let lo = 0, hi = starts.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= idx) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans + 1;
  };
}
function lineTextAt(text, idx) {
  const s = text.lastIndexOf('\n', idx - 1) + 1;
  const e = text.indexOf('\n', idx);
  return text.slice(s, e === -1 ? text.length : e).trim().slice(0, 160);
}
function grepAll(masked, original, re) {
  const hits = [];
  const lineOf = lineIndexer(masked);
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(masked))) {
    hits.push({ index: m.index, line: lineOf(m.index), text: lineTextAt(original, m.index), match: m[0].trim().slice(0, 80) });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return hits;
}
/** 这个位置的外链是不是在「真的会去加载」的上下文里 */
function isLoadingContext(masked, idx) {
  const before = masked.slice(Math.max(0, idx - 140), idx);
  if (/(?:src|href|poster|data-src|action|content|xlink:href)\s*=\s*["']?\s*$/.test(before)) return true;
  if (/url\(\s*["']?\s*$/.test(before)) return true;
  if (/(?:new\s+Audio|fetch|XMLHttpRequest|importScripts|loadScript|\$\.(?:get|ajax)|axios)\s*\(\s*["']?\s*$/.test(before)) return true;
  if (/@import\s+(?:url\()?\s*["']?\s*$/.test(before)) return true;
  if (/<(?:script|link|img|source|audio|video|iframe)\b[^>]*$/i.test(before)) return true;
  return false;
}
/** 这个位置的外链是不是「出处/法条依据」数据字段（不加载，允许） */
function isCitationContext(masked, idx) {
  const before = masked.slice(Math.max(0, idx - 700), idx);
  return /(?:sources?|references?|refs?|citation|出处|依据|法条)\s*:\s*\[[^\]]*$/i.test(before);
}
/** XML 命名空间（xmlns）不是资源，是标识符 */
function isNamespaceUri(masked, idx) {
  return /^https?:\/\/www\.w3\.org\//i.test(masked.slice(idx, idx + 80));
}
function describeHits(hits, limit = 4) {
  return hits.slice(0, limit).map((h) => `L${h.line}: ${h.match}`).join(' ; ') +
    (hits.length > limit ? ` ; …共 ${hits.length} 处` : '');
}

/* ══════════════════════════ 1. 静态语法 ══════════════════════════ */

function sectionStatic() {
  group('1. 静态语法 node --check');
  const files = listDir('js', (f) => f.endsWith('.js'));
  if (!files.length) {
    fail('js/*.js 是否存在', 'js/ 目录下没有任何 .js 文件（队友尚未产出）');
    return;
  }
  for (const f of files) {
    const rel = `js/${f}`;
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { cwd: ROOT, encoding: 'utf8' });
    if (r.error) fail(`node --check ${rel}`, short(r.error));
    else if (r.status !== 0) fail(`node --check ${rel}`, (r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' | '));
    else pass(`node --check ${rel}`, `${fs.statSync(path.join(ROOT, rel)).size} B`);
  }
}

/* ══════════════════════════ 2. 国旗几何 ══════════════════════════ */

const ALLOWED_FLAG_COLORS = new Set(['e30a17', 'ffffff', 'fff', 'none', 'transparent', 'currentcolor', 'inherit']);

function svgStarInfo(svg) {
  // 1) polygon / polyline 顶点数
  const re = /<(?:polygon|polyline)\b[^>]*\bpoints\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(svg))) {
    const nums = m[1].trim().split(/[\s,]+/).filter(Boolean).map(Number).filter((v) => Number.isFinite(v));
    const verts = Math.floor(nums.length / 2);
    if (verts === 10 || (verts >= 5 && verts % 5 === 0)) return { ok: true, how: `polygon ${verts} 顶点` };
  }
  // 2) path 里的关键字标注
  if (/\bstar\b|pentagram|五角星|y[ıi]ld[ıi]z/i.test(svg)) return { ok: true, how: 'star 关键字' };
  return { ok: false, how: '未找到 10 顶点多边形 / star 关键字' };
}

function svgColorInfo(svg) {
  const found = new Map();
  const push = (c) => { const k = c.trim().toLowerCase(); if (k) found.set(k, (found.get(k) || 0) + 1); };
  for (const m of svg.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
    const hex = m[1].toLowerCase();
    if ([3, 4, 6, 8].includes(hex.length)) push('#' + hex);
  }
  for (const m of svg.matchAll(/\b(?:fill|stroke|stop-color|flood-color)\s*[:=]\s*["']?\s*([a-zA-Z]+)\s*(?:["';>]|$)/gi)) push(m[1]);
  const disallowed = [...found.keys()].filter((c) => {
    const k = c.replace(/^#/, '');
    if (c.startsWith('#')) {
      // 8 位带 alpha 的十六进制：取前 6 位比对
      return !ALLOWED_FLAG_COLORS.has(k) && !ALLOWED_FLAG_COLORS.has(k.slice(0, 6)) && !ALLOWED_FLAG_COLORS.has(k.slice(0, 3));
    }
    return !ALLOWED_FLAG_COLORS.has(k);
  });
  return { all: [...found.keys()], disallowed };
}

function sectionFlag() {
  group('2. 国旗几何 PDT.Flag');
  let F = null;
  try {
    F = resolveFlag(loadJs('js/flag.js'));
  } catch (e) {
    fail('require js/flag.js', '加载失败（契约 §7 要求可被 node require 且顶层不得访问 DOM）：' + short(e));
    return;
  }
  if (!F) { fail('PDT.Flag 命名空间', 'require 后没找到 PDT.Flag.svgString / selfCheck'); return; }
  pass('require js/flag.js → PDT.Flag');

  check('PDT.Flag.SPEC 存在且 red === #E30A17', () => {
    must(F.SPEC && typeof F.SPEC === 'object', 'SPEC 不存在');
    const red = String(F.SPEC.red || '').toUpperCase();
    must(red === '#E30A17', `SPEC.red = ${JSON.stringify(F.SPEC.red)}，期望 '#E30A17'`);
    if (F.SPEC.ratio != null) must(Math.abs(Number(F.SPEC.ratio) - 1.5) < 1e-6, `SPEC.ratio = ${F.SPEC.ratio}，期望 1.5`);
    return `red=${F.SPEC.red} ratio=${F.SPEC.ratio ?? '(未提供，按 1.5 断言 SVG)'}`;
  });

  check('selfCheck().ok === true 且 detail 每项通过', () => {
    must(typeof F.selfCheck === 'function', 'selfCheck 不是函数');
    const r = F.selfCheck();
    must(r && typeof r === 'object', 'selfCheck() 未返回对象');
    must(r.ok === true, `selfCheck().ok = ${JSON.stringify(r.ok)}`);
    must(Array.isArray(r.detail) && r.detail.length > 0, 'detail 不是非空数组');
    const bad = r.detail.filter((d) => d && typeof d === 'object' &&
      (d.pass === false || d.ok === false || d.valid === false || d.result === false));
    must(bad.length === 0, `${bad.length} 项 detail 未通过：` +
      bad.slice(0, 3).map((d) => d.name || d.label || JSON.stringify(d).slice(0, 60)).join(' / '));
    return `${r.detail.length} 项自检全通过`;
  });

  check('draw() 存在（等比居中绘制入口）', () => {
    must(typeof F.draw === 'function', 'PDT.Flag.draw 不是函数（契约 §5.1）');
    return 'typeof draw === function';
  });

  let svg = '';
  check('svgString(600,400) 返回可解析 SVG 且宽高比 1.5', () => {
    must(typeof F.svgString === 'function', 'svgString 不是函数');
    svg = F.svgString(600, 400);
    must(typeof svg === 'string' && svg.length > 80, `返回值不是像样的字符串（len=${svg && svg.length}）`);
    must(/<svg\b/i.test(svg), 'SVG 里没有 <svg> 根元素');
    must(/<\/svg>\s*$/i.test(svg.trim()), 'SVG 没有正确闭合 </svg>');
    const vb = /viewBox\s*=\s*["']\s*([-\d.eE+]+)[\s,]+([-\d.eE+]+)[\s,]+([-\d.eE+]+)[\s,]+([-\d.eE+]+)\s*["']/i.exec(svg);
    must(vb, 'SVG 缺少合法 viewBox');
    const vw = Number(vb[3]), vh = Number(vb[4]);
    must(vw > 0 && vh > 0, `viewBox 宽高非法：${vb[3]} x ${vb[4]}`);
    const vbRatio = vw / vh;
    must(Math.abs(vbRatio - 1.5) <= 0.001, `viewBox 宽高比 ${vbRatio.toFixed(4)}，期望 1.5（±0.001）`);
    let note = `viewBox=${vb[1]} ${vb[2]} ${vw} ${vh} → ${vbRatio.toFixed(4)}`;
    const wA = /\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(svg);
    const hA = /\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(svg);
    if (wA && hA) {
      const r = Number(wA[1]) / Number(hA[1]);
      must(Math.abs(r - 1.5) <= 0.001, `width/height 宽高比 ${r.toFixed(4)}，期望 1.5`);
      note += `; width/height=${wA[1]}x${hA[1]}`;
    }
    return note;
  });

  check('SVG 含五角星多边形', () => {
    must(svg, 'svgString 未产出，跳过');
    const s = svgStarInfo(svg);
    must(s.ok, s.how);
    return s.how;
  });

  check('SVG 主色只有 #E30A17 / #FFFFFF', () => {
    must(svg, 'svgString 未产出，跳过');
    const info = svgColorInfo(svg);
    must(info.disallowed.length === 0, `出现契约外颜色：${info.disallowed.join(', ')}（允许 #E30A17 / #FFFFFF）`);
    must(info.all.some((c) => c.replace('#', '').toLowerCase().startsWith('e30a17')), `SVG 里没找到官方红 #E30A17，实际颜色：${info.all.join(', ') || '(无)'}`);
    return `颜色：${info.all.join(', ')}`;
  });
}

/* ══════════════════════════ 3. 引擎规则 ══════════════════════════ */

const TYPES = ['flag', 'parachute', 'trunks', 'kebab', 'balloon', 'grin'];
const STAT_KEYS = ['moves', 'matchedPairs', 'totalPairs', 'score', 'combo', 'bestCombo', 'elapsedMs', 'mergeCount'];
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function playFullGame(Engine, mode, rng) {
  const e = new Engine();
  let guard = 0;
  let prevScore = e.stats().score;
  const drops = [];
  let merges = 0;
  const expectedPairs = 12;
  while (!e.isWon()) {
    if (++guard > 600) throw new Error('600 步内未通关（疑似死循环）');
    const down = e.getCards().filter((c) => c.state === 'down');
    if (!down.length) throw new Error("牌桌已无 down 牌，但 isWon() 仍为 false");
    const byType = new Map();
    for (const c of down) { if (!byType.has(c.type)) byType.set(c.type, []); byType.get(c.type).push(c); }
    const flagC = (byType.get('flag') || [])[0];
    const paraC = (byType.get('parachute') || [])[0];
    let a = null, b = null;
    const wantMerge = !!(flagC && paraC) &&
      (mode === 'merge' || (mode === 'random' && rng() < 0.5));
    if (wantMerge) { a = flagC; b = paraC; }
    else {
      const pairs = [...byType.values()].filter((l) => l.length >= 2);
      if (pairs.length) {
        const list = pairs[Math.floor(rng() * pairs.length) % pairs.length];
        a = list[0]; b = list[1];
      } else if (flagC && paraC) { a = flagC; b = paraC; }
      else throw new Error(`无合法解：剩余 ${down.map((c) => c.type).join(',')}`);
    }
    const ra = e.flip(a.index);
    const rb = e.flip(b.index);
    if (rb.status === 'ignore') throw new Error(`自动通关出现 ignore（${a.index}, ${b.index}）`);
    if (rb.status === 'mismatch') { e.unflipPending(); throw new Error(`自动通关出现 mismatch：${a.type} vs ${b.type}`); }
    if (rb.status === 'merge') merges++;
    must(ra.status !== 'ignore', `首翻 ${a.index} 返回 ignore`);
    const st = e.stats();
    if (st.score < prevScore) drops.push(`${prevScore}→${st.score}`);
    prevScore = st.score;
  }
  const st = e.stats();
  must(st.matchedPairs === expectedPairs, `matchedPairs = ${st.matchedPairs}，期望 12（同型对 + 合并都算一对）`);
  must(st.totalPairs === expectedPairs, `totalPairs = ${st.totalPairs}，期望 12`);
  must(st.moves > 0, 'moves 应 > 0');
  must(st.score > 0, 'score 应 > 0');
  must(Number.isFinite(st.elapsedMs) && st.elapsedMs >= 0, `elapsedMs 非法：${st.elapsedMs}`);
  // 合并次数不变量（game-core 确认：4 flag + 4 parachute 最多合并 4 次，只能是 0/2/4）
  must(Number.isInteger(st.mergeCount) && st.mergeCount >= 0 && st.mergeCount <= 4,
    `mergeCount = ${st.mergeCount} 越界，合法值 0/2/4`);
  must(st.mergeCount % 2 === 0, `mergeCount = ${st.mergeCount} 必须是偶数（跨类合并成对消耗 flag/parachute）`);
  const mergedCards = e.getCards().filter((c) => c.state === 'merged').length;
  must(mergedCards === st.mergeCount * 2, `状态为 merged 的卡 ${mergedCards} 张 ≠ 2 × mergeCount(${st.mergeCount})`);
  must(drops.length === 0, `分数出现回退：${drops.slice(0, 3).join(', ')}`);
  const left = e.getCards().filter((c) => c.state === 'down' || c.state === 'up');
  must(left.length === 0, `通关后仍有 ${left.length} 张未清空（${left.map((c) => c.state).join(',')}）`);
  const stars = e.stars();
  must(Number.isFinite(stars) && stars >= 1 && stars <= 3, `stars() = ${stars}，期望 1~3`);
  return { st, guard, merges };
}

function sectionEngine() {
  group('3. 引擎规则 PDT.Engine');
  let Engine = null;
  try {
    Engine = resolveEngine(loadJs('js/engine.js'));
  } catch (e) {
    fail('require js/engine.js', '加载失败（契约 §7）：' + short(e));
    return;
  }
  if (!Engine) { fail('PDT.Engine 构造器', 'require 后没找到可 new 的 PDT.Engine'); return; }
  pass('require js/engine.js → PDT.Engine');

  check('新引擎：24 张 / 6 型各 4 / 全 down / 字段完整', () => {
    const e = new Engine();
    const cards = e.getCards();
    must(Array.isArray(cards), 'getCards() 未返回数组');
    must(cards.length === 24, `牌数 ${cards.length}，期望 24`);
    for (const t of TYPES) {
      const n = cards.filter((c) => c.type === t).length;
      must(n === 4, `type '${t}' 有 ${n} 张，期望 4`);
    }
    const extra = [...new Set(cards.map((c) => c.type))].filter((t) => !TYPES.includes(t));
    must(extra.length === 0, `出现契约外 type：${extra.join(',')}`);
    const bad = cards.filter((c) => c.state !== 'down');
    must(bad.length === 0, `${bad.length} 张初始状态不是 down：` + bad.slice(0, 3).map((c) => `${c.index}:${c.state}`).join(','));
    for (const c of cards) {
      must(typeof c.index === 'number', '卡牌缺 index');
      must('art' in c, `卡牌 ${c.index} 缺 art 字段`);
    }
    const idx = new Set(cards.map((c) => c.index));
    must(idx.size === 24, `index 不唯一（只有 ${idx.size} 个）`);
    return '24 张 / 6×4 / 全 down';
  });

  check('getCards() 返回副本（外部改动不污染引擎）', () => {
    const e = new Engine();
    const a = e.getCards();
    a[0].state = 'matched';
    a[0].type = 'hacked';
    a.length = 0;
    const b = e.getCards();
    must(b.length === 24 && b[0].state === 'down' && b[0].type !== 'hacked', 'getCards() 泄漏内部引用');
    return '副本语义正常';
  });

  check('第一次 flip → flipped；同一张再 flip → ignore', () => {
    const e = new Engine();
    const c0 = e.getCards()[0];
    const r1 = e.flip(c0.index);
    must(r1 && r1.status === 'flipped', `第一次 flip 返回 ${JSON.stringify(r1 && r1.status)}，期望 'flipped'`);
    must(Array.isArray(r1.indices) && r1.indices.includes(c0.index), `flip 返回的 indices 不含 ${c0.index}：${JSON.stringify(r1.indices)}`);
    must(e.getCards()[c0.index].state === 'up', 'flip 后该牌状态应为 up');
    const r2 = e.flip(c0.index);
    must(r2 && r2.status === 'ignore', `同一张再 flip 返回 ${JSON.stringify(r2 && r2.status)}，期望 'ignore'`);
    return 'flipped → ignore';
  });

  check('elapsedMs 从第一次翻牌开始计时', () => {
    const e = new Engine();
    must(e.stats().elapsedMs === 0 || e.stats().elapsedMs === null || typeof e.stats().elapsedMs === 'number', 'elapsedMs 类型异常');
    e.flip(e.getCards()[0].index);
    sleep(25);
    const ms = e.stats().elapsedMs;
    must(typeof ms === 'number' && ms > 0, `第一次翻牌 25ms 后 elapsedMs = ${ms}，期望 > 0`);
    return `${ms}ms`;
  });

  check('flag + parachute → merge（mergeCount++，分数 ≥ 300）', () => {
    const e = new Engine();
    const cards = e.getCards();
    const f = cards.find((c) => c.type === 'flag');
    const p = cards.find((c) => c.type === 'parachute');
    must(f && p, '牌堆里找不到 flag 或 parachute');
    const s0 = e.stats();
    must(e.flip(f.index).status === 'flipped', '翻 flag 应返回 flipped');
    const r = e.flip(p.index);
    must(r && r.status === 'merge', `flag+parachute 返回 ${JSON.stringify(r && r.status)}，期望 'merge'（这是跨类合并，不是普通 match）`);
    must(Array.isArray(r.indices) && r.indices.length === 2, `merge 的 indices 应为 2 张，实际 ${JSON.stringify(r.indices)}`);
    const s1 = e.stats();
    must(s1.mergeCount >= s0.mergeCount + 1, `mergeCount 未增加：${s0.mergeCount} → ${s1.mergeCount}`);
    must(s1.score - s0.score >= 300, `合并得分 ${s1.score - s0.score}，期望 ≥ 300`);
    const after = e.getCards();
    where: {
      must(['merged', 'matched'].includes(after[f.index].state),
        `flag 合并后状态 ${after[f.index].state}，期望 merged（契约状态枚举含 'merged'）`);
      must(['merged', 'matched'].includes(after[p.index].state),
        `parachute 合并后状态 ${after[p.index].state}，期望 merged`);
    }
    return `+${s1.score - s0.score} 分, mergeCount=${s1.mergeCount}, 状态=${after[f.index].state}/${after[p.index].state}`;
  });

  check('普通配对 match 后自动消除且加分', () => {
    const e = new Engine();
    const cards = e.getCards();
    const t = TYPES.find((x) => x !== 'flag' && x !== 'parachute');
    const two = cards.filter((c) => c.type === t).slice(0, 2);
    must(e.flip(two[0].index).status === 'flipped', '首翻应为 flipped');
    const r = e.flip(two[1].index);
    must(r.status === 'match', `同 type 两张返回 ${r.status}，期望 'match'`);
    const s = e.stats();
    must(s.matchedPairs === 1, `matchedPairs = ${s.matchedPairs}，期望 1`);
    must(s.score > 0, '配对后分数应 > 0');
    const after = e.getCards();
    must(['matched', 'merged'].includes(after[two[0].index].state), `配对后状态 ${after[two[0].index].state}，期望 matched`);
    return `+${s.score} 分`;
  });

  check('mismatch：unflipPending() 之前两张仍是 up', () => {
    const e = new Engine();
    const cards = e.getCards();
    const a = cards.find((c) => c.type === 'trunks');
    const b = cards.find((c) => c.type === 'kebab');
    must(a && b, '找不到 trunks / kebab 牌');
    must(e.flip(a.index).status === 'flipped', '首翻应为 flipped');
    const r = e.flip(b.index);
    must(r.status === 'mismatch', `翻 trunks+kebab 返回 ${r.status}，期望 'mismatch'`);
    const mid = e.getCards();
    must(mid[a.index].state === 'up', `翻错后（未 unflip）第一张状态 ${mid[a.index].state}，期望 up`);
    must(mid[b.index].state === 'up', `翻错后（未 unflip）第二张状态 ${mid[b.index].state}，期望 up`);
    must(e.stats().combo === 0, `配错后 combo 应清零，实际 ${e.stats().combo}`);
    e.unflipPending();
    const after = e.getCards();
    must(after[a.index].state === 'down' && after[b.index].state === 'down',
      `unflipPending 后状态 ${after[a.index].state}/${after[b.index].state}，期望 down/down`);
    return 'up→up（等待 UI 播完）→ down';
  });

  check('连击：连续 3 次 match 后 combo === 3', () => {
    const e = new Engine();
    for (let k = 0; k < 3; k++) {
      const down = e.getCards().filter((c) => c.state === 'down');
      const byType = new Map();
      for (const c of down) { if (!byType.has(c.type)) byType.set(c.type, []); byType.get(c.type).push(c); }
      const entry = [...byType.entries()].find(([, l]) => l.length >= 2);
      must(entry, `第 ${k + 1} 次配对前已无成对牌`);
      const [, l] = entry;
      e.flip(l[0].index);
      const r = e.flip(l[1].index);
      must(r.status === 'match', `第 ${k + 1} 次应 match，实际 ${r.status}`);
    }
    const s = e.stats();
    must(s.combo === 3, `连续 3 次 match 后 combo = ${s.combo}，期望 3`);
    must(s.bestCombo >= 3, `bestCombo = ${s.bestCombo}，期望 ≥ 3`);
    return `combo=${s.combo} bestCombo=${s.bestCombo}`;
  });

  check('固定牌序全自动通关（同型配对策略）', () => {
    const rng = mulberry32(20260101);
    const g = playFullGame(Engine, 'same', rng);
    return `12 对清空, ${g.guard} 步操作, 分数 ${g.st.score}, ${g.st.moves} 步`;
  });

  check('固定牌序全自动通关（合并优先策略）', () => {
    const g = playFullGame(Engine, 'merge', mulberry32(7));
    must(g.merges >= 1, '合并优先策略下一局都没触发 merge');
    return `12 对清空, 触发 merge ${g.merges} 次, 分数 ${g.st.score}`;
  });

  check('随机 200 局全自动通关（含随机合并）', () => {
    const rng = mulberry32(987654321);
    let totalScore = 0, merges = 0, minScore = Infinity;
    const dist = { 0: 0, 2: 0, 4: 0 };
    for (let i = 0; i < 200; i++) {
      try {
        const g = playFullGame(Engine, 'random', rng);
        totalScore += g.st.score;
        merges += g.st.mergeCount;
        dist[g.st.mergeCount] = (dist[g.st.mergeCount] || 0) + 1;
        minScore = Math.min(minScore, g.st.score);
      } catch (e) {
        throw new Error(`第 ${i + 1} 局失败：${short(e)}`);
      }
    }
    return `200/200 通关, 平均分 ${Math.round(totalScore / 200)}, 最低分 ${minScore}, mergeCount 分布 ${JSON.stringify(dist)}（合计 ${merges} 次）`;
  });

  check('stats() 字段齐全 + API 表面完整', () => {
    const e = new Engine();
    for (const k of ['reset', 'getCards', 'flip', 'unflipPending', 'stats', 'isWon', 'stars']) {
      must(typeof e[k] === 'function', `缺少方法 ${k}()`);
    }
    const st = e.stats();
    for (const k of STAT_KEYS) must(k in st, `stats() 缺字段 ${k}`);
    must(st.matchedPairs === 0 && st.moves === 0 && st.score === 0, `新引擎统计不为零：${JSON.stringify(st)}`);
    must(typeof e.isWon() === 'boolean', 'isWon() 应返回 boolean');
    must(e.isWon() === false, '新引擎 isWon() 应为 false');
    must(typeof e.stars() === 'number', 'stars() 应返回 number');
    e.reset();
    must(e.getCards().length === 24, 'reset() 后牌数应为 24');
    return STAT_KEYS.join('/') + ' 齐全';
  });
}

/* ══════════════════════════ 4. HTML / DOM ══════════════════════════ */

const REQUIRED_IDS = ['app', 'screen-start', 'board', 'hud', 'hud-moves', 'hud-time', 'hud-score', 'btn-mute', 'overlay-layer', 'screen-win'];
const SCRIPT_ORDER = ['js/flag.js', 'js/engine.js', 'js/audio.js', 'js/merge-effect.js', 'js/ui.js'];

function normSrc(s) { return s.trim().replace(/^\.\//, ''); }

function sectionHtml() {
  group('4. HTML / DOM 契约');
  const html = readText('index.html');
  const uiJs = readText('js/ui.js') || '';
  if (html == null) {
    fail('index.html 存在', '文件不存在（ui-shell 尚未产出）');
    return;
  }
  pass('index.html 存在', `${html.length} 字符`);

  check('script 顺序 = flag → engine → audio → merge-effect → ui', () => {
    const srcs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => normSrc(m[1]));
    must(srcs.length > 0, 'index.html 里没有任何 <script src>');
    const idx = SCRIPT_ORDER.map((s) => srcs.findIndex((x) => x === s));
    const miss = SCRIPT_ORDER.filter((s, i) => idx[i] === -1);
    must(miss.length === 0, `缺少 script 标签：${miss.join(', ')}（实际顺序：${srcs.join(' → ')}）`);
    for (let i = 1; i < idx.length; i++) {
      must(idx[i] > idx[i - 1], `顺序错误：${SCRIPT_ORDER[i]} 必须在 ${SCRIPT_ORDER[i - 1]} 之后（实际：${srcs.join(' → ')}）`);
    }
    return srcs.join(' → ');
  });

  check('DOM 契约 id 齐全（10 个）', () => {
    const absent = [];
    const dynamic = [];
    for (const id of REQUIRED_IDS) {
      const re = new RegExp(`id\\s*=\\s*["']${id}["']`);
      if (re.test(html)) continue;
      if (new RegExp(`["']${id}["']`).test(uiJs)) { dynamic.push(id); continue; }
      absent.push(id);
    }
    must(absent.length === 0, `index.html 里找不到：#${absent.join(' #')}`);
    return dynamic.length ? `静态 ${REQUIRED_IDS.length - dynamic.length} 个，动态生成 ${dynamic.join('/')}` : '全部静态存在';
  });

  check('启动入口 PDT.UI.boot() 已挂上', () => {
    must(/PDT\.UI\.boot\s*\(/.test(html), 'index.html 里没有 PDT.UI.boot() 调用（契约 §2）');
    must(/DOMContentLoaded/.test(html) || /defer|DOMContentLoaded/.test(html), '没有在 DOMContentLoaded 后启动');
    return 'DOMContentLoaded → PDT.UI.boot()';
  });

  check('index.html 无内联 ES module', () => {
    must(!/<script\b[^>]*type\s*=\s*["']?module/i.test(html), '出现 <script type="module">（file:// 下会挂）');
    return '无 type="module"';
  });

  check('引用的 css/js 文件存在', () => {
    const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+\.(?:css|js|webmanifest))["']/gi)].map((m) => normSrc(m[1]));
    const gone = refs.filter((r) => !/^(https?:)?\/\//i.test(r) && !exists(r));
    must(gone.length === 0, `引用但文件不存在：${gone.join(', ')}`);
    return refs.length ? refs.join(', ') : '无 css/js 引用';
  });

  const cssText = listDir('css', (f) => f.endsWith('.css')).map((f) => readText(`css/${f}`) || '').join('\n');
  const frontEnd = `${html}\n${uiJs}\n${cssText}`;

  check('牌面结构 .card > .card-inner > .card-back/.card-front + data-type/data-index', () => {
    const need = ['card-inner', 'card-back', 'card-front', 'data-type', 'data-index'];
    const lost = need.filter((t) => !frontEnd.includes(t));
    must(lost.length === 0, `缺：${lost.join(', ')}（契约 §5.5 的牌面 DOM 结构）`);
    return need.join(' + ');
  });

  check('牌桌响应式：竖屏 4 列 / 宽屏 6 列，牌面 aspect-ratio 1', () => {
    must(/repeat\(\s*4\s*,/.test(cssText), 'CSS 里没有 4 列网格（移动端竖屏 4×6）');
    must(/repeat\(\s*6\s*,/.test(cssText), 'CSS 里没有 6 列网格（横屏/宽屏 6×4）');
    must(/aspect-ratio\s*:\s*1/.test(cssText), 'CSS 里没有 aspect-ratio: 1（牌面必须是正方形）');
    return '4 列 / 6 列 / aspect-ratio:1 均在';
  });

  check('#overlay-layer 为全屏 pointer-events:none 特效层', () => {
    const scope = `${cssText}\n${html}\n${uiJs}`;
    must(/overlay-layer/.test(scope), '没有任何地方定义 #overlay-layer');
    const hasPE = /overlay-layer[\s\S]{0,600}?pointer-events\s*:\s*none/i.test(scope) ||
      /pointer-events\s*:\s*none[\s\S]{0,600}?overlay-layer/i.test(scope) ||
      /overlay-layer/.test(cssText) && /pointer-events\s*:\s*none/i.test(cssText);
    must(hasPE, '没找到 overlay-layer 的 pointer-events:none（会挡住牌桌点击）');
    return 'pointer-events:none 已设';
  });
}

/* ══════════════════════════ 5. 资源文件 ══════════════════════════ */

const IMG_REQUIRED = [
  'assets/img/cards/parachute.png',
  'assets/img/cards/trunks.png',
  'assets/img/cards/kebab.png',
  'assets/img/cards/balloon.png',
  'assets/img/cards/grin.png',
  'assets/img/scene/cardback.png',
  'assets/img/scene/bg.png',
  'assets/img/scene/bg-win.png',
  'assets/img/merge/spark.png',
];
const SVG_REQUIRED = ['assets/flag/turkish-flag.svg'];
const AUDIO_REQUIRED = [
  'assets/audio/bgm.ogg',
  'assets/audio/flip.ogg',
  'assets/audio/match.ogg',
  'assets/audio/merge.ogg',
  'assets/audio/win.ogg',
  'assets/audio/mismatch.ogg',
  'assets/audio/click.ogg',
];
const SQUARE_REQUIRED = new Set([
  'assets/img/cards/parachute.png', 'assets/img/cards/trunks.png', 'assets/img/cards/kebab.png',
  'assets/img/cards/balloon.png', 'assets/img/cards/grin.png',
  'assets/img/scene/cardback.png', 'assets/img/merge/spark.png',
]);

function pngInfo(rel) {
  const abs = path.join(ROOT, rel);
  const buf = Buffer.alloc(33);
  const fd = fs.openSync(abs, 'r');
  try { fs.readSync(fd, buf, 0, 33, 0); } finally { fs.closeSync(fd); }
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { ok: false };
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return { ok: false };
  return { ok: true, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const REF_EXT = 'png|jpe?g|webp|gif|ogg|mp3|wav|m4a|svg|webmanifest';
const REF_RE = new RegExp(
  '(?:^|[\\s"\'`(\\[=,:;])((?:\\.{0,2}\\/)?[A-Za-z0-9_@.\\-]+(?:\\/[A-Za-z0-9_@.\\-]+)*\\.(?:' + REF_EXT + '))(?![A-Za-z0-9])',
  'gi'
);

function resolveRef(ref, fromFile) {
  const clean = ref.replace(/[?#].*$/, '');
  const cands = [
    path.resolve(ROOT, clean),
    path.resolve(path.dirname(path.join(ROOT, fromFile)), clean),
  ];
  return cands.find((p) => fs.existsSync(p)) || null;
}

function sectionAssets() {
  group('5. 资源文件');

  // 5a. 契约 §4 必须存在清单：图片类允许缺失（记为 MISSING，不让 exit 1），svg/音频缺失算 FAIL
  for (const rel of IMG_REQUIRED) {
    if (!exists(rel)) { missing(rel, '图片未就绪（art-cards/art-scene 出图中）'); continue; }
    const info = pngInfo(rel);
    if (!info.ok) { fail(rel, '不是有效 PNG（签名/IHDR 校验失败）'); continue; }
    if (SQUARE_REQUIRED.has(rel) && info.w !== info.h) {
      fail(rel, `尺寸 ${info.w}x${info.h}，契约要求 1:1 正方形`);
      continue;
    }
    pass(rel, `${info.w}x${info.h}`);
  }
  for (const rel of SVG_REQUIRED) {
    if (!exists(rel)) { fail(rel, '文件不存在（flag-engineer 产出，非 AI 图，缺了就是缺了）'); continue; }
    const t = readText(rel);
    const okSvg = !!t && /<svg\b/i.test(t);
    if (!okSvg) fail(rel, '文件存在但不是合法 SVG 文本');
    else pass(rel, `${t.length} 字符`);
  }
  for (const rel of AUDIO_REQUIRED) {
    if (exists(rel)) { pass(rel, `${fs.statSync(path.join(ROOT, rel)).size} B`); continue; }
    const alt = ['.mp3', '.wav'].map((e) => rel.replace(/\.ogg$/, e)).filter((p) => exists(p));
    fail(rel, alt.length ? `缺 .ogg，只有 ${alt.join('/')}（契约要求优先 .ogg）` : '文件不存在（audio-design 尚未产出）');
  }

  // 5b. 源码里实际引用的相对资源路径
  const sources = [];
  const html = readText('index.html');
  if (html != null) sources.push(['index.html', html]);
  for (const f of listDir('css', (x) => x.endsWith('.css'))) sources.push([`css/${f}`, readText(`css/${f}`) || '']);
  for (const f of listDir('js', (x) => x.endsWith('.js'))) sources.push([`js/${f}`, readText(`js/${f}`) || '']);

  if (!sources.length) { fail('源码内资源引用扫描', '没有 index.html / css / js 可扫描'); return; }

  const seen = new Set();
  const bad = [];
  let checked = 0;
  let bare = 0;
  for (const [src, text] of sources) {
    const masked = maskComments(text, src.endsWith('.html'));
    REF_RE.lastIndex = 0;
    let m;
    while ((m = REF_RE.exec(masked))) {
      const ref = m[1].replace(/^\.\//, '');
      if (/^(https?:)?\/\//i.test(ref)) continue;
      if (ref.startsWith('/')) continue;
      if (!ref.includes('/')) { bare++; continue; } // 裸文件名（如 audio.js 里的 'bgm.ogg' 候选表）交给契约清单校验
      const key = `${src}::${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      checked++;
      if (!resolveRef(ref, src)) bad.push({ ref, src });
    }
  }
  const IMG_EXT = /\.(?:png|jpe?g|webp|gif)$/i;
  const refOf = (b) => b.ref;
  const badImg = bad.filter((b) => IMG_EXT.test(refOf(b)));
  const badHard = bad.filter((b) => !IMG_EXT.test(refOf(b)));
  for (const b of badImg) missing(`源码引用的图片 ${b.ref}`, `被 ${b.src} 引用但文件尚未产出（美术出图中，不阻塞 exit code）`);
  if (badHard.length) fail('源码引用的本地资源存在', `引用但文件不存在：${badHard.slice(0, 8).map((b) => `${b.ref}（${b.src}）`).join('; ')}${badHard.length > 8 ? ` …共 ${badHard.length} 条` : ''}`);
  else pass('源码引用的本地资源存在', `${checked} 条路径命中（图片未就绪 ${badImg.length} 条已单列；另有 ${bare} 个裸文件名跳过）`);
  if (!badImg.length && !badHard.length) pass('源码引用的图片素材齐全', `${checked} 条路径全部命中`);
}

/* ══════════════════════════ 6. 禁止项 ══════════════════════════ */

const FORBIDDEN = [
  { label: 'http(s):// 外链', re: /https?:\/\//gi },
  { label: '协议相对外链 //', re: /(?:^|[^:\w/])\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?=[/"'\s)]|$)/gi },
  { label: 'cdn. 外链', re: /\bcdn\./gi },
  { label: '转义形式外链 https:\\/\\/', re: /https?:\\\/\\\//gi },
];
const ES_IMPORT = /(?:^|[\s;{}()])import\s*(?:[({'"]|[\w$*]+\s+from\b)/g;
const ES_EXPORT = /(?:^|[\s;{}])export\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|\{)/g;

function sectionForbidden() {
  group('6. 禁止项（外链 / ES module）');
  const files = [];
  const html = readText('index.html');
  if (html != null) files.push(['index.html', html, true]);
  for (const f of listDir('css', (x) => x.endsWith('.css'))) files.push([`css/${f}`, readText(`css/${f}`) || '', false]);
  for (const f of listDir('js', (x) => x.endsWith('.js'))) files.push([`js/${f}`, readText(`js/${f}`) || '', false]);
  if (!files.length) { fail('禁止项扫描', '没有可扫描的 index.html / css / js'); return; }

  for (const [src, text, isHtml] of files) {
    const masked = maskComments(text, isHtml);
    for (const { label, re } of FORBIDDEN) {
      const hits = grepAll(masked, text, re);
      if (!hits.length) { pass(`${src} 无${label}`); continue; }
      const ns = hits.filter((h) => isNamespaceUri(masked, h.index));
      const rest = hits.filter((h) => !isNamespaceUri(masked, h.index));
      if (ns.length) note(`${src} ${label}：XML 命名空间`, `${ns.length} 处 www.w3.org 命名空间声明（SVG/XML 必需，不会联网取资源）`);
      if (!rest.length) { pass(`${src} 无${label}`); continue; }
      const loading = rest.filter((h) => isLoadingContext(masked, h.index));
      const cite = rest.filter((h) => !isLoadingContext(masked, h.index) && isCitationContext(masked, h.index));
      const literal = rest.filter((h) => !isLoadingContext(masked, h.index) && !isCitationContext(masked, h.index));
      if (loading.length) fail(`${src} 无${label}（真的会加载）`, describeHits(loading));
      else if (literal.length) fail(`${src} 无${label}（非注释字面量）`, `${describeHits(literal)} —— lead 口径：出处 URL 只允许出现在注释里`);
      else pass(`${src} 无${label}`, `${cite.length} 处位于 sources/依据 数据字段，不加载、不算外链资源`);
    }
    const imp = grepAll(masked, text, ES_IMPORT);
    const exp = isHtml ? [] : grepAll(masked, text, ES_EXPORT);
    if (imp.length || exp.length) {
      fail(`${src} 无 ES module 语法`, `import: ${describeHits(imp) || '无'} ; export: ${describeHits(exp) || '无'}`);
    } else pass(`${src} 无 import / export`);
  }
}

/* ══════════════════════════ 7. 运行入口与命名空间 ══════════════════════════ */

const NS_EXPECT = {
  'js/audio.js': { ns: /PDT\.Audio\s*=/, methods: ['init', 'play', 'musicPlay', 'musicStop', 'musicToggle', 'setMuted', 'isMuted'] },
  'js/merge-effect.js': { ns: /PDT\.Merge\s*=/, methods: ['play'] },
  'js/ui.js': { ns: /PDT\.UI\s*=/, methods: ['boot'] },
};

function sectionRuntime() {
  group('7. 运行入口与命名空间');
  for (const rel of ['js/flag.js', 'js/engine.js']) {
    if (!exists(rel)) { fail(`node ${rel} 可执行`, '文件不存在'); continue; }
    const r = spawnSync(process.execPath, [path.join(ROOT, rel)], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    if (r.error) fail(`node ${rel} 可执行`, short(r.error));
    else if (r.status !== 0) fail(`node ${rel} 可执行`, (r.stderr || r.stdout || '非零退出').trim().split('\n').slice(0, 3).join(' | '));
    else pass(`node ${rel} 可执行（不报错）`);
  }
  for (const [rel, spec] of Object.entries(NS_EXPECT)) {
    const t = readText(rel);
    if (t == null) { fail(`${rel} 命名空间`, '文件不存在'); continue; }
    const masked = maskComments(t, false);
    if (!spec.ns.test(masked)) { fail(`${rel} 命名空间`, `没找到 PDT.${rel.includes('audio') ? 'Audio' : rel.includes('merge') ? 'Merge' : 'UI'} 的赋值（契约 §5 要求统一命名空间）`); continue; }
    const lost = spec.methods.filter((m) => !new RegExp(`[.\\s]${m}\\s*[:=(]`).test(masked));
    if (lost.length) fail(`${rel} API 方法`, `没找到：${lost.join(', ')}`);
    else pass(`${rel} 命名空间 + API`, spec.methods.join('/'));
  }
  const ui = readText('js/ui.js');
  if (ui != null) {
    const masked = maskComments(ui, false);
    if (!/overlay-layer/.test(masked)) fail('js/ui.js 引用 #overlay-layer', '契约 §5.5 要求 merge 时把特效挂到 #overlay-layer');
    else if (!/PDT\.Merge\.play/.test(masked)) fail('js/ui.js 调用 PDT.Merge.play', 'merge 时没调用特效模块');
    else pass('js/ui.js 接入 merge 特效', '#overlay-layer + PDT.Merge.play');
    if (!/PDT\.Audio/.test(masked)) fail('js/ui.js 调用 PDT.Audio', '翻牌/配对/删除音效没接上');
    else pass('js/ui.js 接入音频', 'PDT.Audio.*');
    // flip 返回的五种 status 是否都被 UI 处理（契约 §5.2 枚举）
    const STATUSES = ['flipped', 'match', 'merge', 'mismatch', 'ignore'];
    const notHandled = STATUSES.filter((s) => !new RegExp(`['"]${s}['"]`).test(masked));
    if (notHandled.length) fail('js/ui.js 处理全部 flip status', `没找到分支：${notHandled.join(', ')}`);
    else pass('js/ui.js 处理全部 flip status', STATUSES.join('/'));
  }
  // 兄弟交付的说明文档（contract §1 写范围，不阻塞 exit code）
  for (const rel of ['docs/ENGINE-NOTES.md', 'docs/FLAG-SPEC.md', 'README.md']) {
    if (exists(rel)) pass(`${rel} 已交付`, `${fs.statSync(path.join(ROOT, rel)).size} B`);
    else note(`${rel} 未交付`, '属 contract §1 写范围内的交付物，但不影响功能验收（不计入 FAIL）');
  }
}

/* ══════════════════════════ 主流程 ══════════════════════════ */

sectionStatic();
sectionFlag();
sectionEngine();
sectionHtml();
sectionAssets();
sectionForbidden();
sectionRuntime();

const nPass = results.filter((r) => r.kind === 'pass').length;
const nFail = results.filter((r) => r.kind === 'fail').length;
const nMiss = results.filter((r) => r.kind === 'missing').length;
const nNote = results.filter((r) => r.kind === 'note').length;
const fails = results.filter((r) => r.kind === 'fail');
const missings = results.filter((r) => r.kind === 'missing');
const notes = results.filter((r) => r.kind === 'note');
const exitCode = nFail > 0 || (OPT.strict && nMiss > 0) ? 1 : 0;

if (OPT.json) {
  console.log(JSON.stringify({
    pass: nPass, fail: nFail, missing: nMiss, note: nNote,
    ready: nFail === 0 && nMiss === 0,
    fails: fails.map((r) => `${r.name} — ${r.detail}`),
    missings: missings.map((r) => `${r.name} — ${r.detail}`),
    notes: notes.map((r) => `${r.name} — ${r.detail}`),
    at: new Date().toISOString(),
  }, null, 2));
  process.exit(exitCode);
}

const groups = [...new Set(results.map((r) => r.group))]
  .sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

console.log(`${C.b}派大星的衣柜 · QA verify${C.x}  ${C.d}${ROOT}${C.x}`);
console.log(`${C.d}${new Date().toISOString()}  node ${process.version}${OPT.strict ? '  [strict]' : ''}${C.x}`);

for (const g of groups) {
  console.log(`${C.b}\n${g}${C.x}`);
  for (const r of results.filter((x) => x.group === g)) {
    const mark = r.kind === 'pass' ? `${C.g}✔${C.x}`
      : r.kind === 'missing' ? `${C.r}✘MISSING${C.x}`
        : r.kind === 'note' ? `${C.y}⚠${C.x}` : `${C.r}✘${C.x}`;
    console.log(`  ${mark} ${r.name}${r.detail ? `  ${C.d}— ${r.detail}${C.x}` : ''}`);
  }
}

console.log('');
if (nFail) {
  console.log(`${C.r}${C.b}FAIL 明细（${nFail}）${C.x}`);
  for (const r of fails) console.log(`  ${C.r}✘${C.x} [${r.group}] ${r.name}: ${r.detail}`);
}
if (nMiss) {
  console.log(`${C.r}${C.b}MISSING 明细（${nMiss}，图片类不阻塞 exit code）${C.x}`);
  for (const r of missings) console.log(`  ${C.r}✘MISSING${C.x} ${r.name}: ${r.detail}`);
}
if (nNote) {
  console.log(`${C.y}${C.b}注意（${nNote}，不阻塞）${C.x}`);
  for (const r of notes) console.log(`  ${C.y}⚠${C.x} ${r.name}: ${r.detail}`);
}
console.log(`\n${C.b}PASS ${nPass} / FAIL ${nFail}${nMiss ? ` / MISSING ${nMiss}` : ''}${nNote ? ` / NOTE ${nNote}` : ''}${C.x}`);
process.exit(exitCode);
