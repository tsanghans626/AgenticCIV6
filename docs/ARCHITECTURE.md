# 架构方案

[← 返回 README](../README.md)

AgenticCIV6 把《文明 6》的游戏数据编译成「可查询、可算账、可溯源」的决策知识库。本文说明它由哪些层组成、每层回答什么问题，以及为什么这样分层。

## 1. 设计目标与三条不变量

1. **数据源可替换**：当前从游戏安装目录构建本地只读 SQLite 镜像，后续改为直接获取游戏实时数据；替换只发生在摄取层。
2. **接入层可替换**：当前通过 DeepSeek Harness 插件暴露工具，后续可做游戏内 Mod 或其他宿主；替换只发生在传输层，见 [接入方式](INTEGRATION.md)。
3. **事实必须可算**：任何玩家可见的数值、成本、前置、效果，都要能落到「官方文本 + 公式 + 出处」三件套上；落不了就显式说"数据层未解析/未收录"，不许用记忆补。

这三条决定了下面的分层：下层只产数据，上层只做投影，越界即错误。

## 2. 分层

```
L0   原始镜像      游戏 XML/SQL → SQLite（只读，不解释）
L1   原子与节点    kb_effect / kb_cost / kb_unlock / kb_closure / kb_node
L1.5 效果事实      effect_cards / modifier_text / requirement_text
L2   轴            kb_dimension / kb_victory / kb_era_window / kb_speed_profile
L2'  公式层        kb_formula / kb_formula_owner / kb_requirement_set
L3   决策切片      kb_plan / kb_target / kb_budget / kb_check / kb_derivation
L3b  派生节奏      src/pacing（查询期现算，不落表）
L4   文明          kb_civ_profile / kb_civ_entity_map / kb_civ_delta / kb_civ_capability
L5   检索          kb_card / v_kb_* 视图 / search_docs（BM25 倒排索引）
工具面             civi6_meta / civi6_instance / civi6_eval / civi6_pace / civi6_pace_eval（模型唯一入口）
```

| 层 | 产物 | 回答什么问题 |
| --- | --- | --- |
| L0 | 约 500 张游戏原表 | 游戏里有什么行 |
| L1 | 原子效果/成本/前置/闭包/节点 | 一个东西要什么、给什么 |
| L1.5 | 每个实体一张效果卡 | 官方怎么描述、哪些已解析 |
| L2 | 公式行与坐标轴 | 到底怎么算、按什么单位算 |
| L3 | 计划带、目标、检查点 | 某个时刻帝国该是什么状态 |
| L3b | 基准节奏（现算） | 任意速度 × 文明 × 胜利线，每个 T 之前必须完成什么 |
| L4 | 文明修正 | 这个文明的套件改变了哪些约束 |
| L5 | 文档与倒排索引 | 从哪里开始找 |
| 工具面 | 按类切好的数据包 + 算账结果 + 基准函数集/求值 | 模型这一轮该拿什么、该算什么 |

### 2.1 仓库地图

```
dsh-plugin/            插件接入层（运行时，零 npm 依赖，直接用 node:sqlite 读库）
  index.js             5 个工具 + 数值层目录/按调用选层 + 系统提示 + 严格 guard + 数据类包组装
  cordis.patch.yml     注入配置（layersDir + 可选 defaultLayer + pacingRoot）
  package.json / locale/ / icon.svg
src/                   构建管线（把游戏/BBG 数据摄取成 SQLite）
  cli.ts / build.ts    命令入口与构建编排
  config.ts            数据源定位、输出路径、BBG ref
  schema.ts / xml.ts   SQL 表结构解析、XML 行归一化
  db.ts / ingest.ts    node:sqlite 封装、加载顺序与同名文件覆盖
  localize.ts          中英本地化文本
  entities.ts          实体抽取与检索文档
  effects.ts           效果事实层（effect_cards / modifier_text / requirement_text）
  formula.ts           公式层（一描述一公式）
  ruleset.ts           _meta.ruleset 规则身份清单
  searchindex.ts / tokenize.ts  倒排索引、统计预计算、分词
  kb/                  决策知识层（节点/路径/约束/焦点/账本/砍单/情景/文明/校验）
  pacing/              基准节奏生成器（图/产出代数/前向构造/反向截止/证书/输出）
  bbg/                 modinfo 解析、BBG SQL 应用、固定版本源码下载
scripts/               ts-loader、verify-*（sources/effects/spec-parity/plugin/kb）、analyze-session
kb/                    策划 JSON（dimensions/victories/eras/speeds/plans/civs + pacing/baseline + pacing/*）+ 决策层设计文档
model/                 数值思路材料（非权威，不参与构建）
docs/                  快速开始 / 架构方案 / 接入方式
dist/pacing/           src/pacing 的 tsc 编译产物（gitignore；civi6_pace 懒加载）
data/                  构建产物：标准库、BBG 库、BBG 源码缓存（gitignore）
```

