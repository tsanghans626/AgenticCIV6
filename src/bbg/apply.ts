import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeDb } from "../db.js";
import { ensureLocalizedTextTable, ingestTextFile } from "../localize.js";
import {
  selectBbgData,
  selectBbgText,
  type BbgModInfo,
  type BbgSkippedAction,
} from "./modinfo.js";

export interface BbgApplyOptions {
  /** Directory containing BetterBalancedGame.modinfo and its sql/lang folders. */
  dir: string;
  langs: string[];
}

export interface BbgApplyResult {
  files: number;
  statements: number;
  textEntries: number;
  skipped: BbgSkippedAction[];
  warnings: string[];
}

export interface SqlStatement {
  sql: string;
  /** 1-based line of the first non-comment character */
  line: number;
}

const TRANSACTION_CONTROL =
  /^(?:BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?|COMMIT(?:\s+TRANSACTION)?|END(?:\s+TRANSACTION)?|ROLLBACK(?:\s+TRANSACTION)?)\s*;?$/i;

/**
 * Split a SQL file into executable statements, respecting quoted strings,
 * quoted identifiers, `--` line comments and block comments.
 * A file containing CREATE TRIGGER is returned as one statement because its
 * body contains semicolons.
 */
export function splitSqlStatements(sql: string): SqlStatement[] {
  const text = sql.charCodeAt(0) === 0xfeff ? sql.slice(1) : sql;
  if (/\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(text)) {
    return [{ sql: text, line: 1 }];
  }

  const out: SqlStatement[] = [];
  const n = text.length;
  let start = -1;
  let startLine = 1;
  let line = 1;
  let i = 0;

  const push = (end: number) => {
    if (start < 0) return;
    const statement = text.slice(start, end).trim();
    if (statement.length > 0) out.push({ sql: statement, line: startLine });
    start = -1;
  };

  while (i < n) {
    const ch = text[i];

    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }

    if (start < 0) {
      start = i;
      startLine = line;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < n) {
        if (text[i] === "\n") line++;
        if (text[i] === quote) {
          if (text[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === "[") {
      i++;
      while (i < n && text[i] !== "]") {
        if (text[i] === "\n") line++;
        i++;
      }
      i++;
      continue;
    }

    if (ch === ";") {
      push(i + 1);
      i++;
      continue;
    }

    i++;
  }
  push(n);
  return out;
}

function formatSqlError(file: string, line: number, sql: string, error: unknown): Error {
  const snippet = sql.replace(/\s+/g, " ").trim().slice(0, 300);
  return new Error(
    `BBG SQL 失败：${file}:${line}\n${snippet}\nSQLite: ${(error as Error).message}`,
  );
}

function rollback(kb: KnowledgeDb): void {
  try {
    kb.db.exec("ROLLBACK;");
  } catch {
    /* no active transaction */
  }
}

function runSqlFiles(kb: KnowledgeDb, dir: string, files: string[]): number {
  let statements = 0;
  kb.begin();
  try {
    for (const relative of files) {
      const file = join(dir, relative);
      if (!existsSync(file)) {
        throw new Error(`BBG 数据文件缺失：${file}`);
      }
      const parts = splitSqlStatements(readFileSync(file, "utf8"));
      for (const part of parts) {
        if (TRANSACTION_CONTROL.test(part.sql)) continue;
        try {
          kb.db.exec(part.sql);
        } catch (error) {
          throw formatSqlError(relative, part.line, part.sql, error);
        }
        statements++;
      }
    }
    kb.commit();
  } catch (error) {
    rollback(kb);
    throw error;
  }
  return statements;
}

function runTextFiles(kb: KnowledgeDb, dir: string, files: { path: string; lang: string }[]): number {
  ensureLocalizedTextTable(kb);
  let entries = 0;
  kb.begin();
  try {
    for (const item of files) {
      const file = join(dir, item.path);
      if (!existsSync(file)) {
        throw new Error(`BBG 文本文件缺失：${file}`);
      }
      entries += ingestTextFile(kb, file, item.lang);
    }
    kb.commit();
  } catch (error) {
    rollback(kb);
    throw error;
  }
  return entries;
}

/** Apply the selected BBG SQL and text files to a copy of the vanilla DB. */
export function applyBbg(kb: KnowledgeDb, mod: BbgModInfo, opts: BbgApplyOptions): BbgApplyResult {
  const selection = selectBbgData(mod);
  if (selection.files.length === 0) {
    throw new Error("BBG 选集为空：modinfo 中没有可执行的 UpdateDatabase/UpdateColors 动作");
  }
  const textFiles = selectBbgText(mod, opts.langs);

  // Civ6 fills Types.Hash internally; the XML ingest leaves it NULL. BBG only
  // uses it for its UI-only CustomPlacement helper table, so a stable unique
  // value is enough to satisfy the NOT NULL constraint.
  if (kb.hasTable("Types")) {
    kb.db.exec(`UPDATE "Types" SET "Hash" = rowid WHERE "Hash" IS NULL;`);
  }

  const statements = runSqlFiles(kb, opts.dir, selection.files);
  const textEntries = runTextFiles(kb, opts.dir, textFiles);

  return {
    files: selection.files.length,
    statements,
    textEntries,
    skipped: selection.skipped,
    warnings: selection.warnings,
  };
}
