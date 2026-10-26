# Civ6 知识库（DeepSeek Harness 插件）

基于本地《文明 6》游戏数据（只读）构建的 SQLite 知识库，供 DeepSeek Harness 插件查询使用。

- **数据源（只读）**：本地 Steam 安装的 Civ6（macOS Aspyr 版）`Civ6.app/Contents/Assets` 下的 XML + SQL 表结构，绝不写入游戏目录。
- **技术栈**：Node.js / TypeScript（Node ≥ 22.5，构建使用内置 `node:sqlite`，无原生编译依赖）。
- **形态**：关系库 SQLite（镜像游戏 schema，支持精确数值查询）+ 实体文档（`search_docs`，供 BM25 检索）。

## 目录结构

```
dsh-plugin/            # DSH 插件本体（运行时，零 npm 依赖，直接用 node:sqlite 读库）
  index.js             #   注册 6 个工具 + BM25 检索 + 修饰符效果链解析
  cordis.patch.yml     #   注入配置（dbPath 指向 data/civi6.sqlite）
  package.json / locale/ / icon.svg
src/                   # 构建管线（把游戏数据摄取成 SQLite）
  config.ts            #   定位 Civ6 数据源 + 配置
  schema.ts            #   解析 SQL 表结构
  xml.ts               #   XML 解析与 Row/Replace/Update/Delete 归一化
  db.ts                #   node:sqlite 封装
  ingest.ts            #   加载顺序 + 数据摄取
  localize.ts          #   本地化文本摄取（中英）
  entities.ts          #   实体抽取与 search_docs 文档构建
  build.ts             #   构建编排
  cli.ts               #   命令入口（仅 build）
data/civi6.sqlite      # 构建产物（插件唯一需要的数据，gitignore）
```

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 构建知识库（若 data/civi6.sqlite 不存在或需重建；源数据只读）
npm run build            # 增量（已构建且有效则跳过）
npm run rebuild          # 强制重建

# 3. 由 DeepSeek Harness 加载 dsh-plugin/（cordis.patch.yml 已把
#    dbPath 指向 ./data/civi6.sqlite，亦可用 CIVI6_DB_PATH 覆盖）
```

## 插件工具

插件注册 6 个查询工具（`civi6_*`）：

| 工具 | 说明 |
| --- | --- |
| `civi6_meta` | 构建元信息、表/行统计、实体类型 |
| `civi6_search` | BM25 全文检索（中英，离线） |
| `civi6_entities` | 某类型实体列表（中英名 + 原始列） |
| `civi6_entity` | 单个实体详情（属性 + 关联表 + 效果链） |
| `civi6_modifiers` | 修饰符/需求集效果链 |
| `civi6_sql` | 只读 SQL（仅 SELECT/WITH/EXPLAIN/PRAGMA） |

实体类型：`unit` `building` `district` `civilization` `leader` `trait` `technology` `civic` `policy` `government` `improvement` `resource` `terrain` `feature` `greatperson`。

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
