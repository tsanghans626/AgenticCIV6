import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { BBG_MODINFO } from "../config.js";
import { asArray } from "../xml.js";

export interface RawBbgAction {
  id: string;
  kind: "database" | "colors" | "text";
  loadOrder: number;
  criteria: string[];
  files: string[];
  /** declaration order in the modinfo, used as a stable tie-breaker */
  order: number;
}

export interface BbgModInfo {
  name: string;
  version: string;
  actions: RawBbgAction[];
}

export interface BbgSkippedAction {
  id: string;
  reason: string;
}

export interface BbgDataSelection {
  actions: { id: string; loadOrder: number; files: string[] }[];
  /** deduplicated SQL files in load order */
  files: string[];
  skipped: BbgSkippedAction[];
  warnings: string[];
}

export interface BbgTextFile {
  path: string;
  lang: string;
}

/**
 * Criteria that describe an optional mod / game-setup variant rather than the
 * standard, all-DLC, Gathering Storm ruleset. Actions guarded by these are
 * excluded so the BBG DB matches a default BBG game.
 */
const UNSUPPORTED_CRITERIA = new Set([
  // Other mods
  "BBGExpanded_WIP",
  "BBGExpanded_Release",
  "BBS",
  "ModManager",
  // Better Balanced City Cap (BBCC) configuration
  "core_bbcc",
  "bbcc_cap",
  "standard_bbcc",
  "no_rng_bbcc",
  "legacy_bbcc",
  // Game-setup victory / settler variants
  "CVSetting_1",
  "CVSetting_2",
  "SVSetting_1",
  "SVSetting_2",
  "DVSetting_1",
  "DVSetting_2",
  "RVSetting_1",
  "RVSetting_2",
  "TerritorialSetting_1",
  "GlobalSetting_1",
  "GlobalSetting_2",
  "GlobalSetting_BBG_Legacy",
  "Settlers_Sent_Back",
]);

const UNSUPPORTED_ACTION_IDS = new Set(["BBG_LoadLast_BBM_WONDERS"]);

/** Actions that belong to BBG Expanded, victory variants, BBCC or Settlers. */
const UNSUPPORTED_ACTION_RE = /^(?:BBG_Expanded|Victory|GlobalVictory|bbcc|Settlers)/i;

const LANG_BY_TEXT_FILE: Record<string, string> = {
  "english.xml": "en_US",
  "chinese.xml": "zh_Hans_CN",
};

/**
 * Upstream 7.5.1 merged these two legacy files into `Base.sql`, but its own
 * modinfo still references the old names. Resolve them the way the working
 * Workshop copy does, and record the substitution in the build warnings.
 */
const LEGACY_FILE_ALIASES: Record<string, { path: string | null; reason: string }> = {
  "sql/DLC_Indonesia_Khmer/_dlc_indo_khmer_utils.sql": {
    path: null,
    reason: "upstream 7.5.1 已将该文件合并进 Base.sql",
  },
  "sql/DLC_Indonesia_Khmer/Other.sql": {
    path: "sql/DLC_Indonesia_Khmer/Base.sql",
    reason: "upstream 7.5.1 已将 Other.sql 合并为 Base.sql",
  },
  "sql/LP/lp_arabia_saladin_sultan.sql": {
    path: null,
    reason: "upstream 7.5.1 已将该文件合并进 Sultan.sql（由 BBG_Negotiators_XP2 加载）",
  },
};

export interface BbgFileResolution {
  /** null means the upstream file is intentionally skipped. */
  path: string | null;
  warning?: string;
}

export function resolveBbgFile(file: string): BbgFileResolution {
  const alias = LEGACY_FILE_ALIASES[file];
  if (!alias) return { path: file };
  return {
    path: alias.path,
    warning: `${file} -> ${alias.path ?? "（跳过）"}：${alias.reason}`,
  };
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") {
    const s = value.trim();
    return s.length > 0 ? s : undefined;
  }
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) {
    return text((value as Record<string, unknown>)["#text"]);
  }
  return undefined;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function collectActions(
  container: Record<string, unknown> | undefined,
  tag: string,
  kind: RawBbgAction["kind"],
  out: RawBbgAction[],
): void {
  if (!container) return;
  for (const node of asArray(container[tag])) {
    if (!node || typeof node !== "object") continue;
    const obj = node as Record<string, unknown>;
    const id = text(obj["@_id"]) ?? "";
    const props = (obj.Properties ?? {}) as Record<string, unknown>;
    const loadOrder = Number(text(props.LoadOrder) ?? 0) || 0;
    const criteria = asArray(obj.Criteria)
      .map(text)
      .filter((v): v is string => Boolean(v));
    const files = asArray(obj.File)
      .map(text)
      .filter((v): v is string => Boolean(v))
      .map(normalizePath);
    out.push({ id, kind, loadOrder, criteria, files, order: out.length });
  }
}

