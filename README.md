# Civ6 知识库（DeepSeek Harness 插件）

基于本地《文明 6》游戏数据（只读）构建的 SQLite 知识库，供 DeepSeek Harness 插件查询。构建期支持两套规则库，运行期只锁定其中一套：

- **标准规则（standard，内部键 `vanilla`）**：`data/civi6.sqlite`，内容为 Base + 迭起兴衰 + 风云际会 + 23 个 DLC；不是“无资料片基础版”。
- **BBG（Better Balanced Game）**：`data/civi6-bbg.sqlite`，以标准库为基座叠加 **BBG 7.5.1**。

> 当前插件配置锁定 **BBG 7.5.1**。工具层没有逐次切换的 `source` 参数；要换规则，改 `dsh-plugin/cordis.patch.yml` 的 `ruleset` 并重载插件。运行期还会用系统提示、严格 guard 和效果事实层约束模型，详见下文“规则锁定与效果事实层”。

- **数据源（只读）**：本地安装的 Civ6 `Assets` 下的 XML + SQL 表结构；BBG 为官方 GitHub 仓库的 SQL/文本覆盖，绝不写入游戏目录。
- **技术栈**：Node.js / TypeScript（Node ≥ 22.18，构建使用内置 `node:sqlite`，无原生编译依赖）。
- **形态**：关系库 SQLite（镜像游戏 schema，支持精确数值查询）+ 效果事实层 `effect_cards`（官方描述 + 直接数值 + Modifier 文本）+ 决策知识层 `kb_*`（胜利切面/时代阶梯/文明修正）+ 构建期倒排索引（`civi6_search` 的 BM25 检索）。

## 目录结构

```
dsh-plugin/            # DSH 插件本体（运行时，零 npm 依赖，直接用 node:sqlite 读库）
  index.js             #   注册 7 个工具 + 单规则锁定 + 系统提示 + 严格 guard + 效果卡读取
  cordis.patch.yml     #   注入配置（ruleset + 两个 dbPaths）
  package.json / locale/ / icon.svg
src/                   # 构建管线（把游戏/BBG 数据摄取成 SQLite）
  config.ts            #   定位 Civ6 数据源、两个数据库路径、BBG ref
  schema.ts            #   解析 SQL 表结构
  xml.ts               #   XML 解析与 Row/Replace/Update/Delete 归一化
  db.ts                #   node:sqlite 封装
  ingest.ts            #   加载顺序 + 数据摄取（含同名文件覆盖规则）
  localize.ts          #   本地化文本摄取（中英）
  entities.ts          #   实体抽取与 search_docs 文档构建
  effects.ts           #   效果事实层：effect_cards / modifier_text / requirement_text
  ruleset.ts           #   _meta.ruleset 规则清单（版本/资料片/DLC/BBG ref）
  searchindex.ts       #   倒排索引 + 统计预计算（写入 _meta）
  tokenize.ts          #   分词（插件内有一份等价副本）
  kb/                  #   决策知识层（schema、原子抽取、反推引擎、文明、卡片、校验）
    node.ts            #     L1b 节点空间（tech/civic/unit/... 归一 + era + 各币种成本）
    path.ts            #     L3 关键路径（on_path / detour 带价 / dead 带原因、era_due）
    constraints.ts     #     L3b 约束方程（tightness、绑定排名、杠杆）
    focus.ts           #     L3c 时代焦点（每时代 3 条：why/代价/替代/放弃/验收）
  bbg/modinfo.ts       #   BBG modinfo 解析、动作选集、上游文件别名
  bbg/apply.ts         #   BBG SQL 语句切分与执行、BBG 文本覆盖
  bbg/fetch.ts         #   固定版本 BBG 源码下载（jsDelivr 优先）
  build.ts / cli.ts    #   构建编排 / 命令入口（build、reindex、effects-build、kb-build、fetch-bbg）
kb/                    # 策划 JSON：dimensions/victories/eras/speeds/plans/objectives/civs + 设计说明
scripts/
  ts-loader.mjs        # 让 node 直接运行 .ts（不需要 tsx/esbuild）
  verify-sources.mjs   # 标准 / BBG 差异断言
  verify-effects.mjs   # 效果事实层：版本指纹、文本完整性、已知数值
  verify-spec-parity.mjs # 构建端与插件端 SPECS 一致性
  verify-kb.mjs        # 决策层断言 + 查询基准
data/
  civi6.sqlite         # 标准规则库（插件数据，gitignore）
  civi6-bbg.sqlite     # BBG 覆盖库（插件数据，gitignore）
  bbg-src/<ref>/       # 下载的 BBG 源码缓存（gitignore）
```

