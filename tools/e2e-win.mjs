/**
 * tools/e2e-win.mjs —— 自动通关验收：从头玩到通关界面，检查星级/统计/再来一局。
 * 依赖一个已在跑的本���服务器（tools/serve.ps1）。
 *   node tools/e2e-win.mjs [url] [outDir]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_GAME = process.argv[2] || 'http://127.0.0.1:8080/';
const OUT = process.argv[3] || path.resolve('docs/ref');
const PORT = 9334;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const profile = path.join(os.tmpdir(), 'pdt-win-' + Date.now());

const child = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--mute-audio',
   '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'],
  { stdio: 'ignore' }
);

async function waitDevtools() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(150);
  }
  throw new Error('devtools 没起来');
}

const ws = new WebSocket(await waitDevtools());
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    errors.push('EXCEPTION ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    errors.push('LOG ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
async function ev(expr, gesture = false) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: gesture });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('  📸 ' + name);
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: URL_GAME });
  await sleep(2500);

  console.log('开始游戏');
  await ev(`document.querySelector('#btn-start').click()`, true);
  await sleep(1000);

  // 状态驱动的自动解题：每步现读棋盘，点两张同型（或 flag+parachute 合并），
  // 然后轮询等这两张变成 .gone，再做下一步。比她慢但稳。
  const readBoard = () =>
    ev(`(() => [...document.querySelectorAll('.card')].map(c => ({
      i: +c.dataset.index, t: c.dataset.type,
      gone: c.classList.contains('gone') || c.classList.contains('matched') || c.classList.contains('merged')
    })))()`);

  const dumpClasses = await ev(`[...new Set([...document.querySelectorAll('.card')].map(c => c.className))].slice(0,5)`);
  console.log('  牌元素 class 形态:', JSON.stringify(dumpClasses));

  let moves = 0;
  for (let guard = 0; guard < 40; guard++) {
    const cards = await readBoard();
    const alive = cards.filter((c) => !c.gone);
    if (alive.length === 0) break;

    const by = {};
    for (const c of alive) (by[c.t] ||= []).push(c.i);
    let a = null, b = null;
    for (const t of Object.keys(by)) {
      if (by[t].length >= 2) { a = by[t][0]; b = by[t][1]; break; }
    }
    if (a === null) {
      // 只剩 flag 与 parachute 各 1 张 -> 跨类合并
      const f = by.flag?.[0], p = by.parachute?.[0];
      if (f != null && p != null) { a = f; b = p; }
      else { console.log('  ⚠ 无法继续，剩余:', JSON.stringify(by)); break; }
    }

    await ev(`(() => {
      const A = document.querySelector('.card[data-index="${a}"]');
      const B = document.querySelector('.card[data-index="${b}"]');
      if (A) A.click(); if (B) B.click();
    })()`, true);
    moves++;

    // 等这两张真的消失（合并特效会慢一些）
    let ok = false;
    for (let w = 0; w < 30; w++) {
      await sleep(200);
      const st = await ev(`(() => {
        const A = document.querySelector('.card[data-index="${a}"]');
        const B = document.querySelector('.card[data-index="${b}"]');
        const g = (el) => !el || el.classList.contains('gone') || el.classList.contains('matched') || el.classList.contains('merged');
        return g(A) && g(B) ? 'gone' : 'wait';
      })()`);
      if (st === 'gone') { ok = true; break; }
    }
    if (!ok) console.log('  ⚠ 第' + moves + '步 ' + a + '+' + b + ' 没消除');
    if (moves === 6) await shot('win-1-midgame.png');
  }

  await sleep(2400);

  const state = await ev(`(() => ({
    remaining: [...document.querySelectorAll('.card')].filter(c => !c.classList.contains('gone')).length,
    winVisible: (() => { const w = document.querySelector('#screen-win'); if (!w) return 'no-el';
      const s = getComputedStyle(w); return (s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.1) ? 'visible' : 'hidden(' + s.display + ',' + s.opacity + ')'; })(),
    winText: (document.querySelector('#screen-win')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 220),
    hud: { moves: document.querySelector('#hud-moves')?.textContent, time: document.querySelector('#hud-time')?.textContent, score: document.querySelector('#hud-score')?.textContent },
    stars: document.querySelectorAll('#screen-win .star, #screen-win [class*=star]').length,
    best: (() => { try { return localStorage.getItem('pdt_best_v1'); } catch (e) { return 'err'; } })()
  }))()`);
  console.log('  通关状态:', JSON.stringify(state, null, 0));
  await shot('win-2-win-screen.png');

  console.log('点「再来一局」');
  const restart = await ev(`(() => { const b = document.querySelector('#btn-restart'); if (!b) return 'no-btn'; b.click(); return 'ok'; })()`, true);
  console.log('  restart:', restart);
  await sleep(1400);
  const after = await ev(`(() => ({
    cards: document.querySelectorAll('.card').length,
    winVisible: (() => { const w = document.querySelector('#screen-win'); if (!w) return 'no-el'; const s = getComputedStyle(w); return (s.display !== 'none' && +s.opacity > 0.1) ? 'visible' : 'hidden'; })(),
    hud: { moves: document.querySelector('#hud-moves')?.textContent, time: document.querySelector('#hud-time')?.textContent, score: document.querySelector('#hud-score')?.textContent }
  }))()`);
  console.log('  重开状态:', JSON.stringify(after));
  await shot('win-3-restart.png');

  console.log('\n控制台错误:');
  console.log(errors.length ? errors.slice(0, 10).map((e) => '  ✘ ' + e).join('\n') : '  ✔ 无');
} catch (e) {
  console.error('失败:', e.message);
  process.exitCode = 1;
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

