# 派大星的衣柜 · 接口契约（唯一事实来源）

> 所有子 agent 必须遵守本文件。**不要修改本文件**（只有 Lead 能改）。
> 有冲突：以本文件为准；如确实需要改动，发消息给 lead。

## 0. 项目定位

H5 记忆翻牌小游戏「派大星的衣柜」：24 张牌，翻两张，图案相同即消除。
隐藏奖励：翻到 **土耳其国旗** + **派大星降落伞** 这一跨类组合时，触发全屏「星月与派大星重合」叠图特效，双方合并消除并加分。

纯前端、零构建、零依赖、可直接双击 `index.html` 打开，也可用本地 http 服务器访问。

## 1. 目录与写权限（严禁越界写别人的文件）

| 负责人 | 独占写范围 |
|---|---|
| lead | `docs/CONTRACT.md`、`README.md`、`tools/serve.ps1` |
| flag-engineer | `js/flag.js`、`js/merge-effect.js`、`assets/flag/**`、`docs/FLAG-SPEC.md` |
| game-core | `js/engine.js`、`docs/ENGINE-NOTES.md` |
| ui-shell | `index.html`、`css/**`、`js/ui.js` |
| audio-design | `js/audio.js`、`assets/audio/**` |
| art-cards | `assets/img/cards/**` |
| art-scene | `assets/img/scene/**`、`assets/img/merge/**` |
| qa-verify | `tools/**`（除 serve.ps1） |

只读范围：整个仓库。**不要**创建本表之外的顶层文件。

## 2. 剧本加载顺序（ui-shell 在 index.html 里固定这些 script 标签）

```html
<script src="js/flag.js"></script>
<script src="js/engine.js"></script>
<script src="js/audio.js"></script>
<script src="js/merge-effect.js"></script>
<script src="js/ui.js"></script>
<script>
  window.addEventListener('DOMContentLoaded', function () { PDT.UI.boot(); });
</script>
```

统一命名空间：`window.PDT = window.PDT || {};`
**普通脚本，不要用 ES module / import / export**（保证 file:// 也能跑）。
每个文件都必须能在自己缺失依赖时优雅降级（例如 `js/ui.js` 里 `if (!window.PDT.Flag) { 用兜底绘制 }`）。

## 3. 卡牌类型表（6 种，全队唯一真相）

| type | 中文名 | 图案来源 |
|---|---|---|
| `flag` | 土耳其国旗 | **严格矢量**（`PDT.Flag`），不用 AI 图 |
| `parachute` | 派大星降落伞 | `assets/img/cards/parachute.png` |
| `trunks` | 粉色大裤衩 | `assets/img/cards/trunks.png` |
| `kebab` | 土耳其烤肉 | `assets/img/cards/kebab.png` |
| `balloon` | 卡帕多奇亚热气球 | `assets/img/cards/balloon.png` |
| `grin` | 派大星憨笑 | `assets/img/cards/grin.png` |

牌堆：**24 张 = 每个 type 各 4 张 = 12 对**。
同 type 两张翻开 => 普通配对消除。
`flag` 与 `parachute` 组合 => **特殊合并**（不是普通配对，无视各自的同类牌）。

## 4. 资源清单（文件名写死，谁产出谁负责）

图片（正方形 1:1，主体居中，纯色/淡色背景，不需要透明通道）：

- `assets/img/cards/parachute.png` — art-cards
- `assets/img/cards/trunks.png` — art-cards
- `assets/img/cards/kebab.png` — art-cards
- `assets/img/cards/balloon.png` — art-cards
- `assets/img/cards/grin.png` — art-cards
- `assets/img/scene/cardback.png` — art-scene（牌背图案，1:1）
- `assets/img/scene/bg.png` — art-scene（主背景，16:9 或 2:3 都可，将被 cover 铺满）
- `assets/img/scene/bg-win.png` — art-scene（通关背景，16:9）
- `assets/img/merge/spark.png` — art-scene（重合特效用的光斑/粒子贴图，1:1，深色背景会做加法混合）
- `assets/flag/turkish-flag.svg` — flag-engineer

音频（`assets/audio/`，优先 `.ogg`，可同时产出 `.mp3`）：

- `bgm.ogg` — 欢快土耳其风循环 BGM，≥30s，可无缝 loop
- `flip.ogg`（翻牌）、`match.ogg`（配对成功）、`merge.ogg`（重合特效，约 2.5s）、`win.ogg`（通关）、`mismatch.ogg`（配错）、`click.ogg`（UI 点击）

**约定**：如果某个资源没就绪，UI/音频层必须用兜底（CSS 渐变占位 / WebAudio 合成音），
不允许因为缺图缺音而白屏或报错。

## 5. 模块 API（必须严格实现，签名不可改）

### 5.1 `PDT.Flag`（flag-engineer）

```js
PDT.Flag.SPEC            // { red: '#E30A17', ratio: 1.5, ... 关键几何常数 + 法条依据 }
PDT.Flag.svgString(w, h) // 返回严格土耳其国旗的 SVG 字符串；宽高比锁定 2:3（h:w = 2:3）
PDT.Flag.draw(canvas, w, h) // 把严格国旗画进 canvas（等比居中，绝不拉伸变形）
PDT.Flag.selfCheck()     // 返回 {ok:boolean, detail:[...]}，自检几何比例
```

要求：红色取官方 Pantone 186C ≈ `#E30A17`；月牙与五角星按土耳其国旗法（Law No. 2893）几何构造；
**任何情况下不得拉伸**（只能等比缩放 + 留边），星星必须是正五角星且一角朝上。

