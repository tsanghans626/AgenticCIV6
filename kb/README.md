# 决策知识层（kb_*）设计与编写指南

本目录是《文明 6》知识库的**决策数据底座**：把游戏原始镜像（约 489 张表）与策划 JSON 合并成可检索的"胜利切面"，供 `civi6_plan` / `civi6_search(scope='plan')` 使用。v3 起回答必须引用账本（`kb_ledger`），而不是只背节点名。

## 1. 为什么需要这一层

原始库回答"这个东西的数值是多少"；决策层回答"走这条胜利线，在某个时刻帝国应该是什么状态"。后者需要：

- 胜利判据（`Victories` 表只有 7 行，且胜利 Requirement 集为空）；
- 从终局反推的速率/城市/人口/维护费；
- 时代阶梯与可观测检查点；
- 文明特有的替代与修正；
- 每个数字的来源、置信度与公式。

## 2. 分层

| 层 | 表 | 来源 | 说明 |
| --- | --- | --- | --- |
| L0 原始镜像 | 游戏 478 表 | XML/SQL + BBG | 只读，不改 |
| L1 原子层 | `kb_effect` / `kb_cost` / `kb_unlock` / `kb_closure` | 原始表抽取 | 数值效果、成本/维护、前置边、传递闭包 |
| **L1b 节点层** | **`kb_node`** | 原始表 + `kb_cost` | 科技/市政/单位/区域/建筑/政策归一成单一节点空间（era + 各币种成本）；路径与约束只允许引用它 |
| **L1.5 效果事实层** | **`effect_cards` / `modifier_text` / `requirement_text`** | **原始表 + 本地化文本 + Modifier 链** | **实体级官方描述、直接数值、已解析 Modifier 文本、未解析审计数据；工具优先读这一层** |
| L2 轴 | `kb_dimension` / `kb_victory` / `kb_era_window` / **`kb_speed_profile`** | 策划 JSON + `Gamespeeds` | 可观测指标、胜利判据、时代窗口、速度档（标准 500 回合/×100，联机 250/×50） |
| **L2b 目标层** | **`kb_objective`** | `kb/objectives/*.json` | “T\* 前必须为真的条件”（单位数、改宗、占城数）；下游全部由它推导 |
| **L2c 供给层** | **`kb_supply_source`** | 作者 JSON + DB 效果 | 每个币种从哪来：建筑/区域/资源/教条/政策/总督，单产、份数、到位回合、价格、dataRef |
| **L3 路径层（树）** | **`kb_path` / `kb_path_node`** | 闭包展开 + 引擎 | `on_path` / `detour`（带整组价格）/ `dead`（带原因）；`era_due`；成本按速度缩放 |
| **L3d 账本层** | **`kb_ledger`** | 路径成本 + 供给积分 | 逐时代 `required_cum / supply_cum / gap / verdict`；供给是积分不是常数 |
| **L3b 约束层** | **`kb_constraint` / `kb_constraint_lever`** | 账本投影 + 供给锚点 | `tightness = required / (supply × window)`；绑定排名、松弛、杠杆 |
| **L3e 砍单层** | **`kb_cut`** | 缺口 + 作者 defer/drop 清单 | 先砍谁、省多少、`slip_turns`（推迟回合）、失去什么 |
| **L3f 情景层** | **`kb_scenario` / `kb_robustness`** | 供给份数区间 → 低/基准/高三套账本 | 哪些决策 invariant、哪些 contingent、翻盘触发条件 |
| **L3c 焦点层** | **`kb_era_focus`** | 排期 + 紧张度 + 覆盖 | 每时代 TOP3：服务哪个约束 / 代价 / 替代 / 放弃条件 / 验收 / **ledger_gap** |
| L3 切面 | `kb_plan` / `kb_target` / `kb_budget` / `kb_check` / `kb_derivation` | 策划 JSON + 反推引擎 | 水平=爆发点；垂直=时代阶梯（有目标层时降级为“可观测投影”） |
| L4 文明 | `kb_civ_profile` / `kb_civ_entity_map` / `kb_civ_delta` / **`kb_civ_capability`** | 原始表 + `civs/*.json` | 基本盘、特色替代、计划修正、**特性即约束变换**（waive/retarget/precondition/convert/amplify） |
| L5 检索 | `kb_card`、`v_kb_*` 视图、`search_docs(type='card')` | 构建期生成 | 一次调用返回完整切面；新增 `v_kb_objective` / `v_kb_path` / `v_kb_focus` |

