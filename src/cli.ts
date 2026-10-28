import { existsSync } from "node:fs";
import { loadBbgConfig, loadConfig, loadOutputConfig, type DataSource } from "./config.js";
import { build, buildBbg, type BuildResult } from "./build.js";
import { KnowledgeDb } from "./db.js";
import { buildSearchIndex, buildStats } from "./searchindex.js";
import { fetchBbgSources } from "./bbg/fetch.js";

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
    `  插入行数    : ${r.rowsInserted}${r.source === "bbg" ? "（继承自原版）" : ""}`,
  );
  console.log(`  本地化文本  : ${r.textEntries}`);
  console.log(`  实体文档    : ${r.entityDocs}`);
  if (r.index) {
    console.log(`  检索索引    : ${r.index.terms} 词 / ${r.index.postings} 倒排项`);
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
        console.log("构建原版知识库…");
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
      console.log(`构建原版知识库（force=${force}）…\n源数据: ${config.paths.assets}`);
      printBuild(await build(config, { force }));
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
  npm run build             构建原版知识库（输出到 ./data/civi6.sqlite）
  npm run rebuild           强制重建原版知识库
  npm run build:bbg         构建 BBG 知识库（输出到 ./data/civi6-bbg.sqlite）
  npm run build:all         依次构建原版 + BBG
  npm run fetch:bbg         下载固定版本的 BBG 源码到 ./data/bbg-src/<ref>
  npm run reindex           为原版库重建检索索引与统计（不需要游戏数据）
  npm run reindex:bbg       为 BBG 库重建检索索引与统计

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
