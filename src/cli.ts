import { loadConfig } from "./config.js";
import { build } from "./build.js";

const [, , cmd, ...rest] = process.argv;

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
      console.log(`\n完成 ✅  ${(r.durationMs / 1000).toFixed(1)}s`);
      console.log(`  数据库      : ${r.dbFile}`);
      console.log(`  表数量      : ${r.tables}`);
      console.log(`  插入行数    : ${r.rowsInserted}`);
      console.log(`  本地化文本  : ${r.textEntries}`);
      console.log(`  实体文档    : ${r.entityDocs}`);
      console.log(`  加载顺序    : ${r.loadOrder.map((d) => d.id).join(" → ")}`);
      break;
    }

    default:
      console.log(`Civ6 知识库构建工具（只读摄取游戏数据 → SQLite）

用法:
  npm run build           构建知识库（源数据只读，输出到 ./data）
  npm run rebuild         强制重建

环境变量见 .env.example。`);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("错误:", (e as Error).message);
  console.error((e as Error).stack);
  process.exit(1);
});
