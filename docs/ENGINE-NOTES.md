# ENGINE-NOTES · 游戏逻辑引擎（js/engine.js）

> 实现者：game-core。契约：`docs/CONTRACT.md` §5.2（**未改动契约**）。
> 本文件记录：规则表、计分公式、星级阈值、自测输出摘要，以及三处需要 lead 拍板的契约歧义。

## 1. 形态与挂载

- 普通脚本（IIFE + `var g = typeof window !== 'undefined' ? window : globalThis`），**不用 ES module**，`file://` 可直接加载。
- 挂载 `window.PDT.Engine`；文件末尾 `if (typeof module !== 'undefined' && module.exports) module.exports = PDT.Engine;`
- `node js/engine.js` 无输出无报错；`node --check js/engine.js` 通过；`require()` 返回 Engine 构造函数。
- 模块顶层只做定义，不触碰 `document` / `canvas`（契约 §7）。

## 2. 牌堆

| 项 | 值 |
|---|---|
| 张数 | 24 = 6 种 × 4 张 = 12 对 |
| 类型 | `flag` `parachute` `trunks` `kebab` `balloon` `grin` |
| 洗牌 | Fisher-Yates（原地，`rng` 返回 [0,1)，越界自动兜回） |
| `index` | **恒等于牌桌数组位置**：`getCards()[i].index === i` |
| 卡面 | flag → `null`（UI 用 `PDT.Flag` 矢量画），其余 → `assets/img/cards/<type>.png` |

构造参数（都为测试方便，业务代码不传）：

```js
new PDT.Engine()                        // 默认 24 张随机洗牌
new PDT.Engine({ deck: [...], rng })    // 自定义牌堆（字符串或 {type}），默认保持给定顺序
new PDT.Engine({ deck, shuffle: true }) // 自定义牌堆并洗牌
new PDT.Engine({ now: () => 假时钟 })    // 注入时钟（测 elapsedMs）
```

> 洗牌实现细节：先建 24 张再 Fisher-Yates，**洗完之后统一重排 `index`**。
> 这一条是必须的 —— 早期版本保留了洗牌前的 index，导致 `flip(i)`（按位置）翻到的是另一张牌、同 type 被判成 `mismatch`（qa-verify 报的阻断 bug，已修，回归用例见 §8 的 0b 段）。

## 3. 规则表（flip 状态机）

`status` 严格 5 种，与契约 §5.2 一致。

| status | 触发条件 | 引擎副作用 | 返回值要点 |
|---|---|---|---|
| `ignore` | 非法 index（越界 / 小数 / NaN / 非数字串…）、牌已 `up`、已 `matched`/`merged`、或**上一次 `mismatch` 还没 `unflipPending()`** | 不改任何状态、不计步 | `points:0`；锁定时额外 `locked:true`、`reason:'pending-unresolved'` |
| `flipped` | 翻开本次第一张 | `state:'up'`，押入 pending；**首张翻牌启动计时** | `indices:[i]`、`type` |
| `match` | 两张同 `type` | 两张自动 `matched`，清 pending，加 100 分档，`combo++`、`matchedPairs++` | `points`、`comboBefore`、`combo` |
| `merge` | `flag` + `parachute`（顺序无关） | 两张自动 `merged`，清 pending，加 300 分档，`combo++`、`matchedPairs++`、`mergeCount++` | `type:'flag+parachute'` |
| `mismatch` | 其余组合 | 两张**保持 `up`**（等 UI 播完动画调 `unflipPending()`），`combo = 0` | `points:0`、`combo:0` |

补充：

- `flag`+`flag`、`parachute`+`parachute` 走**普通 match**，不是 merge（契约 §3）。
- `unflipPending()` 只处理「pending 恰为 2 张」的 mismatch，把两张翻回 `down` 并清 pending；没有待处理时安全空操作，返回 `{status:'none'}`。
- `isLocked()` 供 UI 判断是否正处于 mismatch 待翻回状态。
- 合并与配对共享同一套「每次只能同时翻开 2 张」的限制。

## 4. 计分公式

