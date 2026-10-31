import { existsSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type BbgConfig, type Config, type DataSource } from "./config.js";
import { KnowledgeDb } from "./db.js";
import { ingestData, discoverLoadOrder } from "./ingest.js";
import { ingestLocalizedText } from "./localize.js";
import { buildEntityIndex } from "./entities.js";
import { buildSearchIndex, buildStats, hasSearchIndex, type SearchIndexStats } from "./searchindex.js";
import { loadBbgModInfo } from "./bbg/modinfo.js";
import { applyBbg } from "./bbg/apply.js";
import { buildKb, hasKb, type KbBuildResult } from "./kb/buildkb.js";
import { buildEffectCards, ensureEffectCards, hasEffectCards, type EffectStats } from "./effects.js";
import { buildRulesetInfo, writeRulesetMeta } from "./ruleset.js";

export interface BbgBuildInfo {
  ref: string;
  modVersion: string;
  modName: string;
  dir: string;
  /** timestamp of the vanilla build this overlay was created from */
  baseBuiltAt?: string;
  files: number;
  statements: number;
  textEntries: number;
  skipped: { id: string; reason: string }[];
  warnings: string[];
}

export interface BuildResult {
  source: DataSource;
  dbFile: string;
  tables: number;
  rowsInserted: number;
  textEntries: number;
  entityDocs: number;
  durationMs: number;
  index?: SearchIndexStats;
  loadOrder: { id: string; dir: string }[];
  bbg?: BbgBuildInfo;
  effects?: EffectStats;
  kb?: Pick<KbBuildResult, "plans" | "targets" | "budgets" | "checks" | "cards" | "validation">;
}

interface StoredBuildMeta {
  builtAt?: string;
  dataSource?: string;
  source?: string;
  rowsInserted?: number;
  textEntries?: number;
  entityDocs?: number;
  loadOrder?: { id: string; dir: string }[];
  bbg?: BbgBuildInfo;
  [key: string]: unknown;
}

function fileCount(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).length;
}

function removeDb(dbFile: string): void {
  rmSync(dbFile, { force: true });
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    rmSync(dbFile + suffix, { force: true });
  }
}

function isFileLockError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

