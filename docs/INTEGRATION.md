# 接入方式

[← 返回 README](../README.md)

AgenticCIV6 的核心是一个宿主无关的知识库与查询契约；"怎么接进去"是可替换的一层。本文先定义所有接入层都必须满足的核心契约，再分别说明已实现的 DSH 插件接入，以及规划中的游戏 Mod 与其他宿主接入。

## 0. 核心 vs 接入层

```
┌──────────────────────────── 核心（不变） ────────────────────────────┐
│  只读知识库（L0–L5）                                                  │
│  三个调用的语义：meta / instance / eval                               │
│  包契约：数据类、行格式、eff/fx/unres、gaps/omitted、体积上限          │
│  口径：speed / era / costBasis / basis / fail-closed 规则身份          │
└──────────────────────────────────────────────────────────────────────┘
        ▲                    ▲                    ▲
        │                    │                    │
  ┌───────────┐        ┌───────────┐        ┌─────────────┐
  │ 方式 A    │        │ 方式 B    │        │ 方式 C      │
  │ DSH 插件  │        │ 游戏 Mod  │        │ 其他宿主    │
  │（已实现） │        │（规划）   │        │（设想）     │
  └───────────┘        └───────────┘        └─────────────┘
```

换接入层只允许替换"谁调用、怎么展示"；数据怎么来、算什么、缺什么，不允许各接入层各自解释。

## 1. 核心契约

### 1.1 三个调用

| 调用 | 输入 | 输出 | 禁止 |
| --- | --- | --- | --- |
| `civi6_meta` | 无（可选 `verbose:true`） | 当前规则（`ruleset`/`locked`）、构建元信息、效果/公式覆盖率、速度档（`speedProfiles`：回合数 / 成本百分比）；`verbose` 时附实体类型清单、完整表清单、构建加载顺序 | 不作数据查询入口 |
| `civi6_instance` | `civ` / `leader` / `speed` / `difficulty` / `section` | 一类数据：`instance`（含 `costBasis`）+ `content` + `definition` + `whenToUse` + `legend` + `gaps` / `omitted` + `manifest.classes` | 没有目标参数，不接受 `source` |
| `civi6_eval` | `builds` / `gates` / `cities` / `popPerCity` / `eraId` / `eraIndex` / `speed` / `victory` | 供给侧 `metrics` + 需求侧 `ledger` / `cut` / `scenarios` / `path` / `deadline` + `basis` + `composition` | 不取数，只做公式组合 |

- 取数只有一个入口：先 `civi6_instance(section='core')` 拿硬约束与 `manifest`，再只取问题涉及的 2~5 类。
- `civi6_eval` 的 `speed` 必填；给 `gates` 时 `eraId` 必填（没有默认时代，它决定分母）。
- 所有成本/回合已是实例速度口径，返回的 `costBasis` / `basis` 回显 `costMultiplier` 与 `turnScale`；`supply` 不随速度缩放。**接入层不得再次乘以速度百分比，也不得自行换算标准/联机。**

### 1.2 包契约

- 11 个数据类：`core` / `tech-tree` / `civic-tree` / `units` / `districts` / `buildings` / `tiles` / `multipliers` / `beliefs` / `promotions` / `governors`。
- 每类自带 `definition` 与 `whenToUse`；行按 `columns` 读，不按位置猜。
- 行：`[h, id, name, era, cost, fx, unres, ...]`；`eff` 是权威文本，`fx` 是已解析公式，`unres` 是未解析机制计数。
- 单类超过 44,000 字符**直接报错**，由接入层原样透出错误，不允许截断后继续。
- `gaps` / `omitted` 是硬契约：写在这里的一律回答"数据层未收录"，不得用记忆补。

### 1.3 规则锁定

- 规则由配置决定，运行期没有按调用切换的 `source` 参数。
- 启动时校验 `_meta.build.dataSource`、`_meta.ruleset.id`、`_meta.effects.rawBuiltAt`、`kb.build.rawBuiltAt` 与 BBG 基座时间戳；不一致就拒绝服务（fail closed）。
- 缺效果事实层时（`effectCardsRequired: true`）同样拒绝启动，避免退回"靠模型记忆描述效果"。

### 1.4 回答协议

接入层应把同一套行为约束传递给模型：

1. 一次取数（`core` → 按需 2~5 类），不在会话里反复扫类别；
2. 算账一律走 `civi6_eval`，不做心算；
3. 答案固定六段：约束方程 / 供给计划 / 砍单 / 情景 / 路径 / 验收；
4. 效果只引用 `eff`/`fx`，`unres>0` 且缺 `fx` 时答"数据层未解析"；
5. 末尾附规则与实体出处。

## 2. 接入方式 A：DeepSeek Harness 插件（已实现）

### 2.1 文件与入口

| 文件 | 作用 |
| --- | --- |
| `dsh-plugin/index.js` | 插件本体：3 个工具、规则锁定、系统提示段、严格 guard、数据类包组装。零 npm 依赖 |
| `dsh-plugin/cordis.patch.yml` | 注入配置（`ruleset` + 两个 `dbPaths`） |
| `dsh-plugin/package.json` | `@local/civi6-kb`；`dsh.bundle.patch` 指向上面的 yml |
| `dsh-plugin/locale/*.json`、`icon.svg` | 界面文案与图标 |

插件导出的 `name` 为 `civi6-kb`，注入 `tools` 与 `systemPrompt` 两个服务；对外只注册 `civi6_meta` / `civi6_instance` / `civi6_eval`。

### 2.2 配置项

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