## 3. 摄取与规则构建

### 3.1 标准规则

按 `Base → Expansion1（迭起兴衰）→ Expansion2（风云际会）→ 23 个领袖/文明 DLC 包` 的顺序摄取。游戏用**同名文件覆盖**旧资料片文件，构建器遵循同样的"后加载的同名文件覆盖"规则，避免产生线上游戏中不存在的重复行。

默认排除可选游戏模式与剧本/场景，避免污染标准规则数据；需要时由 `CIV6_INCLUDE_MODES` / `CIV6_INCLUDE_SCENARIOS` 显式开启。

### 3.2 BBG 覆盖

BBG 是对标准规则的 SQL/文本覆盖，因此以标准库为基座：

1. 复制标准库到 BBG 库；
2. 按 `BetterBalancedGame.modinfo` 的 `LoadOrder` 执行核心 SQL；
3. 用 `lang/english.xml`、`lang/chinese.xml` 覆盖 `LocalizedText`；
4. 重建 `effect_cards`、`search_docs`、`search_*` 与 `_meta` 统计。

BBG 库记录基座库的构建时间；标准库重建后再跑 `npm run build:bbg` 会自动重建，不会沿用旧基座。默认只构建标准规则核心 BBG，不含 BBG Expanded、BBCC、BBS、Settlers、胜利条件变体等可选子模组，跳过项写入 `_meta.build.bbg.skipped`，上游 `modinfo` 的旧引用兼容映射写入 `_meta.build.bbg.warnings`。

### 3.3 规则身份与 fail-closed

构建期写 `_meta.ruleset`：规则 id、中文标签、资料片、DLC 列表、BBG ref/版本、被排除的可选子模组、构建时间与来源目录。

插件扫描 `layersDir` 下的 `*.sqlite`，逐个读取 `_meta.ruleset` 自动注册数值层；每次调用用 `layer` 选择库。打开某层时校验 `_meta.build.dataSource`、`_meta.ruleset.id`、`_meta.effects.rawBuiltAt`、`kb.build.rawBuiltAt` 与 BBG 基座时间戳；任何不一致都拒绝该层，而不是降级到"凭记忆回答"。层 id 重复、库缺少 `_meta.ruleset`、请求层未知都在 `civi6_meta.layers`/工具错误里显式报出。

### 3.4 当前构建指纹

以下为 `civi6_meta` 在 BBG 7.5.1 构建（`builtAt` 2026-10-31T15:18:20.640Z）上返回的值，只作体检基线，随时以工具现值为准：

| 字段 | 值 |
| --- | --- |
| `ruleset.id` | `bbg` |
| `tables` | 492 |
| `rowsInserted` | 53,540 |
| `textEntries` | 390,990 |
| `entityDocs` | 1,798 |
| `searchDocs` | 2,124 |
| `effectCoverage.cards / effects` | 1,942 / 6,723 |
| `kb.plans / targets / checks` | 5 / 789 / 254 |
| `kb.validationOk` | `true`（0 errors，1 warning） |

## 4. 效果事实层

回答"文本怎么说"：

