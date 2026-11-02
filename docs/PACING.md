# 基准游戏节奏生成器（Pacing Baseline）

[← 返回 README](../README.md)

`npm run pace` 生成一局「基准节奏」：给定 **速度 × 文明 × 胜利方式**，输出以回合 `t` 为变量的状态函数与动作函数，并附带可机器复核的**可达性证书**。

它不是又一张手写节奏表：现有 `kb_plan` 的经验带只覆盖 5 条胜利线 × 标准速度 × 通用阶梯，换文明或速度就退化为猜测。这里反过来——**只作者化「口径」与「胜利目标」，路径、成本、产出、回合数全部由数据库重算**。

## 1. 什么叫「基准」

```
基准节奏 P = 一个确定性时间表，满足：
  (1) 从终局条件出发，沿前置闭包反推出关键节点与主路径；
  (2) 每个节点完成时，其币种的累计产出 ≥ 累计支出（逐回合检查）；
  (3) 产出只来自「已完成的动作」或声明过的基准源，不含随机收益；
  (4) 终局条件在 T* 成立。
```

`T*` 是**构造出来的**，不是拟合的：前向模拟从空状态开始，每一步只允许花费已经产生的东西。因此「可达」由构造本身证明，不需要事后声称。

```
状态 S(t) = (已完成节点 K, 城市队列 C, 人口 P, 政策/政体 Q)
速率 r_d(t) = Σ_{o∈Owned(t)} Σ_{f∈F(o)} v_f · m_f(S) · (1+π_scope)
累计 Y_d(t) = Y_d(0) + Σ_{k≤t} r_d(k)
硬约束 ∀n: Σ_{n'∈K(T_n)} c_{n'} ≤ Y_{κ(n')}(T_n)  且  T_n > max T_{prereq}
```

## 2. 输入与输出

```bash
# 默认：输出可 import 的 ESM 函数模块（stdout；加 --out=... 写文件）
npm run pace -- --victory=domination --civ=CIVILIZATION_KOREA --leader=LEADER_SEONDEOK --speed=online --out=data/pacing/korea-dom-online.mjs

# 数据契约 / 人读
npm run pace -- --victory=science --civ=CIVILIZATION_ROME --speed=standard --format=json --out=data/pacing/rome-science.json
npm run pace -- --victory=science --civ=CIVILIZATION_ROME --target-turn=250 --format=md
```

| 参数 | 说明 |
| --- | --- |
| `--victory` | `science` / `culture` / `religion` / `domination` / `diplomatic` |
| `--civ` / `--leader` | 文明必需；领袖可选（缺省取该文明第一条 profile） |
| `--speed` | 必须已在 `kb/speeds.json` 注册（当前 `standard` / `online`） |
| `--assurance` | `standard`（默认，含声明的标准地图保底）或 `strict`（仅规则来源） |
| `--target-turn` | 反向校验：给出目标回合，不可行时输出 `target` blocker 而不是改目标 |
| `--format` | `js`（默认，函数模块）/ `json`（数据契约）/ `csv` / `md`（人读） |

### 2.1 公式模块（默认产物）

默认输出是零依赖 ESM **公式模块**：它不内嵌逐回合采样或完整结果，只携带

```
累积状态  Y(t) = base·t + Σ Δrate·(t − turn + 1)     （速率差分基）
城市/人口 = 步进点
动作/里程碑 = 索引事件元组 + 共享 ids/labels
```

函数在调用时实时计算。科学/标准模块 **约 28KB**（改动前 235KB）；其中 state 部分 146KB → 7KB。`--format=json` 仍是精确全量契约（CLI 缩进输出约 404KB，minified 约 226KB）。

```js
import pace from "./rome-science.mjs";

pace.T;                          // 344
pace.science(120);               // 累计科技（实时算）
pace.production(120);            // 累计产能
pace.cities(120);                // 城市数（步进）
pace.rate(120).production;       // 当回合产能
pace.state(120);                 // { turn, cumulative, rate, cities, population, research, civic, builds }
pace.research(120);              // { id, label } | null
pace.builds(120);                // 当前在建/在造（区域/建筑/项目/单位）
pace.milestonesUntil(120);       // T<=120 的里程碑（紧凑对象）
pace.nextMilestone(120);
pace.formula;                    // 最小公式基 { base, delta, counts, ids, labels, actions, milestones, meta }
```