| 配置 | 说明 |
| --- | --- |
| `ruleset` | 当前会话使用的唯一规则；`vanilla` 是标准规则的内部键（含迭起兴衰/风云际会/DLC）。旧字段 `dataSource` 仍兼容 |
| `lockRuleset` | 声明式锁定：运行期没有按调用切换规则的入口，改规则只能改配置并重载 |
| `strictGrounding` | 拦截 `pwsh`/`bash` 直读 `data/civi6*.sqlite`，只允许 3 个工具取数（默认开） |
| `effectCardsRequired` | 必须有可用的效果事实层，缺失或过期都 fail closed（默认开） |
| `dbPaths` | 两套库的位置；相对路径以插件目录为基准。旧字段 `dbPath` 仍兼容 |

### 2.3 挂载与重载

1. 把 `dsh-plugin/` 作为本地插件装入当前 DSH profile（本地安装，随 profile 生效）；
2. 按需在 profile 的插件配置里覆盖 `ruleset` / `dbPaths`；
3. 重载插件（改配置或改插件代码后都要重载，必要时重启宿主）；
4. 新会话里调用 `civi6_meta`，确认 `ruleset.id` 与 `locked:true`。

### 2.4 环境变量覆盖

仅供临时调试，优先级高于默认值：

| 变量 | 说明 |
| --- | --- |
| `CIVI6_DATA_SOURCE` | 兜底规则（`bbg` / `vanilla`）：只在配置未给 `ruleset` / `dataSource` 时生效 |
| `CIVI6_DB_PATH` | 覆盖标准库路径（优先级低于 `dbPaths.vanilla`） |
| `CIVI6_BBG_DB_PATH` | 覆盖 BBG 库路径（优先级低于 `dbPaths.bbg`） |

### 2.5 严格模式

`strictGrounding: true` 时，命令里出现 Civ6 数据库路径会被 guard 拒绝。维护/调试确实需要直读库时，把它设为 `false` 并重载；正常问答不要关闭。构建与验证命令（`npm run build|rebuild|effects:build|reindex|kb:build|verify`）不受影响。

## 3. 接入方式 B：游戏内 Mod（规划，未实现）

目标形态：把同一份知识库以游戏内顾问/面板的形式接入，玩家在游戏里直接问"这个时代该做什么"。

已确定的边界：

- **复用核心，不重写逻辑**：同一个只读库、同一套三个调用语义、同一份包契约；Mod 侧只负责 I/O 与渲染。
- **KB 只读**：Mod 不写入知识库；数据更新由构建/摄取管线完成。
- **规则版本随游戏**：Mod 场景下规则身份与游戏版本必须绑定，仍按 fail-closed 校验。
- **数据来源切换**：实时数据接入的适配器边界见 [架构方案 §10](ARCHITECTURE.md)。
- 本文只描述接入形状；具体 API、渲染与打包方式在实现时另行设计。

## 4. 接入方式 C：其他宿主（设想）

核心库对宿主没有硬依赖，以下导出可以直接在没有 DSH 的进程里复用：

| 导出 | 用途 |
| --- | --- |
| `createKnowledgeBase(dbPath, sourceName)` | 打开只读库并构造查询对象 |
| `SPECS` / `TOOL_BUDGETS` | 工具与体积预算定义 |
| `renderToolPayload(kind, value)` | 把查询结果渲染成模型可读的载荷 |
| `apply(ctx, config)` | DSH 宿主适配器（`ctx` 实现 `tools` / `systemPrompt` 即可） |

`npm run verify:plugin` 本身就通过直接 import `dsh-plugin/index.js` 完成断言，可作为最小接入示例。要做 MCP / CLI / HTTP 接入，只需实现对应的 I/O 适配与规则锁定，不需要复制查询逻辑。

## 5. 切换规则

只能改配置，不能按调用切换：

1. 编辑插件配置的 `ruleset` 为 `bbg` 或 `vanilla`；
2. 重新安装/重新加载插件（或改 profile 中该插件的 config 后重载）；
3. 新会话用 `civi6_meta` 确认 `ruleset.id` 与 `locked:true`。

要对比两套规则，请改配置并重载，或离线运行 `npm run verify:effects` / `npm run kb:verify`；没有"日常对比时直接传 source"这种用法。

## 6. 退役接口

以下模型面工具已下线：`civi6_entity` / `civi6_entities` / `civi6_plan` / `civi6_search` / `civi6_modifiers` / `civi6_schema` / `civi6_sql`。

原因是它们分别提供了逐实体取数、按目标命中取数、以及绕开数据包直接查库的通道。只要留着任意一条，数据包就不会被当作答案面（实测见 [架构方案 §8](ARCHITECTURE.md)）。对应内部实现（`kb.entityDetail` / `kb.search` / `kb.plan` / `kb.sql`）作为 QA/预设 API 保留，但不再注册给模型。

## 7. 换接入层检查清单

- [ ] 只读打开知识库，规则身份与构建指纹校验失败即拒绝服务
- [ ] 只暴露 `meta` / `instance` / `eval` 三个调用，无 SQL、无单实体放大镜、无 `source` 参数
- [ ] `instance` 按类交付，单类超限报错而不是截断
- [ ] 成本与回合原样透出 `costBasis` / `basis`，不二次换算
- [ ] `gaps` / `omitted` 原样透出，缺失项回答"数据层未收录"
- [ ] 系统提示/工具描述携带同一套回答协议（一次取数、公式算账、六段式、出处）
- [ ] 跑通 `npm run verify:effects`、`npm run kb:verify`