## 快速开始

```bash
# 1. 构建标准规则库（已构建则跳过）
npm run build            # Windows 需先设 CIV6_ASSETS，见 .env.example
npm run rebuild          # 强制重建（本机实测约 14s）

# 2. 下载 BBG 源码 + 构建 BBG 覆盖库（BBG 7.5.1）
npm run fetch:bbg        # 下载到 data/bbg-src/7.5.1（jsDelivr 镜像，支持断点续传）
npm run build:bbg        # 复制标准库 → 执行 BBG SQL → 覆盖中英文本 → 效果卡 → 实体索引

# 也可以一次构建两套：
npm run build:all

# 3. 只重建效果事实层（不需要游戏数据，秒级；升级旧库或改效果抽取逻辑后使用）
npm run effects:build
npm run effects:build:bbg

# 4. 只重建决策层（策划 JSON 改动后使用，不需要游戏数据，秒级）
npm run kb:build
npm run kb:build:bbg

# 5. 只重建检索索引与统计（不需要游戏数据，秒级；效果层缺失时会自动补建）
npm run reindex
npm run reindex:bbg

# 6. 校验已知差异 + 效果事实层 + 决策层断言与基准
npm run verify
npm run verify:effects
npm run kb:verify

# 7. 由 DeepSeek Harness 加载 dsh-plugin/（cordis.patch.yml 锁定 ruleset: bbg）
```

脚本用 `node --import ./scripts/ts-loader.mjs` 直接运行 TypeScript，不依赖 tsx/esbuild（`npm run typecheck` 仍需要 `typescript`）。

## 规则锁定与效果事实层

### 为什么需要两层

之前模型会在 BBG / “原版” / 风云际会之间横跳，并把 `LOC_*`、`RAW MODIFIER` 或记忆中的旧数值当作效果描述。根因不是提示词，而是：

1. 插件没有挂载到 profile，模型直接 `pwsh + node:sqlite` 查询两个库；
2. 工具允许每次调用传 `source`，配置里的 `dataSource` 只是默认值；
3. 宗教教条没有一等实体，建筑效果没有从 `Building_YieldChanges / Building_GreatPersonPoints / BuildingModifiers` 合成；
4. `ModifierStrings` 多数是 `LOC_*` 标签且没有 Summary，插件只做简单 `{Name}` 替换；
5. 没有 `resolved`/出处/覆盖率，也没有效果回归测试。

### 当前架构

- **规则身份层**：构建期写 `_meta.ruleset`（规则 id、中文标签、资料片/DLC、BBG ref、可选子模组、构建时间）。插件只打开配置的 `ruleset`，校验 `_meta.build.dataSource`、`_meta.ruleset.id`、`_meta.effects.rawBuiltAt`、`kb.build.rawBuiltAt` 和 BBG 基座时间戳；任何不一致都 fail closed。
- **效果事实层**：构建期写 `effect_cards` / `modifier_text` / `requirement_text`，并在 `_meta.effects` 记录覆盖率。
  - `effect_cards`：每个实体一张卡，包含官方描述、属性、已解析效果、未解析 Modifier 审计数据；每条效果带 `authority` 和 `source`。
  - `modifier_text`：只收录 `ModifierStrings.Context='Summary'`，本地化并处理 `{Name}`、`{Amount : plural ...}`、`[NEWLINE]`、`[ICON_*]`。
  - `requirement_text`：RequirementStrings 的本地化文本（当前库只有 1 条）。
  - 没有 Summary 的建筑/教条/政策/特性 Modifier 不会被编造成效果句；它们进入 `unresolved`，`effects` 只保留官方描述和直接数值。
