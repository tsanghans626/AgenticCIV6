import { existsSync } from "node:fs";
import { loadBbgConfig, loadConfig, loadOutputConfig, type DataSource } from "./config.js";
import { build, buildBbg, type BuildResult, type BbgBuildInfo } from "./build.js";
import { KnowledgeDb } from "./db.js";
import { buildSearchIndex, buildStats } from "./searchindex.js";
import { buildKb as buildDecisionKb } from "./kb/buildkb.js";
import { fetchBbgSources } from "./bbg/fetch.js";
import { buildEffectCards, ensureEffectCards } from "./effects.js";
import { buildEntityIndex } from "./entities.js";
import { buildRulesetInfo, readRulesetMeta, writeRulesetMeta } from "./ruleset.js";

const [, , cmd, ...rest] = process.argv;

function hasFlag(name: string, short?: string): boolean {
  return rest.includes(name) || (short ? rest.includes(short) : false);
}

function argValue(name: string, short?: string): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === name || (short && arg === short)) return rest[i + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function parseSource(allowAll = false): DataSource | "all" {
  const raw = (argValue("--source", "-s") ?? "vanilla").trim().toLowerCase();
  if (raw === "vanilla" || raw === "原版" || raw === "base") return "vanilla";
  if (raw === "bbg") return "bbg";
  if (raw === "all" && allowAll) return "all";
  throw new Error(`未知数据源：${raw}（可选 ${allowAll ? "vanilla / bbg / all" : "vanilla / bbg"}）`);
}

function printBuild(r: BuildResult): void {
  console.log(`\n完成 ✅  ${r.source}  ${(r.durationMs / 1000).toFixed(1)}s`);
  console.log(`  数据库      : ${r.dbFile}`);
  console.log(`  表数量      : ${r.tables}`);
  console.log(
    `  插入行数    : ${r.rowsInserted}${r.source === "bbg" ? "（继承自标准库）" : ""}`,
  );
  console.log(`  本地化文本  : ${r.textEntries}`);
  console.log(`  实体文档    : ${r.entityDocs}`);
  if (r.effects) {
    console.log(
      `  效果事实层  : ${r.effects.cards} 卡 / ${r.effects.effects} 效果 / ` +
        `${r.effects.unresolved} 未解析修饰符`,
    );
  }
  if (r.index) {
    console.log(`  检索索引    : ${r.index.terms} 词 / ${r.index.postings} 倒排项`);
  }
  if (r.kb) {
    console.log(
      `  决策层      : ${r.kb.plans} 计划 / ${r.kb.targets} 目标 / ${r.kb.cards} 卡片` +
        `（校验 ${r.kb.validation.ok ? "通过" : "失败"}，${r.kb.validation.errors} 错误 / ${r.kb.validation.warnings} 警告）`,
    );
  }
  if (r.bbg) {
    console.log(`  BBG 版本    : ${r.bbg.modName} (${r.bbg.ref})`);
    console.log(
      `  BBG 覆盖    : ${r.bbg.files} 文件 / ${r.bbg.statements} 语句 / ${r.bbg.textEntries} 文本`,
    );
    if (r.bbg.skipped.length) {
      console.log(`  跳过动作    : ${r.bbg.skipped.length}`);
    }
    for (const warning of r.bbg.warnings) console.log(`  警告        : ${warning}`);
  }
  console.log(`  加载顺序    : ${r.loadOrder.map((d) => d.id).join(" → ")}`);
}

async function main() {
  switch (cmd) {
    case "build": {
      const source = parseSource(true);
      const force = hasFlag("--force", "-f");

      if (source === "all") {
        console.log("构建标准规则知识库…");
        printBuild(await build(loadConfig(), { force }));
        console.log("\n构建 BBG 知识库…");
        printBuild(await buildBbg(loadBbgConfig(), { force }));
        break;
      }

      if (source === "bbg") {
        const config = loadBbgConfig();
        console.log(
          `构建 BBG 知识库（force=${force}）…\nBBG 源码: ${config.bbgDir}\n基座数据库: ${config.baseDbFile}`,
        );
        printBuild(await buildBbg(config, { force }));
        break;
      }

      const config = loadConfig();
      console.log(`构建标准规则知识库（force=${force}）…\n源数据: ${config.paths.assets}`);
      printBuild(await build(config, { force }));
      break;
    }

    case "kb-build": {
      const parsed = parseSource();
      if (parsed === "all") throw new Error("kb-build 不支持 --source all");
      const source = parsed;
      const { dbFile } = loadOutputConfig(source);
      if (!existsSync(dbFile)) {
        throw new Error(`知识库不存在：${dbFile}\n请先运行：${source === "bbg" ? "npm run build:bbg" : "npm run build"}`);
      }
      console.log(`重建决策层（${source}，不需要游戏数据）: ${dbFile}`);
      const kb = new KnowledgeDb(dbFile);
      try {
        buildDecisionKb(kb, source);
        const stats = buildSearchIndex(kb);
        buildStats(kb);
        console.log(`\n完成 ✅  ${stats.docs} 篇文档 / ${stats.terms} 词 / ${stats.postings} 倒排项`);
      } finally {
        kb.close();
      }
      break;
    }

    case "effects-build": {
      const source = parseSource();
      if (source === "all") throw new Error("effects-build 不支持 --source all");
      const { dbFile } = loadOutputConfig(source);
      if (!existsSync(dbFile)) {
        throw new Error(
          `知识库不存在：${dbFile}\n请先运行：${source === "bbg" ? "npm run build:bbg" : "npm run build"}`,
        );
      }
      console.log(`重建效果事实层（${source}，不需要游戏数据）: ${dbFile}`);
      const kb = new KnowledgeDb(dbFile);
      try {
        const buildMeta = kb.get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'build';`);
        const bmeta = buildMeta?.value
          ? (JSON.parse(buildMeta.value) as {
              builtAt?: string;
              source?: string | null;
              loadOrder?: { id: string; dir: string }[];
              bbg?: BbgBuildInfo;
            })
          : null;
        const rawBuiltAt = bmeta?.builtAt ?? null;
        if (!rawBuiltAt) throw new Error("数据库缺少 _meta.build；请先运行完整构建");
        if (!readRulesetMeta(kb)) {
          writeRulesetMeta(
            kb,
            buildRulesetInfo(source, {
              builtAt: rawBuiltAt,
              dbFile,
              source: bmeta?.source ?? null,
              loadOrder: bmeta?.loadOrder ?? [],
              bbg: bmeta?.bbg ?? null,
              baseBuiltAt: bmeta?.bbg?.baseBuiltAt ?? null,
            }),
          );
        }
        const effects = buildEffectCards(kb, source, { rawBuiltAt });
        const docs = buildEntityIndex(kb);
        const stats = buildSearchIndex(kb);
        buildStats(kb);
        console.log(
          `\n完成 ✅  ${effects.cards} 张效果卡 / ${effects.effects} 条效果 / ` +
            `${effects.unresolved} 条未解析修饰符 / ${docs} 篇实体文档 / ` +
            `${stats.terms} 词 / ${stats.postings} 倒排项`,
        );
      } finally {
        kb.close();
      }
      break;
    }

    case "reindex": {
      const source = parseSource();
      if (source === "all") throw new Error("reindex 不支持 --source all");
      const { dbFile } = loadOutputConfig(source);
      if (!existsSync(dbFile)) {
        throw new Error(
          `知识库不存在：${dbFile}\n请先运行：${source === "bbg" ? "npm run build:bbg" : "npm run build"}`,
        );
      }
      console.log(`重建检索索引（${source}，不需要游戏数据）: ${dbFile}`);
      const kb = new KnowledgeDb(dbFile);
      try {
        if (!readRulesetMeta(kb)) {
          const buildMeta = kb.get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'build';`);
          const bmeta = buildMeta?.value
            ? (JSON.parse(buildMeta.value) as {
                builtAt?: string;
                source?: string | null;
                loadOrder?: { id: string; dir: string }[];
                bbg?: BbgBuildInfo;
              })
            : null;
          if (bmeta?.builtAt) {
            writeRulesetMeta(
              kb,
              buildRulesetInfo(source, {
                builtAt: bmeta.builtAt,
                dbFile,
                source: bmeta.source ?? null,
                loadOrder: bmeta.loadOrder ?? [],
                bbg: bmeta.bbg ?? null,
                baseBuiltAt: bmeta.bbg?.baseBuiltAt ?? null,
              }),
            );
          }
        }
        const rebuilt = ensureEffectCards(kb, source);
        if (rebuilt) {
          console.log("检测到效果事实层缺失/陈旧，先重建效果卡与实体文档…");
          buildEntityIndex(kb);
        }
        const stats = buildSearchIndex(kb);
        buildStats(kb);
        console.log(`\n完成 ✅  ${stats.docs} 篇文档 / ${stats.terms} 词 / ${stats.postings} 倒排项`);
      } finally {
        kb.close();
      }
      break;
    }

    case "fetch-bbg": {
      const local = process.env.CIV6_BBG_DIR?.trim();
      if (local) {
        console.log(`CIV6_BBG_DIR 已设置：${local}\n将直接使用本地 BBG 源码，跳过下载。`);
        break;
      }
      const ref = argValue("--ref");
      const force = hasFlag("--force", "-f");
      const { langs } = loadOutputConfig("bbg");
      console.log(`下载 BBG 源码（ref=${ref ?? "默认固定版本"}）…`);
      const result = await fetchBbgSources({ ref, langs, force });
      console.log(`\n完成 ✅  ${result.modName} (${result.modVersion})`);
      console.log(`  目录        : ${result.dir}`);
      console.log(
        `  文件        : ${result.files}（下载 ${result.downloaded}，跳过 ${result.skipped}）`,
      );
      break;
    }

    default:
      console.log(`Civ6 知识库构建工具（只读摄取游戏数据 → SQLite）

用法:
  npm run build             构建标准规则知识库（输出到 ./data/civi6.sqlite）
  npm run rebuild           强制重建标准规则知识库
  npm run build:bbg         构建 BBG 知识库（输出到 ./data/civi6-bbg.sqlite）
  npm run build:all         依次构建标准规则 + BBG
  npm run fetch:bbg         下载固定版本的 BBG 源码到 ./data/bbg-src/<ref>
  npm run reindex           为标准规则库重建检索索引与统计（不需要游戏数据）
  npm run reindex:bbg       为 BBG 库重建检索索引与统计
  npm run effects:build     重建标准规则效果事实层（效果卡 + 实体文档 + 索引）
  npm run effects:build:bbg 重建 BBG 效果事实层
  npm run kb:build          重建标准规则决策层（kb_* 表 + 卡片 + 索引）
  npm run kb:build:bbg      重建 BBG 决策层
  npm run kb:verify         校验决策层、对照锚点与查询基准
  npm run verify:effects    校验效果事实层的已知事实与文本完整性

可选参数:
  --source, -s vanilla|bbg|all   选择数据源（build 默认 vanilla）
  --force, -f                    强制重建
  --ref <tag>                    fetch-bbg 使用的 BBG tag（默认 7.5.1）

环境变量见 .env.example。`);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("错误:", (e as Error).message);
  console.error((e as Error).stack);
  process.exit(1);
});
