import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export type SqlType = "TEXT" | "INTEGER" | "REAL";

export interface TableDef {
  /** ordered list of column names */
  columns: string[];
  /** column name -> sqlite type */
  columnTypes: Map<string, SqlType>;
  /** primary key column names (in order) */
  primaryKey: string[];
}

function toSqlType(t: string): SqlType {
  const u = t.toUpperCase();
  if (u === "REAL" || u === "FLOAT" || u === "DOUBLE" || u === "NUMERIC") return "REAL";
  if (u === "INTEGER" || u === "INT" || u === "SMALLINT" || u === "BIGINT" || u === "BOOLEAN") return "INTEGER";
  // TEXT and any custom/unknown type (e.g. "LocalizedText", "String", "JSON") -> TEXT
  return "TEXT";
}

/** Split a CREATE TABLE body on top-level commas (ignoring parens). */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Parse one comma-separated segment into a column definition, or null if a constraint. */
function parseColumnSegment(seg: string): { name: string; type: SqlType; isPk: boolean } | null {
  const s = seg.trim();
  if (!s) return null;
  if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(s)) return null;
  const m = /^("?[A-Za-z_][A-Za-z0-9_]*"?)\s+([A-Za-z_][A-Za-z0-9_]*)?/.exec(s);
  if (!m) return null;
  const name = m[1].replace(/"/g, "");
  const type = toSqlType(m[2] ?? "TEXT");
  const isPk = /PRIMARY\s+KEY/i.test(s);
  return { name, type, isPk };
}

/**
 * Extract `CREATE TABLE ...` statements from a Civ6 schema SQL file and
 * return a map of table name -> TableDef. Tolerates quoted/unquoted names,
 * inline PRIMARY KEY, and table-level PRIMARY KEY(...) clauses.
 */
export function parseSchemaSql(sql: string): Map<string, TableDef> {
  const tables = new Map<string, TableDef>();

  // Split into CREATE TABLE blocks. Each block ends at the matching `);`.
  const re = /CREATE\s+TABLE\s+("?[A-Za-z_][A-Za-z0-9_]*"?)\s*\(([\s\S]*?)\)\s*;/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1].replace(/"/g, "");
    const body = m[2];

    const columns: string[] = [];
    const columnTypes = new Map<string, SqlType>();
    const seen = new Set<string>();
    const primaryKey: string[] = [];

    for (const seg of splitTopLevel(body)) {
      const col = parseColumnSegment(seg);
      if (col) {
        if (!seen.has(col.name)) {
          seen.add(col.name);
          columns.push(col.name);
          columnTypes.set(col.name, col.type);
        }
        if (col.isPk) primaryKey.push(col.name);
      } else {
        const pk = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(seg.trim());
        if (pk) {
          for (const part of pk[1].split(",")) {
            const c = part.trim().replace(/"/g, "");
            if (c) primaryKey.push(c);
          }
        }
      }
    }

    tables.set(name, { columns, columnTypes, primaryKey });
  }
  return tables;
}

/** Parse every *.sql schema file in the given directories (in order). */
export function loadSchemaFiles(schemaDirs: string[]): Map<string, TableDef> {
  const all = new Map<string, TableDef>();
  const files: string[] = [];
  for (const dir of schemaDirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith(".sql")) files.push(join(dir, f));
    }
  }
  for (const f of files) {
    const sql = readFileSync(f, "utf8");
    const parsed = parseSchemaSql(sql);
    for (const [name, def] of parsed) {
      // Merge: union columns, later files may add columns or tables.
      const existing = all.get(name);
      if (!existing) {
        all.set(name, def);
      } else {
        for (const col of def.columns) {
          if (!existing.columns.includes(col)) {
            existing.columns.push(col);
            existing.columnTypes.set(col, def.columnTypes.get(col) ?? "TEXT");
          }
        }
        if (existing.primaryKey.length === 0 && def.primaryKey.length > 0) {
          existing.primaryKey = def.primaryKey;
        }
      }
    }
  }
  return all;
}
