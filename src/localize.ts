import { readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { Config } from "./config.js";
import type { KnowledgeDb } from "./db.js";
import { parseXmlFile, rowToRecord, asArray } from "./xml.js";

interface TextEntry {
  tag: string;
  text: string;
  lang: string;
  source: string;
}

function langFromPath(file: string): string {
  const m = /([A-Za-z]{2}_[A-Za-z0-9]+)\//.exec(file.replace(/\\/g, "/"));
  if (m) return m[1];
  const base = basename(file);
  const vm = /^Vanilla_([A-Za-z_]+)\.xml$/.exec(base);
  if (vm) return vm[1];
  return "en_US";
}

/** Discover all localized text XML files, in load order (base before DLC). */
export function discoverTextFiles(config: Config): string[] {
  const { paths } = config;
  const files: string[] = [];
  const pushDir = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).sort()) {
      const full = join(dir, f);
      if (statSync(full).isFile() && f.endsWith(".xml")) files.push(full);
    }
  };

  // Base text: language folders + root-level Vanilla_*.xml.
  pushDir(join(paths.baseText, "en_US"));
  pushDir(join(paths.baseText, "zh_Hans_CN"));
  if (existsSync(paths.baseText)) {
    for (const f of readdirSync(paths.baseText).sort()) {
      if (f.endsWith(".xml")) files.push(join(paths.baseText, f));
    }
  }

  // DLC text: language folders + root-level text files.
  if (existsSync(paths.dlc)) {
    for (const name of readdirSync(paths.dlc).sort()) {
      const textDir = join(paths.dlc, name, "Text");
      if (!existsSync(textDir)) continue;
      pushDir(join(textDir, "en_US"));
      pushDir(join(textDir, "zh_Hans_CN"));
      for (const f of readdirSync(textDir).sort()) {
        const full = join(textDir, f);
        if (statSync(full).isFile() && f.endsWith(".xml")) files.push(full);
      }
    }
  }
  return files;
}

/** Parse a text file into entries, splitting base text from localized text. */
function parseTextFile(file: string): { base: TextEntry[]; localized: TextEntry[] } {
  const base: TextEntry[] = [];
  const localized: TextEntry[] = [];
  let parsed;
  try {
    parsed = parseXmlFile(file);
  } catch {
    return { base, localized };
  }
  if (parsed.root !== "GameData" && parsed.root !== "GameInfo") return { base, localized };

  const defaultLang = langFromPath(file);
  for (const [, tableEl] of Object.entries(parsed.body)) {
    if (!tableEl || typeof tableEl !== "object") continue;
    const el = tableEl as Record<string, unknown>;
    for (const key of ["Row", "Replace", "Insert"]) {
      for (const node of asArray(el[key])) {
        const rec = rowToRecord(node);
        const tag = rec.Tag ?? rec.tag;
        const text = rec.Text ?? rec.text;
        if (typeof tag !== "string" || tag.length === 0) continue;
        if (text == null) continue;
        const explicitLang = rec.Language ?? rec.language;
        const entry: TextEntry = {
          tag,
          text: String(text),
          lang: typeof explicitLang === "string" ? explicitLang : defaultLang,
          source: basename(file),
        };
        if (typeof explicitLang === "string") localized.push(entry);
        else base.push(entry);
      }
    }
  }
  return { base, localized };
}

/** Ingest localized text into the LocalizedText table. */
export function ingestLocalizedText(kb: KnowledgeDb, config: Config): { entries: number; files: number } {
  kb.db.exec(`
    CREATE TABLE IF NOT EXISTS "LocalizedText" (
      "Tag" TEXT NOT NULL,
      "Language" TEXT NOT NULL,
      "Text" TEXT,
      "Source" TEXT,
      PRIMARY KEY("Tag","Language")
    );
  `);
  const files = discoverTextFiles(config);
  let entries = 0;

  // Pass 1: base text (no explicit Language) -> resolved language (usually en_US).
  // Pass 2: localized text (explicit Language) -> overrides base within same lang.
  const run = (list: TextEntry[]) => {
    for (const e of list) {
      kb.db
        .prepare(
          `INSERT OR REPLACE INTO "LocalizedText" ("Tag","Language","Text","Source") VALUES (?,?,?,?);`,
        )
        .run(e.tag, e.lang, e.text, e.source);
      entries++;
    }
  };

  kb.begin();
  try {
    for (const f of files) {
      const { base, localized } = parseTextFile(f);
      run(base);
      run(localized);
    }
  } finally {
    kb.commit();
  }
  return { entries, files: files.length };
}
