import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { KnowledgeDb } from "./db.js";
import { ingestData, discoverLoadOrder } from "./ingest.js";
import { ingestLocalizedText } from "./localize.js";
import { buildEntityIndex } from "./entities.js";
import { buildSearchIndex, buildStats, hasSearchIndex, type SearchIndexStats } from "./searchindex.js";

export interface BuildResult {
  dbFile: string;
  tables: number;
  rowsInserted: number;
  textEntries: number;
  entityDocs: number;
  durationMs: number;
  index?: SearchIndexStats;
  loadOrder: { id: string; dir: string }[];
}

function fileCount(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).length;
}

/**
 * Build the knowledge base: schema + data + localized text + entity index.
 * Writes only to config.outputDir (never to game data).
 */
export async function build(config: Config, opts: { force?: boolean } = {}): Promise<BuildResult> {
  const t0 = Date.now();
  const { outputDir, dbFile } = config;
  mkdirSync(outputDir, { recursive: true });

  // A DB is considered "built" only if it carries a valid _meta.build record.
  let valid = false;
  if (existsSync(dbFile) && !opts.force) {
    const probe = new KnowledgeDb(dbFile);
    valid = probe.hasTable("_meta") && !!probe.get(`SELECT 1 FROM _meta WHERE key = 'build';`);
    probe.close();
  }
  const needsBuild = !valid;
  if (needsBuild) {
    rmSync(dbFile, { force: true });
    rmSync(dbFile + "-wal", { force: true });
    rmSync(dbFile + "-shm", { force: true });
    rmSync(dbFile + "-journal", { force: true });
  }

  const kb = new KnowledgeDb(dbFile);
  const order = discoverLoadOrder(config);

  let tables = 0;
  let rowsInserted = 0;
  let textEntries = 0;
  let entityDocs = 0;
  let index: SearchIndexStats | undefined;

  if (needsBuild) {
    const ing = ingestData(kb, config);
    tables = ing.schemaTables;
    rowsInserted = ing.rowsInserted;

    const loc = ingestLocalizedText(kb, config);
    textEntries = loc.entries;

    entityDocs = buildEntityIndex(kb);
    index = buildSearchIndex(kb);
    buildStats(kb);

    const meta = {
      builtAt: new Date().toISOString(),
      source: config.paths.assets,
      langs: config.langs,
      tables,
      rowsInserted,
      textEntries,
      entityDocs,
      loadOrder: order.dataDirs,
    };
    kb.db.exec(`CREATE TABLE IF NOT EXISTS "_meta" ("key" TEXT PRIMARY KEY, "value" TEXT);`);
    const ins = kb.db.prepare(`INSERT OR REPLACE INTO "_meta" ("key","value") VALUES (?,?);`);
    ins.run("build", JSON.stringify(meta));
    ins.run("dbFile", dbFile);
  } else {
    const metaRow = kb.get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'build';`);
    if (metaRow) {
      const m = JSON.parse(metaRow.value);
      tables = m.tables;
      rowsInserted = m.rowsInserted;
      textEntries = m.textEntries;
      entityDocs = m.entityDocs;
    }
    tables = kb.listTables().length;

    // Databases built before the read-optimised index existed are upgraded in
    // place instead of forcing a full rebuild from the game data.
    if (!hasSearchIndex(kb)) {
      console.log("检测到旧库，补齐检索索引与统计…");
      index = buildSearchIndex(kb);
      buildStats(kb);
    } else if (!kb.get(`SELECT 1 FROM _meta WHERE key = 'stats';`)) {
      buildStats(kb);
    }
  }

  kb.close();
  return {
    dbFile,
    tables,
    rowsInserted,
    textEntries,
    entityDocs,
    durationMs: Date.now() - t0,
    index,
    loadOrder: order.dataDirs,
  };
}

export function openDb(config: Config): KnowledgeDb {
  if (!existsSync(config.dbFile)) {
    throw new Error(`知识库尚未构建：${config.dbFile}\n请先运行：npm run build`);
  }
  return new KnowledgeDb(config.dbFile);
}
