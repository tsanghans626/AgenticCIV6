# 快速开始

[← 返回 README](../README.md)

目标：从零构建出可查询的《文明 6》知识库，并跑通验证。

> 本文只讲操作。分层、公式、包契约见 [架构方案](ARCHITECTURE.md)；挂载到宿主见 [接入方式](INTEGRATION.md)。

## 1. 前置条件

| 项 | 要求 |
| --- | --- |
| Node.js | ≥ 22.18.0（构建使用内置 `node:sqlite`，无原生编译依赖） |
| 游戏数据 | 本地已安装的 Civ6；Windows 下 `CIV6_ASSETS` 指向的目录里应直接含 `Base\` 与 `DLC\` |
| BBG（可选） | 已安装/已解压的 BBG Mod 目录（需含 `BetterBalancedGame.modinfo`） |
| 磁盘 | `data/` 下两套库为百 MB 级构建产物，不入库 |

构建产物只写 `data/`；游戏安装目录始终只读。

## 2. 指向数据源

按 [`.env.example`](../.env.example) 在 shell 里设置环境变量（构建器**不会**自动读取 `.env` 文件）：

```bash
# macOS
export CIV6_ASSETS="/path/to/Civ6.app/Contents/Assets"
# Windows（该目录下应直接包含 Base\ 与 DLC\）
# $env:CIV6_ASSETS = "E:\SteamLibrary\steamapps\common\Sid Meier's Civilization VI"
```

常用变量：

| 变量 | 说明 |
| --- | --- |
| `CIV6_ASSETS` | 游戏 Assets 目录（或是 Windows 游戏根目录） |
| `CIV6_ROOT` | 游戏根目录；`CIV6_ASSETS` 未设时按 `<root>/Civ6.app/Contents/Assets` 推导 |
| `CIV6_OUTPUT` | 输出目录，默认 `./data` |
| `CIV6_LANGS` | 语言列表，默认 `en_US,zh_Hans_CN` |
| `CIV6_INCLUDE_MODES` | 设 `1` 时额外纳入游戏模式数据（默认排除） |
| `CIV6_INCLUDE_SCENARIOS` | 设 `1` 时额外纳入剧本/场景数据（可能覆盖核心实体，慎用） |
| `CIV6_BBG_REF` | BBG 版本 tag，默认固定发布版 |
| `CIV6_BBG_DIR` | 指向本地 BBG Mod 目录；设置后跳过下载 |

## 3. 构建

标准规则库（Base → 迭起兴衰 → 风云际会 → 23 个领袖/文明 DLC 包）：

```bash
npm run build            # 已有库则跳过
npm run rebuild          # 强制重建
```

BBG 以标准库为基座，分两步：

```bash
npm run fetch:bbg        # 下载固定 tag 的 BBG 源码到 data/bbg-src/<ref>
npm run build:bbg        # 复制标准库 → 执行 BBG SQL → 覆盖中英文本 → 效果卡 → 索引
```

两套一起构建：

```bash
npm run build:all
```

`npm run rebuild:bbg` 用于强制重建 BBG 库（例如更新了本地 `CIV6_BBG_DIR` 之后）。

## 4. 增量重建

以下命令不需要游戏安装数据，通常秒级：

| 命令 | 重建什么 | 何时用 |
| --- | --- | --- |
| `npm run effects:build` / `effects:build:bbg` | 效果事实层（`effect_cards` 等） | 改了效果抽取逻辑、升级旧库 |
| `npm run kb:build` / `kb:build:bbg` | 决策知识层（`kb_*`） | 改了 `kb/*.json` 策划数据 |
| `npm run reindex` / `reindex:bbg` | 倒排索引与统计 | 检索/统计口径变化；效果层缺失时会自动补建 |

## 5. 验证

```bash
npm run verify          # 标准库与 BBG 的已知差异断言
npm run verify:effects  # 效果层指纹与文本完整性 + SPECS 一致性 + 插件夹具
npm run kb:verify       # 决策层断言与查询基准
npm run typecheck       # TypeScript 类型检查（需要 devDependencies）
```

`verify:effects` 会依次执行 `verify-effects`、`verify:spec-parity`、`verify:plugin`。其中 `verify:plugin` 会打印各数据类的实测体积，是改插件后最先跑的一条。

轨迹体检（读取本机 DSH 会话日志）：

```bash
npm run sessions:analyze
npm run sessions:analyze -- "C:\Users\<you>\.dsh\sessions\--D-Code-AgenticCIV6--\session-xxxx"
```

输出步数、每步调用数、输出 token、被截断的载荷、重复取类与 `entityCalls`（改造后应为 0）。

## 6. BBG 源码获取

- 默认从 GitHub 固定 tag 下载，优先 `cdn.jsdelivr.net`，并支持 `fastly` / `gcore` 与 raw 回退、单文件续传。
- 离线可用：把 `CIV6_BBG_DIR` 指向已安装的 BBG Mod 目录（需含 `BetterBalancedGame.modinfo`），构建时不再联网。
- 升级版本：`CIV6_BBG_REF=<新 tag> npm run fetch:bbg`，再 `npm run build:bbg`。
- 上游 `modinfo` 可能残留已合并文件的旧引用；构建器按实际发布内容做兼容映射，并把每条映射写入 `_meta.build.bbg.warnings`，不静默跳过。

## 7. 常见问题

| 现象 | 处理 |
| --- | --- |
| `npm run build` 报"未找到 Civ6 游戏数据" | 检查 `CIV6_ASSETS`（或 `CIV6_ROOT`）是否指向含 `Base/` 的目录 |
| BBG 重建提示数据库文件被占用 | 先在 DSH 中禁用/重新加载插件，再 `npm run rebuild:bbg`；标准库支持原地重建 |
| 构建输出出现 `skipped` | 可选子模组（BBG Expanded、BBCC、BBS、Settlers、胜利条件变体）默认不构建，记录在 `_meta.build.bbg.skipped` |
| 效果层/决策层像旧的 | 插件会校验 `_meta.effects.rawBuiltAt`、`kb.build.rawBuiltAt` 与基座构建时间，不一致就 fail closed；用 `effects:build` / `kb:build` 重建 |

## 8. 下一步

- 挂载到 DeepSeek Harness → [接入方式](INTEGRATION.md)
- 想理解为什么这样分层 → [架构方案](ARCHITECTURE.md)