### 为什么是这条链（结构决定功能）

```
objective（要什么）
  → path（靠哪棵树到那里，哪些是绕路/死路）
  → constraint（哪一币种是瓶颈，紧张度多少）
  → era_focus（这个时代只做 3 件事，各自的代价与放弃条件）
  → kb_target/kb_check（怎么在面板上验收）
  → civi6_plan(view='focus')（工具一次返回全链，提示强制引用）
```

每一层只回答一个问题；下一层只能读上一层的输出。因此“把非目标产出当目标”“漏掉真正瓶颈”“动作没有代价/放弃条件”这三类错误在构建期就会被断言拦住（见 §7）。


### 水平与垂直为什么共用一张表

```
H(v) = π_{R(v)}( S(T_burst(v)) )   // 水平：固定时间，横切
V(v,e) = π_{R(v)}( S(T_e) )        // 垂直：固定胜利，遍历时代
```

二者都是同一个状态向量的投影，因此共用 `kb_target`：

- `slice_kind='burst'`：单时间点、硬门（`=`/`>=`）、`role=blocking`、前置闭包；
- `slice_kind='era'`：多时间点、软带（`between`/`value_lo..hi`）、检查点与补救。

差异只在**约束语义**和**载荷**，不在表结构；这样可以免费获得"相邻时代 diff"和"从爆发点回溯"的能力。

## 3. 策划 JSON

### 3.1 文件布局

```
kb/
  dimensions.json     指标字典
  victories.json      胜利判据
  eras.json           时代窗口
  speeds.json         速度档（totalTurns + costMultiplier，标准/联机）
  plans/*.json        每个胜利一份 PlanSpec（通用阶梯）
  objectives/*.json   目标层（按文明/领袖的 T* 条件胶囊，驱动路径/约束/焦点）
  civs/*.json         文明 CivSpec（可以是单对象或数组；含 capabilities）
```

### 3.2 PlanSpec

```jsonc
{
  "victoryId": "science",
  "nameZh": "科技胜利",
  "burst": {
    "turn": 250,
    "eraId": "ERA_INFORMATION",
    "window": 30,
    "margin": 0.1,
    "projects":    [{ "id": "PROJECT_LAUNCH_MARS_BASE", "qty": 1, "role": "blocking" }],
    "techs":       [{ "id": "TECH_ROCKETRY", "role": "blocking" }],
    "civics":      [{ "id": "CIVIC_SPACE_RACE", "role": "enabling" }],
    "policies":    [{ "id": "POLICY_FIVE_YEAR_PLAN", "role": "enabling" }],
    "governments": [{ "id": "GOVERNMENT_COMMUNISM", "role": "enabling" }],
    "districts":   [{ "id": "DISTRICT_SPACEPORT", "qty": 1, "role": "blocking" }],
    "buildings":   [{ "id": "BUILDING_RESEARCH_LAB", "role": "enabling" }],
    "units":       [{ "id": "UNIT_INFANTRY", "qty": 6, "role": "support" }],
    "metrics":     [{ "dimension": "science_per_turn", "op": ">=", "value": 420 }],
    "infrastructure": {
      "cities": 13,
      "popPerCity": 8,
      "perCity": { "BUILDING_LIBRARY": 1, "BUILDING_UNIVERSITY": 1 },
      "empire":  { "DISTRICT_CAMPUS": 13, "DISTRICT_SPACEPORT": 1 },
      "units":   { "UNIT_INFANTRY": 6 },
      "perCityProd": 40,
      "tradeRoutes": 8,
      "goldPerRoute": 3,
      "luxuries": 8,
      "entertainmentAmenities": 8,
      "housingPerCity": 9
    }
  },
  "eras": [
    {
      "eraId": "ERA_MEDIEVAL",
      "turnLo": 90, "turnHi": 140,
      "cities": { "lo": 8, "hi": 12 },
      "science": { "lo": 100, "hi": 200 },
      "techs": ["TECH_EDUCATION"],
      "civics": ["CIVIC_CIVIL_SERVICE"],
      "notes": "大学开始普及"
    }
  ],
  "overrides": {
    "bbg": { "burst": { "turn": 245 } }
  }
}
```