### 5.2 `PDT.Engine`（game-core）

```js
var e = new PDT.Engine();          // 默认 24 张、每种 4 张、随机洗牌（可传 opts 便于测试）
e.reset();
e.getCards();   // [{index, type, art, state:'down'|'up'|'matched'|'merged'}]（返回副本）
e.flip(index);  // -> {status, indices, type, points, combo, ...}
   // status 取值： 'ignore' | 'flipped' | 'match' | 'merge' | 'mismatch'
e.unflipPending(); // mismatch 动画结束后由 UI 调用，把两张翻回去
e.stats();      // {moves, matchedPairs, totalPairs, score, combo, bestCombo, elapsedMs, mergeCount}
e.isWon();      // 12 对（含 1 次合并）全部清空
e.stars();      // 1~3 星评价
```

规则细节：
- 已经翻开 / 已消除的牌 `flip()` 返回 `{status:'ignore'}`。
- `match` / `merge` 后引擎**自动**把这些牌标记为已消除，UI 只负责播动画。
- 特殊合并：两次翻开分别是 `flag` 与 `parachute` => `status:'merge'`，基础分 300 + 连击加成，`mergeCount++`。
- 连续配对成功累计 `combo`，配错清零。普通配对基础分 100 × (1 + combo*0.25) 取整。
- `elapsedMs` 从第一次翻牌开始计时（引擎内部用 Date.now，`stats()` 实时读）。
- **必须能被 node 直接跑通**：文件末尾加

```js
if (typeof module !== 'undefined' && module.exports) { module.exports = window.PDT.Engine; }
```

（用 `globalThis`/`window` 兼容写法，确保 `node js/engine.js` 不报错。）

### 5.3 `PDT.Audio`（audio-design）

```js
PDT.Audio.init();        // 首次用户手势里调用；内部做 WebAudio unlock，返回 Promise
PDT.Audio.play(name);    // 'flip'|'match'|'merge'|'win'|'mismatch'|'click'；缺失时静默或用合成音兜底
PDT.Audio.musicPlay();   // 播放 BGM（loop）
PDT.Audio.musicStop();
PDT.Audio.musicToggle(); // 返回当前是否播放
PDT.Audio.setMuted(bool);
PDT.Audio.isMuted();
```

只允许用 `new Audio(...)` / WebAudio，不允许引入第三方库。文件候选列表按 `.ogg` -> `.mp3` -> `.wav` 顺序探测。

### 5.4 `PDT.Merge`（flag-engineer）

```js
PDT.Merge.play(hostEl, { duration: 2600 }) // -> Promise，动画结束 resolve
```

`hostEl` 是一个全屏且 `pointer-events:none` 的容器（由 ui-shell 提供并保证 z-index 最高）。
内部自建 canvas，画布像素比按 devicePixelRatio 适配，窗口 resize 要能自适应或至少不崩。
内容要点：派大星降落伞升起 -> 严格国旗的月牙与五角星「融」进伞面并完美重合 -> 光斑爆开 -> 淡出。
结束后必须自行清理 DOM 和 canvas。

### 5.5 `PDT.UI`（ui-shell）

```js
PDT.UI.boot();   // 挂载整个应用，幂等（重复调用不重复挂载）
```

DOM 契约（QA 会按这个查）：

- `#app` 根容器
- `#screen-start`（开始界面，含标题/开始按钮/玩法说明）
- `#board`（牌桌，`grid` 布局，24 个 `.card` 子元素）
- `.card[data-type][data-index]` > `.card-inner` > `.card-back` + `.card-front`
- `#hud`（步数 `#hud-moves`、时间 `#hud-time`、分数 `#hud-score`、静音按钮 `#btn-mute`）
- `#overlay-layer`（全屏特效层，`pointer-events:none`，`z-index` 高于牌桌）
- `#screen-win`（通关界面，含星级、统计、再来一局）

交互要点：牌桌支持点击与触摸；翻错后 ~700ms 自动翻回；`match`/`merge` 播完动画再让引擎标记完成（引擎已自动标记，UI 只播动画）；
`merge` 时调用 `PDT.Merge.play(document.getElementById('overlay-layer'))` 并播 `merge` 音效。
移动端竖屏 4 列 × 6 行，横屏/宽屏 6 列 × 4 行；牌面用 `aspect-ratio: 1`。

## 6. 美术风格统一（art-cards / art-scene 必读）

所有 AI 图统一风格前缀（保证 6 张牌摆一起不打架）：

> flat vector cartoon sticker illustration, thick clean dark outline, bold saturated colors, soft cel shading,
> single subject centered, simple flat pastel background, no text, no letters, no watermark, square 1:1 composition

- 不要照抄用户给的梗图；用描述重新生成（原创二次创作，海绵宝宝同人卡通风格）。
- 不要在图里写任何文字/字母/国旗文字。
- **绝对不要**让 AI 画土耳其国旗（会被画歪），国旗只能来自 `PDT.Flag`。
- 生成后自查：主体是否居中、是否有多余文字、是否明显跑题。跑题就重画。

## 7. 自测要求

- `js/flag.js` 与 `js/engine.js` 必须能被 node `require()`（模块顶层不得访问 `document`/`canvas`），
  以便 QA 在 node 里断言引擎规则与国旗几何。
- `node js/engine.js` 必须不报错。
- `node tools/verify.mjs`（qa-verify 产出）全部通过。
- 所有 JS 文件 `node --check <file>` 通过。
- 不引入任何外部 CDN / 网络字体；所有资源本地相对路径。