```
points = Math.round( BASE × (1 + comboBefore × 0.25) )
BASE   = 100（普通配对） / 300（flag+parachute 合并）
comboBefore = 这次配对**之前**已经连续成功的次数（0 起）
配对成功 => combo++ 且 bestCombo = max(bestCombo, combo)
配错     => combo = 0（分数不扣，全程单调不减）
```

取值都是 25 的整数倍（`Math.round` 与 `floor` 等价）：

| comboBefore | 0 | 1 | 2 | 3 | 4 | … | 11 |
|---|---|---|---|---|---|---|---|
| 配对得分 | 100 | 125 | 150 | 175 | 200 | … | 375 |
| 合并得分 | 300 | 375 | 450 | 525 | 600 | … | 1125 |

完美局（12 步全对，combo 0→11）总分 = **2850**。

## 5. 步数（moves）口径 —— ⚠ 与任务书的一处出入

- **实现**：每凑成两张并判定一次 `moves++`（`match` / `merge` / `mismatch` 都算一步）。
- 任务书原文把 `moves++` 只写在 `mismatch` 分支下。但那样「理想 12 步内 3 星」就变成「12 次配错才 3 星」，且完美局 HUD 会显示步数 0，语义反了。
- 因此按 memory 游戏标准口径实现（12 对 → 完美 12 步），并使星级阈值自洽。
- 若 lead 坚持「只有配错才计步」，改 `_resolvePair` 里一行即可，但**星级阈值必须重定**。见 §9 待决清单第 2 条。

## 6. 星级阈值（写进代码注释 + 常量 `Engine.STAR_THRESHOLDS`）

| 步数 | 星级 | 含义 |
|---|---|---|
| `moves <= 12` | ★★★ | 一局不配错（12 对理论下限） |
| `13 <= moves <= 17` | ★★ | ≤ 5 次失误 |
| `moves >= 18` | ★ | 其余 |

`stars()` 随时可调，只看当前 `moves`（不强制 `isWon()`）。

## 7. 计时

- `elapsedMs` 用 `Date.now()`（可注入），**从第一次成功翻牌开始**（`ignore` 不启动）。
- `stats().elapsedMs` 实时计算，不是缓存值。
- 清空牌桌瞬间冻结（之后不再增长）。
- `pause()` / `resume()` 可选：暂停期间冻结，恢复时把暂停时长计入补偿、不累加。
- 未翻牌时为 `0`。

## 8. 自测（脚本在 `%TEMP%\pdt-engine-selftest.js`，不进仓库）

覆盖：牌堆结构 / 洗牌 / 副本语义 / 逐条规则 / 计分与连击 / 计时与暂停 / 星级三档 / 200 局随机模糊测试。

```
$ node --check js/engine.js
node --check: PASS
$ node js/engine.js
（无输出、无报错，exit 0）

$ node %TEMP%\pdt-engine-selftest.js
==== 自测结果 ====
断言总数(失败数): 0
每局消除数集合: [24]
mergeCount 分布: {"0":19,"2":138,"4":43}
星级分布(随机乱点): {"1":200}
步数范围: 26 ~ 116
最高单局分数: 2525  最高连击: 6
非法点击次数: 2104
平均单局分数: 1780.3
样例A 随机局(真时钟) stats: {"moves":91,"matchedPairs":12,"totalPairs":12,"score":1825,"combo":4,"bestCombo":4,"elapsedMs":0,"mergeCount":2} stars= 1
样例B 拟真局 stats: {"moves":36,"matchedPairs":12,"totalPairs":12,"score":1875,"combo":3,"bestCombo":3,"elapsedMs":152314,"mergeCount":2} stars= 1
样例C 完美局 stats: {"moves":12,"matchedPairs":12,"totalPairs":12,"score":2850,"combo":12,"bestCombo":12,"elapsedMs":36000,"mergeCount":0} stars= 3
ALL PASS
```

各段明细：