规则：

- 实体 id 必须存在于当前数据库；构建期校验，拼错会直接失败。
- 数字能由 DB 算出的不要写死；`burst.metrics` 只用于覆盖/补充经验值。
- `overrides.<source>` 可选；数组替换，对象浅合并。
- `role`：`blocking` / `enabling` / `support` / `optional`。
- `sourceFlag`：`db` / `rule` / `derived` / `empirical`。

### 3.3 CivSpec

```jsonc
{
  "civId": "CIVILIZATION_KOREA",
  "leaderId": "LEADER_SEONDEOK",
  "supportedVictories": ["science"],
  "playstyleTags": ["科技", "书院"],
  "summary": "书院替代学院……",
  "deltas": [
    {
      "victoryId": "science",
      "op": "add",
      "targetRef": { "category": "metric", "dimensionId": "science_per_turn" },
      "valueNum": 40,
      "eraId": "ERA_MEDIEVAL",
      "reason": "书院平地+4 相邻"
    }
  ]
}
```

- 特色单位/区域/建筑/改良由原始 `TraitType` + `*Replaces` 自动推导，不需要手写。
- `targetRef` 支持 `category` + `entityId` 或 `dimensionId`；`eraId` 可选。
- `op`：`add` / `multiply` / `replace` / `remove` / `note`。
- 没有 delta 的文明会回退到通用计划，工具会明确标注。

### 3.4 目标层（`kb/objectives/*.json`）与能力层（`capabilities`）

目标层是“倒推”的起点：它只说 T\* 前必须为真的条件，路径/约束/焦点全部由引擎推导。

```jsonc
{
  "objectiveId": "domination:CIVILIZATION_BYZANTIUM:LEADER_BASIL",
  "victoryId": "domination",
  "civId": "CIVILIZATION_BYZANTIUM",
  "leaderId": "LEADER_BASIL",
  "burstTurn": 110,                    // 标准速度口径；联机按 speeds.json 缩放
  "burstEra": "ERA_MEDIEVAL",
  "gates": [
    { "kind": "unit", "id": "UNIT_HEAVY_CHARIOT", "qty": 8, "role": "blocking" },
    { "kind": "node", "id": "CIVIC_DIVINE_RIGHT", "role": "blocking" },
    { "kind": "metric", "id": "captured_capitals", "op": ">=", "value": 7, "role": "blocking" }
  ],
  "constraints": [
    { "metric": "culture_per_turn", "supplyRate": 12, "notes": "纪念碑1+宫殿1+文化资源", "sourceFlag": "empirical" },
    { "metric": "great_person_points", "required": 30, "supplyRate": 4, "unit": "点" }
  ],
  "deadEnds": [{ "kind": "tech", "id": "TECH_STIRRUPS", "why": "甲胄骑兵前置是市政" }],
  "detours":   [{ "groupId": "upgrade-discount", "ids": ["CIVIC_MERCENARIES"], "why": "职业军队-40%" }],
  "eraFocusOverrides": [ /* 可选：每时代最多 3 条，覆盖派生结果 */ ]
}
```

规则：

- `gates.kind`：`unit` / `node` / `metric`；blocking gate 进入 `on_path` 并计入约束，enabling/support 进入 `detour`。
- `deadEnds` 必须写 `why`（“不研究马镫”与“研究王权神授”同等重要）。
- `detours` 以组为单位定价；`alternative` 写“什么时候整组跳过”。
- `constraints[].supplyRate` 是供给锚点（经验值），`required` 可省略（由路径求和）；`tightness` 由引擎算，不许手写。
- `eraFocusOverrides[].constraintKey` 可写完整 key 或 metric 名；`rank` 1..3；每条必须有 `why`。
- 文件内可以是单个对象或数组；`objectiveId` 全局唯一；`victoryId`/`burstEra` 必须已登记。

