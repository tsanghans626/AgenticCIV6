# Civ6 知识库外围适配器（只读）

基于本地《文明 6》游戏数据（只读）搭建的知识库外围适配器，用于后续「游戏打法 / 策略」开发。

- **数据源（只读）**：本地 Steam 安装的 Civ6（macOS Aspyr 版）`Civ6.app/Contents/Assets` 下的 XML 数据 + SQL 表结构，绝不写入游戏目录。
- **技术栈**：Node.js / TypeScript（Node ≥ 22.5，使用内置 `node:sqlite`，无原生编译依赖）。
- **知识库形态（混合）**：
  1. **关系库**：镜像游戏自身 schema 的 SQLite（`data/civi6.sqlite`），支持精确数值查询。
  2. **检索层**：对实体文档做 BM25 词法检索（离线、零依赖）+ 可选 OpenAI 向量嵌入做混合检索。
- **对外接口**：HTTP REST API + CLI。

## 快速开始

```bash
# 1. 安装依赖（若 npm 全局缓存有 root 权限问题，可加 --cache 指向本地目录）
npm install

# 2. 构建知识库（只读摄取游戏数据，输出到 ./data）
npm run build          # 增量（已构建且有效则跳过）
npm run rebuild        # 强制重建

# 3. 启动 REST API（默认 http://127.0.0.1:8787）
npm run serve

# 4. 其他命令
npm run search -- --q "学院 相邻加成"   # 命令行检索
npm run stats                          # 查看统计
```

## 数据范围与加载顺序

默认摄取「标准规则」下全量内容（不含可选游戏模式与剧本，避免其 `<Update>/<Delete>` 覆盖核心实体，例如僵尸模式会把战士改写成僵尸）：

```
Base → Expansion1(迭起兴衰) → Expansion2(风云际会) → 23 个领袖/文明 DLC 包
```

- `CIV6_INCLUDE_MODES=1`：额外纳入游戏模式数据（僵尸、秘密结社、垄断、动荡时代等）。
- `CIV6_INCLUDE_SCENARIOS=1`：额外纳入剧本/场景数据（可能覆盖核心实体，慎用）。
- 环境变量见 [`.env.example`](./.env.example)。

> 说明：`DynamicModifiers`（动态修饰符，约 968 条）用于部分复杂领袖/文明能力的运行时效果绑定，v1 尚未展开解析；实体自带的 `Description` 描述文本已完整本地化，可用于检索与阅读。

## REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（数据源、库路径） |
| GET | `/api/meta` | 构建元信息、表/行统计、实体类型 |
| GET | `/api/tables` | 所有表及列、行数 |
| GET | `/api/tables/:name/rows?col=val&limit=&offset=` | 表行数据（按列过滤） |
| GET | `/api/query?sql=SELECT...` | 只读 SQL（仅允许 SELECT/WITH/EXPLAIN/PRAGMA） |
| GET | `/api/entities` | 实体类型清单 |
| GET | `/api/entities/:type?q=&limit=&offset=` | 某类型实体列表（中英名） |
| GET | `/api/entities/:type/:id` | 实体详情（属性 + 关联表 + 效果链） |
| GET | `/api/modifiers/:type/:id` | 实体的修饰符/需求集效果链 |
| GET | `/api/search?q=&type=&limit=` | 混合检索（BM25 + 可选向量） |

实体类型：`unit` `building` `district` `civilization` `leader` `trait` `technology` `civic` `policy` `government` `improvement` `resource` `terrain` `feature` `greatperson`。

### 示例

```bash
# 精确查询：近战战力 ≥ 60 的单位
curl 'http://127.0.0.1:8787/api/query?sql=SELECT%20UnitType,Combat%20FROM%20Units%20WHERE%20Combat>=60%20ORDER%20BY%20Combat%20DESC%20LIMIT%205'

# 学院（Campus）详情：产出、相邻加成、效果链
curl 'http://127.0.0.1:8787/api/entities/district/DISTRICT_CAMPUS'

# 某文明的修饰符效果链
curl 'http://127.0.0.1:8787/api/modifiers/civilization/CIVILIZATION_KOREA'

# 混合检索（中英皆可）
curl 'http://127.0.0.1:8787/api/search?q=科技值'
```

## 向量 / RAG（可选）

不设置 `OPENAI_API_KEY` 时，检索走纯 BM25（离线、零依赖、开箱即用）。设置后，构建时对实体文档生成 `text-embedding-3-small` 嵌入，`/api/search` 自动升级为 BM25 + 向量的混合检索：

```bash
export OPENAI_API_KEY=sk-...
npm run rebuild
```

## 目录结构

```
src/
  config.ts      # 定位 Civ6 数据源 + 配置
  schema.ts      # 解析 SQL 表结构
  xml.ts         # XML 解析与 Row/Replace/Update/Delete 归一化
  db.ts          # node:sqlite 封装（表/列管理、只读友好）
  ingest.ts      # 加载顺序 + 数据摄取
  localize.ts    # 本地化文本摄取（中英）
  entities.ts    # 实体抽取与文档构建
  modifiers.ts   # 修饰符/需求集效果链解析
  search.ts      # BM25 + 向量混合检索
  api.ts         # Express REST API
  build.ts       # 构建编排
  cli.ts         # 命令入口
data/            # 构建产物（civi6.sqlite），gitignore
```

## 只读保证

- 游戏数据目录仅以只读方式 `readFileSync` 读取。
- 唯一写入目标是 `data/`（本工作区），且每次构建先删除旧库再重建，不触碰游戏文件。
- REST API 的 `/api/query` 仅放行 `SELECT/WITH/EXPLAIN/PRAGMA`，写操作一律拒绝。
