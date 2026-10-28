# Civ6 知识库（DeepSeek Harness 插件）

基于本地《文明 6》游戏数据（只读）构建的 SQLite 知识库，供 DeepSeek Harness 插件查询使用。支持两套规则库：

- **原版（vanilla）**：`data/civi6.sqlite`
- **BBG（Better Balanced Game）**：`data/civi6-bbg.sqlite`

- **数据源（只读）**：本地安装的 Civ6 `Assets` 下的 XML + SQL 表结构；BBG 为官方 GitHub 仓库的 SQL/文本覆盖，绝不写入游戏目录。
- **技术栈**：Node.js / TypeScript（Node ≥ 22.18，构建使用内置 `node:sqlite`，无原生编译依赖）。
- **形态**：关系库 SQLite（镜像游戏 schema，支持精确数值查询）+ 构建期倒排索引（`civi6_search` 的 BM25 检索）。

## 目录结构

```
dsh-plugin/            # DSH 插件本体（运行时，零 npm 依赖，直接用 node:sqlite 读库）
  index.js             #   注册 6 个工具 + 数据源选择 + 语句缓存 + 批量取数 + 修饰符效果链解析
  cordis.patch.yml     #   注入配置（dataSource + 两个 dbPaths）
  package.json / locale/ / icon.svg
src/                   # 构建管线（把游戏/BBG 数据摄取成 SQLite）
  config.ts            #   定位 Civ6 数据源、两个数据库路径、BBG ref
  schema.ts            #   解析 SQL 表结构
  xml.ts               #   XML 解析与 Row/Replace/Update/Delete 归一化
  db.ts                #   node:sqlite 封装
  ingest.ts            #   加载顺序 + 数据摄取（含同名文件覆盖规则）
  localize.ts          #   本地化文本摄取（中英）
  entities.ts          #   实体抽取与 search_docs 文档构建
  searchindex.ts       #   倒排索引 + 统计预计算（写入 _meta）
  tokenize.ts          #   分词（插件内有一份等价副本）
  bbg/modinfo.ts       #   BBG modinfo 解析、动作选集、上游文件别名
  bbg/apply.ts         #   BBG SQL 语句切分与执行、BBG 文本覆盖
  bbg/fetch.ts         #   固定版本 BBG 源码下载（jsDelivr 优先）
  build.ts / cli.ts    #   构建编排 / 命令入口（build、reindex、fetch-bbg）
scripts/
  ts-loader.mjs        # 让 node 直接运行 .ts（不需要 tsx/esbuild）
  verify-sources.mjs   # 原版 / BBG 差异断言
data/
  civi6.sqlite         # 原版库（插件数据，gitignore）
  civi6-bbg.sqlite     # BBG 覆盖库（插件数据，gitignore）
  bbg-src/<ref>/       # 下载的 BBG 源码缓存（gitignore）
```

## 快速开始

```bash
# 1. 构建原版知识库（已构建则跳过）
npm run build            # Windows 需先设 CIV6_ASSETS，见 .env.example
npm run rebuild          # 强制重建（本机实测约 14s）

# 2. 下载 BBG 源码 + 构建 BBG 覆盖库（BBG 7.5.1）
npm run fetch:bbg        # 下载到 data/bbg-src/7.5.1（jsDelivr 镜像，支持断点续传）
npm run build:bbg        # 复制原版库 → 执行 BBG SQL → 覆盖中英文本 → 重建索引

# 也可以一次构建两套：
npm run build:all

# 3. 只重建检索索引与统计（不需要游戏数据，秒级；也可用来升级旧库）
npm run reindex
npm run reindex:bbg

# 4. 校验两套库的已知差异
npm run verify

# 5. 由 DeepSeek Harness 加载 dsh-plugin/（cordis.patch.yml 已指向两个数据库）
```

脚本用 `node --import ./scripts/ts-loader.mjs` 直接运行 TypeScript，不依赖 tsx/esbuild（`npm run typecheck` 仍需要 `typescript`）。

## 数据源（原版 / BBG）

### 原版

按 `Base → Expansion1 → Expansion2 → 23 个领袖/文明 DLC 包` 的顺序摄取标准规则数据。游戏用同名文件覆盖旧资料片文件（Expansion2 完整替换了 67 个 Expansion1 数据文件），构建器遵循同样的“后加载的同名文件覆盖”规则，避免产生线上游戏中不存在的重复行。

### BBG

BBG 7.5.1 是对原版数据的 SQL/文本覆盖，因此 BBG 库以原版库为基座：

1. 复制 `data/civi6.sqlite` 到 `data/civi6-bbg.sqlite`；
2. 按 `BetterBalancedGame.modinfo` 的 `LoadOrder` 执行核心 SQL（当前 150 个文件、约 4300 条语句）；
3. 用 `lang/english.xml` / `lang/chinese.xml` 覆盖 `LocalizedText`；
4. 重建 `search_docs`、`search_*` 与 `_meta` 统计。