文明特性写成 `capabilities`（`kb/civs/civs.json`），引擎会作用到路径/约束上：

```jsonc
{
  "op": "waive",              // waive | retarget | precondition | convert | amplify
  "traitId": "TRAIT_LEADER_BASIL",
  "remove": ["UNIT_TREBUCHET"],       // 节点 id 或约束 key
  "requires": { "targetCityReligion": "same" },
  "effectTextZh": "（逐字取 effects[].text_zh）",
  "why": "同宗教城骑兵打满伤害，攻城单位不是硬门"
}
```

| op | 语义 | 结构效果 |
| --- | --- | --- |
| `waive` | 特性让某个硬门不再需要 | `remove` 的节点变 `dead`；约束标 `waived_by`，退出绑定排名 |
| `retarget` | 把需求换到另一条树支 | `add` 的节点进入 `on_path`，`remove` 的节点变 `dead` |
| `precondition` | 特性依赖的前置（如圣地/寺庙） | `add` 的节点按 on_path 计入成本 |
| `convert` | 产出/前置转成能力（信仰→战力/改宗） | 只记录，不产生新目标；防止“信仰当产出目标” |
| `amplify` | 倍率 | 记录在 `kb_civ_capability.value`，供解释 |


### 3.5 供给 / 砍单 / 情景（v3）

账本把“这一时代到底能不能走完”变成算术。目标 JSON 新增四块：

```jsonc
{
  "supply": [
    { "sourceId":"palace", "metric":"culture_per_turn", "kind":"building",
      "refId":"BUILDING_PALACE", "perUnit":1, "copies":1, "fromTurn":1,
      "dataRef":"kb_effect:building:BUILDING_PALACE:culture_per_turn", "sourceFlag":"db" },
    { "sourceId":"connoisseur", "metric":"culture_per_turn", "kind":"governor",
      "refId":"GOVERNOR_PROMOTION_EDUCATOR_CONNOISSEUR", "perUnit":1, "copies":6,
      "perPop":true, "fromTurn":40, "sourceFlag":"rule" }
  ],
  "scenarios": [
    { "id":"base", "label":"基准" },
    { "id":"low", "label":"0 文化资源 + 早战", "supplyOverrides":{ "monuments":1, "connoisseur":0 } },
    { "id":"high", "label":"3+ 资源", "supplyOverrides":{ "monuments":4, "connoisseur":9 } }
  ],
  "cutOrder": [
    { "kind":"defer", "refId":"CIVIC_MYSTICISM", "saves":{"culture":50},
      "lose":"神秘主义延后：先知点顺延", "order":1 },
    { "kind":"drop", "group":"upgrade-discount", "saves":{"culture":810},
      "lose":"职业军队 -40% 升级金币", "order":9 }
  ],
  "inspiration": { "mode":"none" },
  "feasibility": "strict"
}
```

规则：

- `supply` 是账本的唯一供给事实；没有来源的币种回退到 `constraints[].supplyRate` 常量锚点（标 `legacy anchor`）。
- `kind:"governor"` 只引用晋升 id，**不要把总督名写进 `sourceId`/`note`**：归属由 `GovernorPromotionSets` 解析，工具返回 `governors[]`；BBG 会重分配晋升而保留原 id 前缀。
- `copies` 可被情景覆盖；`fromTurn` 按速度缩放（联机 ×0.5），供给按回合积分。
- `cutOrder.kind='defer'` 必须指向 on_path 节点：它省下当期文化，但 `slip_turns = 省下额度 / 当期供给速率`，会推迟爆发点；`drop` 只释放产能/信仰，不减少在路需求。
- `feasibility='strict'`（默认）：base 情景在爆发时代仍有缺口 → **构建失败**；`report` 只记录并给出缺口。
- 灵感（Boosts）当前只覆盖后期 19 行；目标默认 `mode='none'`，不许手填百分比。数据补齐后再开 `authored`。


