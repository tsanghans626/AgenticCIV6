import type { KnowledgeDb } from "./db.js";
import { SPECS } from "./entities.js";
import { tokenize } from "./tokenize.js";

/**
 * Build-time helpers for the read-optimised plugin runtime.
 *
 * The runtime used to tokenise the whole corpus and rebuffer 454 table counts on
 * every tool call. Both are static for a given database, so we precompute them
 * once here:
 *
 *   search_terms(term, df)         - document frequency per token
 *   search_postings(term, doc_id, tf) - inverted index (WITHOUT ROWID, term first)
 *   search_docs.len                - document length in tokens
 *   _meta['search_index']          - N / avgdl / term count for BM25
 *   _meta['stats']                 - table + entity-type row counts for civi6_meta
 *
 * A query then costs: one postings lookup for the query terms, one fetch of the
 * winning documents. No full-corpus pass.
 */

export interface SearchIndexStats {
  docs: number;
  terms: number;
  postings: number;
  avgdl: number;
  builtAt: string;
}

export function hasSearchIndex(kb: KnowledgeDb): boolean {
  return kb.hasTable("search_postings") && kb.hasTable("search_terms");
}

function setMeta(kb: KnowledgeDb, key: string, value: unknown): void {
  kb.db.exec(`CREATE TABLE IF NOT EXISTS "_meta" ("key" TEXT PRIMARY KEY, "value" TEXT);`);
  kb.db
    .prepare(`INSERT OR REPLACE INTO "_meta" ("key","value") VALUES (?,?);`)
    .run(key, JSON.stringify(value));
}

function ensureLenColumn(kb: KnowledgeDb): void {
  const cols = new Set(kb.tableColumns("search_docs").map((c) => c.toLowerCase()));
  if (!cols.has("len")) kb.db.exec(`ALTER TABLE "search_docs" ADD COLUMN "len" INTEGER;`);
}

/**
 * (Re)build the inverted index from `search_docs`. Safe to run on an existing
 * database: the postings tables are cleared first.
 */
export function buildSearchIndex(kb: KnowledgeDb): SearchIndexStats {
  if (!kb.hasTable("search_docs")) throw new Error("search_docs is missing; build the entity index first");
  const db = kb.db;
  const t0 = Date.now();

  db.exec(`
    CREATE TABLE IF NOT EXISTS "search_terms" (
      "term" TEXT PRIMARY KEY,
      "df" INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS "search_postings" (
      "term" TEXT NOT NULL,
      "doc_id" TEXT NOT NULL,
      "tf" INTEGER NOT NULL,
      PRIMARY KEY ("term","doc_id")
    ) WITHOUT ROWID;
  `);
  ensureLenColumn(kb);
  db.exec(`DELETE FROM "search_postings"; DELETE FROM "search_terms";`);

  const docs = kb.all<{ id: string; doc: string | null }>(`SELECT "id","doc" FROM "search_docs";`);
  const insPosting = db.prepare(
    `INSERT INTO "search_postings" ("term","doc_id","tf") VALUES (?,?,?);`,
  );
  const updLen = db.prepare(`UPDATE "search_docs" SET "len" = ? WHERE "id" = ?;`);
  const insTerm = db.prepare(`INSERT OR REPLACE INTO "search_terms" ("term","df") VALUES (?,?);`);

  const df = new Map<string, number>();
  let postings = 0;
  let totalLen = 0;

  kb.begin();
  try {
    for (const d of docs) {
      const tokens = tokenize(d.doc ?? "");
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [term, n] of tf) {
        insPosting.run(term, d.id, n);
        postings++;
      }
      for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
      updLen.run(tokens.length, d.id);
      totalLen += tokens.length;
    }
    for (const [term, n] of df) insTerm.run(term, n);
  } finally {
    kb.commit();
  }

  const stats: SearchIndexStats = {
    docs: docs.length,
    terms: df.size,
    postings,
    avgdl: docs.length ? totalLen / docs.length : 1,
    builtAt: new Date().toISOString(),
  };
  setMeta(kb, "search_index", stats);
  console.log(
    `  检索索引    : ${stats.docs} 篇 / ${stats.terms} 词 / ${stats.postings} 倒排项 ` +
      `(${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );
  return stats;
}

/**
 * Precompute the counts `civi6_meta` reports, so the runtime never runs
 * `COUNT(*)` over 454 tables.
 */
export function buildStats(kb: KnowledgeDb): void {
  const tables = kb
    .listTables()
    .map((name) => ({ name, rows: kb.countRows(name) }));

  const entityTypes = SPECS.map((s) => ({
    type: s.type,
    table: s.table,
    count: kb.hasTable(s.table) ? kb.countRows(s.table) : 0,
  }));

  let effectMeta: Record<string, unknown> = {};
  try {
    const row = kb.get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'effects';`);
    if (row?.value) effectMeta = JSON.parse(row.value) as Record<string, unknown>;
  } catch {
    effectMeta = {};
  }

  setMeta(kb, "stats", {
    tables,
    entityTypes,
    searchDocs: kb.hasTable("search_docs") ? kb.countRows("search_docs") : 0,
    effectCards: effectMeta.cards ?? 0,
    effects: effectMeta.effects ?? 0,
    effectsResolved: effectMeta.resolved ?? 0,
    effectsUnresolved: effectMeta.unresolved ?? 0,
    generatedAt: new Date().toISOString(),
  });
}