- **系统提示**：插件通过 `ctx.systemPrompt.section()` 在每次请求中声明唯一规则、禁止直接读库、要求逐字引用 `effects[].text_zh`。
- **严格 guard**：`strictGrounding: true` 时，`pwsh`/`bash` 命令若包含 Civ6 数据库路径会被拒绝；旧会话传 `source` 也会被拒绝。
- **工具层**：7 个工具都不再接受 `source`。`civi6_entity` 默认返回效果卡；`civi6_entities` 支持 `effects:true`、`beliefClass`；`civi6_search` 的 `type` 包含 `belief`；`civi6_plan` 明确标注是决策模型估计。

### 切换规则

只能改配置，不能按调用切换：

1. 编辑 `dsh-plugin/cordis.patch.yml` 的 `config.ruleset` 为 `bbg` 或 `vanilla`（`vanilla` 内部键 = 标准规则）；
2. 重新安装/重新加载插件（或改 profile 中该插件的 config 后重载）；
3. 新会话里用 `civi6_meta` 确认 `ruleset.id` 与 `locked:true`。

## 数据源

### 标准规则（standard / 内部键 vanilla）

按 `Base → Expansion1 → Expansion2 → 23 个领袖/文明 DLC 包` 的顺序摄取标准规则数据。游戏用同名文件覆盖旧资料片文件（Expansion2 完整替换了 67 个 Expansion1 数据文件），构建器遵循同样的“后加载的同名文件覆盖”规则，避免产生线上游戏中不存在的重复行。

### BBG

BBG 7.5.1 是对标准规则数据的 SQL/文本覆盖，因此 BBG 库以标准库为基座：

1. 复制 `data/civi6.sqlite` 到 `data/civi6-bbg.sqlite`；
2. 按 `BetterBalancedGame.modinfo` 的 `LoadOrder` 执行核心 SQL（当前 150 个文件、约 4300 条语句）；
3. 用 `lang/english.xml` / `lang/chinese.xml` 覆盖 `LocalizedText`；
4. 重建 `effect_cards`、`search_docs`、`search_*` 与 `_meta` 统计。

BBG 库会记录基座库的构建时间；重新构建标准库后再运行 `npm run build:bbg` 会自动重建，不会沿用旧基座。

默认只构建标准规则核心 BBG，不包含：BBG Expanded、BBG 胜利条件变体、BBCC、Settlers 选项、BBS 等可选 Mod。跳过动作会记录在构建输出与 `_meta.build.bbg.skipped`。

BBG 源码获取：

- `npm run fetch:bbg` 默认从 GitHub tag `7.5.1` 下载，优先使用 `cdn.jsdelivr.net`（本机直连 raw.githubusercontent 不可用），并支持 `fastly`/`gcore` 与 raw 回退、单文件续传。
- 也可设置 `CIV6_BBG_DIR` 指向已安装/已解压的 BBG Mod 目录（包含 `BetterBalancedGame.modinfo`），构建时不再联网。
- 升级 BBG：`CIV6_BBG_REF=7.5.2 npm run fetch:bbg`，再 `npm run build:bbg`。
- 使用 `CIV6_BBG_DIR` 更新本地 Mod 文件后，用 `npm run rebuild:bbg` 强制重建。

> 上游 7.5.1 的 `modinfo` 仍有 3 个已合并文件的旧引用（`_dlc_indo_khmer_utils.sql`、`Other.sql`、`lp_arabia_saladin_sultan.sql`）。构建器按实际发布内容做了兼容映射，并把每条映射记录到 `_meta.build.bbg.warnings`。

Windows 上插件会保持数据库的只读连接。重建标准库时若文件被占用，`npm run build` 会自动原地重建；重建 BBG 库若提示文件被占用，请先在 DSH 中禁用/重新加载插件后重试。

## 插件工具

插件注册 7 个查询工具（`civi6_*`）。**所有工具都没有 `source` 参数**；当前规则由插件配置 `ruleset` 固定。旧会话/旧客户端传 `source` 会被拒绝。