构建时执行：

1. 抽取 `kb_effect` / `kb_cost` / `kb_unlock`；
2. 计算 `kb_closure`；
3. 由原子表生成 `kb_node`（统一节点空间 + era + 各币种成本）；
4. 对每个目标（× 每个速度档）：gates → 闭包 → `kb_path*`（on_path/detour/dead）→ 供给积分 → `kb_ledger`（逐时代缺口）→ `kb_cut`（砍单/推迟）→ `kb_scenario`/`kb_robustness`（情景与稳健性）→ `kb_constraint*`（账本投影）→ `kb_era_focus`（每时代 3 条 + ledger_gap）；
5. 对每个胜利：终局项目成本 → 产能速率 → 城市数 → 人口 → 维护费/宜居/住房；有目标层时 era 带下界取 `max(authored, required/window)`；
6. 写入 `kb_target` / `kb_budget` / `kb_check` / `kb_derivation`；
7. 生成文明基本盘、deltas 与 `kb_civ_capability`；
8. 生成 `kb_card`（含 `card:<objective>:why` 推理卡）并写入 `search_docs`；
9. `kb:verify` 断言。

关键公式：

```
finalCost   = Σ 终局项目成本 + 宇航中心
prodRate    = ceil(final_cost / window × (1 + margin))
cities      = ceil(prodRate / perCityProd)
population  = cities × popPerCity
upkeep      = Σ(数量 × per_turn 维护)
goldNet     = population×perPopGold + tradeRoutes×goldPerRoute + buildingGold − upkeep
amenity     = luxuries×4 + entertainment − Σ ceil((popCity-2)/2)
science     = Σ closedTechCost × (1 − 0.4η) / window
```

> 注意：当前 DB 的完整航天链是 **11700 锤**（900 + 1500 + 4×1800 + 2100），不是模型文档旧口径的 9900（旧文档只算了 3 个火星项目）。构建器以 DB 为准。

## 5. 命令行

```bash
npm run effects:build    # 标准规则：只重建效果事实层 + 实体文档 + 索引（不需要游戏数据）
npm run effects:build:bbg # BBG
npm run kb:build         # 标准规则：只重建 kb_* + 卡片 + 索引（不需要游戏数据）
npm run kb:build:bbg     # BBG
npm run verify:effects   # 效果事实层断言 + SPECS 一致性
npm run kb:verify        # 决策层断言 + 基准 + 版本指纹
npm run build:all        # 完整构建（ingest + 效果层 + KB + 索引）
```

修改 JSON 后只需 `kb:build`，不必重新摄取游戏数据。

## 6. 检索契约

- `civi6_plan({ victory, era?, civ?, leader?, speed?, view?, detail? })`
  - `view='focus'`：目标层 + 逐时代账本 `budget[]`（required/supply/gap/perTurn/verdict）+ 供给来源 `supply[]` + 砍单 `cut[]`（saves/lose/slipTurns）+ 情景 `scenario[]` + 稳健性 `robustness[]` + 每时代 3 条焦点（why/cost/alternative/abandonIf/checkpoint/ledgerGap）；
  - `view='burst'`：硬门 + 指标 + 预算 + 检查点 + 文明 delta（附目标约束摘要）；
  - `view='ladder'`：时代阶梯；指定 `era` 时只看该时代；
  - `view='check'`：可观测检查清单 + 补救；
  - `view='civ'`：文明基本盘/特色/推荐胜利线；
  - `speed='online'`：按 `kb_speed_profile` 缩放回合与科技/市政成本（生产类成本不缩放）；
  - `detail='full'`：附带闭包、公式、置信度、来源。
- `civi6_search({ q, scope:'plan' })`：检索预计算卡片，返回完整 `body`。
- 旧工具 `civi6_entity` / `civi6_modifiers` / `civi6_sql` 保留，用于下钻原始数据。

## 7. 验收

`npm run kb:verify` 检查：