- `effect_cards`：每个实体一张卡，含官方描述、属性、已解析效果、未解析 Modifier 的审计数据；每条效果带 `authority` 与 `source`。
- `modifier_text`：只收录 `ModifierStrings.Context='Summary'`，本地化并处理 `{Name}`、`{Amount : plural ...}`、`[NEWLINE]`、`[ICON_*]`。
- `requirement_text`：`RequirementStrings` 的本地化文本。
- 没有 Summary 的建筑/教条/政策/特性 Modifier **不会被编造成效果句**，而是进入 `unresolved`（审计数据）；该实体的 `effects` 只保留官方描述与直接数值。

## 5. 公式层

效果事实层回答"文本怎么说"，公式层回答"到底怎么算"。构建期把每条 modifier 与每条表格效果落成一行：

```
scope + dimension + op + value (+ per + condition)
```

`desc` 由同一绑定渲染（如"本城科技 +2"），所以描述与公式不可能漂移。表格效果（`Building_YieldChanges`、伟人点数、巨作槽位等）也按同样方式落行。

曲线型公式（伤害、成长阈值等）的参数取自 `GlobalParameters`；函数形状标记 `empirical` 并保留 confidence。覆盖率与未绑定明细写入 `_meta.effects.formulaCoverage`（含 `unparsedTypes`），由 `npm run verify:effects` 打印，绝不猜。

## 6. 决策知识层

原始表回答"数值是多少"，`kb_*` 回答"走这条胜利线，在某个时刻帝国应该是什么状态"。

| 层 | 表 | 作用 |
| --- | --- | --- |
| L1 原子层 | `kb_effect` / `kb_cost` / `kb_unlock` / `kb_closure` / `kb_node` | 效果、成本、前置边、传递闭包、统一节点空间 |
| L2 轴 | `kb_dimension` / `kb_victory` / `kb_era_window` / `kb_speed_profile` | 可观测指标、胜利判据、时代窗口、速度档 |
| L2' 公式 | `kb_formula` / `kb_formula_owner` / `kb_requirement_set` | 一描述一公式，构建期生成 |
| L3 切面 | `kb_plan` / `kb_target` / `kb_budget` / `kb_check` / `kb_derivation` | 计划带与检查点 |
| L4 文明 | `kb_civ_profile` / `kb_civ_entity_map` / `kb_civ_delta` / `kb_civ_capability` | 基本盘、特色替代、特性即约束变换 |
| L5 检索 | `kb_card`、`v_kb_*` 视图、`search_docs(type='card')` | 一次调用返回完整切面 |

- **水平切面**：`kb_target.slice_kind='burst'`，某个胜利爆发点的硬门 + 前置闭包 + 瞬时产能/存量。
- **垂直切面**：`kb_target.slice_kind='era'`，从爆发点反推的逐时代软目标带与检查点。
- 两者共用同一张状态表、同一维度字典、同一来源/置信度模型；差异只在约束语义与检索载荷。

> **已退役：作者目标层**。`kb/objectives/*` 与 `kb_objective` / `kb_path*` / `kb_constraint*` / `kb_era_focus` / `kb_supply_source` / `kb_ledger` / `kb_cut` / `kb_scenario` / `kb_robustness` 这批表保持为空。原因是它把"取数"绑在"优化目标"上：只有手写过的（文明 × 胜利 × 速度）组合才有数据包，其余问题退化成探索。现在数据由 `civi6_instance` 按硬约束一次给完，账本由 `civi6_eval` 在查询期按公式现算。

决策层的详细设计与编写规范见 [kb/README.md](../kb/README.md)。注意：该文档部分章节描述的是上述已退役目标层，阅读时以本节的现状为准。

### 6.1 基准节奏：派生层，不复活退役目标层

退役目标层的教训是「不要把取数绑在手写组合上」。基准节奏（`src/pacing/`、`kb/pacing/*.json`）走相反的路：