| 工具 | 说明 |
| --- | --- |
| `civi6_meta` | 当前规则（`ruleset`/`locked`）、构建元信息、实体类型与行数、效果覆盖率、`kb` 构建/校验状态；`verbose:true` 才返回完整表清单 |
| `civi6_plan` | **决策切面**：`view='focus'` 返回目标层（objective）+ 约束方程（按 tightness 排序）+ 关键路径（在路/绕路/死路）+ 每时代 3 条焦点（why/代价/替代/放弃条件/验收）；`burst`/`ladder`/`check`/`civ` 为原有切面；`speed='online'` 按速度档缩放回合与科技/市政成本。数值是决策模型估计，不是游戏规则数值 |
| `civi6_search` | BM25 全文检索（中英，效果文本已进入实体文档）；`scope:'entity'` 查实体，`scope:'plan'` 查预计算决策卡片，`scope:'all'` 合并 |
| `civi6_entities` | 某类型实体列表：`id`/`name`/`name_zh`/关键属性；`effects:true` 加一行效果；`type:'belief'` 可用 `beliefClass` 过滤 |
| `civi6_entity` | 实体详情：单 id 或 `ids:[...]` 批量，支持中文名自动解析；默认返回效果卡，`effects:'full'` 返回全部效果，`modifiers:'summary'\|'full'` 才展开原始修饰符链；`governor_promotion` 返回 `governors[]` 归属 |
| `civi6_modifiers` | 原始修饰符/需求集审计链，分页（`offset`/`limit`） |
| `civi6_sql` | 只读 SQL（仅 SELECT/WITH/EXPLAIN/PRAGMA）；原始行查询，不用于效果描述。总督归属查 `v_governor_promotion`，不要按晋升 id 前缀推断 |

实体类型：`unit` `building` `district` `civilization` `leader` `trait` `technology` `civic` `policy` `government` `improvement` `resource` `terrain` `feature` `greatperson` `belief` `governor` `governor_promotion`。

> 总督晋升的归属来自 `GovernorPromotionSets`（多对多），不是 id 前缀：BBG 会把晋升改挂到别的总督而保留原 id。工具返回 `governors[]`；零归属时按“数据层未解析”处理。

### 决策知识层（`kb_*`）

原始表回答"数值是多少"，`kb_*` 回答"走这条胜利线，在某个时刻帝国应该是什么状态"。详细设计与编写规范见 [`kb/README.md`](kb/README.md)。

```
L1 原子层   kb_effect / kb_cost / kb_unlock / kb_closure / kb_node
L2 轴       kb_dimension / kb_victory / kb_era_window / kb_speed_profile
L2b 目标层  kb_objective（“T* 前必须为真的条件”，驱动下游）
L3 路径层   kb_path / kb_path_node（on_path / detour 带价 / dead 带原因）
L3b 约束层  kb_constraint / kb_constraint_lever（tightness、绑定排名、杠杆）
L3c 焦点层  kb_era_focus（每时代 3 条：为什么/代价/替代/放弃条件）
L3 切面     kb_plan / kb_target / kb_budget / kb_check / kb_derivation
L4 文明     kb_civ_profile / kb_civ_entity_map / kb_civ_delta / kb_civ_capability
L5 检索     kb_card + v_kb_* 视图 + search_docs(type='card')
```

推理链是单向的：`objective → path → constraint → era_focus → target/check`，工具只读表，构建期断言保证“焦点必须挂约束、死路必须写原因、绑定排名必须按紧张度”。

- **水平切面**：`kb_target.slice_kind='burst'`，某个胜利爆发点的硬门 + 前置闭包 + 瞬时产能/存量。
- **垂直切面**：`kb_target.slice_kind='era'`，从爆发点反推的 8 个时代软目标带 + 检查点。
- 两者共用同一张状态表、同一维度字典、同一来源/置信度模型；差异只在约束语义与检索载荷。
- 数字从当前 DB 现算，意图/锚点来自 `kb/plans/*.json`；构建期写入 `formula`/`provenance`，`npm run kb:verify` 可追溯与回归。

示例：

```jsonc
// 科技胜利爆发点
{ "victory": "science" }
// 中世纪阶段目标 + 朝鲜修正
{ "victory": "science", "civ": "CIVILIZATION_KOREA", "era": "medieval", "view": "ladder" }
// 只需检查清单
{ "victory": "culture", "view": "check" }
```