BBG 库会记录基座库的构建时间；重新构建原版库后再运行 `npm run build:bbg` 会自动重建，不会沿用旧基座。

默认只构建标准规则核心 BBG，不包含：BBG Expanded、BBG 胜利条件变体、BBCC、Settlers 选项、BBS 等可选 Mod。跳过动作会记录在构建输出与 `_meta.build.bbg.skipped`。

BBG 源码获取：

- `npm run fetch:bbg` 默认从 GitHub tag `7.5.1` 下载，优先使用 `cdn.jsdelivr.net`（本机直连 raw.githubusercontent 不可用），并支持 `fastly`/`gcore` 与 raw 回退、单文件续传。
- 也可设置 `CIV6_BBG_DIR` 指向已安装/已解压的 BBG Mod 目录（包含 `BetterBalancedGame.modinfo`），构建时不再联网。
- 升级 BBG：`CIV6_BBG_REF=7.5.2 npm run fetch:bbg`，再 `npm run build:bbg`。
- 使用 `CIV6_BBG_DIR` 更新本地 Mod 文件后，用 `npm run rebuild:bbg` 强制重建。

> 上游 7.5.1 的 `modinfo` 仍有 3 个已合并文件的旧引用（`_dlc_indo_khmer_utils.sql`、`Other.sql`、`lp_arabia_saladin_sultan.sql`）。构建器按实际发布内容做了兼容映射，并把每条映射记录到 `_meta.build.bbg.warnings`。

Windows 上插件会保持数据库的只读连接。重建原版库时若文件被占用，`npm run build` 会自动原地重建；重建 BBG 库若提示文件被占用，请在 DSH 中禁用/重新加载插件后重试。

## 插件工具

插件注册 6 个查询工具（`civi6_*`）。所有工具都支持可选 `source` 参数：

```jsonc
{ "source": "vanilla" } // 原版（默认，或插件 config.dataSource）
{ "source": "bbg" }     // BBG 规则库
```

| 工具 | 说明 |
| --- | --- |
| `civi6_meta` | 构建元信息、实体类型与行数、当前数据源、可用数据源列表（默认不返回 450+ 张表的清单，`verbose:true` 才返回） |
| `civi6_search` | BM25 全文检索（中英），返回可直接喂给 `civi6_entity` 的 id |
| `civi6_entities` | 某类型实体列表：`id`/`name`/`name_zh`/关键属性；`full:true` 才回原始列 |
| `civi6_entity` | 实体详情：单 id 或 `ids:[...]` 批量，支持中文名自动解析；`modifiers:"summary"\|"full"\|"none"` |
| `civi6_modifiers` | 修饰符/需求集效果链，分页（`offset`/`limit`） |
| `civi6_sql` | 只读 SQL（仅 SELECT/WITH/EXPLAIN/PRAGMA） |

实体类型：`unit` `building` `district` `civilization` `leader` `trait` `technology` `civic` `policy` `government` `improvement` `resource` `terrain` `feature` `greatperson`。

### 插件配置

`dsh-plugin/cordis.patch.yml`：

```yaml
config:
  dataSource: vanilla          # 默认数据源：vanilla | bbg
  dbPaths:
    vanilla: ../data/civi6.sqlite
    bbg: ../data/civi6-bbg.sqlite
```

旧配置 `dbPath` 仍兼容（等同于 `dbPaths.vanilla`）；环境变量 `CIVI6_DB_PATH` / `CIVI6_BBG_DB_PATH` / `CIVI6_DATA_SOURCE` 可临时覆盖。修改插件配置后需要重新加载插件；日常对比两套规则时直接在工具参数里传 `source` 即可，无需重启。

### 性能设计

单次工具调用的成本由三部分组成，插件对三者都做了约束：

1. **执行的 SQL 条数**：语句按 SQL 文本缓存（不再每次 `prepare`），取数改为批量 `IN (...)`。单位详情 483 → 12 条，`meta` 488 → 2 条，列表 103 → 4 条。
2. **返回体积**：默认只回策展字段、去掉空列、紧凑 JSON，并有 12k 字符预算兜底（超限按数组截断并标注）。单位列表 110KB → 22KB，`meta` 36KB → 7KB，单位详情 40KB → 10KB。
3. **检索开销**：`search_terms` / `search_postings` / `search_docs.len` 构建期算好，查询只读倒排表；带 `type` 过滤时只过滤候选，不再用子集重算 IDF。

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
- 唯一写入目标是 `data/`（本工作区）：原版库、BBG 库、BBG 源码缓存；不触碰游戏文件。
- 插件的 `civi6_sql` 以只读方式打开库，并仅放行 `SELECT/WITH/EXPLAIN/PRAGMA`。
- BBG 源码为 MIT 许可，仅下载到本地缓存，不随仓库分发。
