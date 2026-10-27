/**
 * tools/e2e-screenshot.mjs —— Lead 用的真浏览器交互验收（零依赖，用 Chrome DevTools Protocol）
 *
 * 做的事：起一个 headless Chrome，打开本地服务器上的 index.html，真实点击：
 *   开始 → 记住两张牌（不配对）→ 配错 → 翻开「土耳其国旗」+「派大星降落伞」触发合并特效
 * 并在关键帧截图到 docs/ref/。
 *
 * 用法：
 *   pwsh -File tools/serve.ps1 -Port 8080     # 另开一个窗口
 *   node tools/e2e-screenshot.mjs [url] [outDir]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_GAME = process.argv[2] || 'http://127.0.0.1:8080/';
const OUT = process.argv[3] || path.resolve('docs/ref');
const PORT = 9333;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!CHROME) {
  console.error('找不到 Chrome/Edge');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const profile = path.join(os.tmpdir(), 'pdt-e2e-' + Date.now());

const child = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--window-size=414,896',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false }
);

async function waitDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(150);
  }
  throw new Error('devtools 没起来');
}

const wsUrl = await waitDevtools();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('EXCEPTION: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    consoleErrors.push('LOG: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  }
});

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr, userGesture = false) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    userGesture,
  });
  if (r.exceptionDetails) throw new Error('eval 失败: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const p = path.join(OUT, name);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('  📸 ' + p);
}

async function clickCard(index) {
  await evaluate(`(() => { const c = document.querySelector('.card[data-index="${index}"]'); if (!c) return 'no-card'; c.click(); return 'ok'; })()`, true);
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });

  await send('Page.navigate', { url: URL_GAME });
  await sleep(2500);

  console.log('阶段 1 · 开始界面');
  const bootOk = await evaluate(`!!(window.PDT && PDT.UI && PDT.Engine && PDT.Flag && PDT.Audio)`);
  console.log('  PDT 命名空间齐全:', bootOk);
  const cardCount0 = await evaluate(`document.querySelectorAll('.card').length`);
  console.log('  开局前 .card 数量:', cardCount0);
  await shot('e2e-1-start.png');

  console.log('阶段 2 · 点「开始翻牌」');
  await evaluate(`(() => { const b = document.querySelector('#btn-start'); if (!b) return 'no-btn'; b.click(); return 'ok'; })()`, true);
  await sleep(1200);
  const cardCount = await evaluate(`document.querySelectorAll('.card').length`);
  console.log('  牌桌 .card 数量:', cardCount, cardCount === 24 ? '✔' : '✘ 应该是 24');
  const types = await evaluate(`(() => { const m = {}; document.querySelectorAll('.card').forEach(c => { m[c.dataset.type] = (m[c.dataset.type]||0)+1; }); return m; })()`);
  console.log('  类型分布:', JSON.stringify(types));
  await shot('e2e-2-board.png');

  console.log('阶段 3 · 翻一张牌（看翻面动画 + 牌背）');
  const deck = await evaluate(`(() => [...document.querySelectorAll('.card')].map(c => ({ i: +c.dataset.index, t: c.dataset.type })))()`);
  const byType = {};
  for (const d of deck) (byType[d.t] ||= []).push(d.i);
  const flagIdx = byType.flag?.[0];
  const paraIdx = byType.parachute?.[0];
  const grinIdx = byType.grin?.[0];
  const kebabIdx = byType.kebab?.[0];
  console.log('  flag:', flagIdx, 'parachute:', paraIdx, 'grin:', grinIdx, 'kebab:', kebabIdx);
  await clickCard(flagIdx);
  await sleep(500);
  await shot('e2e-3-flag-flipped.png');

  console.log('阶段 4 · 配错（flag + grin），看回翻');
  await clickCard(grinIdx);
  await sleep(300);
  await shot('e2e-4-mismatch.png');
  await sleep(1200);
  const backDown = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.card')];
    const up = cards.filter(c => /(^|\\s)(is-)?(up|flipped|open)(\\s|$)/.test(c.className) || c.dataset.state === 'up').length;
    return up + ' | 样例class=' + (cards[0]?.className || '');
  })()`);
  console.log('  mismatch 后仍为 up 的牌数（应为 0）:', backDown);

  console.log('阶段 5 · 特殊合并：flag + parachute');
  await clickCard(flagIdx);
  await sleep(450);
  await clickCard(paraIdx);
  await sleep(900);
  await shot('e2e-5-merge-mid.png');
  await sleep(900);
  await shot('e2e-6-merge-late.png');
  await sleep(2200);
  const hud = await evaluate(`({
    moves: document.querySelector('#hud-moves')?.textContent?.trim(),
    time: document.querySelector('#hud-time')?.textContent?.trim(),
    score: document.querySelector('#hud-score')?.textContent?.trim()
  })`);
  console.log('  HUD 快照:', JSON.stringify(hud));
  const cleared = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.card')];
    const gone = cards.filter(c => /(matched|merged|gone|cleared|done|removed)/.test(c.className) || c.dataset.state === 'matched' || c.dataset.state === 'merged').length;
    return gone + ' | class样例=' + cards.slice(0, 3).map(c => c.className).join(' / ');
  })()`);
  console.log('  已消除牌数（合并应为 2）:', cleared);
  await shot('e2e-7-after-merge.png');

  console.log('阶段 6 · 横屏布局');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  await shot('e2e-8-landscape.png');

  console.log('\n控制台错误 / 异常:');
  if (consoleErrors.length === 0) console.log('  ✔ 无');
  else consoleErrors.slice(0, 20).forEach((e) => console.log('  ✘ ' + e));
} catch (e) {
  console.error('E2E 失败:', e.message);
  process.exitCode = 1;
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

