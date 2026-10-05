import { loadConfig } from "./config.js";
import { build, openDb } from "./build.js";
import { createApp } from "./api.js";
import { hybridSearchSync } from "./search.js";
import { listEntityTypes, getSpec } from "./entities.js";

const [, , cmd, ...rest] = process.argv;

function arg(name: string, short?: string): string | undefined {
  const idx = rest.findIndex((a) => a === name || (short && a === short));
  if (idx >= 0 && idx + 1 < rest.length) return rest[idx + 1];
  return undefined;
}

function hasFlag(name: string, short?: string): boolean {
  return rest.includes(name) || (short ? rest.includes(short) : false);
}

async function main() {
  const config = loadConfig();

  switch (cmd) {
    case "build": {
      const force = hasFlag("--force", "-f");
      console.log(`构建知识库（force=${force}）...\n源数据: ${config.paths.assets}`);
      const r = await build(config, { force });
      console.log(`\n完成 ✅  ${((r.durationMs) / 1000).toFixed(1)}s`);
      console.log(`  数据库      : ${r.dbFile}`);
      console.log(`  表数量      : ${r.tables}`);
      console.log(`  插入行数    : ${r.rowsInserted}`);
      console.log(`  本地化文本  : ${r.textEntries}`);
      console.log(`  实体文档    : ${r.entityDocs}`);
      console.log(`  向量嵌入    : ${r.embeddedDocs}${config.openaiApiKey ? "" : "（未设置 OPENAI_API_KEY，仅 BM25）"}`);
      console.log(`  加载顺序    : ${r.loadOrder.map((d) => d.id).join(" → ")}`);
      break;
    }

    case "serve": {
      const kb = openDb(config);
      const app = createApp(kb, config);
      app.listen(config.port, config.host, () => {
        console.log(`Civ6 知识库 API 已启动: http://${config.host}:${config.port}`);
        console.log(`  健康检查      GET /api/health`);
        console.log(`  元信息        GET /api/meta`);
        console.log(`  表清单        GET /api/tables`);
        console.log(`  表行数据      GET /api/tables/:name/rows`);
        console.log(`  只读SQL       GET /api/query?sql=SELECT...`);
        console.log(`  实体类型      GET /api/entities`);
        console.log(`  实体列表      GET /api/entities/:type`);
        console.log(`  实体详情      GET /api/entities/:type/:id`);
        console.log(`  效果链        GET /api/modifiers/:type/:id`);
        console.log(`  混合检索      GET /api/search?q=...`);
        console.log(`  （只读数据源，不写游戏目录；输出库: ${config.dbFile}）`);
      });
      break;
    }

    case "search": {
      const q = arg("--q", "-q");
      if (!q) {
        console.error('用法: npm run search -- --q "学院 相邻加成" [--type unit] [--limit 10]');
        process.exit(1);
      }
      const kb = openDb(config);
      const r = hybridSearchSync(kb, q, {
        limit: Number(arg("--limit") ?? 10),
        type: arg("--type"),
      });
      console.log(`查询: ${r.query}  (${r.count} 条, ${r.embedding ? "BM25+向量" : "BM25"})`);
      for (const x of r.results) {
        console.log(`  [${x.type}] ${x.name} (${x.name_zh})  score=${x.score.toFixed(3)}`);
        console.log(`      ${x.snippet.replace(/\n/g, " ⏎ ").slice(0, 160)}`);
      }
      kb.close();
      break;
    }

    case "stats": {
      const kb = openDb(config);
      console.log(`知识库: ${config.dbFile}`);
      console.log(`源数据: ${config.paths.assets}`);
      const tables = kb.listTables();
      let totalRows = 0;
      for (const t of tables) totalRows += kb.countRows(t);
      console.log(`表数量: ${tables.length}, 总行数: ${totalRows}`);
      console.log(`\n实体类型:`);
      for (const t of listEntityTypes()) {
        const spec = getSpec(t)!;
        console.log(`  ${t.padEnd(14)} ${spec.table.padEnd(26)} ${kb.countRows(spec.table)} 行`);
      }
      const loc = kb.countRows("LocalizedText");
      const docs = kb.countRows("search_docs");
      console.log(`\n本地化文本: ${loc} 条\n实体文档: ${docs} 条`);
      kb.close();
      break;
    }

    default:
      console.log(`Civ6 知识库外围适配器（只读）

用法:
  npm run build           构建知识库（源数据只读，输出到 ./data）
  npm run rebuild         强制重建
  npm run serve           启动 REST API
  npm run search -- --q "查询词"   命令行检索
  npm run stats           查看统计

环境变量见 .env.example。`);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("错误:", (e as Error).message);
  console.error((e as Error).stack);
  process.exit(1);
});