| 函数 | 返回 |
| --- | --- |
| `science/culture/gold/production/food/faith/tourism(t)` | 累计值（number，实时计算） |
| `cities(t)` / `population(t)` | 当回合城市数 / 总人口 |
| `rate(t)` / `rateOf(key,t)` | 7 个当回合速率 |
| `state(t)` | 上述状态的快照 + 当前动作 |
| `research(t)` / `civic(t)` | `{id,label}` 或 `null` |
| `builds(t)` / `actionsAt(t)` | 区间覆盖 t 的动作（后者含研究/市政/铺城） |
| `milestonesUntil(t)` / `nextMilestone(t)` | 里程碑查询（`deps` 省略，需要依赖图请用 `--format=json`） |
| `formula` / `input/basis/baseline/checks/assumptions` | 最小公式基与元数据 |

边界语义（显式）：`t` 向下取整；`t<1` → 0/空；`1≤t≤T` → 精确回合；`t>T` → 取末值（不外推）；非数字 → `TypeError`。系数按 1e-6 取整；与 JSON 的全回合最大偏差实测 9e-12。

`--format=json` 仍是数据契约 `civi6.pacing/v1`：

- `baseline`：`feasible`、`turn`（胜利回合）、`selfTurn`（我方就位）、`burstTurn`（终局链完成）、`referenceTurn`（经验参照，已按速度缩放）、`blockers[]`。
- `milestones[]`：每个节点的完成回合、**最晚回合**、松弛、成本、币种、作用、**前置**、城市。
- `state`：7 条状态函数（科技/文化/金币/锤/粮/信仰/旅游），分段线性：事件处跳变，区间内 `Y(t)=cumFrom+rate·(t-from+1)`。
- `series[]`：逐回合速率、累计、城市数、总人口。
- `actions[]`：动作函数，按（动作 × 节点）压缩成区间 + 次数；含 `id`/`label`；逐城时序在 `milestones[].city`。
- `checks`：证书七项。
- `assumptions` / `provenance`：口径、未建模修饰符计数、构建指纹。

## 3. 两个核心机制

**M1 反向截止时间（从终局到关键节点）**

```
LF(G) = T* − flight
LF(n) = min_{s∈succ(n)} LS(s),   LS(n) = LF(n) − dur(n),   dur(n) = c_n / r̄(n)
slack(n) = LS(n) − 实际完成回合
```

slack=0 的节点构成关键链；`--target-turn` 下 slack 为负即目标不可行，输出 blocker。

**M2 前向可达构造 + 双向不动点**

前向逐回合模拟：研究/市政各一条队列；每城一条生产队列（区域/建筑/项目/单位/移民）；粮食按 `GlobalParameters` 阈值成长，住房封顶；世界时代按 `kb_era_window` 推进并套用 `TECH/CIVIC_COST_PERCENT_CHANGE_BEFORE/AFTER_GAME_ERA`（±20%）。反向标签回灌前向优先级，最多 `tick.maxPasses` 轮，取**已验证可行的最早**一轮。不声称最优。

## 4. 口径与来源策略

`kb/pacing/baseline.json` 是唯一的口径来源；`standard` 与 `strict` 只差白名单：

| 来源类别 | standard | strict | 说明 |
| --- | --- | --- | --- |
| 建筑/区域/政策/政体/文明特性/科技/市政的直接产出 | ✅ | ✅ | `Building_YieldChanges` + 白名单 modifier |
| 地块保底（每人口粮/锤）、住房、专业工人、城邦保底 | ✅（声明值） | ❌ | 见 `assumptions.tileFloor/districtFloor` |
| 贸易路线 / 相邻加成表 / 专家槽 / 巨作 / 地块特征 / 资源 / 改良 / 伟人个体 / 信条 | ❌ | ❌ | 语义或地图依赖；计入 `excludedByReason` |
| 尤里卡/鼓舞、部落村庄、随机事件、奇观抢占 | ❌ | ❌ | 随机或对手依赖 |
| 金币/信仰购买 | ❌ | ❌ | v1 只作为状态函数，不作为加速手段 |

条件修饰符只接受模型认识的 requirement；未知条件一律丢弃（绝不默认成立）。

## 5. 五条胜利线的终局

| 胜利 | 终局 | 保证层级 |
| --- | --- | --- |
| 科学 | 7 个航天项目 + 宇航中心（可建 3 座并行）+ 飞行回合（按速度缩放） | `full`（全链自证） |
| 统治 | 指定军力就位；参照回合=对手侧经验值 | `self-side` |
| 宗教 | 累计信仰达到改宗需求；对手城数/审判官未建模 | `self-side` |
| 文化 | 累计旅游 > 对手国内游客折算；伟作/奇观/乐队未建模 | `self-side` |
| 外交 | 议会点数达到 20（`DIPLOMATIC_VICTORY_POINTS_REQUIRED`）；援助/竞赛未建模 | `self-side` |

`self-side` 表示证书只覆盖我方供给；胜利回合 = `max(我方就位, 参照回合)`。