/** Drop every user table/view so a locked DB can be rebuilt without deleting it. */
function dropAllObjects(dbFile: string): void {
  const db = new KnowledgeDb(dbFile);
  try {
    db.db.exec("PRAGMA foreign_keys = OFF;");
    const objects = db.all<{ type: string; name: string }>(
      `SELECT type, name FROM sqlite_master
        WHERE type IN ('view','table') AND name NOT LIKE 'sqlite_%';`,
    );
    db.begin();
    try {
      for (const object of objects.filter((o) => o.type === "view")) {
        db.db.exec(`DROP VIEW IF EXISTS "${object.name}";`);
      }
      for (const object of objects.filter((o) => o.type === "table")) {
        db.db.exec(`DROP TABLE IF EXISTS "${object.name}";`);
      }
      db.commit();
    } catch (error) {
      try {
        db.db.exec("ROLLBACK;");
      } catch {
        /* no active transaction */
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

function readBuildMeta(dbFile: string): StoredBuildMeta | null {
  if (!existsSync(dbFile)) return null;
  let probe: KnowledgeDb | null = null;
  try {
    probe = new KnowledgeDb(dbFile);
    const row = probe.get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'build';`);
    return row?.value ? (JSON.parse(row.value) as StoredBuildMeta) : null;
  } catch {
    return null;
  } finally {
    probe?.close();
  }
}

function writeMeta(kb: KnowledgeDb, key: string, value: unknown): void {
  kb.db.exec(`CREATE TABLE IF NOT EXISTS "_meta" ("key" TEXT PRIMARY KEY, "value" TEXT);`);
  kb.db
    .prepare(`INSERT OR REPLACE INTO "_meta" ("key","value") VALUES (?,?);`)
    .run(key, JSON.stringify(value));
}

/**
 * Build the vanilla knowledge base: schema + data + localized text + entity index.
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
    try {
      removeDb(dbFile);
    } catch (error) {
      if (!isFileLockError(error)) throw error;
      console.log("数据库被正在运行的 DSH 插件占用，改为原地重建…");
      dropAllObjects(dbFile);
    }
  }

  const kb = new KnowledgeDb(dbFile);
  const order = discoverLoadOrder(config);
  if (order.shadowedFiles.length) {
    console.log(
      `  同名覆盖    : ${order.shadowedFiles.length} 个文件由后续资料片版本覆盖`,
    );
  }

  let tables = 0;
  let rowsInserted = 0;
  let textEntries = 0;
  let entityDocs = 0;
  let index: SearchIndexStats | undefined;
  let kbInfo: BuildResult["kb"];
  let effectStats: EffectStats | undefined;

  if (needsBuild) {
    const ing = ingestData(kb, config);
    tables = ing.schemaTables;
    rowsInserted = ing.rowsInserted;

    const loc = ingestLocalizedText(kb, config);
    textEntries = loc.entries;

    const builtAt = new Date().toISOString();
    effectStats = buildEffectCards(kb, "vanilla", { rawBuiltAt: builtAt, builtAt });
    entityDocs = buildEntityIndex(kb);
    const kbResult = buildKb(kb, "vanilla", { rawBuiltAt: builtAt, builtAt });
    kbInfo = {
      plans: kbResult.plans,
      targets: kbResult.targets,
      budgets: kbResult.budgets,
      checks: kbResult.checks,
      cards: kbResult.cards,
      validation: kbResult.validation,
    };
    index = buildSearchIndex(kb);
    buildStats(kb);
    tables = kb.listTables().length;

    const meta = {
      builtAt,
      dataSource: "vanilla",
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
    writeRulesetMeta(
      kb,
      buildRulesetInfo("vanilla", {
        builtAt,
        dbFile,
        source: config.paths.assets,
        loadOrder: order.dataDirs,
      }),
    );
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
    const metaBuiltAt: string | undefined =
      metaRow ? (JSON.parse(metaRow.value) as { builtAt?: string }).builtAt : undefined;

    let entityIndexRebuilt = false;
    if (!hasEffectCards(kb)) {
      console.log("检测到效果事实层缺失/陈旧，重建…");
      effectStats = ensureEffectCards(kb, "vanilla") ?? undefined;
      entityDocs = buildEntityIndex(kb);
      entityIndexRebuilt = true;
    }

    // Databases built before the decision layer existed are upgraded in place.
    // Keep the KB in sync with the raw build timestamp so BBG overlays cannot
    // silently serve vanilla targets.
    const kbMeta = kb.get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'kb.build';`);
    const kbRawBuiltAt = kbMeta
      ? (JSON.parse(kbMeta.value) as { rawBuiltAt?: string }).rawBuiltAt
      : undefined;
    const needKb = !hasKb(kb) || (!!metaBuiltAt && kbRawBuiltAt !== metaBuiltAt);
    if (needKb) {
      console.log("检测到 KB 层缺失/陈旧，重建决策层…");
      const kbResult = buildKb(kb, "vanilla", { rawBuiltAt: metaBuiltAt ?? null, builtAt: new Date().toISOString() });
      kbInfo = {
        plans: kbResult.plans,
        targets: kbResult.targets,
        budgets: kbResult.budgets,
        checks: kbResult.checks,
        cards: kbResult.cards,
        validation: kbResult.validation,
      };
      index = buildSearchIndex(kb);
      buildStats(kb);
    } else if (entityIndexRebuilt) {
      readKbInfo(kb, (info) => { kbInfo = info; });
      index = buildSearchIndex(kb);
      buildStats(kb);
    } else {
      readKbInfo(kb, (info) => { kbInfo = info; });
    }

    // Databases built before the read-optimised index existed are upgraded in
    // place instead of forcing a full rebuild from the game data.
    if (!hasSearchIndex(kb)) {
      console.log("检测到旧库，补齐检索索引与统计…");
      index = buildSearchIndex(kb);
      buildStats(kb);
    } else if (!kb.get(`SELECT 1 FROM _meta WHERE key = 'stats';`)) {
      buildStats(kb);
    }
    if (!kb.get(`SELECT 1 FROM _meta WHERE key = 'ruleset';`)) {
      writeRulesetMeta(
        kb,
        buildRulesetInfo("vanilla", {
          builtAt: metaBuiltAt ?? new Date().toISOString(),
          dbFile,
          source: config.paths.assets,
          loadOrder: order.dataDirs,
        }),
      );
    }
  }

  kb.close();
  return {
    source: "vanilla",
    dbFile,
    tables,
    rowsInserted,
    textEntries,
    entityDocs,
    durationMs: Date.now() - t0,
    index,
    loadOrder: order.dataDirs,
    effects: effectStats,
    kb: kbInfo,
  };
}

/** Read the stored KB counters without running a build. */
function readKbInfo(kb: KnowledgeDb, set: (info: NonNullable<BuildResult["kb"]>) => void): void {
  const row = kb.get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'kb.build';`);
  if (!row?.value) return;
  const m = JSON.parse(row.value) as {
    plans?: number; targets?: number; budgets?: number; checks?: number; cards?: number;
  };
  const v = kb.get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'kb.validation';`);
  const validation = v?.value
    ? (JSON.parse(v.value) as { ok: boolean; errors: number; warnings: number })
    : { ok: true, errors: 0, warnings: 0 };
  set({
    plans: m.plans ?? 0,
    targets: m.targets ?? 0,
    budgets: m.budgets ?? 0,
    checks: m.checks ?? 0,
    cards: m.cards ?? 0,
    validation: {
      ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
      issues: [],
      stats: {
        plans: 0, targets: 0, budgets: 0, checks: 0, cards: 0, effects: 0, costs: 0,
        unlocks: 0, closure: 0, civs: 0, nodes: 0, objectives: 0, constraints: 0,
        focus: 0, capabilities: 0, supplies: 0, ledger: 0, cuts: 0, scenarios: 0,
      },
    },
  });
}

/**
 * Build the BBG knowledge base as an overlay on the vanilla DB: copy the base
 * database, execute BBG's selected SQL in load order, apply its text, then
 * rebuild the entity docs and search index.
 */
export async function buildBbg(config: BbgConfig, opts: { force?: boolean } = {}): Promise<BuildResult> {
  const t0 = Date.now();
  mkdirSync(config.outputDir, { recursive: true });

  let baseMeta = readBuildMeta(config.baseDbFile);
  if (!baseMeta) {
    console.log("未找到有效的标准规则知识库，先构建标准库…");
    await build(loadConfig(), { force: false });
    baseMeta = readBuildMeta(config.baseDbFile);
  }
  if (!baseMeta) {
    throw new Error(`标准规则知识库无效：${config.baseDbFile}\n请先运行：npm run build`);
  }

  let stored: StoredBuildMeta | null = null;
  let valid = false;
  if (existsSync(config.dbFile) && !opts.force) {
    stored = readBuildMeta(config.dbFile);
    valid =
      stored?.dataSource === "bbg" &&
      stored.bbg?.ref === config.bbgRef &&
      stored.bbg?.dir === config.bbgDir &&
      stored.bbg?.baseBuiltAt === baseMeta.builtAt;
  }

  if (!valid) {
    try {
      removeDb(config.dbFile);
      copyFileSync(config.baseDbFile, config.dbFile);
    } catch (error) {
      throw new Error(
        `无法重建 BBG 数据库（文件可能被正在运行的 DSH 插件占用）：${config.dbFile}\n` +
          `请重启 DSH 后重试。\n${(error as Error).message}`,
      );
    }
  }

  const kb = new KnowledgeDb(config.dbFile, { doubleQuotedStringLiterals: true });
  try {
    let index: SearchIndexStats | undefined;
    let bbgInfo: BbgBuildInfo;
    let tables: number;
    let rowsInserted: number;
    let textEntries: number;
    let entityDocs: number;
    let loadOrder: { id: string; dir: string }[];
    let kbInfo: BuildResult["kb"];
    let effectStats: EffectStats | undefined;

    if (!valid) {
      const mod = loadBbgModInfo(config.bbgDir);
      const applied = applyBbg(kb, mod, { dir: config.bbgDir, langs: config.langs });
      const bbgBuiltAt = new Date().toISOString();
      bbgInfo = {
        ref: config.bbgRef,
        modVersion: mod.version,
        modName: mod.name,
        dir: config.bbgDir,
        baseBuiltAt: typeof baseMeta.builtAt === "string" ? baseMeta.builtAt : undefined,
        files: applied.files,
        statements: applied.statements,
        textEntries: applied.textEntries,
        skipped: applied.skipped,
        warnings: applied.warnings,
      };
      effectStats = buildEffectCards(kb, "bbg", { rawBuiltAt: bbgBuiltAt, builtAt: bbgBuiltAt });
      entityDocs = buildEntityIndex(kb);
      // Write the raw-build anchor before the KB pass: an overlay starts from
      // a copy of the vanilla DB, so the copied `_meta.build` would otherwise
      // look stale during KB validation.
      writeMeta(kb, "build", {
        builtAt: bbgBuiltAt,
        dataSource: "bbg",
        source: baseMeta.source ?? null,
        baseDb: config.baseDbFile,
        langs: config.langs,
        tables: kb.listTables().length,
        rowsInserted: baseMeta.rowsInserted ?? 0,
        textEntries: kb.countRows("LocalizedText"),
        entityDocs,
        loadOrder: baseMeta.loadOrder ?? [],
        bbg: bbgInfo,
      });
      writeRulesetMeta(
        kb,
        buildRulesetInfo("bbg", {
          builtAt: bbgBuiltAt,
          dbFile: config.dbFile,
          source: baseMeta.source ?? null,
          loadOrder: baseMeta.loadOrder ?? [],
          bbg: bbgInfo,
          baseBuiltAt: bbgInfo.baseBuiltAt ?? null,
        }),
      );
      const kbResult = buildKb(kb, "bbg", {
        // The raw mirror is this BBG database, so its own build timestamp is
        // the staleness anchor; `baseBuiltAt` is tracked separately in bbgInfo.
        rawBuiltAt: bbgBuiltAt,
        builtAt: bbgBuiltAt,
      });
      kbInfo = {
        plans: kbResult.plans,
        targets: kbResult.targets,
        budgets: kbResult.budgets,
        checks: kbResult.checks,
        cards: kbResult.cards,
        validation: kbResult.validation,
      };
      index = buildSearchIndex(kb);
      buildStats(kb);

      tables = kb.listTables().length;
      rowsInserted = baseMeta.rowsInserted ?? 0;
      textEntries = kb.countRows("LocalizedText");
      loadOrder = baseMeta.loadOrder ?? [];
      writeMeta(kb, "build", {
        builtAt: bbgBuiltAt,
        dataSource: "bbg",
        source: baseMeta.source ?? null,
        baseDb: config.baseDbFile,
        langs: config.langs,
        tables,
        rowsInserted,
        textEntries,
        entityDocs,
        loadOrder,
        bbg: bbgInfo,
      });
      writeMeta(kb, "dbFile", config.dbFile);
    } else {
      const meta = stored as StoredBuildMeta;
      tables = kb.listTables().length;
      rowsInserted = meta.rowsInserted ?? 0;
      textEntries = meta.textEntries ?? kb.countRows("LocalizedText");
      entityDocs = meta.entityDocs ?? (kb.hasTable("search_docs") ? kb.countRows("search_docs") : 0);
      loadOrder = meta.loadOrder ?? [];
      bbgInfo = meta.bbg as BbgBuildInfo;

      if (!kb.hasTable("search_docs")) {
        console.log("检测到不完整的 BBG 库，补齐实体文档与检索索引…");
        entityDocs = buildEntityIndex(kb);
      }

      let entityIndexRebuilt = false;
      if (!hasEffectCards(kb)) {
        console.log("检测到 BBG 效果事实层缺失/陈旧，重建…");
        effectStats = ensureEffectCards(kb, "bbg") ?? undefined;
        entityDocs = buildEntityIndex(kb);
        entityIndexRebuilt = true;
      }

      const kbMeta = kb.get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'kb.build';`);
      const kbRawBuiltAt = kbMeta
        ? (JSON.parse(kbMeta.value) as { rawBuiltAt?: string }).rawBuiltAt
        : undefined;
      const metaBuiltAt = typeof meta.builtAt === "string" ? meta.builtAt : undefined;
      if (!hasKb(kb) || (metaBuiltAt && kbRawBuiltAt !== metaBuiltAt)) {
        console.log("检测到 BBG KB 层缺失/陈旧，重建决策层…");
        const kbResult = buildKb(kb, "bbg", {
          rawBuiltAt: metaBuiltAt ?? new Date().toISOString(),
          builtAt: metaBuiltAt ?? new Date().toISOString(),
        });
        kbInfo = {
          plans: kbResult.plans,
          targets: kbResult.targets,
          budgets: kbResult.budgets,
          checks: kbResult.checks,
          cards: kbResult.cards,
          validation: kbResult.validation,
        };
        index = buildSearchIndex(kb);
        buildStats(kb);
      } else if (entityIndexRebuilt) {
        readKbInfo(kb, (info) => { kbInfo = info; });
        index = buildSearchIndex(kb);
        buildStats(kb);
      } else {
        readKbInfo(kb, (info) => { kbInfo = info; });
      }

      if (!hasSearchIndex(kb)) {
        console.log("检测到旧 BBG 库，补齐检索索引与统计…");
        index = buildSearchIndex(kb);
        buildStats(kb);
      } else if (!kb.get(`SELECT 1 FROM _meta WHERE key = 'stats';`)) {
        buildStats(kb);
      }
      if (!kb.get(`SELECT 1 FROM _meta WHERE key = 'ruleset';`)) {
        writeRulesetMeta(
          kb,
          buildRulesetInfo("bbg", {
            builtAt: metaBuiltAt ?? new Date().toISOString(),
            dbFile: config.dbFile,
            source: baseMeta.source ?? null,
            loadOrder,
            bbg: bbgInfo,
            baseBuiltAt: bbgInfo.baseBuiltAt ?? null,
          }),
        );
      }
    }

    kb.close();
    return {
      source: "bbg",
      dbFile: config.dbFile,
      tables,
      rowsInserted,
      textEntries,
      entityDocs,
      durationMs: Date.now() - t0,
      index,
      loadOrder,
      bbg: bbgInfo,
      effects: effectStats,
      kb: kbInfo,
    };
  } catch (error) {
    try {
      kb.close();
    } catch {
      /* already closed */
    }
    try {
      removeDb(config.dbFile);
    } catch {
      /* a running plugin still holds the file; restart DSH to rebuild */
    }
    throw error;
  }
}

export function openDb(config: Config): KnowledgeDb {
  if (!existsSync(config.dbFile)) {
    throw new Error(`知识库尚未构建：${config.dbFile}\n请先运行：npm run build`);
  }
  return new KnowledgeDb(config.dbFile);
}