- 30 张 `kb_*` 表 / 7 个视图存在（含 v2 的 `kb_node` / `kb_objective` / `kb_path*` / `kb_constraint*` / `kb_era_focus` / `kb_civ_capability`，v3 的 `kb_supply_source` / `kb_ledger` / `kb_cut` / `kb_scenario` / `kb_robustness`）；
- 每个计划有 burst + ≥4 个时代；每个目标有约束、有在路径节点、有时代焦点；
- **账本自洽**：`gap = required_cum − supply_cum`；逐时代 required/supply 单调不降；`verdict` 与 gap 同号；
- **供给可定位**：每条 `kb_supply_source.ref_id` 必须命中原始表（建筑/区域/资源/政策/教条/总督）；
- **砍单可定位**：`defer` 必须在 on_path 上，`drop` 必须有 detour 组价格；砍单必须写 `lose`；
- **可行性**：`feasibility='strict'` 的目标在 base 情景必须闭合，否则构建失败；`report` 只告警；
- 焦点行必须带 `ledger_gap`（没有账本就不给时代方案）；
- **紧张度与公式一致**（`required/(supply×window)`，ε=0.02）；**绑定排名必须按紧张度降序**；
- **死路必须有 `why`，且不得出现在焦点里**；焦点的 `ref_id` 必须是 `kb_node` 里存在的节点；焦点引用的约束必须存在；
- 目标实体 id 都能在原始表命中；
- 预算 `income - expense = net`；
- 航天项目合计 = 11700；
- vanilla/BBG 指纹（区域递增参数 40/35、工作坊 195/160、科技时代惩罚 20/30）；
- `civi6_plan` 热态 p95 < 50ms、payload < 12KB；`view='focus'`（拜占庭·联机）payload < 12KB。

## 8. 已知边界

- 目标层目前只覆盖已编写的文明（`kb/objectives/*.json`）；未覆盖的胜利线回退通用阶梯，`view='focus'` 会说明“未收录”而不是硬套。
- 时代/城市/产出锚点来自神级标准速度经验值，标 `empirical`；`supplyRate` 是可校准字段，可用实局替换。
- 速度档只缩放回合窗与科技/市政成本（`Gamespeeds.CostMultiplier`）；生产类成本不缩放，因此联机档的 `tightness` 与标准档可比。
- 区域成本递增（`COST_PROGRESSION_NUM_UNDER_AVG_PLUS_TECH`）只记录模型名与参数，具体公式仍属“数据层未解析”，路径按基准价计并标 `cost_basis='progress'`。
- 升级金币公式未解析（DB 只有 `UPGRADE_BASE_COST` / `UPGRADE_NET_PRODUCTION_PERCENT_COST`），因此金币不作为推导约束；需要时用 `constraints[].required` 手写。
- 灵感（`Boosts`）只有 19 行后期数据，古代/古典行缺失；账本默认按 0% 抵扣（保守，只会高估需求），目标里不许手填比例。
- 供给来源的 `copies` 与 `fromTurn` 是经验值（`sourceFlag='empirical'`），用于回答“从哪来、何时到位”；它们可被 `scenarios` 覆盖，不应当作游戏规则数值。
- 砍单的 `slip_turns` 是按当期供给速率折算的模型估计，不是精确排期；只用于比较“砍哪一项更划算”。
- 文化/宗教/外交的终局是对手相对量，给区间而非假精确值。
- 相邻加成按期望/规则描述，不按具体地图重算。
- 效果事实层会解析 `ModifierStrings(Context='Summary')`；没有 Summary 的 Modifier（建筑/教条/政策/特性大量如此）进入 `unresolved`，不会被编造成效果句。`effects` 只保留官方描述和直接数值表，`civi6_entity` 默认不展开原始 Modifier 链。
- 效果事实层不自动判定“官方描述 vs 表内数值”的语义冲突；两者都带 `authority`/`source` 暴露，引用时以官方描述为玩家可读文本、以表内数值为精确数字。
- 只覆盖 18 个主流文明/领袖的 delta（另加拜占庭/巴兹尔的能力条目）；其余回退通用计划。