- 作者数据只有 1 个口径（`baseline.json`：地块/区域保底、来源白名单、迭代轮数）+ 5 个胜利目标（终局谓词、瓶颈币种、参照回合）；
- 路径、成本、产出、回合数在查询期由 `kb_node` / `kb_unlock` / `kb_formula` / `kb_civ_*` / `kb_speed_profile` / `kb_era_window` 现算，**不落 `kb_*` 表**；
- 输出默认是**可 `import` 的零依赖 ESM 公式模块**（base + 速率差分，按调用计算；科学/标准约 28KB；JSON 仍是 `--format=json` 的精确契约），证书逐回合复核成本覆盖、同城前置、来源合法与单调性；
- 同一套引擎也以**数据化工具**交付：`civi6_pace` 返回 `civi6.pacing/formula/v1` 函数集 + `handle`，`civi6_pace_eval` 按 `{fn,t,...}` 求值；agent 不再需要 import 模块或心算分段函数（见 [PACING §2.2](PACING.md)）；
- 它不替代 `kb_plan`：后者是经验参照，前者的 `referenceTurn` 只用于对照。详细公式与实测见 [基准节奏](PACING.md)。

## 7. 数据面契约

模型面有 5 个工具（见 [接入方式](INTEGRATION.md)），其中取数只有 `civi6_instance` 一个入口，它是 **objective-free** 的：只由硬约束（数值层/文明/领袖/速度/难度）决定，一次调用返回**一类数据**。

- 先取 `core`（硬约束 + 文明套件全文 + 城邦 + 中性索引 + 全局参数子集 + `gaps`/`omitted` + `manifest.classes`），再按 `manifest[].whenToUse` 只取问题涉及的 2~5 类。
- 11 个数据类（含 `core`）：`core` / `tech-tree` / `civic-tree` / `units` / `districts` / `buildings` / `tiles` / `multipliers` / `beliefs` / `promotions` / `governors`。
- 每类自带 `definition`（这一类是什么、含哪些列、不含什么）与 `whenToUse`（什么时候取），另加 `legend`（本类专有列含义）。
- 行格式固定：`[h, id, name, era, cost, fx, unres, ...columns 第 7 位起]`。`eff` 是权威文本（官方描述/相邻加成/产出行），`fx` 是已解析公式，`unres` 是未解析机制计数。
- 科技/市政是树结构：`treeRow` 树位、`depth` 树深、`req` AND 前置、`children` 后继、`unlocks` 解锁句柄。
- **体积硬约束**：任一类超过 44,000 字符直接报错，不交给传输层截断。
- 行内 `cost` 已是本实例速度口径（`instance.costBasis` 回显倍数与来源），换速度需重取；`civi6_eval` 的 `required` / `cut.cost` / `deadline` 同样按速度折算并回显 `basis`，`supply` 不随速度缩放。
- `gaps` / `omitted` 是硬契约：`omitted` 列数据层确实没有的量（时代得分/黄金时代、伟人个体、自然奇观本体、巨作清单、未进 `cityStates` 的城邦加成），`gaps` 列包内故意没带的字段（购买价、政策槽数量、OR 型前置、每行 `fx` 第 4 条以后、原始修饰符链、单位通用能力清单、光环是否叠加）。写在清单里的一律回答"数据层未收录"。
- 基准时间表不在 `instance` 里：`civi6_pace`（精确 id + victory）一次构建函数集与 `handle`，`civi6_pace_eval`（handle + `calls`）按回合求值；两者共用同一份 `kb/pacing` 口径与证书。

## 8. 实测附录：为什么是这个形状

早期版本允许模型逐实体取数、保留 SQL 退路。实测显示真正的成本是往返次数与输出 token，而不是工具执行时间（工具通常只占墙钟的千分之几）。下表的会话都跑在同一仓库上，改造点见注：

