# Civ6 知识库（DeepSeek Harness 插件）

基于本地《文明 6》游戏数据（只读）构建的 SQLite 知识库，供 DeepSeek Harness 插件查询使用。

- **数据源（只读）**：本地安装的 Civ6 `Assets` 下的 XML + SQL 表结构，绝不写入游戏目录。
- **技术栈**：Node.js / TypeScript（Node ≥ 22.18，构建使用内置 `node:sqlite`，无原生编译依赖）。
- **形态**：关系库 SQLite（镜像游戏 schema，支持精确数值查询）+ 构建期倒排索引（`civi6_search` 的 BM25 检索）。

## 目录结构

```
dsh-plugin/            # DSH 插件本体（运行时，零 npm 依赖，直接用 node:sqlite 读库）
  index.js             #   注册 6 个工具 + 语句缓存 + 批量取数 + 修饰符效果链解析
  cordis.patch.yml     #   注入配置（dbPath 相对插件目录：../data/civi6.sqlite）
  package.json / locale/ / icon.svg
src/                   # 构建管线（把游戏数据摄取成 SQLite）
  config.ts            #   定位 Civ6 数据源 + 配置
  schema.ts            #   解析 SQL 表结构
  xml.ts               #   XML 解析与 Row/Replace/Update/Delete 归一化
  db.ts                #   node:sqlite 封装
  ingest.ts            #   加载顺序 + 数据摄取
  localize.ts          #   本地化文本摄取（中英）
  entities.ts          #   实体抽取与 search_docs 文档构建
  searchindex.ts       #   倒排索引 + 统计预计算（写入 _meta）
  tokenize.ts          #   分词（插件内有一份等价副本）
  build.ts / cli.ts    #   构建编排 / 命令入口（build、reindex）
scripts/
  ts-loader.mjs        # 让 node 直接运行 .ts（不需要 tsx/esbuild）
data/civi6.sqlite      # 构建产物（插件唯一需要的数据，gitignore）
```

## 快速开始

```bash
# 1. 构建知识库（源数据只读；已构建则跳过）
npm run build            # Windows 需先设 CIV6_ASSETS，见 .env.example
npm run rebuild          # 强制重建（本机实测约 18s）

# 2. 只重建检索索引与统计（不需要游戏数据，秒级；也可用来升级旧库）
npm run reindex

# 3. 由 DeepSeek Harness 加载 dsh-plugin/（cordis.patch.yml 已把 dbPath 指向
#    ../data/civi6.sqlite，相对路径以插件目录为基准；亦可用 CIVI6_DB_PATH 覆盖）
```

脚本用 `node --import ./scripts/ts-loader.mjs` 直接运行 TypeScript，不依赖 tsx/esbuild（`npm run typecheck` 仍需要 `typescript`）。

## 插件工具

插件注册 6 个查询工具（`civi6_*`）：

| 工具 | 说明 |
| --- | --- |
| `civi6_meta` | 构建元信息、实体类型与行数（默认不返回 450+ 张表的清单，`verbose:true` 才返回） |
| `civi6_search` | BM25 全文检索（中英），返回可直接喂给 `civi6_entity` 的 id |
| `civi6_entities` | 某类型实体列表：`id`/`name`/`name_zh`/关键属性；`full:true` 才回原始列 |
| `civi6_entity` | 实体详情：单 id 或 `ids:[...]` 批量，支持中文名自动解析；`modifiers:"summary"\|"full"\|"none"` |
| `civi6_modifiers` | 修饰符/需求集效果链，分页（`offset`/`limit`） |
| `civi6_sql` | 只读 SQL（仅 SELECT/WITH/EXPLAIN/PRAGMA） |

实体类型：`unit` `building` `district` `civilization` `leader` `trait` `technology` `civic` `policy` `government` `improvement` `resource` `terrain` `feature` `greatperson`。

### 性能设计

单次工具调用的成本由三部分组成，插件对三者都做了约束：

1. **执行的 SQL 条数**：语句按 SQL 文本缓存（不再每次 `prepare`），取数改为批量 `IN (...)`。单位详情 483 → 12 条，`meta` 488 → 2 条，列表 103 → 4 条。
2. **返回体积**：默认只回策展字段、去掉空列、紧凑 JSON，并有 12k 字符预算兜底（超限按数组截断并标注）。单位列表 110KB → 22KB，`meta` 36KB → 7KB，单位详情 40KB → 10KB。
3. **检索开销**：`search_terms` / `search_postings` / `search_docs.len` 构建期算好，查询只读倒排表；带 `type` 过滤时只过滤候选，不再用子集重算 IDF。1664 篇语料下单次检索约 0.5–4ms（旧实现每次重建内存索引 20–60ms）。

实测（提交前用 A/B 基准脚本对比 12 次典型调用）：SQL 总条数 1208 → 61，输出总体积 261KB → 72KB；排序结果与旧实现逐条一致（分数差 0）。

## 数据范围与加载顺序

默认摄取「标准规则」下全量内容（不含可选游戏模式与剧本）：

```
Base → Expansion1(迭起兴衰) → Expansion2(风云际会) → 23 个领袖/文明 DLC 包
```

- `CIV6_INCLUDE_MODES=1`：额外纳入游戏模式数据。
- `CIV6_INCLUDE_SCENARIOS=1`：额外纳入剧本/场景数据（可能覆盖核心实体，慎用）。
- 环境变量见 [`.env.example`](./.env.example)。

## 只读保证

- 游戏数据目录仅以只读方式 `readFileSync` 读取。
- 唯一写入目标是 `data/`（本工作区），且每次构建先删除旧库再重建，不触碰游戏文件。
- 插件的 `civi6_sql` 以只读方式打开库，并仅放行 `SELECT/WITH/EXPLAIN/PRAGMA`。