## 6. 当前实测（vanilla，罗马，standard）

| 胜利 | feasible | 我方就位 | burst | 胜利回合 | 参照 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 科学 | ✅ | 344 | 344 | 394 | 250 | 飞行 50 回合；T200 科研 297、T250 锤 711 |
| 宗教 | ✅ | 142 | 142 | 220 | 220 | 信仰 5000 提前到位 |
| 统治 | ✅ | 244 | 244 | 244 | 235 | 军力就位晚于经验参照 |
| 外交 | ✅ | 210 | 210 | 265 | 265 | 点数按每届 4 点 |
| 文化 | ❌ | — | — | — | 250 | 阻断：旅游来源全被排除（伟作/奇观/乐队） |

在线速度：科学 burst 220 / 胜利 245（飞行按 0.5 缩放）；成本与回合同时减半，但粮食成长不缩放，所以**不是**严格的 0.5 倍。

科学线与经验参照差 ~94 回合，主因是基准不含尤里卡/鼓舞（经验口径按 η≈0.5 折 20% 成本）、伟人、城邦使者、奇观与商路。这是**有意的保守**：基准回答「不做运气假设时，最晚什么时候能到」，参照回答「正常强局大概什么时候到」。

## 7. 证书（`npm run pace:verify`）

1. **I1 成本覆盖**：每个完成回合，该币种累计支出 ≤ 累计产出。
2. **I2 前置顺序**：科技/市政全局；建筑/区域按**同城**实例。
3. **I3 来源合法**：`noRandomGains` / `noPurchases` 声明存在；未建模项计数透出。
4. **I4 终局**：`feasible` 与 `terminal` 一致；不可行必须有 terminal/target blocker。
5. **I5 确定性**：同输入两次输出逐字节一致（`generatedAt` 除外）。
6. **I6 单调性**：累计不降，速率非负。
7. **I7 速度关系**：online burst < standard burst，且不低于一半；成本倍率 0.5。
8. **I8 松弛自洽**：`slack = latestTurn − turn`；负值不静默。
9. 另含：`--target-turn` 不可行必须显式拒绝；`strict` 不得优于 `standard`。
10. **公式 = IR 事实**：生成的模块可 `import`、API 齐全、与库内求值器在 **0..T+10 每个整数回合**一致（累计/速率误差 ≤1e-6）、零 `import`/`require`、无内嵌 `series`/`DATA`、体积 ≤40KB、同输入两次生成逐字节一致。

## 8. 边界与已知缺口

- 不模拟地图/地块/寻路/战争/外交 AI；城市是同模板队列。
- 不模拟相邻加成表、专家槽、贸易路线、伟人个体、奇观、信条；`standard` 用声明的区域保底把「标准地图的典型值」折进去。
- 区域成本递增公式仍未解析：按基准价计（`cost_basis='progress'`），与 `kb/` 其余层一致。
- 文化线在无伟作/奇观假设下不可达；这是结论，不是 bug。
- 外交线的「每届 4 点」是经验值；援助/竞赛/城邦宗主未建模。
- 世界时代按 `kb_era_window` 的参考节奏推进；玩家自身研究不推进世界时代（避免自指）。
- 输出体积：默认公式模块约 13KB（religion online）～28KB（science standard）；`--format=json` 全量约 404KB（CLI 缩进；minified 约 226KB），是精确逃生口；人读请用 `--format=md`。

## 9. 与既有层的关系

- 复用而不重建：`kb_node`（成本/时代）、`kb_unlock`（前置边）、`kb_formula`+`kb_formula_owner`（产出）、`kb_civ_*`（文明投影）、`kb_speed_profile`（速度口径）、`kb_era_window`（时代）、`GlobalParameters`（成长/旅游/议会参数）。
- 不改 `kb_plan`：它是经验参照，`provenance.referenceTurn` 只用于对照；校准稳定后再讨论替换。
- 不复活已退役的 `kb_objective/kb_path/kb_constraint*` 目标层：那些表把「取数」绑在手写组合上；本生成器对任意文明/速度现算，不落表。

## 10. 扩展

- **加速度**：在 `kb/speeds.json` 增行（`totalTurns` + `costMultiplier`）并 `npm run kb:build`，无需改代码。
- **加文明**：`kb_civ_profile` 已有全部文明；特色替代来自 `kb_civ_entity_map`，缺记录时回退通用。
- **调口径**：只改 `kb/pacing/baseline.json`（地块/区域保底、条件白名单、迭代轮数）。
- **加胜利线**：`kb/pacing/<victory>.json` 写终局与瓶颈；终局类型目前支持 `space-race` / `yield-target` / `units` / `congress`。
