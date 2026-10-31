import { readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { Config } from "./config.js";
import type { KnowledgeDb } from "./db.js";
import { loadSchemaFiles } from "./schema.js";
import { parseXmlFile, tableOps, type RowOp } from "./xml.js";

export interface DataDir {
  id: string;
  dir: string;
}

export interface LoadOrder {
  baseData: string;
  baseSchema: string;
  /** ordered list of data directories (base first, then DLC) */
  dataDirs: DataDir[];
  /** ordered list of schema SQL files */
  schemaFiles: string[];
  /** ordered list of data XML files */
  dataFiles: string[];
  /** earlier files with the same basename as a later file (shadowed by the later copy) */
  shadowedFiles: string[];
}

/** DLC folders that are optional game modes rather than standard content. */
const MODE_DIRS = new Set(["BarbarianClansMode", "TreeRandomizer"]);

/** Determine which directories to load and in what order. */
export function discoverLoadOrder(config: Config, opts: { skipScenarios?: boolean } = {}): LoadOrder {
  const { paths } = config;
  // Scenarios and game modes are conditionally loaded by the game (they mutate
  // core data). Default to the standard ruleset; opt in via env vars.
  const includeScenarios = /^(1|true|yes)$/i.test(process.env.CIV6_INCLUDE_SCENARIOS ?? "");
  const includeModes = /^(1|true|yes)$/i.test(process.env.CIV6_INCLUDE_MODES ?? "");
  const skipScenarios = opts.skipScenarios ?? !includeScenarios;

  // Explicit priority for the two expansions so they load after base, in
  // canonical order (Expansion1 = Rise and Fall, Expansion2 = Gathering Storm).
  const priority: Record<string, number> = { Expansion1: 1, Expansion2: 2 };

  const dlcDirs: DataDir[] = [];
  if (existsSync(paths.dlc)) {
    for (const name of readdirSync(paths.dlc).sort()) {
      if (skipScenarios && /scenario/i.test(name)) continue;
      if (!includeModes && MODE_DIRS.has(name)) continue;
      const dataDir = join(paths.dlc, name, "Data");
      if (existsSync(dataDir)) dlcDirs.push({ id: name, dir: dataDir });
    }
  }
  dlcDirs.sort((a, b) => (priority[a.id] ?? 3) - (priority[b.id] ?? 3) || a.id.localeCompare(b.id));

  const dataDirs: DataDir[] = [];
  if (existsSync(paths.baseData)) dataDirs.push({ id: "Base", dir: paths.baseData });
  dataDirs.push(...dlcDirs);

  const schemaFiles: string[] = [];
  const dataFiles: string[] = [];

  for (const d of dataDirs) {
    // `*_RemoveData.xml` deletes rows the expansion or a later DLC replaces.
    // In the game's load order they run BEFORE the add files of the same pack;
    // alphabetically they sort after (`Civics.xml` < `RemoveData.xml`), which
    // wipes the freshly added rows instead. Apply removals first.
    const rank = (name: string) => (/removedata/i.test(name) ? 0 : 1);
    for (const f of readdirSync(d.dir).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
      const full = join(d.dir, f);
      if (!statSync(full).isFile()) continue;
      if (f.endsWith(".sql")) schemaFiles.push(full);
      else if (f.endsWith(".xml")) {
        // Optional game-mode data is conditionally loaded by the game; skip it
        // so the default knowledge base reflects standard rules.
        if (!includeModes && /_mode/i.test(f)) continue;
        dataFiles.push(full);
      }
    }
  }
  // Base schema directory first (contains 01_GameplaySchema.sql etc.).
  const baseSchemaFiles = existsSync(paths.baseSchema)
    ? readdirSync(paths.baseSchema)
        .filter((f) => f.endsWith(".sql"))
        .sort()
        .map((f) => join(paths.baseSchema, f))
    : [];
  schemaFiles.unshift(...baseSchemaFiles);

  // Civ6's virtual file system lets a later expansion replace a same-named file
  // wholesale (Expansion2 ships complete replacements for 67 Expansion1 data
  // files). Loading both copies creates rows the live game never has and makes
  // balance mods fail on primary-key updates, so keep only the last copy.
  const lastByBasename = new Map<string, number>();
  dataFiles.forEach((file, index) => lastByBasename.set(basename(file).toLowerCase(), index));
  const shadowedFiles = dataFiles.filter(
    (file, index) => lastByBasename.get(basename(file).toLowerCase()) !== index,
  );
  const effectiveDataFiles = dataFiles.filter(
    (file, index) => lastByBasename.get(basename(file).toLowerCase()) === index,
  );

  return {
    baseData: paths.baseData,
    baseSchema: paths.baseSchema,
    dataDirs,
    schemaFiles,
    dataFiles: effectiveDataFiles,
    shadowedFiles,
  };
}

function applyOps(kb: KnowledgeDb, table: string, ops: RowOp[]): { rows: number; updated: number; deleted: number } {
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  for (const op of ops) {
    if (op.kind === "update") {
      if (op.where && op.set && Object.keys(op.where).length > 0) {
        kb.updateRows(table, op.where, op.set);
        updated++;
      }
    } else if (op.kind === "delete") {
      if (op.where && Object.keys(op.where).length > 0) {
        kb.deleteRows(table, op.where);
        deleted++;
      }
    } else if (op.record && Object.keys(op.record).length > 0) {
      kb.insertRow(table, op.record, op.kind === "insert" ? "insert" : "replace");
      inserted++;
    }
  }
  return { rows: inserted, updated, deleted };
}

export interface IngestResult {
  schemaTables: number;
  dataFilesLoaded: number;
  tablesTouched: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsDeleted: number;
  skippedFiles: string[];
}

/** Create game tables from schema and ingest all data files into the DB. */
export function ingestData(kb: KnowledgeDb, config: Config, opts: { skipScenarios?: boolean } = {}): IngestResult {
  const order = discoverLoadOrder(config, opts);

  const tableDefs = loadSchemaFiles([order.baseSchema]);
  for (const [name, def] of tableDefs) kb.createTable(name, def);

  // DLC schema files (Expansion1_Schema.sql / Expansion2_Schema.sql) may add
  // columns and tables on top of the base schema.
  const dlcSchemaDirs = order.dataDirs.filter((d) => d.id !== "Base").map((d) => d.dir);
  const dlcDefs = loadSchemaFiles(dlcSchemaDirs);
  for (const [name, def] of dlcDefs) {
    if (!kb.hasTable(name)) kb.createTable(name, def);
    else {
      for (const col of def.columns) kb.ensureColumn(name, col);
    }
  }

  const result: IngestResult = {
    schemaTables: kb.listTables().length,
    dataFilesLoaded: 0,
    tablesTouched: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsDeleted: 0,
    skippedFiles: [],
  };

  const touched = new Set<string>();
  kb.begin();
  try {
    for (const file of order.dataFiles) {
      let parsed;
      try {
        parsed = parseXmlFile(file);
      } catch (e) {
        result.skippedFiles.push(`${basename(file)}: ${(e as Error).message}`);
        continue;
      }
      if (parsed.root !== "GameInfo" && parsed.root !== "GameData") continue;
      result.dataFilesLoaded++;
      for (const [table, el] of Object.entries(parsed.body)) {
        const ops = tableOps(el);
        if (ops.length === 0) continue;
        touched.add(table);
        // Text tables (BaseGameText/LocalizedText/GameText) are handled by the
        // localization pass; skip them here to avoid a duplicate text table.
        if (/Text$/i.test(table) && !kb.hasTable(table)) continue;
        const { rows, updated, deleted } = applyOps(kb, table, ops);
        result.rowsInserted += rows;
        result.rowsUpdated += updated;
        result.rowsDeleted += deleted;
      }
    }
  } finally {
    kb.commit();
  }
  result.tablesTouched = touched.size;
  return result;
}