| 用例段 | 结论 |
|---|---|
| 0 牌堆结构 | 24 张 / 6 种各 4 张 / 全 `down` / `art` 正确（flag 为 null）/ `stats()` 键集与契约逐字一致 / `getCards()` 返回副本 / 洗牌生效且仍是每种 4 张 |
| 0b 洗牌回归 | 50 次默认构造 `desync = 0`（`getCards()[k].index === k`）；同 type 两张 `flipped → match`；按 type 配对可 12 步完整通关 |
| 1 规则逐条 | 固定牌堆逐条断言 `ignore/flipped/match/merge/mismatch` + `unflipPending` + `reset()`；非法输入 17 种全部安全 `ignore` |
| 2 计时 | ignore 不启动、实时增长、暂停冻结、恢复补偿、无负值/NaN |
| 3 星级 | 12 步 → 3★；17 步 → 2★；18 步 → 1★ |
| 4 模糊测试 | 200 局全自动通关：`isWon()===true`、消除数 24、`matchedPairs===12`、分数单调不减、`mergeCount∈{0,2,4}`、每步状态不变量（牌数守恒、up ≤ 2、matched/merged 成对）、mismatch 后保持 up + 未 resolve 时锁住 + unflip 归位、终局后继续点击全部安全 |
| 5 样例 | 上面 A/B/C 三组 stats |

> `样例A` 的 `elapsedMs: 0` 是 node 跑得比 1ms 还快造成的，不是计时失效；`样例B` 用假时钟模拟人类节奏（每次翻牌 1.2–2.6s），得到 152.3 秒。

## 9. 待 lead 拍板的契约疑点

1. **`status:'locked'`** —— 契约只列了 5 种 status，所以把「mismatch 未 resolve 时再 flip」**并回 `'ignore'`**，另用 `locked:true` + `reason:'pending-unresolved'` 标记（`e.isLocked()` 也可查）。UI 不需要新增 `switch` 分支；若 UI 想区分，读 `r.locked` 即可。**已按契约优先处理，无需改契约。**
2. **`moves` 口径** —— 见 §5。我按「每判定两张 +1」实现，与 12/17 星级阈值自洽；任务书那句「mismatch → moves++」如果本意是排他，需要 lead 明确并重定星级。
3. **合并次数上界是 4，不是 2** —— 4 张 flag + 4 张 parachute 可以跨类合并 4 次（每次消耗各 1 张），此时 4 次合并 + 8 个同类对 = 12 对，牌桌照样清空、`mergeCount` 只能是 **0 / 2 / 4**（奇数不可能：剩下的 flag/parachute 必须是偶数才能各自成对）。模糊测试实测分布 `{0:19, 2:138, 4:43}`。**任务书里的断言「mergeCount ≤ 2」在数学上不成立**，我改为断言 `∈{0,2,4}` 且 `merged 张数 = 2 × mergeCount`。
4. **`matchedPairs` 含义** —— 取「已清除的对数（同 type 对 + 合并）」，0..12，与 `totalPairs:12` 配对使用；总合并次数另有 `mergeCount`。
5. **`isWon()` 的判定** —— 契约写「12 对（含 1 次合并）全部清空」，但合并次数实际可为 0/2/4。所以实现上按「**24 张全部 matched/merged**」判定，不绑定合并次数，任何合法终局都成立。

## 10. 给 ui-shell 的接口小抄

```js
var engine = new PDT.Engine();
engine.getCards().forEach(function (c) { /* c.index / c.type / c.art / c.state */ });

var r = engine.flip(index);
switch (r.status) {
  case 'ignore':   break;                       // 含 r.locked（上次 mismatch 未播完）
  case 'flipped':  /* 播 flip 音效 */ break;
  case 'match':    /* 播 match 音效；两张已自动 matched */ break;
  case 'merge':    /* PDT.Merge.play(overlay) + merge 音效；两张已自动 merged */ break;
  case 'mismatch': /* 播 mismatch 音效；约 700ms 后 engine.unflipPending() 翻回 */ break;
}
engine.stats();  // {moves, matchedPairs, totalPairs:12, score, combo, bestCombo, elapsedMs, mergeCount}
engine.isWon();  // true 后展示星级 engine.stars()
engine.reset();  // 再来一局（重新洗牌 + 清分/清时）
```

静态常量（方便复用，不影响契约）：`PDT.Engine.TYPES`、`PDT.Engine.ART`、`PDT.Engine.STAR_THRESHOLDS`、`PDT.Engine.SCORE`、`PDT.Engine.isMergePair(a,b)`。