> 当前 DB 的完整航天链为 **11700 锤**（900 + 1500 + 4×1800 + 2100）；模型文档旧口径的 9900 只算了 3 个火星项目，KB 以 DB 为准。

### 插件配置

`dsh-plugin/cordis.patch.yml`：

```yaml
config:
  ruleset: bbg              # 唯一规则：bbg | vanilla（vanilla = 标准规则，含风云际会）
  lockRuleset: true
  strictGrounding: true     # 拒绝 pwsh/bash 直接读 Civ6 数据库
  effectCardsRequired: true # 缺效果层时 fail closed
  dbPaths:
    vanilla: ../data/civi6.sqlite
    bbg: ../data/civi6-bbg.sqlite
```

旧配置 `dataSource` 仍兼容；环境变量 `CIVI6_DB_PATH` / `CIVI6_BBG_DB_PATH` / `CIVI6_DATA_SOURCE` 可临时覆盖。修改 `ruleset` 或插件代码后需要重新安装/重新加载插件（或重启 DSH）。**没有“日常对比两套规则时直接传 source”这种用法**：要对比，请改配置并重载，或离线运行 `npm run verify:effects` / `npm run kb:verify`。

> `strictGrounding: true` 会拦截 `pwsh`/`bash` 直接读取 `data/civi6*.sqlite`。如果维护/调试确实需要直接读库，把它设为 `false` 并重载；正常问答不要关闭。

> 重建 BBG 库时如果提示文件被占用，请先在 DSH 中禁用/重新加载 `civi6-kb` 插件，再运行 `npm run rebuild:bbg`。标准库支持原地重建，不会被这个问题阻塞。

### 性能设计

单次工具调用的成本由三部分组成，插件对三者都做了约束：

1. **执行的 SQL 条数**：语句按 SQL 文本缓存（不再每次 `prepare`），取数改为批量 `IN (...)`。效果卡按 `card_id` 一次点查，不再运行期拼接 Modifier 文本。
2. **返回体积**：默认只回策展字段、去掉空列、紧凑 JSON，并有 12k 字符预算兜底（超限按数组截断并标注）。`civi6_entity` 默认效果最多 12 条，`civi6_entities(effects:true)` 每行最多 3 条，可用 `effectLimit` 调整。
3. **检索开销**：`search_terms` / `search_postings` / `search_docs.len` 构建期算好，查询只读倒排表；效果文本已加入实体文档，无需二次 join。
4. **决策切面**：`civi6_plan` 只做 1–5 次点查（`kb_plan` / `kb_target` / `kb_budget` / `kb_check` / 文明 delta），不跨原始表 join；实测热态 p95 ≈ 1–2ms、summary payload ≈ 8KB。`npm run kb:verify` 会跑 100 次基准并断言。

## 数据范围与加载顺序

默认摄取「标准规则」下全量内容（不含可选游戏模式与剧本）：

```
Base → Expansion1(迭起兴衰) → Expansion2(风云际会) → 23 个领袖/文明 DLC 包
```

- 同名文件由后续资料片覆盖（例如 Expansion2 的 `Expansion1_*.xml` 覆盖 Expansion1 版本）。
- `CIV6_INCLUDE_MODES=1`：额外纳入游戏模式数据。
- `CIV6_INCLUDE_SCENARIOS=1`：额外纳入剧本/场景数据（可能覆盖核心实体，慎用）。
- 环境变量见 [`.env.example`](./.env.example)。

## 只读保证

- 游戏数据目录仅以只读方式 `readFileSync` 读取。
- 唯一写入目标是 `data/`（本工作区）：标准库、BBG 库、BBG 源码缓存；不触碰游戏文件。
- 插件的 `civi6_sql` 以只读方式打开库，并仅放行 `SELECT/WITH/EXPLAIN/PRAGMA`。
- 严格模式下插件还会拒绝 `pwsh`/`bash` 直接读取 `data/civi6*.sqlite`；维护命令（`npm run build|rebuild|effects:build|reindex|kb:build|verify`）不受影响。
- BBG 源码为 MIT 许可，仅下载到本地缓存，不随仓库分发。
