import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TableDef } from "./schema.js";

export type DbValue = string | number | bigint | Uint8Array | null;

/** Normalize a JS value (from XML) into a type node:sqlite can bind. */
export function normalizeValue(v: unknown): DbValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "bigint") return v;
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

export interface KnowledgeDbOptions {
  /**
   * Civ6's SQLite build accepts double-quoted string literals. Node's
   * node:sqlite disables that legacy behaviour by default, so the BBG builder
   * opts back in for the game's SQL files.
   */
  doubleQuotedStringLiterals?: boolean;
}

export class KnowledgeDb {
  readonly db: DatabaseSync;
  /** in-memory cache of table -> known columns (primed lazily from the DB) */
  private columnCache = new Map<string, Set<string>>();

  constructor(filePath: string, options: KnowledgeDbOptions = {}) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(
      filePath,
      options.doubleQuotedStringLiterals ? { enableDoubleQuotedStringLiterals: true } : {},
    );
    this.db.exec("PRAGMA journal_mode = OFF;");
    this.db.exec("PRAGMA synchronous = OFF;");
    // The game schema and BBG's helper tables contain foreign keys that the
    // read-only knowledge base does not need to enforce (and BBG's
    // CustomPlacement references a non-unique Types.Hash).
    this.db.exec("PRAGMA foreign_keys = OFF;");
  }

  close(): void {
    this.db.close();
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** Ensure a table exists and its columns are cached. */
  private ensureTableInternal(table: string): void {
    if (this.columnCache.has(table)) return;
    const exists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;")
      .get(table);
    if (!exists) this.db.exec(`CREATE TABLE IF NOT EXISTS "${table}" ("_rowid_" INTEGER);`);
    const cols = new Set(
      (this.db.prepare(`PRAGMA table_info("${table}");`).all() as { name: string }[]).map((r) =>
        r.name.toLowerCase(),
      ),
    );
    this.columnCache.set(table, cols);
  }

  /** Create a game table from a schema TableDef if it does not exist. */
  createTable(name: string, def: TableDef): void {
    if (this.columnCache.has(name)) return;
    const cols = def.columns.map((c) => `"${c}" ${def.columnTypes.get(c) ?? "TEXT"}`);
    const pk = def.primaryKey.length
      ? `, PRIMARY KEY(${def.primaryKey.map((c) => `"${c}"`).join(",")})`
      : "";
    this.db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${[...cols].join(", ")}${pk});`);
    this.columnCache.set(
      name,
      new Set(def.columns.map((c) => c.toLowerCase())),
    );
  }

  /** Add a column to a table if missing (used for DLC schema / mod columns). */
  ensureColumn(table: string, column: string): void {
    this.ensureTableInternal(table);
    const cols = this.columnCache.get(table)!;
    const key = column.toLowerCase();
    if (cols.has(key)) return;
    this.db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" TEXT;`);
    cols.add(key);
  }

  private ensureColumnsForRecord(table: string, rec: Record<string, unknown>): void {
    this.ensureTableInternal(table);
    const cols = this.columnCache.get(table)!;
    const missing = Object.keys(rec).filter((k) => !cols.has(k.toLowerCase()));
    if (missing.length === 0) return;
    for (const k of missing) {
      try {
        this.db.exec(`ALTER TABLE "${table}" ADD COLUMN "${k}" TEXT;`);
      } catch (e) {
        throw new Error(
          `ALTER TABLE "${table}" ADD COLUMN "${k}" failed: ${(e as Error).message}`,
        );
      }
    }
    for (const k of missing) cols.add(k.toLowerCase());
  }

  /** INSERT (with OR REPLACE if the table has a primary key) one record. */
  insertRow(table: string, rec: Record<string, unknown>, mode: "insert" | "replace" = "insert"): void {
    this.ensureColumnsForRecord(table, rec);
    const keys = Object.keys(rec);
    if (keys.length === 0) return;
    const sql = `INSERT ${mode === "replace" ? "OR REPLACE " : ""}INTO "${table}" (${keys
      .map((k) => `"${k}"`)
      .join(", ")}) VALUES (${keys.map(() => "?").join(", ")});`;
    try {
      this.db.prepare(sql).run(...keys.map((k) => normalizeValue(rec[k])));
    } catch (e) {
      if (mode === "insert") this.insertRow(table, rec, "replace");
      else throw e;
    }
  }

  /** UPDATE a table given WHERE columns (all must match). */
  updateRows(table: string, where: Record<string, unknown>, set: Record<string, unknown>): void {
    const setKeys = Object.keys(set);
    const whereKeys = Object.keys(where);
    if (setKeys.length === 0 || whereKeys.length === 0) return;
    this.ensureColumnsForRecord(table, where);
    this.ensureColumnsForRecord(table, set);
    const setSql = setKeys.map((k) => `"${k}" = ?`).join(", ");
    const whereSql = whereKeys.map((k) => `"${k}" = ?`).join(" AND ");
    this.db
      .prepare(`UPDATE "${table}" SET ${setSql} WHERE ${whereSql};`)
      .run(...setKeys.map((k) => normalizeValue(set[k])), ...whereKeys.map((k) => normalizeValue(where[k])));
  }

  /** DELETE rows given WHERE columns (all must match). */
  deleteRows(table: string, where: Record<string, unknown>): void {
    const whereKeys = Object.keys(where);
    if (whereKeys.length === 0) return;
    this.ensureColumnsForRecord(table, where);
    const whereSql = whereKeys.map((k) => `"${k}" = ?`).join(" AND ");
    this.db
      .prepare(`DELETE FROM "${table}" WHERE ${whereSql};`)
      .run(...whereKeys.map((k) => normalizeValue(where[k])));
  }

  all<T = Record<string, unknown>>(sql: string, ...params: DbValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, ...params: DbValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  hasTable(name: string): boolean {
    if (this.columnCache.has(name)) return true;
    return !!this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;").get(name);
  }

  listTables(): string[] {
    return this.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
    ).map((r) => r.name);
  }

  tableColumns(name: string): string[] {
    return this.all<{ name: string }>(`PRAGMA table_info("${name}");`).map((r) => r.name);
  }

  countRows(name: string): number {
    const r = this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}";`);
    return r?.n ?? 0;
  }

  begin(): void {
    this.db.exec("BEGIN;");
  }
  commit(): void {
    this.db.exec("COMMIT;");
  }
}
