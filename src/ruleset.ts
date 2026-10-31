import type { KnowledgeDb } from "./db.js";
import type { DataSource } from "./config.js";
import type { BbgBuildInfo } from "./build.js";

export const RULESET_SCHEMA_VERSION = 1;

export interface RulesetMod {
  name: string;
  version: string;
  ref: string;
}

export interface RulesetInfo {
  schemaVersion: number;
  id: DataSource;
  labelZh: string;
  labelEn: string;
  baseGame: string;
  expansions: string[];
  dlc: string[];
  mods: RulesetMod[];
  excludedOptionalMods: string[];
  builtAt: string;
  source: string | null;
  dbFile: string;
  baseBuiltAt: string | null;
}

export interface RulesetBuildOptions {
  builtAt: string;
  dbFile: string;
  source: string | null;
  loadOrder: { id: string; dir: string }[];
  bbg?: BbgBuildInfo | null;
  baseBuiltAt?: string | null;
}

const OPTIONAL_BBG_MODS = [
  "BBG Expanded",
  "BBCC",
  "BBS",
  "Settlers",
  "胜利条件变体",
];

function expansionIds(loadOrder: { id: string }[]): string[] {
  return loadOrder
    .map((entry) => entry.id)
    .filter((id) => /^Expansion\d+$/.test(id));
}

function dlcIds(loadOrder: { id: string }[]): string[] {
  return loadOrder
    .map((entry) => entry.id)
    .filter((id) => !/^(Base|Expansion\d+)$/.test(id));
}

/** Build the exact ruleset identity that the runtime will lock onto. */
export function buildRulesetInfo(source: DataSource, opts: RulesetBuildOptions): RulesetInfo {
  const expansions = expansionIds(opts.loadOrder);
  const dlc = dlcIds(opts.loadOrder);
  if (source === "bbg") {
    const bbg = opts.bbg;
    const ref = bbg?.ref ?? "7.5.1";
    return {
      schemaVersion: RULESET_SCHEMA_VERSION,
      id: "bbg",
      labelZh: `BBG ${ref}（基于风云际会标准规则）`,
      labelEn: `BBG ${ref} (Gathering Storm standard rules)`,
      baseGame: "Civilization VI",
      expansions,
      dlc,
      mods: [
        {
          name: bbg?.modName ?? "Better Balanced Game",
          version: bbg?.modVersion ?? ref,
          ref,
        },
      ],
      excludedOptionalMods: OPTIONAL_BBG_MODS,
      builtAt: opts.builtAt,
      source: opts.source,
      dbFile: opts.dbFile,
      baseBuiltAt: opts.baseBuiltAt ?? bbg?.baseBuiltAt ?? null,
    };
  }
  return {
    schemaVersion: RULESET_SCHEMA_VERSION,
    id: "vanilla",
    labelZh: "标准规则（含迭起兴衰、风云际会与 DLC）",
    labelEn: "Standard rules (Rise and Fall + Gathering Storm + DLC)",
    baseGame: "Civilization VI",
    expansions,
    dlc,
    mods: [],
    excludedOptionalMods: [],
    builtAt: opts.builtAt,
    source: opts.source,
    dbFile: opts.dbFile,
    baseBuiltAt: null,
  };
}

export function writeRulesetMeta(kb: KnowledgeDb, info: RulesetInfo): void {
  kb.exec(`CREATE TABLE IF NOT EXISTS "_meta" ("key" TEXT PRIMARY KEY, "value" TEXT);`);
  kb.db
    .prepare(`INSERT OR REPLACE INTO "_meta" ("key","value") VALUES (?,?);`)
    .run("ruleset", JSON.stringify(info));
}

export function readRulesetMeta(kb: KnowledgeDb): RulesetInfo | null {
  if (!kb.hasTable("_meta")) return null;
  const row = kb.get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'ruleset';`);
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as RulesetInfo;
  } catch {
    return null;
  }
}