/** Parse a BetterBalancedGame.modinfo document. */
export function parseBbgModInfoText(xml: string): BbgModInfo {
  const parsed = parseXmlFileText(xml);
  if (parsed.root !== "Mod") {
    throw new Error(`不是 BBG modinfo（根元素为 "${parsed.root}"）`);
  }
  const body = parsed.body;
  const props = (body.Properties ?? {}) as Record<string, unknown>;
  const name = text(props.Name) ?? "Better Balanced Game";
  const version = text(props.Version) ?? "";

  const actions: RawBbgAction[] = [];
  const inGame = (body.InGameActions ?? {}) as Record<string, unknown>;
  collectActions(inGame, "UpdateDatabase", "database", actions);
  collectActions(inGame, "UpdateColors", "colors", actions);
  collectActions(inGame, "UpdateText", "text", actions);

  return { name, version, actions };
}

/** Read and parse `<dir>/BetterBalancedGame.modinfo`. */
export function loadBbgModInfo(dir: string): BbgModInfo {
  const file = join(dir, BBG_MODINFO);
  if (!existsSync(file)) {
    throw new Error(`BBG modinfo 不存在：${file}`);
  }
  return parseBbgModInfoText(readFileSync(file, "utf8"));
}

/**
 * Select the BBG database overlay: all standard-ruleset UpdateDatabase/UpdateColors
 * actions, ordered by LoadOrder (stable by declaration order).
 */
export function selectBbgData(mod: BbgModInfo): BbgDataSelection {
  const ordered = mod.actions
    .filter((a) => a.kind !== "text")
    .slice()
    .sort((a, b) => a.loadOrder - b.loadOrder || a.order - b.order);

  const actions: BbgDataSelection["actions"] = [];
  const files: string[] = [];
  const seen = new Map<string, string>();
  const skipped: BbgSkippedAction[] = [];
  const warnings: string[] = [];

  for (const action of ordered) {
    if (!action.id) {
      skipped.push({ id: "(unnamed)", reason: "missing id" });
      continue;
    }
    if (UNSUPPORTED_ACTION_IDS.has(action.id) || UNSUPPORTED_ACTION_RE.test(action.id)) {
      skipped.push({ id: action.id, reason: "optional action" });
      continue;
    }
    const badCriteria = action.criteria.find((c) => UNSUPPORTED_CRITERIA.has(c));
    if (badCriteria) {
      skipped.push({ id: action.id, reason: `criteria:${badCriteria}` });
      continue;
    }
    const actionFiles: string[] = [];
    for (const original of action.files) {
      const resolved = resolveBbgFile(original);
      if (resolved.warning) warnings.push(resolved.warning);
      if (!resolved.path) continue;
      const previous = seen.get(resolved.path);
      if (previous) {
        warnings.push(`重复文件 ${resolved.path}（${previous} 与 ${action.id}），按首次出现加载`);
        continue;
      }
      seen.set(resolved.path, action.id);
      actionFiles.push(resolved.path);
      files.push(resolved.path);
    }
    actions.push({ id: action.id, loadOrder: action.loadOrder, files: actionFiles });
  }

  return { actions, files, skipped, warnings };
}

/** Select BBG text files for the languages the plugin queries (en_US / zh_Hans_CN). */
export function selectBbgText(mod: BbgModInfo, langs: string[]): BbgTextFile[] {
  const wanted = new Set(langs);
  const out: BbgTextFile[] = [];
  const seen = new Set<string>();
  const ordered = mod.actions
    .filter((a) => a.kind === "text")
    .slice()
    .sort((a, b) => a.loadOrder - b.loadOrder || a.order - b.order);

  for (const action of ordered) {
    if (UNSUPPORTED_ACTION_IDS.has(action.id) || UNSUPPORTED_ACTION_RE.test(action.id)) continue;
    if (action.criteria.some((c) => UNSUPPORTED_CRITERIA.has(c))) continue;
    for (const file of action.files) {
      const base = file.split("/").pop() ?? file;
      const lang = LANG_BY_TEXT_FILE[base];
      if (!lang || !wanted.has(lang) || seen.has(file)) continue;
      seen.add(file);
      out.push({ path: file, lang });
    }
  }
  return out;
}

/**
 * `parseXmlFile` only reads from disk. This variant reuses the same parser
 * settings for already-downloaded modinfo text.
 */
function parseXmlFileText(xml: string): { root: string; body: Record<string, unknown> } {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseAttributeValue: true,
    trimValues: true,
    parseTagValue: false,
    processEntities: true,
  });
  const cleaned = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const parsed = parser.parse(cleaned) as Record<string, unknown>;
  const root = Object.keys(parsed).find((k) => !k.startsWith("?xml") && !k.startsWith("!DOCTYPE"));
  if (!root) return { root: "", body: {} };
  return { root, body: (parsed[root] ?? {}) as Record<string, unknown> };
}