| 会话 | 数据面 | steps | 工具调用 | 输出 token | 墙钟 |
| --- | --- | --- | --- | --- | --- |
| `f115a67d`（旧：focus 报错 3 次后探索） | plan/search/entities/entity 共 74 次 | 23 | 74 | 48,222 | 341s |
| `24f2827c`（分片前：单包 90KB 被截断） | instance ×1（截断）→ sql ×40 / entity ×8 | 31 | 50 | 57,256 | 7.2m |
| `2f8fada4`（分片前，靠 grep 读 spill 临时文件） | instance ×1（截断）+ grep spill + eval ×3 | 5 | 6 | 8,533 | 51.7s |
| `6137a841`（分片前模块，改用 kinds 分片） | instance ×4（首片 49,930 溢出后改 kinds 重试）+ eval ×6 | 6 | 11 | 8,867 | 56.3s |
| `2071e1b3`（分片后：4 片全部到位、0 截断） | instance ×4 + sql ×62 / entity ×14 / eval ×1 | 31 | 82 | 81,729 | 9.6m |
| `17b596ad`（分片后：五片全到、无 SQL） | instance ×5 + entity ×39 / eval ×1 / meta ×1 | 7 | 46 | 38,140 | 4.6m |
| `09d8a845`（三类改造后：3 工具） | 无实体放大镜、无 SQL；思考里出现"eval 到底乘没乘速度"的猜测 | — | — | — | — |

1. `2f8fada4` 的 51.7s **依赖 grep 读 spill 文件**（模型绕过了截断），是旁路不是结构收益。
2. `6137a841` 跑的是**尚未重载的旧模块**（参数带 `kinds`、首片仍触发 49,930 溢出即为证据），所以它验证的是"子包恰好落在传输上限以下时可行"，不是分片补丁本身。
3. `2071e1b3` 是"有 SQL 退路"的对照组：四片全到位、无截断、无丢实体，SQL 却从 40 涨到 62（其中 11 次查的是包里已有的成本与前置，8 次猜列名失败，15 次在手工拼修饰符链）。结论：**只要还留着原始查询，包再大也不会被当作答案面**。因此 `civi6_sql` 下线，行契约改成内联。
4. `17b596ad` 是"按类交付 + 内联全文"的直接证据：39 次 `entity` 调用（合计 180KB）要的权威文本只有约 51KB，却被旧契约挡在包外。因此 `civi6_entity` 下线、11 类各自内联 `eff`，并用 `verify:plugin` 的 39 实体夹具做回归闸门。
5. `09d8a845` 不是调用数问题，而是**口径**问题：模型的思考链在推算 `costMultiplier` 是否要相乘，并明确放弃了精确回合。修复后行内 `cost` 与 `civi6_eval` 的 `required`/`cut`/`deadline` 都是实例速度口径并各自回显 `costBasis`/`basis`，`speed` 与 `eraId` 变为必填，`verify:plugin` 用"标准 × 0.5 = 联机、且 requiredPerTurn 不变"两组恒等式钉死。

工具执行本身很便宜，昂贵的是一次次往返和把答案面撑大。轨迹先用 `npm run sessions:analyze` 量化：步数、调用/步、输出 token（拆分 think/text）、被截断载荷、`instanceSections`（含重复取类）、`entityCalls`（改造后必须为 0）与最慢步骤。先量再改。

## 9. 只读与安全

- 游戏数据目录仅以只读方式读取；唯一写入目标是工作区的 `data/`（标准库、BBG 库、BBG 源码缓存），不触碰游戏文件。
- 插件的数据库连接是只读的；模型面没有 SQL 工具、没有单实体放大镜，取数只经由 5 个 `civi6_*` 工具。
- 严格模式下插件会拒绝 `pwsh`/`bash` 直接读取 `data/civi6*.sqlite`；维护命令不受影响。
- BBG 源码为 MIT 许可，仅下载到本地缓存，不随仓库分发。

## 10. 演进：从镜像库到实时数据

当前数据源是构建期生成的只读镜像。后续会改为直接获取游戏实时数据，届时替换的只是**摄取与指纹**这一段：

```
数据源适配器（游戏 XML/SQL 镜像 ── 将来：实时数据）
  → 效果事实层 + 公式层（同一套绑定与覆盖率审计）
  → 决策知识层（同一套计划带/检查点）
  → 按类数据包 + 确定性算账（同一份契约）
```

保持不变的是：实体 id 空间、成本口径（速度/时代）、包契约（类、行格式、`eff`/`fx`/`unres`、`gaps`/`omitted`）、公式层的一描述一公式，以及 fail-closed 的规则身份校验。接入层怎么换见 [接入方式](INTEGRATION.md)。
