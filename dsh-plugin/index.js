import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "civi6-kb";
export const inject = ["tools", "systemPrompt"];

/** Directory of this plugin file; relative dbPath values are anchored here. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/** Internal ruleset keys. `vanilla` means the unmodded standard rules. */
const SOURCES = ["vanilla", "bbg"];
const DEFAULT_DB_PATHS = {
  vanilla: "../data/civi6.sqlite",
  bbg: "../data/civi6-bbg.sqlite",
};

/** Accept the canonical config value plus Chinese/aliased forms. */
function normalizeRuleset(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const source = String(value).trim().toLowerCase();
  if (
    source === "vanilla" ||
    source === "standard" ||
    source === "原版" ||
    source === "标准" ||
    source === "base" ||
    source === "gathering storm" ||
    source === "gs" ||
    source === "风云际会"
  ) {
    return "vanilla";
  }
  if (source === "bbg" || source === "better balanced game") return "bbg";
  throw new Error(`civi6-kb: unknown ruleset "${value}" (expected "vanilla" or "bbg")`);
}

/**
 * Hard cap on the JSON a single tool call returns to the model.
 *
 * The cap must never change *which facts* the caller asked for: batched entity
 * fetches keep every requested item and `civi6_plan` keeps every contract-cited
 * array. Oversized payloads drop audit-only data (raw modifier chains, coverage
 * blobs, provenance) and compact repeated fields instead, then report what was
 * dropped plus the exact parameter that restores it. The previous implementation
 * halved the largest array, which silently dropped half of a batch and half of
 * the plan path while telling the model to "use a smaller limit" on tools that
 * have no `limit` parameter.
 */
const MAX_OUTPUT_CHARS = 12000;
export const TOOL_BUDGETS = {
  entity: 16000,
  // focus now carries the answer packet (evidence + outline); it is fetched
  // once per question while replacing dozens of exploratory calls.
  plan: 32000,
  eval: 24000,
  // One bounded page of the instance packet (the transport caps a tool result
  // at ~50k chars; oversize must be an error, never a silent cut).
  instance: 44000,
  search: 8000,
  sql: 12000,
  schema: 14000,
};

// ---------------------------------------------------------------------------
// Entity specs (mirrors src/entities.ts SPECS). Each entry describes one
// knowledge-base entity type: its backing table, primary key, localization
// prefix, stat columns, related tables for detail payloads, and how its
// modifier effect chain is resolved.
// ---------------------------------------------------------------------------
export const SPECS = [
  {
    type: "unit", table: "Units", pk: "UnitType", loc: "LOC_UNIT_",
    stats: ["Cost", "Combat", "RangedCombat", "BaseMoves", "BaseSightRange", "Maintenance", "Domain", "FormationClass", "PromotionClass", "PrereqTech", "PrereqCivic", "StrategicResource", "Range", "Bombard", "AirSlots", "AntiAirCombat", "ReligiousStrength", "SpreadCharges", "BuildCharges"],
    related: [
      { table: "UnitUpgrades", fk: "Unit" },
      { table: "UnitReplaces", fk: "CivUniqueUnitType" },
      { table: "TypeTags", fk: "Type" },
    ],
    modifierResolver: "unit",
  },
  {
    type: "building", table: "Buildings", pk: "BuildingType", loc: "LOC_BUILDING_",
    stats: ["Cost", "Maintenance", "PrereqDistrict", "PrereqTech", "PrereqCivic", "Housing", "Entertainment", "RegionalRange", "IsWonder", "CitizenSlots", "OuterDefenseStrength", "DefenseModifier"],
    related: [
      { table: "Building_YieldChanges", fk: "BuildingType" },
      { table: "Building_GreatPersonPoints", fk: "BuildingType" },
      { table: "BuildingPrereqs", fk: "Building" },
    ],
    modifierResolver: "direct",
  },
  {
    type: "district", table: "Districts", pk: "DistrictType", loc: "LOC_DISTRICT_",
    stats: ["Cost", "Maintenance", "PrereqTech", "PrereqCivic", "RequiresPopulation", "OnePerCity", "Aqueduct", "InternalOnly", "ZOC", "Housing", "CitizenSlots", "AirSlots"],
    related: [
      { table: "District_Adjacencies", fk: "DistrictType" },
      { table: "District_CitizenYieldChanges", fk: "DistrictType" },
      { table: "District_TradeRouteYields", fk: "DistrictType" },
    ],
    modifierResolver: "direct",
  },
  {
    type: "civilization", table: "Civilizations", pk: "CivilizationType", loc: "LOC_CIVILIZATION_",
    stats: ["Adjective", "Ethnicity"],
    related: [
      { table: "CivilizationTraits", fk: "CivilizationType" },
      { table: "CivilizationLeaders", fk: "CivilizationType" },
    ],
    modifierResolver: "civilization",
  },
  {
    type: "leader", table: "Leaders", pk: "LeaderType", loc: "LOC_LEADER_",
    stats: ["InheritFrom", "Sex", "SameSexPercentage"],
    related: [{ table: "LeaderTraits", fk: "LeaderType" }],
    modifierResolver: "leader",
  },
  {
    type: "trait", table: "Traits", pk: "TraitType", loc: "LOC_TRAIT_",
    stats: ["InternalOnly"],
    related: [],
    modifierResolver: "direct",
  },
  {
    type: "technology", table: "Technologies", pk: "TechnologyType", loc: "LOC_TECH_",
    stats: ["Cost", "EraType", "UITreeRow", "Critical"],
    related: [
      { table: "TechnologyPrereqs", fk: "Technology" },
      { table: "Boosts", fk: "TechnologyType" },
    ],
    modifierResolver: "direct",
  },
  {
    type: "civic", table: "Civics", pk: "CivicType", loc: "LOC_CIVIC_",
    stats: ["Cost", "EraType", "UITreeRow"],
    related: [
      { table: "CivicPrereqs", fk: "Civic" },
      { table: "Boosts", fk: "CivicType" },
    ],
    modifierResolver: "direct",
  },
  {
    type: "policy", table: "Policies", pk: "PolicyType", loc: "LOC_POLICY_",
    stats: ["GovernmentSlotType", "PrereqCivic", "PrereqTech", "RequiresGovernmentUnlock"],
    related: [],
    modifierResolver: "direct",
  },
  {
    type: "government", table: "Governments", pk: "GovernmentType", loc: "LOC_GOVERNMENT_",
    stats: ["PrereqCivic", "Tier", "OtherGovernmentIntolerance", "InfluencePointsPerTurn"],
    related: [{ table: "Government_SlotCounts", fk: "GovernmentType" }],
    modifierResolver: "direct",
  },
  {
    type: "improvement", table: "Improvements", pk: "ImprovementType", loc: "LOC_IMPROVEMENT_",
    stats: ["PrereqTech", "PrereqCivic", "Buildable", "Housing", "Appeal", "DefenseModifier", "OnePerCity", "Domain"],
    related: [
      { table: "Improvement_YieldChanges", fk: "ImprovementType" },
      { table: "Improvement_ValidTerrains", fk: "ImprovementType" },
      { table: "Improvement_ValidFeatures", fk: "ImprovementType" },
      { table: "Improvement_ValidResources", fk: "ImprovementType" },
    ],
    modifierResolver: "direct",
  },
  {
    type: "resource", table: "Resources", pk: "ResourceType", loc: "LOC_RESOURCE_",
    stats: ["ResourceClassType", "Happiness", "Frequency", "PrereqTech", "PrereqCivic"],
    related: [{ table: "Resource_YieldChanges", fk: "ResourceType" }],
    modifierResolver: "none",
  },
  {
    type: "terrain", table: "Terrains", pk: "TerrainType", loc: "LOC_TERRAIN_",
    stats: ["MovementCost", "DefenseModifier", "Appeal", "Mountain", "Hills", "Water", "Impassable"],
    related: [{ table: "Terrain_YieldChanges", fk: "TerrainType" }],
    modifierResolver: "none",
  },
  {
    type: "feature", table: "Features", pk: "FeatureType", loc: "LOC_FEATURE_",
    stats: ["NaturalWonder", "DefenseModifier", "Appeal", "Impassable", "Removable", "Forest"],
    related: [{ table: "Feature_YieldChanges", fk: "FeatureType" }],
    modifierResolver: "none",
  },
  {
    type: "greatperson", table: "GreatPersonIndividuals", pk: "GreatPersonIndividualType", loc: "LOC_GREAT_PERSON_INDIVIDUAL_",
    stats: ["GreatPersonClassType", "EraType", "ActionCharges"],
    related: [],
    modifierResolver: "greatperson",
  },
  {
    type: "belief", table: "Beliefs", pk: "BeliefType", loc: "LOC_BELIEF_",
    stats: ["BeliefClassType"],
    related: [{ table: "BeliefModifiers", fk: "BeliefType" }],
    modifierResolver: "belief",
  },
  {
    // Governor ownership lives in GovernorPromotionSets and can be reassigned
    // by a mod while the promotion id keeps the vanilla prefix. Expose it as a
    // first-class relation so callers never infer owners from the id.
    type: "governor", table: "Governors", pk: "GovernorType", loc: "LOC_GOVERNOR_",
    stats: [],
    related: [{ table: "GovernorPromotionSets", fk: "GovernorType" }],
    modifierResolver: "none",
  },
  {
    type: "governor_promotion", table: "GovernorPromotions", pk: "GovernorPromotionType", loc: "LOC_GOVERNOR_PROMOTION_",
    stats: ["Level", "Column"],
    related: [{ table: "GovernorPromotionSets", fk: "GovernorPromotion" }],
    modifierResolver: "direct",
  },
  {
    // Unit promotions are a first-class tree (class -> level -> column), not an
    // opaque modifier dump: "what does 冲锋 do / what follows it" is a routine
    // planning question, and the raw tables used to force SQL archaeology.
    type: "promotion", table: "UnitPromotions", pk: "UnitPromotionType", loc: "LOC_PROMOTION_",
    stats: ["Level", "Column", "PromotionClass"],
    related: [
      { table: "UnitPromotionPrereqs", fk: "UnitPromotion" },
      { table: "UnitPromotionModifiers", fk: "UnitPromotionType" },
    ],
    modifierResolver: "direct",
  },
];

const specByType = new Map(SPECS.map((s) => [s.type, s]));
const ENTITY_TYPES = SPECS.map((s) => s.type);

const DIRECT_MODIFIER_TABLE = {
  building: "BuildingModifiers",
  district: "DistrictModifiers",
  trait: "TraitModifiers",
  technology: "TechnologyModifiers",
  civic: "CivicModifiers",
  policy: "PolicyModifiers",
  government: "GovernmentModifiers",
  improvement: "ImprovementModifiers",
  belief: "BeliefModifiers",
  governor_promotion: "GovernorPromotionModifiers",
  promotion: "UnitPromotionModifiers",
};

/** A few Civ6 tables spell the modifier FK differently. */
const MODIFIER_COLUMNS = {
  belief: "ModifierID",
};

const BM25_K1 = 1.5;
const BM25_B = 0.75;

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------
function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n)) return def;
  return Math.min(Math.max(n, min), max);
}

function placeholders(n) {
  return new Array(n).fill("?").join(",");
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function uniq(values) {
  return [...new Set(values.filter((v) => v !== null && v !== undefined && v !== ""))];
}

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

/** Convert node:sqlite rows into plain, lossless JSON. */
function toJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof Uint8Array) return { __blob: `${v.byteLength} bytes` };
  if (Array.isArray(v)) return v.map(toJson);
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = toJson(v[k]);
    return out;
  }
  return String(v);
}

/** Drop null / empty columns: most Civ6 tables are very wide but sparse. */
function compactRow(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v === null || v === undefined || v === "") continue;
    out[k] = toJson(v);
  }
  return out;
}

/**
 * Turn a SQLite error into something the caller can act on in the same step:
 * the tables whose name resembles the missing one, and the columns of the
 * tables the query already references. A bare "no such column" used to cost a
 * PRAGMA round trip (a full model step) every time.
 */
function sqlErrorPayload(ctx, sql, error) {
  const message = error instanceof Error ? error.message : String(error);
  const tableMiss = /no such table:\s*([^\s;]+)/i.exec(message);
  const columnMiss = /no such column:\s*([^\s;]+)/i.exec(message);
  const rawToken = tableMiss?.[1] ?? columnMiss?.[1] ?? null;
  const token = rawToken
    ? rawToken.replace(/^["'`\[]+|["'`\]]+$/g, "").split(".").pop()
    : null;
  const out = {
    sql,
    error: message,
    count: 0,
    rows: [],
    hint: columnMiss
      ? "no such column: use candidates.columns for the tables in this query (names are authoritative)."
      : "no such table: use candidates.tables, or call civi6_schema with q.",
  };
  const candidates = { tables: [] };
  if (token) {
    // Exact-miss names are usually one segment off ("UnitUpgradeCosts" vs
    // "UnitUpgrades"); probe progressively shorter CamelCase prefixes so the
    // caller gets a usable shortlist instead of an empty list.
    const probes = new Set([token]);
    const stripped = token.replace(/(Costs?|Types?|Values?|Tables?|Names?)$/i, "");
    if (stripped && stripped !== token && stripped.length >= 4) probes.add(stripped);
    const words = token.match(/[A-Z][A-Za-z0-9]*/g) ?? [];
    if (words.length >= 2) probes.add(words.slice(0, 2).join(""));
    if (words.length >= 1 && words[0].length >= 4) probes.add(words[0]);
    const list = [...probes].slice(0, 4);
    const likeArgs = list.map((p) => `%${p}%`);
    const where = list.map(() => "name LIKE ?").join(" OR ");
    candidates.tables = q(
      ctx,
      `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND (${where}) ORDER BY name LIMIT 10;`,
      ...likeArgs,
    ).map((r) => r.name);
    if (columnMiss) {
      candidates.tablesByColumn = q(
        ctx,
        `SELECT name FROM sqlite_master WHERE type = 'table' AND (${list.map(() => "sql LIKE ?").join(" OR ")}) ORDER BY name LIMIT 10;`,
        ...likeArgs,
      ).map((r) => r.name);
    }
  }
  const referenced = uniq(
    [...sql.matchAll(/\b(?:from|join)\s+["'`\[]?([A-Za-z][A-Za-z0-9_]*)/gi)]
      .map((m) => m[1])
      .filter((name) => name.toUpperCase() !== "SELECT"),
  );
  const columns = {};
  for (const table of referenced.slice(0, 4)) {
    if (!hasTable(ctx, table)) continue;
    columns[table] = q(ctx, `PRAGMA table_info("${table}");`).map((r) => r.name);
  }
  if (Object.keys(columns).length) candidates.columns = columns;
  out.candidates = candidates;
  return out;
}

/**
 * Tokenizer. MUST stay identical to src/tokenize.ts; `node bench/parity.mjs`
 * checks that both produce the same tokens. Exported for that test only.
 */
export function tokenize(text) {
  const tokens = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) tokens.push(m[0]);
  for (const m of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i]);
      if (i + 1 < run.length) tokens.push(run[i] + run[i + 1]);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Per-connection context: cached statements, table set, localization memo.
// Cache lifetime == database connection lifetime (one per plugin process).
// ---------------------------------------------------------------------------
const STATEMENT_CACHE_LIMIT = 256;
const LOCALIZE_CACHE_LIMIT = 50000;

function createContext(db) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table';").all().map((r) => String(r.name)),
  );
  return {
    db,
    tables,
    statements: new Map(),
    locCache: new Map(),
    statsCache: null,
    indexMeta: null,
    memoryIndex: null,
    queries: 0,
  };
}

function stmt(ctx, sql) {
  let s = ctx.statements.get(sql);
  if (s === undefined) {
    if (ctx.statements.size >= STATEMENT_CACHE_LIMIT) ctx.statements.clear();
    s = ctx.db.prepare(sql);
    ctx.statements.set(sql, s);
  }
  return s;
}

function q(ctx, sql, ...params) {
  ctx.queries += 1;
  return stmt(ctx, sql).all(...params);
}

function q1(ctx, sql, ...params) {
  ctx.queries += 1;
  return stmt(ctx, sql).get(...params);
}

function hasTable(ctx, table) {
  return ctx.tables.has(table);
}

/** Run `SELECT ... IN (...)` in chunks to stay well below SQLite's variable limit. */
function selectIn(ctx, buildSql, values, leading = []) {
  const rows = [];
  for (const part of chunk(values, 400)) {
    rows.push(...q(ctx, buildSql(placeholders(part.length)), ...leading, ...part));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Localization (memoized + batched)
// ---------------------------------------------------------------------------
function locKey(lang, tag) {
  return `${lang}\u0000${tag}`;
}

/** Prefetch all `tags` for `lang`; returns a lookup function for this call. */
function localizeMany(ctx, tags, lang) {
  const wanted = uniq(tags);
  const missing = wanted.filter((tag) => !ctx.locCache.has(locKey(lang, tag)));
  if (missing.length) {
    for (const part of chunk(missing, 400)) {
      const rows = q(
        ctx,
        `SELECT Tag, Text FROM LocalizedText WHERE Language = ? AND Tag IN (${placeholders(part.length)});`,
        lang,
        ...part,
      );
      for (const r of rows) ctx.locCache.set(locKey(lang, r.Tag), r.Text ?? undefined);
      const seen = new Set(rows.map((r) => r.Tag));
      for (const tag of part) if (!seen.has(tag)) ctx.locCache.set(locKey(lang, tag), undefined);
    }
    if (ctx.locCache.size > LOCALIZE_CACHE_LIMIT) ctx.locCache.clear();
  }
  return (tag) => (typeof tag === "string" && tag ? ctx.locCache.get(locKey(lang, tag)) : undefined);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------
function listEntities(ctx, type, opts = {}) {
  const spec = specByType.get(type);
  if (!spec || !hasTable(ctx, spec.table)) return { total: 0, items: [] };
  const limit = clampInt(opts.limit, 30, 1, 200);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const full = opts.full === true;

  const clauses = [];
  const params = [];
  if (opts.q) {
    // Match the id, the raw (untranslated) name tag and the localized zh/en
    // name. Without the last arm, q='君主' missed GOVERNMENT_MONARCHY even
    // though its Chinese name is 天主教君主政体.
    clauses.push(
      `("${spec.pk}" LIKE ? OR "Name" LIKE ? OR EXISTS (
         SELECT 1 FROM LocalizedText lt
          WHERE lt.Tag = COALESCE("Name", '${spec.loc}' || "${spec.pk}" || '_NAME')
            AND lt.Language IN ('zh_Hans_CN','en_US')
            AND lt.Text LIKE ?))`,
    );
    const like = `%${opts.q}%`;
    params.push(like, like, like);
  }
  if (type === "belief" && opts.beliefClass) {
    clauses.push(`"BeliefClassType" = ?`);
    params.push(String(opts.beliefClass));
  }
  if (type === "promotion" && opts.promotionClass) {
    clauses.push(`"PromotionClass" = ?`);
    params.push(String(opts.promotionClass));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = q1(ctx, `SELECT COUNT(*) AS n FROM "${spec.table}" ${where};`, ...params)?.n ?? 0;
  const rows = q(
    ctx,
    `SELECT * FROM "${spec.table}" ${where} ORDER BY "${spec.pk}" LIMIT ? OFFSET ?;`,
    ...params,
    limit,
    offset,
  );

  const nameTags = rows.map((row) => row.Name ?? `${spec.loc}${String(row[spec.pk])}_NAME`);
  const zh = localizeMany(ctx, nameTags, "zh_Hans_CN");
  const en = localizeMany(ctx, nameTags, "en_US");

  const items = rows.map((row) => {
    const id = String(row[spec.pk]);
    const tag = row.Name ?? `${spec.loc}${id}_NAME`;
    const base = { id, name: en(tag) ?? id, name_zh: zh(tag) ?? id };
    if (full) return { ...base, ...compactRow(row) };
    const stats = {};
    for (const col of spec.stats) {
      const v = row[col];
      if (v !== null && v !== undefined && v !== "") stats[col] = toJson(v);
    }
    return { ...base, stats };
  });

  if (opts.effects === true && hasTable(ctx, "effect_cards") && items.length) {
    const cards = selectIn(
      ctx,
      (ph) =>
        `SELECT card_id, description_zh, effects_json, coverage_json
           FROM effect_cards WHERE card_id IN (${ph});`,
      items.map((item) => `${type}:${item.id}`),
    );
    const byId = new Map(cards.map((c) => [c.card_id, c]));
    const effectLimit = clampInt(opts.effectLimit, 3, 1, 20);
    for (const item of items) {
      const card = byId.get(`${type}:${item.id}`);
      if (!card) continue;
      const effects = parseJsonArray(card.effects_json);
      item.effects = effects.slice(0, effectLimit).map((e) => e.text_zh ?? e.text_en).filter(Boolean);
      if (effects.length > effectLimit) item.effectsMore = effects.length - effectLimit;
      if (!item.description_zh && card.description_zh) item.description_zh = card.description_zh;
      item.coverage = parseJson(card.coverage_json, null);
    }
  }

  // A promotion's owner is a relation, not an id prefix; batch-resolve it so a
  // single list call already answers "whose is this?".
  if (type === "governor_promotion" && items.length) {
    const owners = governorOwnersOf(ctx, items.map((item) => item.id));
    for (const item of items) item.governors = owners.get(item.id) ?? [];
  }

  return { total, returned: items.length, offset, items };
}

function collectModifierIds(ctx, spec, id) {
  const directByFk = (table, fk, values, modifierColumn = "ModifierId") => {
    if (!hasTable(ctx, table) || !values.length) return [];
    return selectIn(
      ctx,
      (ph) => `SELECT "${modifierColumn}" AS mid FROM "${table}" WHERE "${fk}" IN (${ph});`,
      values,
    ).map((r) => r.mid);
  };

  switch (spec.modifierResolver) {
    case "unit": {
      const tags = hasTable(ctx, "TypeTags")
        ? q(ctx, "SELECT Tag FROM TypeTags WHERE Type = ?;", id).map((r) => r.Tag)
        : [];
      if (!tags.length) return [];
      const abilities = selectIn(
        ctx,
        (ph) =>
          `SELECT Type FROM TypeTags WHERE Tag IN (${ph}) AND Type IN (SELECT UnitAbilityType FROM UnitAbilities);`,
        uniq(tags),
      ).map((r) => r.Type);
      if (!abilities.length) return [];
      return selectIn(
        ctx,
        (ph) => `SELECT ModifierId FROM UnitAbilityModifiers WHERE UnitAbilityType IN (${ph});`,
        uniq(abilities),
      ).map((r) => r.ModifierId);
    }
    case "civilization": {
      const traits = hasTable(ctx, "CivilizationTraits")
        ? q(ctx, "SELECT TraitType FROM CivilizationTraits WHERE CivilizationType = ?;", id).map((r) => r.TraitType)
        : [];
      return directByFk("TraitModifiers", "TraitType", uniq(traits));
    }
    case "leader": {
      const traits = hasTable(ctx, "LeaderTraits")
        ? q(ctx, "SELECT TraitType FROM LeaderTraits WHERE LeaderType = ?;", id).map((r) => r.TraitType)
        : [];
      return directByFk("TraitModifiers", "TraitType", uniq(traits));
    }
    case "greatperson": {
      return [
        ...directByFk("GreatPersonIndividualBirthModifiers", "GreatPersonIndividualType", [id]),
        ...directByFk("GreatPersonIndividualActionModifiers", "GreatPersonIndividualType", [id]),
      ];
    }
    case "belief": {
      return directByFk("BeliefModifiers", "BeliefType", [id], "ModifierID");
    }
    case "none":
      return [];
    case "direct":
    default: {
      const table = DIRECT_MODIFIER_TABLE[spec.type];
      return table ? directByFk(table, spec.pk, [id], MODIFIER_COLUMNS[spec.type] ?? "ModifierId") : [];
    }
  }
}

function substitute(text, args) {
  let out = text;
  for (const a of args) {
    if (typeof a.Name === "string" && a.Value != null) {
      out = out.replaceAll(`{${a.Name}}`, String(a.Value));
    }
  }
  return out;
}

function prettyTag(value) {
  const s = typeof value === "string" ? value : String(value ?? "");
  if (s.startsWith("YIELD_")) return `LOC_${s}_NAME`;
  if (s.startsWith("LOC_")) return s;
  return undefined;
}

/** Build-time localized ModifierStrings summary, if the build produced one. */
function precomputedModifierText(ctx, modifierId) {
  if (!hasTable(ctx, "modifier_text")) return undefined;
  const row = q1(
    ctx,
    `SELECT text_zh, text_en, resolved FROM modifier_text WHERE modifier_id = ?;`,
    modifierId,
  );
  if (!row || !Number(row.resolved)) return undefined;
  return row.text_zh || row.text_en || undefined;
}

/** Build-time localized RequirementStrings summary, if any. */
function precomputedRequirementText(ctx, requirementId) {
  if (!hasTable(ctx, "requirement_text")) return undefined;
  const row = q1(
    ctx,
    `SELECT text_zh, text_en, resolved FROM requirement_text WHERE requirement_id = ?;`,
    requirementId,
  );
  if (!row || !Number(row.resolved)) return undefined;
  return row.text_zh || row.text_en || undefined;
}

/**
 * Resolve a batch of modifier ids with a fixed number of queries (about 8,
 * regardless of how many modifiers/requirements are involved).
 */
function resolveModifiers(ctx, modifierIds) {
  const ids = uniq(modifierIds);
  if (!ids.length || !hasTable(ctx, "Modifiers")) return [];

  const modRows = selectIn(ctx, (ph) => `SELECT * FROM Modifiers WHERE ModifierId IN (${ph});`, ids);
  const modById = new Map(modRows.map((r) => [r.ModifierId, r]));

  const argsByMod = hasTable(ctx, "ModifierArguments")
    ? groupBy(selectIn(ctx, (ph) => `SELECT * FROM ModifierArguments WHERE ModifierId IN (${ph});`, ids), "ModifierId")
    : new Map();

  const stringByMod = new Map();
  if (hasTable(ctx, "ModifierStrings")) {
    for (const r of selectIn(
      ctx,
      (ph) => `SELECT ModifierId, Text, Context FROM ModifierStrings WHERE ModifierId IN (${ph});`,
      ids,
    )) {
      const prev = stringByMod.get(r.ModifierId);
      if (!prev || (r.Context === "Summary" && prev.Context !== "Summary")) stringByMod.set(r.ModifierId, r);
    }
  }

  const setIds = uniq(modRows.flatMap((r) => [r.OwnerRequirementSetId, r.SubjectRequirementSetId]));
  const setsById = new Map();
  const reqIdsBySet = new Map();
  const reqById = new Map();
  const reqArgsById = new Map();
  const reqStringById = new Map();

  if (setIds.length && hasTable(ctx, "RequirementSets")) {
    for (const r of selectIn(ctx, (ph) => `SELECT * FROM RequirementSets WHERE RequirementSetId IN (${ph});`, setIds)) {
      setsById.set(r.RequirementSetId, r);
    }
    const setReqs = hasTable(ctx, "RequirementSetRequirements")
      ? selectIn(
          ctx,
          (ph) => `SELECT RequirementSetId, RequirementId FROM RequirementSetRequirements WHERE RequirementSetId IN (${ph});`,
          setIds,
        )
      : [];
    for (const r of setReqs) {
      if (!reqIdsBySet.has(r.RequirementSetId)) reqIdsBySet.set(r.RequirementSetId, []);
      reqIdsBySet.get(r.RequirementSetId).push(r.RequirementId);
    }
    const reqIds = uniq(setReqs.map((r) => r.RequirementId));
    if (reqIds.length) {
      if (hasTable(ctx, "Requirements")) {
        for (const r of selectIn(ctx, (ph) => `SELECT * FROM Requirements WHERE RequirementId IN (${ph});`, reqIds)) {
          reqById.set(r.RequirementId, r);
        }
      }
      if (hasTable(ctx, "RequirementArguments")) {
        for (const r of selectIn(ctx, (ph) => `SELECT * FROM RequirementArguments WHERE RequirementId IN (${ph});`, reqIds)) {
          if (!reqArgsById.has(r.RequirementId)) reqArgsById.set(r.RequirementId, []);
          reqArgsById.get(r.RequirementId).push(r);
        }
      }
      if (hasTable(ctx, "RequirementStrings")) {
        for (const r of selectIn(
          ctx,
          (ph) => `SELECT RequirementId, Text, Context FROM RequirementStrings WHERE RequirementId IN (${ph});`,
          reqIds,
        )) {
          const prev = reqStringById.get(r.RequirementId);
          if (!prev || (r.Context === "Summary" && prev.Context !== "Summary")) reqStringById.set(r.RequirementId, r);
        }
      }
    }
  }

  // Localized names for argument values (yields, entity types) in one pass.
  const valueTags = [];
  for (const args of argsByMod.values()) {
    for (const a of args) valueTags.push(prettyTag(a.Value));
  }
  for (const args of reqArgsById.values()) {
    for (const a of args) valueTags.push(prettyTag(a.Value));
  }
  const zh = localizeMany(ctx, valueTags, "zh_Hans_CN");

  function prettyValue(value) {
    const s = String(value);
    const tag = prettyTag(s);
    if (!tag) return s;
    const text = zh(tag);
    return text ? (tag.startsWith("LOC_") ? text : `${text}(${s})`) : s;
  }

  function describe(mod) {
    const precomputed = precomputedModifierText(ctx, mod.ModifierId);
    if (precomputed) return precomputed;
    const args = (argsByMod.get(mod.ModifierId) ?? []).map(toJson);
    const row = stringByMod.get(mod.ModifierId);
    if (row?.Text) {
      let text = row.Text;
      if (text.startsWith("LOC_")) {
        const localized = zh(text);
        if (localized) text = localized;
      }
      return substitute(text, args);
    }
    const pairs = args
      .filter((a) => typeof a.Name === "string" && a.Value != null)
      .map((a) => `${a.Name}=${prettyValue(a.Value)}`);
    return pairs.length ? `${mod.ModifierType} (${pairs.join(", ")})` : String(mod.ModifierType ?? "");
  }

  function describeRequirement(requirementId) {
    const precomputed = precomputedRequirementText(ctx, requirementId);
    if (precomputed) return precomputed;
    const row = reqStringById.get(requirementId);
    if (!row?.Text) return undefined;
    const args = (reqArgsById.get(requirementId) ?? []).map(toJson);
    return substitute(row.Text, args);
  }

  function requirementSet(setId) {
    const set = setsById.get(setId);
    if (!set) return null;
    const requirements = (reqIdsBySet.get(setId) ?? []).map((reqId) => {
      const req = reqById.get(reqId);
      return {
        requirementId: reqId,
        requirementType: req?.RequirementType ?? null,
        description: describeRequirement(reqId) ?? null,
        arguments: (reqArgsById.get(reqId) ?? []).map(toJson),
      };
    });
    return { requirementSetId: setId, requirementSetType: set.RequirementSetType, requirements };
  }

  const out = [];
  for (const mid of ids) {
    const mod = modById.get(mid);
    if (!mod) continue;
    const ownerId = typeof mod.OwnerRequirementSetId === "string" ? mod.OwnerRequirementSetId : null;
    const subjectId = typeof mod.SubjectRequirementSetId === "string" ? mod.SubjectRequirementSetId : null;
    out.push({
      modifierId: mid,
      modifierType: String(mod.ModifierType ?? ""),
      description: describe(mod),
      runOnce: mod.RunOnce ?? null,
      permanent: mod.Permanent ?? null,
      ownerRequirementSetId: ownerId,
      subjectRequirementSetId: subjectId,
      ownerRequirement: ownerId ? requirementSet(ownerId) : null,
      subjectRequirement: subjectId ? requirementSet(subjectId) : null,
      arguments: (argsByMod.get(mid) ?? []).map(toJson),
    });
  }
  return out;
}

/**
 * Resolve promotion -> governors from GovernorPromotionSets. The id prefix is
 * never consulted: BBG keeps vanilla ids while reassigning ownership.
 */
function governorOwnersOf(ctx, promotionIds) {
  const out = new Map();
  const ids = uniq(promotionIds.map((v) => String(v)));
  if (!ids.length || !hasTable(ctx, "GovernorPromotionSets") || !hasTable(ctx, "Governors")) return out;
  const sets = selectIn(
    ctx,
    (ph) => `SELECT GovernorPromotion, GovernorType FROM GovernorPromotionSets WHERE GovernorPromotion IN (${ph});`,
    ids,
  );
  if (!sets.length) return out;
  const governorIds = uniq(sets.map((r) => String(r.GovernorType)));
  const governors = selectIn(
    ctx,
    (ph) => `SELECT GovernorType, Name FROM Governors WHERE GovernorType IN (${ph});`,
    governorIds,
  );
  const byId = new Map(governors.map((r) => [String(r.GovernorType), r.Name]));
  const zh = localizeMany(ctx, governors.map((r) => r.Name), "zh_Hans_CN");
  const en = localizeMany(ctx, governors.map((r) => r.Name), "en_US");
  for (const row of sets) {
    const promotion = String(row.GovernorPromotion);
    const governor = String(row.GovernorType);
    const tag = byId.get(governor);
    const entry = {
      id: governor,
      name: en(tag) ?? governor,
      name_zh: zh(tag) ?? en(tag) ?? governor,
    };
    const list = out.get(promotion) ?? [];
    if (!list.some((item) => item.id === entry.id)) list.push(entry);
    out.set(promotion, list);
  }
  return out;
}

/** Resolve governor -> promotions (id/name/level/column), again from the sets table. */
function governorPromotionsOf(ctx, governorIds) {
  const out = new Map();
  const ids = uniq(governorIds.map((v) => String(v)));
  if (!ids.length || !hasTable(ctx, "GovernorPromotionSets") || !hasTable(ctx, "GovernorPromotions")) return out;
  const rows = selectIn(
    ctx,
    (ph) =>
      `SELECT s.GovernorType AS governor, p.GovernorPromotionType AS promotion,
              p.Level AS level, p."Column" AS promotion_column, p.Name AS name
         FROM GovernorPromotionSets s
         JOIN GovernorPromotions p ON p.GovernorPromotionType = s.GovernorPromotion
        WHERE s.GovernorType IN (${ph})
        ORDER BY p.Level, p."Column";`,
    ids,
  );
  if (!rows.length) return out;
  const zh = localizeMany(ctx, rows.map((r) => r.name), "zh_Hans_CN");
  const en = localizeMany(ctx, rows.map((r) => r.name), "en_US");
  for (const row of rows) {
    const governor = String(row.governor);
    const promotion = String(row.promotion);
    const list = out.get(governor) ?? [];
    if (list.some((item) => item.id === promotion)) continue;
    list.push({
      id: promotion,
      name: en(row.name) ?? promotion,
      name_zh: zh(row.name) ?? en(row.name) ?? promotion,
      level: row.level === null || row.level === undefined ? null : Number(row.level),
      column: row.promotion_column === null || row.promotion_column === undefined ? null : Number(row.promotion_column),
    });
    out.set(governor, list);
  }
  return out;
}

/**
 * District -> buildings: the game links them through Buildings.PrereqDistrict.
 * A unique district (Hippodrome) has no rows of its own; it inherits the
 * buildings of the district it replaces (Entertainment Complex), so the union
 * is what a plan actually builds.
 */
function districtBuildings(ctx, districtId) {
  const replaced = hasTable(ctx, "DistrictReplaces")
    ? q(ctx, `SELECT ReplacesDistrictType FROM DistrictReplaces WHERE CivUniqueDistrictType = ?;`, districtId)
        .map((r) => r.ReplacesDistrictType)
        .filter(Boolean)
    : [];
  if (!hasTable(ctx, "Buildings")) return { buildings: [], unique: [], replaced };
  const ids = uniq([districtId, ...replaced]);
  const rows = selectIn(
    ctx,
    (ph) =>
      `SELECT BuildingType, Name, Cost, PrereqTech, PrereqCivic, PrereqDistrict FROM Buildings
        WHERE PrereqDistrict IN (${ph}) ORDER BY Cost, BuildingType;`,
    ids,
  );
  if (!rows.length) return { buildings: [], unique: [], replaced };
  const tags = rows.map((r) => r.Name ?? `LOC_BUILDING_${r.BuildingType}_NAME`);
  const zh = localizeMany(ctx, tags, "zh_Hans_CN");
  const en = localizeMany(ctx, tags, "en_US");
  // Unique replacements (Tlachtli -> Arena, Thermal Bath -> Zoo) share the same
  // PrereqDistrict but are not buildable by every civ, so keep them out of the
  // base chain and list them separately with the building they replace.
  const uniqueMap = new Map();
  if (hasTable(ctx, "BuildingReplaces")) {
    for (const row of selectIn(
      ctx,
      (ph) => `SELECT CivUniqueBuildingType, ReplacesBuildingType FROM BuildingReplaces
                WHERE ReplacesBuildingType IN (${ph});`,
      uniq(rows.map((r) => r.BuildingType)),
    )) {
      uniqueMap.set(row.CivUniqueBuildingType, row.ReplacesBuildingType);
    }
  }
  const shaped = rows.map((r, i) => ({
    id: r.BuildingType,
    name: en(tags[i]) ?? r.BuildingType,
    name_zh: zh(tags[i]) ?? r.BuildingType,
    cost: r.Cost ?? null,
    district: r.PrereqDistrict ?? null,
    prereqTech: r.PrereqTech ?? null,
    prereqCivic: r.PrereqCivic ?? null,
    ...(uniqueMap.has(r.BuildingType) ? { replaces: uniqueMap.get(r.BuildingType) } : {}),
  }));
  return {
    replaced,
    buildings: shaped.filter((b) => !b.replaces),
    unique: shaped.filter((b) => b.replaces),
  };
}

/**
 * Upgrade chain facts. The raw table only says "UpgradeUnit"; a unique unit
 * replaces the target, so "重战车 -> 骑士" is incomplete for Byzantium without
 * exposing the replacement. Upgrade gold is a derived estimate (the game ships
 * GlobalParameters, not a cost table) and is labelled as such.
 */
function unitUpgradeFacts(ctx, id, row) {
  if (!hasTable(ctx, "UnitUpgrades")) return null;
  const facts = {};
  const to = q1(ctx, `SELECT UpgradeUnit FROM UnitUpgrades WHERE Unit = ?;`, id)?.UpgradeUnit ?? null;
  if (to) facts.to = to;
  const replacersOf = (unitId) =>
    hasTable(ctx, "UnitReplaces") && unitId
      ? q(ctx, `SELECT CivUniqueUnitType FROM UnitReplaces WHERE ReplacesUnitType = ?;`, unitId)
          .map((r) => r.CivUniqueUnitType)
          .filter(Boolean)
      : [];
  const replacedBy = replacersOf(id);
  if (replacedBy.length) facts.replacedBy = uniq(replacedBy);
  const targetReplacedBy = replacersOf(to);
  const replacedRaw = hasTable(ctx, "UnitReplaces")
    ? q(ctx, `SELECT ReplacesUnitType FROM UnitReplaces WHERE CivUniqueUnitType = ?;`, id)
        .map((r) => r.ReplacesUnitType)
        .filter(Boolean)
    : [];
  const sources = uniq([id, ...replacedRaw]);
  const from = selectIn(ctx, (ph) => `SELECT Unit FROM UnitUpgrades WHERE UpgradeUnit IN (${ph});`, sources)
    .map((r) => r.Unit)
    .filter(Boolean);
  if (from.length) facts.upgradableFrom = uniq(from);

  if (!to) return Object.keys(facts).length ? facts : null;
  const target = q1(ctx, `SELECT Cost FROM Units WHERE UnitType = ?;`, to);
  const productionDelta =
    target?.Cost !== null && target?.Cost !== undefined && row.Cost !== null && row.Cost !== undefined
      ? target.Cost - row.Cost
      : null;
  if (productionDelta !== null) facts.productionDelta = productionDelta;

  let model = null;
  if (hasTable(ctx, "GlobalParameters")) {
    const params = Object.fromEntries(
      q(
        ctx,
        `SELECT Name, Value FROM GlobalParameters
          WHERE Name IN ('UPGRADE_BASE_COST','UPGRADE_NET_PRODUCTION_PERCENT_COST','UPGRADE_MINIMUM_COST');`,
      ).map((r) => [r.Name, Number(r.Value)]),
    );
    const base = params.UPGRADE_BASE_COST;
    const percentOfNet = params.UPGRADE_NET_PRODUCTION_PERCENT_COST;
    const minimum = params.UPGRADE_MINIMUM_COST;
    if ([base, percentOfNet, minimum].every((n) => Number.isFinite(n))) {
      model = { base, percentOfNet, minimum, source: "GlobalParameters" };
      facts.goldCostModel = model;
    }
  }
  const estimate = (delta) =>
    model && delta !== null && delta !== undefined
      ? Math.max(model.minimum, Math.round(model.base + (delta * model.percentOfNet) / 100))
      : null;
  const goldEstimate = estimate(productionDelta);
  if (goldEstimate !== null) {
    facts.goldEstimate = goldEstimate;
    facts.goldEstimateFormula = `${model.base} + ${productionDelta} × ${model.percentOfNet}% (min ${model.minimum})`;
    facts.goldEstimateAuthority = "derived";
    facts.goldEstimateConfidence = 0.5;
  }

  // The upgrade target itself may be replaced by unique units: 重战车 -> 骑士 in
  // the base rules, but 骑士 is replaced by Mamluk / Mandekalu / Tagma. List the
  // candidates with their own delta instead of guessing which civ is meant.
  if (targetReplacedBy.length) {
    facts.targetReplacedBy = uniq(targetReplacedBy).map((replacerId) => {
      const replacer = q1(ctx, `SELECT Cost FROM Units WHERE UnitType = ?;`, replacerId);
      const delta =
        replacer?.Cost !== null && replacer?.Cost !== undefined && row.Cost !== null && row.Cost !== undefined
          ? replacer.Cost - row.Cost
          : null;
      const entry = {
        id: replacerId,
        productionDelta: delta,
        note: "effective only for the civilization that builds this replacement unique",
      };
      const effectiveGold = estimate(delta);
      if (effectiveGold !== null) entry.goldEstimate = effectiveGold;
      return entry;
    });
  }
  return Object.keys(facts).length ? facts : null;
}

/** Strategic-resource cost/maintenance for a unit (Units + Units_XP2). */
function unitResourceFacts(ctx, id, row) {
  if (!hasTable(ctx, "Units_XP2")) return null;
  const xp2 = q1(
    ctx,
    `SELECT ResourceCost, ResourceMaintenanceType, ResourceMaintenanceAmount FROM Units_XP2 WHERE UnitType = ?;`,
    id,
  );
  if (!xp2) return null;
  const type = row.StrategicResource ?? xp2.ResourceMaintenanceType ?? null;
  const cost = xp2.ResourceCost ?? null;
  const maintenance = xp2.ResourceMaintenanceAmount ?? null;
  if (type === null && cost === null) return null;
  const requiresResource = Boolean(type);
  return {
    type,
    requiresResource,
    cost,
    maintenancePerTurn: maintenance,
    // Some units carry a leftover ResourceCost without a declared strategic
    // resource. State the data-layer conclusion instead of making the model
    // chase Units_XP2 with SQL.
    ...(requiresResource || !cost
      ? {}
      : { note: "Units_XP2.ResourceCost 有值但 Units 未声明战略资源；按数据层结论不需要资源，不要推断。" }),
  };
}

function getEntityDetail(ctx, type, id, opts = {}) {
  const spec = specByType.get(type);
  if (!spec || !hasTable(ctx, spec.table)) return undefined;
  const row = q1(ctx, `SELECT * FROM "${spec.table}" WHERE "${spec.pk}" = ?;`, id);
  if (!row) return undefined;

  const detail = { id, type, row: compactRow(row), related: {} };

  for (const r of spec.related) {
    if (!hasTable(ctx, r.table)) continue;
    detail.related[r.table] = q(ctx, `SELECT * FROM "${r.table}" WHERE "${r.fk}" = ? LIMIT 50;`, id).map(compactRow);
  }

  if (type === "governor_promotion") {
    detail.governors = governorOwnersOf(ctx, [id]).get(id) ?? [];
  } else if (type === "governor") {
    detail.promotions = governorPromotionsOf(ctx, [id]).get(id) ?? [];
  }

  const nameTag = row.Name ?? `${spec.loc}${id}_NAME`;
  const descTag = row.Description ?? `${spec.loc}${id}_DESCRIPTION`;
  const zh = localizeMany(ctx, [nameTag, descTag], "zh_Hans_CN");
  const en = localizeMany(ctx, [nameTag, descTag], "en_US");
  detail.name = en(nameTag) ?? id;
  detail.name_zh = zh(nameTag) ?? id;
  if (row.Description) {
    detail.description = en(descTag) ?? null;
    detail.description_zh = zh(descTag) ?? null;
    detail.description_en = detail.description;
  }

  // Derived relations that the raw row does not carry but a plan answer needs:
  // "which buildings does this district give", "what upgrades into/out of this
  // unit", "what does one upgrade cost". These used to cost the model several
  // SQL detours per session.
  if (type === "unit") {
    const upgrade = unitUpgradeFacts(ctx, id, row);
    if (upgrade) detail.upgrade = upgrade;
    const resource = unitResourceFacts(ctx, id, row);
    if (resource) detail.resource = resource;
  } else if (type === "district") {
    const info = districtBuildings(ctx, id);
    if (info.replaced.length) detail.replaces = info.replaced;
    if (info.buildings.length) detail.buildings = info.buildings;
    if (info.unique.length) detail.uniqueBuildings = info.unique;
  }

  // The effect card is the canonical, player-facing answer. Keep the raw
  // modifier chain below it for auditing, but never make the model compose
  // effect prose from raw `MODIFIER_*` rows.
  const effectMode = opts.effects ?? "summary";
  if (effectMode !== "none" && hasTable(ctx, "effect_cards")) {
    const card = q1(
      ctx,
      `SELECT * FROM effect_cards WHERE card_id = ?;`,
      `${type}:${id}`,
    );
    if (card) {
      const allEffects = parseJsonArray(card.effects_json);
      const limit = effectMode === "full" ? allEffects.length : 12;
      detail.description_zh = card.description_zh ?? detail.description_zh ?? null;
      detail.description_en = card.description_en ?? detail.description_en ?? null;
      if (detail.description_en) detail.description = detail.description_en;
      detail.attributes = parseJsonArray(card.attributes_json);
      detail.effects = allEffects.slice(0, limit).map((e) => {
        const shaped = {
          kind: e.kind,
          text: e.text_zh ?? e.text_en ?? "",
          authority: e.authority,
          source: e.source,
        };
        if (e.text_en) shaped.text_en = e.text_en;
        if (e.value !== null && e.value !== undefined) shaped.value = e.value;
        if (e.unit) shaped.unit = e.unit;
        const condition = e.condition_zh ?? e.condition_en;
        if (condition) shaped.condition = condition;
        return shaped;
      });
      if (allEffects.length > limit) detail.effectsTruncated = true;
      detail.effectCount = allEffects.length;
      const unresolved = parseJsonArray(card.unresolved_json);
      detail.unresolvedCount = unresolved.length;
      detail.unresolved = unresolved.slice(0, effectMode === "full" ? 20 : 3);
      detail.coverage = parseJson(card.coverage_json, null);
      detail.rulesetId = card.ruleset_id;
      detail.effectBuiltAt = card.built_at;
    }
  }

  // Raw modifier chains are audit data. They are opt-in now that the effect
  // card carries the player-facing text; a one-line summary per modifier is
  // still available with modifiers:'summary'.
  const mode = opts.modifiers ?? "none";
  const modifierIds = uniq(collectModifierIds(ctx, spec, id));
  detail.modifierCount = modifierIds.length;
  if (mode === "full") detail.modifiers = resolveModifiers(ctx, modifierIds);
  else if (mode !== "none" && modifierIds.length) detail.modifiers = resolveModifierSummaries(ctx, modifierIds);
  return detail;
}

/** One query per table, description only: ~120 bytes per modifier. */
function resolveModifierSummaries(ctx, modifierIds) {
  const ids = uniq(modifierIds);
  if (!ids.length || !hasTable(ctx, "Modifiers")) return [];
  const modById = new Map(
    selectIn(ctx, (ph) => `SELECT * FROM Modifiers WHERE ModifierId IN (${ph});`, ids).map((r) => [r.ModifierId, r]),
  );
  const argsByMod = hasTable(ctx, "ModifierArguments")
    ? groupBy(selectIn(ctx, (ph) => `SELECT * FROM ModifierArguments WHERE ModifierId IN (${ph});`, ids), "ModifierId")
    : new Map();
  const stringByMod = new Map();
  if (hasTable(ctx, "ModifierStrings")) {
    for (const r of selectIn(
      ctx,
      (ph) => `SELECT ModifierId, Text, Context FROM ModifierStrings WHERE ModifierId IN (${ph});`,
      ids,
    )) {
      const prev = stringByMod.get(r.ModifierId);
      if (!prev || (r.Context === "Summary" && prev.Context !== "Summary")) stringByMod.set(r.ModifierId, r);
    }
  }

  const valueTags = [];
  for (const args of argsByMod.values()) for (const a of args) valueTags.push(prettyTag(a.Value));
  const zh = localizeMany(ctx, valueTags, "zh_Hans_CN");
  const pretty = (value) => {
    const s = String(value);
    const tag = prettyTag(s);
    const text = tag ? zh(tag) : undefined;
    if (!text) return s;
    return tag.startsWith("LOC_") ? text : `${text}(${s})`;
  };

  const out = [];
  for (const mid of ids) {
    const mod = modById.get(mid);
    if (!mod) continue;
    const args = (argsByMod.get(mid) ?? []).map(toJson);
    const row = stringByMod.get(mid);
    let description = precomputedModifierText(ctx, mid);
    if (!description) {
      if (row?.Text) {
        let text = row.Text;
        if (text.startsWith("LOC_")) {
          const localized = zh(text);
          if (localized) text = localized;
        }
        description = substitute(text, args);
      } else {
        const pairs = args
          .filter((a) => typeof a.Name === "string" && a.Value != null)
          .map((a) => `${a.Name}=${pretty(a.Value)}`);
        description = pairs.length ? `${mod.ModifierType} (${pairs.join(", ")})` : String(mod.ModifierType ?? "");
      }
    }
    out.push({ modifierId: mid, modifierType: String(mod.ModifierType ?? ""), description });
  }
  return out;
}

/** Fuzzy id lookup: exact-ish id substring -> localized name -> search docs. */
function findEntityCandidates(ctx, type, needle) {
  const spec = specByType.get(type);
  if (!spec) return [];
  const out = [];
  const push = (id, name, nameZh) => {
    if (out.length < 8 && id && !out.some((c) => c.id === id)) out.push({ id, name, name_zh: nameZh });
  };

  if (hasTable(ctx, spec.table)) {
    for (const r of q(ctx, `SELECT * FROM "${spec.table}" WHERE "${spec.pk}" LIKE ? LIMIT 8;`, `%${needle}%`)) {
      const id = String(r[spec.pk]);
      const tag = r.Name ?? `${spec.loc}${id}_NAME`;
      push(id, localizeMany(ctx, [tag], "en_US")(tag) ?? id, localizeMany(ctx, [tag], "zh_Hans_CN")(tag) ?? id);
    }
  }
  if (out.length < 8 && hasTable(ctx, "search_docs")) {
    for (const r of q(
      ctx,
      "SELECT id, name, name_zh FROM search_docs WHERE type = ? AND (name LIKE ? OR name_zh LIKE ?) LIMIT 8;",
      type,
      `%${needle}%`,
      `%${needle}%`,
    )) {
      push(String(r.id).slice(type.length + 1), r.name, r.name_zh);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search: precomputed postings when available, in-memory BM25 otherwise
// ---------------------------------------------------------------------------
function indexMeta(ctx) {
  if (ctx.indexMeta) return ctx.indexMeta;
  let meta = null;
  if (hasTable(ctx, "_meta")) {
    const row = q1(ctx, "SELECT value FROM _meta WHERE key = 'search_index';");
    if (row?.value) {
      try {
        meta = JSON.parse(String(row.value));
      } catch {
        meta = null;
      }
    }
  }
  if (!meta && hasTable(ctx, "search_docs")) {
    const n = q1(ctx, "SELECT COUNT(*) AS n FROM search_docs;")?.n ?? 0;
    // avgdl is only used by the postings path, which implies the precomputed index.
    meta = { docs: n, avgdl: 1 };
  }
  ctx.indexMeta = meta ?? { docs: 0, avgdl: 1 };
  return ctx.indexMeta;
}

function postingsAvailable(ctx) {
  return hasTable(ctx, "search_postings") && hasTable(ctx, "search_terms");
}

function searchDocsByPostings(ctx, query, opts) {
  const meta = indexMeta(ctx);
  const limit = clampInt(opts.limit, 20, 1, 100);
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !meta.docs) return [];

  const type = opts.scope === "plan"
    ? "card"
    : opts.type && (specByType.has(opts.type) || opts.type === "card")
      ? opts.type
      : undefined;
  const dfByTerm = new Map(
    selectIn(ctx, (ph) => `SELECT term, df FROM search_terms WHERE term IN (${ph});`, terms).map((r) => [r.term, r.df]),
  );
  if (!dfByTerm.size) return [];

  const rows = selectIn(
    ctx,
    (ph) =>
      `SELECT p.term AS term, p.doc_id AS doc_id, p.tf AS tf, d.len AS len,
              d.name AS name, d.name_zh AS name_zh
         FROM search_postings p JOIN search_docs d ON d.id = p.doc_id
        WHERE ${type ? "d.type = ? AND " : ""}${opts.scope === "entity" ? "d.type <> 'card' AND " : ""}p.term IN (${ph});`,
    terms,
    type ? [type] : [],
  );

  const scores = new Map();
  for (const r of rows) {
    const df = dfByTerm.get(r.term);
    if (!df) continue;
    const len = r.len ?? meta.avgdl ?? 1;
    const idf = Math.log(1 + (meta.docs - df + 0.5) / (df + 0.5));
    const denom = r.tf + BM25_K1 * (1 - BM25_B + (BM25_B * len) / (meta.avgdl || 1));
    // A small title bonus keeps short exact-title matches ("科技胜利 爆发点")
    // ahead of long cards that merely mention the same words.
    const title = `${r.name ?? ""} ${r.name_zh ?? ""}`;
    const titleBonus = title.includes(r.term) ? 0.7 : 0;
    scores.set(
      r.doc_id,
      (scores.get(r.doc_id) ?? 0) + idf * ((r.tf * (BM25_K1 + 1)) / denom + titleBonus),
    );
  }

  const top = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit);
  if (!top.length) return [];

  const dest = new Map(
    selectIn(
      ctx,
      (ph) => `SELECT id, type, name, name_zh, doc FROM search_docs WHERE id IN (${ph});`,
      top.map(([id]) => id),
    ).map((r) => [r.id, r]),
  );

  return top
    .filter(([id]) => dest.has(id))
    .map(([id, score]) => {
      const d = dest.get(id);
      const out = {
        id: d.id,
        type: d.type,
        name: d.name,
        name_zh: d.name_zh,
        score: Math.round(score * 1000) / 1000,
        snippet: String(d.doc ?? "").slice(0, 200),
      };
      // Plan cards are decision answers: return the whole card body so one
      // search call can replace several entity lookups.
      if (opts.full === true || d.type === "card") {
        out.body = String(d.doc ?? "").slice(0, clampInt(opts.bodyLimit, 1600, 200, 4000));
      }
      return out;
    });
}

/** Legacy path for databases without the precomputed index: build once, cache. */
function searchDocsInMemory(ctx, query, opts) {
  if (!ctx.memoryIndex) {
    const rows = q(ctx, "SELECT id, type, name, name_zh, doc FROM search_docs;");
    const docs = rows.map((r) => ({
      id: String(r.id),
      type: String(r.type),
      name: String(r.name ?? ""),
      name_zh: String(r.name_zh ?? ""),
      doc: String(r.doc ?? ""),
    }));
    const df = new Map();
    const indexed = docs.map((doc) => {
      const tokens = tokenize(doc.doc);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      return { doc, tf, len: tokens.length };
    });
    const avgdl = indexed.length ? indexed.reduce((s, d) => s + d.len, 0) / indexed.length : 1;
    ctx.memoryIndex = { docs: indexed, df, avgdl, n: indexed.length };
  }
  const index = ctx.memoryIndex;
  const qTokens = [...new Set(tokenize(query))];
  const scored = [];
  for (const d of index.docs) {
    if (opts.scope === "plan" && d.doc.type !== "card") continue;
    if (opts.type && d.doc.type !== opts.type) continue;
    if (opts.scope === "entity" && d.doc.type === "card") continue;
    let score = 0;
    for (const t of qTokens) {
      const df = index.df.get(t);
      if (df === undefined) continue;
      const tf = d.tf.get(t) ?? 0;
      if (tf === 0) continue;
      const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
      const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * d.len) / (index.avgdl || 1));
      const titleBonus = `${d.doc.name} ${d.doc.name_zh}`.includes(t) ? 0.7 : 0;
      score += idf * ((tf * (BM25_K1 + 1)) / denom + titleBonus);
    }
    if (score > 0) scored.push({ doc: d.doc, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, clampInt(opts.limit, 20, 1, 100)).map((r) => {
    const out = {
      id: r.doc.id,
      type: r.doc.type,
      name: r.doc.name,
      name_zh: r.doc.name_zh,
      score: Math.round(r.score * 1000) / 1000,
      snippet: r.doc.doc.slice(0, 200),
    };
    if (opts.full === true || r.doc.type === "card") {
      out.body = r.doc.doc.slice(0, clampInt(opts.bodyLimit, 1600, 200, 4000));
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Decision-layer (`kb_*`) retrieval
// ---------------------------------------------------------------------------
const PLAN_VICTORIES = ["science", "culture", "religion", "domination", "diplomatic"];
const PLAN_ERAS = {
  ancient: "ERA_ANCIENT",
  classical: "ERA_CLASSICAL",
  medieval: "ERA_MEDIEVAL",
  renaissance: "ERA_RENAISSANCE",
  industrial: "ERA_INDUSTRIAL",
  modern: "ERA_MODERN",
  atomic: "ERA_ATOMIC",
  information: "ERA_INFORMATION",
};

function hasKb(ctx) {
  return (
    hasTable(ctx, "kb_plan") &&
    hasTable(ctx, "kb_target") &&
    hasTable(ctx, "kb_budget") &&
    hasTable(ctx, "kb_check") &&
    hasTable(ctx, "kb_card")
  );
}

function normalizePlanEra(value) {
  if (value === undefined || value === null || value === "") return null;
  const raw = String(value).trim();
  if (raw.toLowerCase() === "burst") return null;
  if (raw.toUpperCase().startsWith("ERA_")) return raw.toUpperCase();
  return PLAN_ERAS[raw.toLowerCase()] ?? null;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function parseJsonArray(value) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function entityLabel(ctx, category, id) {
  if (!id) return id;
  const row = q1(ctx, `SELECT name_zh, name FROM search_docs WHERE id = ?;`, `${category}:${id}`);
  return row?.name_zh || row?.name || id;
}

function resolveCiv(ctx, source, civArg, leaderArg) {
  if (!civArg && !leaderArg) return null;
  const leader = leaderArg ? String(leaderArg) : "";
  if (civArg && /^CIVILIZATION_/i.test(String(civArg))) {
    if (leader) {
      const exact = q1(
        ctx,
        `SELECT * FROM kb_civ_profile WHERE source = ? AND civ_id = ? AND leader_id = ? LIMIT 1;`,
        source,
        String(civArg),
        leader,
      );
      if (exact) return exact;
    }
    const row = q1(
      ctx,
      `SELECT * FROM kb_civ_profile WHERE source = ? AND civ_id = ?
        ORDER BY (SELECT COUNT(*) FROM kb_civ_delta d
                   WHERE d.source = kb_civ_profile.source
                     AND d.civ_id = kb_civ_profile.civ_id
                     AND d.leader_id = kb_civ_profile.leader_id) DESC,
                 leader_id LIMIT 1;`,
      source,
      String(civArg),
    );
    if (row) return row;
  }
  const like = `%${String(civArg ?? leaderArg ?? "").trim()}%`;
  if (!like || like === "%%") return null;
  const row = q1(
    ctx,
    `SELECT * FROM kb_civ_profile
      WHERE source = ? AND (name_zh LIKE ? OR name_en LIKE ? OR civ_id LIKE ? OR leader_id LIKE ?)
      ORDER BY (SELECT COUNT(*) FROM kb_civ_delta d
                 WHERE d.source = kb_civ_profile.source
                   AND d.civ_id = kb_civ_profile.civ_id
                   AND d.leader_id = kb_civ_profile.leader_id) DESC,
               leader_id LIMIT 1;`,
    source,
    like,
    like,
    like,
    like,
  );
  return row ?? null;
}

function civEntityMap(ctx, source, civ) {
  const map = new Map();
  if (!civ) return map;
  const rows = q(
    ctx,
    `SELECT slot_kind, base_id, unique_id FROM kb_civ_entity_map
      WHERE source = ? AND civ_id = ? AND (leader_id = ? OR leader_id = '');`,
    source,
    civ.civ_id,
    civ.leader_id,
  );
  for (const r of rows) {
    if (!map.has(r.slot_kind)) map.set(r.slot_kind, new Map());
    map.get(r.slot_kind).set(r.base_id, r.unique_id);
  }
  return map;
}

function civDeltas(ctx, source, victory, civ) {
  if (!civ) return [];
  return q(
    ctx,
    `SELECT * FROM kb_civ_delta
      WHERE source = ? AND civ_id = ? AND victory_id = ? AND (leader_id = ? OR leader_id = '')
      ORDER BY delta_id;`,
    source,
    civ.civ_id,
    victory,
    civ.leader_id,
  );
}

function applyCivToTargets(ctx, source, targets, civ, victory) {
  if (!civ) return { targets, applied: 0, notes: [], unmatched: [] };
  const map = civEntityMap(ctx, source, civ);
  let applied = 0;
  const notes = [];
  const unmatched = [];

  for (const t of targets) {
    const slot = map.get(t.category);
    if (!slot) continue;
    const unique = slot.get(t.entity_id);
    if (!unique) continue;
    t.entity_id = unique;
    t.label_zh = entityLabel(ctx, t.category, unique);
    t.label_en = t.label_zh;
    t._civReplaced = true;
  }

  const deltas = civDeltas(ctx, source, victory, civ);
  for (const d of deltas) {
    const ref = parseJson(d.target_ref, {});
    const matches = targets.filter((t) => {
      if (d.era_id && t.era_id !== d.era_id) return false;
      if (ref.category && t.category !== ref.category) return false;
      if (ref.entityId && t.entity_id !== ref.entityId) return false;
      if (ref.dimensionId && t.dimension_id !== ref.dimensionId) return false;
      return true;
    });
    if (!matches.length) {
      // A civ-only view has no slice to mutate; an era-scoped delta also does
      // not apply to a burst-only view.
      if (!targets.length) continue;
      if (d.era_id && !targets.some((t) => t.era_id === d.era_id)) continue;
      unmatched.push({ op: d.op, ref, reason: d.reason ?? null });
      continue;
    }
    for (const t of matches) {
      if (d.op === "note") {
        notes.push(d.value_text || d.reason || "");
      } else if (d.op === "remove") {
        t._removed = true;
      } else if (d.op === "add") {
        if (t.value_num !== null && t.value_num !== undefined) t.value_num += Number(d.value_num ?? 0);
        if (t.value_lo !== null && t.value_lo !== undefined) t.value_lo += Number(d.value_num ?? 0);
        if (t.value_hi !== null && t.value_hi !== undefined) t.value_hi += Number(d.value_num ?? 0);
      } else if (d.op === "multiply") {
        if (t.value_num !== null && t.value_num !== undefined) t.value_num *= Number(d.value_num ?? 1);
        if (t.value_lo !== null && t.value_lo !== undefined) t.value_lo *= Number(d.value_num ?? 1);
        if (t.value_hi !== null && t.value_hi !== undefined) t.value_hi *= Number(d.value_num ?? 1);
      } else if (d.op === "replace") {
        if (d.value_num !== null && d.value_num !== undefined) {
          t.value_num = Number(d.value_num);
          t.value_lo = null;
          t.value_hi = null;
        }
        if (d.value_lo !== null && d.value_lo !== undefined) t.value_lo = Number(d.value_lo);
        if (d.value_hi !== null && d.value_hi !== undefined) t.value_hi = Number(d.value_hi);
        if (d.value_text) {
          t.value_text = d.value_text;
          if (ref.category && ref.category !== "metric" && /^[A-Z][A-Z0-9_]+$/.test(d.value_text)) {
            t.entity_id = d.value_text;
            t.label_zh = entityLabel(ctx, t.category, d.value_text);
            t.label_en = t.label_zh;
          }
        }
      }
      applied++;
    }
  }
  return { targets: targets.filter((t) => !t._removed), applied, notes, unmatched };
}

function shapeTarget(t, detail) {
  const out = {
    category: t.category,
    id: t.entity_id || t.dimension_id,
    label: t.label_zh || t.entity_id || t.dimension_id,
    role: t.role,
    op: t.op,
  };
  if (t.entity_id) out.qty = t.value_num ?? 1;
  if (t.dimension_id) {
    out.value = t.op === "between" ? [t.value_lo, t.value_hi] : t.value_num;
    if (t.unit) out.unit = t.unit;
  }
  if (t.rationale) out.note = t.rationale;
  if (detail === "full") {
    out.confidence = t.confidence;
    out.source = t.source_flag;
    if (t.formula) out.formula = t.formula;
    if (t.check_hint) out.checkHint = t.check_hint;
    if (t.remedy) out.remedy = t.remedy;
  }
  return out;
}

function shapeBudget(b) {
  return { currency: b.currency, income: b.income, expense: b.expense, net: b.net };
}

function shapeCheck(c) {
  return {
    era: c.era_id,
    turn: [c.turn_lo, c.turn_hi],
    dimension: c.dimension_id,
    band: [c.value_lo, c.value_hi],
    message: c.message,
    // NULL remedy must stay JSON (not `undefined`): the host rejects tool
    // output that is not lossless JSON, which used to break view='check'.
    remedy: c.remedy ?? null,
    severity: c.severity,
  };
}

function loadPlanTargets(ctx, planId, sliceKind, eraId) {
  if (eraId) {
    return q(
      ctx,
      `SELECT * FROM kb_target WHERE plan_id = ? AND slice_kind = ? AND era_id = ?
        ORDER BY CASE role WHEN 'blocking' THEN 0 WHEN 'enabling' THEN 1 ELSE 2 END, category, priority;`,
      planId,
      sliceKind,
      eraId,
    );
  }
  return q(
    ctx,
    `SELECT * FROM kb_target WHERE plan_id = ? AND slice_kind = ?
      ORDER BY turn_lo, CASE role WHEN 'blocking' THEN 0 WHEN 'enabling' THEN 1 ELSE 2 END, category, priority;`,
    planId,
    sliceKind,
  );
}

function loadBudgets(ctx, planId, sliceKind, eraId) {
  if (eraId) {
    return q(
      ctx,
      `SELECT era_id, currency, income, expense, net FROM kb_budget
        WHERE plan_id = ? AND slice_kind = ? AND era_id = ? ORDER BY currency;`,
      planId,
      sliceKind,
      eraId,
    );
  }
  return q(
    ctx,
    `SELECT era_id, currency, income, expense, net FROM kb_budget
      WHERE plan_id = ? AND slice_kind = ? ORDER BY era_id, currency;`,
    planId,
    sliceKind,
  );
}

function loadObjective(ctx, victory, civ, leader, speed) {
  if (!hasTable(ctx, "kb_objective")) {
    // The KB may have been rebuilt after this connection was opened; probe the
    // table once so a running session picks the objective layer up.
    try {
      q(ctx, `SELECT 1 FROM kb_objective LIMIT 1;`);
      ctx.tables.add("kb_objective");
    } catch {
      return null;
    }
  }
  const rows = q(
    ctx,
    `SELECT * FROM kb_objective WHERE victory_id = ? AND speed = ?
      ORDER BY (civ_id IS NULL), civ_id, leader_id;`,
    victory,
    speed,
  );
  if (!rows.length) return null;
  const civId = civ?.civ_id ?? null;
  const leaderId = civ?.leader_id ?? null;
  if (civId) {
    const exact = rows.find((r) => r.civ_id === civId && (!leaderId || r.leader_id === leaderId));
    if (exact) return exact;
    const civWide = rows.find((r) => r.civ_id === civId && !r.leader_id);
    if (civWide) return civWide;
  }
  return rows.find((r) => !r.civ_id) ?? null;
}

function shapeConstraint(c) {
  return {
    id: c.constraint_key,
    metric: c.metric,
    unit: c.unit,
    required: c.required,
    supplyRate: c.supply_rate,
    tightness: c.tightness,
    bindingRank: c.binding_rank,
    waivedBy: c.waived_by,
  };
}

function objectivePayload(ctx, objective) {
  const objectiveId = objective.objective_id;
  const constraints = q(
    ctx,
    `SELECT * FROM kb_constraint WHERE objective_id = ?
      ORDER BY COALESCE(binding_rank, 99) LIMIT 8;`,
    objectiveId,
  ).map(shapeConstraint);
  const path = q(
    ctx,
    `SELECT kind, id, role, group_id, era_due, cost, why FROM kb_path_node
      WHERE objective_id = ? ORDER BY role, era_due, depth DESC LIMIT 60;`,
    objectiveId,
  );
  const onPath = path
    .filter((n) => n.role === "on_path")
    .slice(0, 18)
    .map((n) => ({
      kind: n.kind,
      id: n.id,
      label: entityLabel(ctx, n.kind, n.id),
      eraDue: n.era_due,
      cost: parseJson(n.cost, {}),
    }));
  const detour = path
    .filter((n) => n.role === "detour")
    .slice(0, 10)
    .map((n) => ({
      kind: n.kind,
      id: n.id,
      label: entityLabel(ctx, n.kind, n.id),
      group: n.group_id,
      cost: parseJson(n.cost, {}),
    }));
  const dead = path
    .filter((n) => n.role === "dead")
    .slice(0, 8)
    .map((n) => ({ id: n.id, why: n.why }));
  const focus = q(
    ctx,
    `SELECT * FROM kb_era_focus WHERE objective_id = ? ORDER BY era_index, rank LIMIT 24;`,
    objectiveId,
  );

  // v3: the ledger / supply / cut / scenario band. This is the arithmetic the
  // answer must quote; without it an era plan is just a list of names.
  const budget = q(
    ctx,
    `SELECT era_id, metric, required_cum, supply_cum, gap, required_per_turn,
            supply_per_turn, window_turns, verdict
       FROM kb_ledger WHERE objective_id = ? AND scenario_id = 'base'
      ORDER BY era_index, metric;`,
    objectiveId,
  ).map((r) => ({
    era: r.era_id,
    metric: r.metric,
    required: round1(r.required_cum),
    supply: round1(r.supply_cum),
    gap: round1(r.gap),
    perTurn: [round1(r.required_per_turn), round1(r.supply_per_turn)],
    window: r.window_turns,
    verdict: r.verdict,
  }));
  const supply = q(
    ctx,
    `SELECT source_id, metric, kind, ref_id, per_unit, copies, from_turn, per_pop, note
       FROM kb_supply_source WHERE objective_id = ? ORDER BY metric, from_turn;`,
    objectiveId,
  ).map((r) => ({
    id: r.source_id,
    metric: r.metric,
    kind: r.kind,
    ref: r.ref_id,
    // Names for the supply ledger so the answer can cite "纪念碑" without a
    // follow-up entity call for BUILDING_MONUMENT.
    name_zh: entityLabel(ctx, r.kind === "governor" ? "governor_promotion" : r.kind, r.ref_id),
    perTurn: round1(r.per_unit * r.copies),
    copies: r.copies,
    fromTurn: r.from_turn,
    perPop: !!r.per_pop,
  }));
  const cut = q(
    ctx,
    `SELECT rank, cut_kind, ref_id, group_id, saves_json, lose, trigger, slip_turns
       FROM kb_cut WHERE objective_id = ? AND scenario_id = 'base' ORDER BY rank LIMIT 6;`,
    objectiveId,
  ).map((r) => ({
    rank: r.rank,
    kind: r.cut_kind,
    ref: r.ref_id || r.group_id,
    saves: parseJson(r.saves_json, {}),
    lose: r.lose,
    trigger: r.trigger,
    slipTurns: r.slip_turns,
  }));
  const scenario = q(
    ctx,
    `SELECT scenario_id, label, feasible, first_gap_era, first_gap_amount, burst_gap
       FROM kb_scenario WHERE objective_id = ? ORDER BY (scenario_id <> 'base'), scenario_id;`,
    objectiveId,
  ).map((r) => ({
    id: r.scenario_id,
    label: r.label,
    feasible: !!r.feasible,
    firstGap: r.first_gap_era ? [r.first_gap_era, round1(r.first_gap_amount)] : null,
    burstGap: round1(r.burst_gap),
  }));
  const robustness = q(
    ctx,
    `SELECT decision_ref, decision_kind, invariant, flips_in FROM kb_robustness
      WHERE objective_id = ? ORDER BY invariant, decision_ref LIMIT 12;`,
    objectiveId,
  ).map((r) => ({
    ref: r.decision_ref,
    kind: r.decision_kind,
    invariant: !!r.invariant,
    flipsIn: parseJsonArray(r.flips_in),
  }));

  const eras = [];
  const byEra = new Map();
  for (const f of focus) {
    if (!byEra.has(f.era_id)) {
      byEra.set(f.era_id, {
        era: f.era_id,
        turn: [f.turn_lo, f.turn_hi],
        items: [],
      });
      eras.push(byEra.get(f.era_id));
    }
    const entry = byEra.get(f.era_id);
    const constraint = constraints.find((c) => c.id === f.constraint_key);
    entry.items.push({
      rank: f.rank,
      action: { kind: f.action_kind, id: f.ref_id, label: f.ref_label },
      constraint: constraint ? { metric: constraint.metric, tightness: constraint.tightness } : null,
      why: f.why,
      cost: f.cost,
      alternative: f.alternative,
      abandonIf: f.abandon_if,
      checkpoint: f.checkpoint,
      ledgerGap: f.ledger_gap,
      supplyDelta: f.supply_delta,
      source: f.source_flag,
    });
    const ledgerRow = budget.find((b) => b.era === f.era_id);
    if (ledgerRow && entry.gap === undefined) {
      entry.gap = ledgerRow.gap;
      entry.verdict = ledgerRow.verdict;
    }
  }
  return {
    objective: {
      id: objective.objective_id,
      title: objective.title,
      victory: objective.victory_id,
      civ: objective.civ_id,
      leader: objective.leader_id,
      speed: objective.speed,
      burstTurn: objective.burst_turn,
      burstEra: objective.burst_era,
      constraints,
    },
    path: { onPath, detour, dead },
    budget,
    supply,
    cut,
    scenario,
    robustness,
    eras,
  };
}

/**
 * The answer-facing packet attached to `civi6_plan(view='focus')`.
 *
 * Why it exists: the plan layer says "what to build and when", but the answer
 * still needs the official text of the uniques/beliefs/policies it mentions.
 * Without it the model re-discovers them with search/SQL and then spends tens
 * of thousands of reasoning tokens reconciling partial payloads. The brief
 * inlines the evidence, the mechanics the data layer does model, the remaining
 * gaps, the answer outline and the explicitly unmodelled topics.
 */
const BRIEF_MAX_EVIDENCE = 20;
const BRIEF_EVIDENCE_KINDS = new Set([
  "unit",
  "building",
  "district",
  "resource",
  "policy",
  "government",
  "belief",
  "promotion",
  "improvement",
  "trait",
  "governor_promotion",
]);
const BRIEF_UNKNOWN_DEFAULTS = [
  { topic: "黄金时代决议（Dedications）", status: "unmodeled" },
  { topic: "其他规则集（原版/其他 mod）的数值", status: "out_of_ruleset" },
];
const BRIEF_OUTLINE = [
  {
    id: "constraints",
    title: "约束方程",
    cite: ["budget[].era", "budget[].metric", "budget[].required", "budget[].supply", "budget[].gap", "budget[].perTurn"],
  },
  { id: "supply", title: "供给计划", cite: ["supply[].id", "supply[].kind", "supply[].perTurn", "supply[].fromTurn", "evidence[]"] },
  { id: "cut", title: "砍单", cite: ["cut[].rank", "cut[].ref", "cut[].saves", "cut[].lose", "cut[].slipTurns"] },
  { id: "scenario", title: "情景", cite: ["scenario[]", "robustness[]"] },
  { id: "path", title: "路径", cite: ["path.onPath", "path.detour", "path.dead[].why"] },
  { id: "acceptance", title: "验收", cite: ["eras[].items[].checkpoint", "eras[].items[].abandonIf"] },
];

function briefEvidenceCard(ctx, kind, id) {
  if (!hasTable(ctx, "effect_cards")) return null;
  return q1(ctx, `SELECT description_zh, effects_json, attributes_json, unresolved_json FROM effect_cards WHERE card_id = ?;`, `${kind}:${id}`);
}

function briefOutlineMarkdown(payload, evidence) {
  const lines = [];
  if (evidence.length) {
    lines.push("## 0. 机制速查（可并入第 2/5 段；正文逐字引用 brief.evidence[].effects）");
    for (const e of evidence) lines.push(`- ${e.name_zh}（${e.kind}:${e.id}）`);
  }
  lines.push("## 1. 约束方程");
  const budgets = [...(payload.budget ?? [])].sort((a, b) => b.gap - a.gap);
  for (const b of budgets) {
    lines.push(
      `- ${b.era} ${b.metric}：required ${b.required} / supply ${b.supply} / gap ${b.gap} / perTurn ${JSON.stringify(b.perTurn)}`,
    );
  }
  lines.push("## 2. 供给计划");
  for (const s of payload.supply ?? []) {
    lines.push(
      `- ${s.kind}:${s.ref}（${s.name_zh ?? s.ref}）${s.perTurn}/回合，T${s.fromTurn} 到位（${s.copies} 份）`,
    );
  }
  lines.push("## 3. 砍单");
  if (!(payload.cut ?? []).length) lines.push("- 无 gap>0，无需砍单");
  for (const c of payload.cut ?? []) {
    lines.push(`- #${c.rank} ${c.ref}：省 ${JSON.stringify(c.saves)}，代价 ${c.lose}，推迟 ${c.slipTurns} 回合`);
  }
  lines.push("## 4. 情景");
  for (const s of payload.scenario ?? []) lines.push(`- ${s.id}：${s.label}（feasible=${s.feasible}）`);
  const invariants = (payload.robustness ?? []).filter((r) => r.invariant).map((r) => r.ref);
  lines.push(`- invariant：${invariants.join("、") || "无"}`);
  lines.push("## 5. 路径");
  lines.push(`- onPath：${(payload.path?.onPath ?? []).map((n) => `${n.kind}:${n.id}`).join(" → ")}`);
  lines.push(`- detour：${(payload.path?.detour ?? []).map((n) => n.id).join("、") || "无"}`);
  for (const d of payload.path?.dead ?? []) lines.push(`- dead ${d.id}：${d.why}`);
  lines.push("## 6. 验收");
  for (const era of payload.eras ?? []) {
    for (const item of era.items ?? []) {
      lines.push(`- ${era.era}：${item.action?.label ?? item.action?.id} → ${item.checkpoint ?? "无 checkpoint"}`);
    }
  }
  return lines.join("\n");
}

function buildBrief(ctx, objective, payload, civ) {
  const capsule = parseJson(objective.win_capsule, {}) ?? {};
  const wanted = [];
  const seen = new Set();
  const add = (kind, id, why, priority) => {
    if (!kind || !id) return;
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    wanted.push({ kind, id, why: why ?? null, priority, authored: priority === 0 });
  };

  for (const item of Array.isArray(capsule.evidence) ? capsule.evidence : []) {
    add(item?.kind, item?.id, item?.why, 0);
  }
  if (civ) {
    for (const id of parseJsonArray(civ.unique_unit)) add("unit", id, null, 1);
    for (const id of parseJsonArray(civ.unique_building)) add("building", id, null, 1);
    for (const id of parseJsonArray(civ.unique_district)) add("district", id, null, 1);
    for (const id of parseJsonArray(civ.unique_improvement)) add("improvement", id, null, 1);
    for (const id of parseJsonArray(civ.trait_ids)) add("trait", id, null, 2);
  }
  for (const source of payload.supply ?? []) {
    const kind = source.kind === "governor" ? "governor_promotion" : source.kind;
    add(kind, source.ref, "供给来源", 3);
  }
  for (const node of [...(payload.path?.onPath ?? []), ...(payload.path?.detour ?? [])]) {
    if (BRIEF_EVIDENCE_KINDS.has(node.kind)) add(node.kind, node.id, null, 4);
  }

  const ordered = wanted.slice().sort((a, b) => a.priority - b.priority);
  const selected = ordered.slice(0, BRIEF_MAX_EVIDENCE);
  const omitted = ordered.slice(BRIEF_MAX_EVIDENCE).map((w) => `${w.kind}:${w.id}`);

  const evidence = selected.map((w) => {
    const card = briefEvidenceCard(ctx, w.kind, w.id);
    const effects = card ? parseJsonArray(card.effects_json) : [];
    const texts = effects.map((e) => e.text_zh ?? e.text_en).filter(Boolean);
    const attributes = card ? parseJsonArray(card.attributes_json) : [];
    const unresolved = card ? parseJsonArray(card.unresolved_json) : [];
    return {
      kind: w.kind,
      id: w.id,
      name_zh: entityLabel(ctx, w.kind, w.id),
      why: w.why,
      effects: texts.slice(0, 3),
      attributes: attributes.slice(0, 6).map((a) => ({
        key: a.key,
        label_zh: a.label_zh,
        value: a.value,
        unit: a.unit,
      })),
      authority: effects[0]?.authority ?? null,
      dataGap: !card || !texts.length,
      authored: w.authored,
      ...(unresolved.length ? { unresolvedCount: unresolved.length } : {}),
    };
  });
  // Auto-derived traits/buildings without official text (internal traits) are
  // noise; only authored gaps become work for the model.
  const textless = evidence.filter((e) => e.dataGap && !e.authored).map((e) => `${e.kind}:${e.id}`);
  const usableEvidence = evidence.filter((e) => !e.dataGap || e.authored);
  const missing = usableEvidence.filter((e) => e.dataGap).map((e) => `${e.kind}:${e.id}`);

  const mechanics = {};
  if (hasTable(ctx, "kb_speed_profile")) {
    const row = q1(ctx, `SELECT speed, total_turns, cost_multiplier FROM kb_speed_profile WHERE speed = ?;`, objective.speed);
    if (row) mechanics.speed = { totalTurns: row.total_turns, costMultiplier: row.cost_multiplier };
  }
  if (hasTable(ctx, "BeliefClasses")) {
    const rows = q(
      ctx,
      `SELECT BeliefClassType, Name, MaxInReligion, AdoptionOrder FROM BeliefClasses
        ORDER BY AdoptionOrder, BeliefClassType;`,
    );
    const zh = localizeMany(ctx, rows.map((r) => r.Name).filter(Boolean), "zh_Hans_CN");
    mechanics.beliefClasses = rows.map((r) => ({
      class: r.BeliefClassType,
      name_zh: zh(r.Name) ?? r.BeliefClassType,
      maxInReligion: r.MaxInReligion,
      adoptionOrder: r.AdoptionOrder,
    }));
  }
  if (hasTable(ctx, "Eras")) {
    mechanics.greatPersonBaseCost = q(
      ctx,
      `SELECT EraType, GreatPersonBaseCost FROM Eras
        WHERE GreatPersonBaseCost IS NOT NULL ORDER BY ChronologyIndex;`,
    ).map((r) => ({ era: r.EraType, cost: r.GreatPersonBaseCost }));
  }
  const districtIds = uniq(
    [...(payload.path?.onPath ?? []), ...(payload.path?.detour ?? [])]
      .filter((n) => n.kind === "district")
      .map((n) => n.id),
  );
  if (districtIds.length && hasTable(ctx, "Projects")) {
    const projects = selectIn(
      ctx,
      (ph) => `SELECT ProjectType, Name, Cost, PrereqDistrict FROM Projects
                WHERE PrereqDistrict IN (${ph}) ORDER BY Cost, ProjectType;`,
      districtIds,
    );
    if (projects.length) {
      const gpp = hasTable(ctx, "Project_GreatPersonPoints")
        ? selectIn(
            ctx,
            (ph) => `SELECT ProjectType, GreatPersonClassType, Points FROM Project_GreatPersonPoints
                      WHERE ProjectType IN (${ph});`,
            projects.map((p) => p.ProjectType),
          )
        : [];
      const byProject = groupBy(gpp, "ProjectType");
      const tags = projects.map((p) => p.Name ?? `LOC_PROJECT_${p.ProjectType}_NAME`);
      const zh = localizeMany(ctx, tags, "zh_Hans_CN");
      mechanics.districtProjects = projects.map((p, i) => ({
        id: p.ProjectType,
        name_zh: zh(tags[i]) ?? p.ProjectType,
        cost: p.Cost ?? null,
        district: p.PrereqDistrict ?? null,
        greatPersonPoints: (byProject.get(p.ProjectType) ?? []).map((g) => ({
          class: g.GreatPersonClassType,
          points: g.Points,
        })),
      }));
    }
  }

  const groups = [];
  if (missing.length) {
    const byKind = new Map();
    for (const key of missing) {
      const [kind, ...rest] = key.split(":");
      const id = rest.join(":");
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push(id);
    }
    groups.push({
      id: "evidenceGaps",
      parallel: true,
      calls: [...byKind.entries()].map(([kind, ids]) => ({
        tool: "civi6_entity",
        args: { type: kind, ids },
      })),
    });
  }

  const unknowns = [];
  const pushUnknown = (topic, status) => {
    if (!topic || unknowns.some((u) => u.topic === topic)) return;
    unknowns.push({ topic, status });
  };
  for (const item of BRIEF_UNKNOWN_DEFAULTS) pushUnknown(item.topic, item.status);
  for (const topic of Array.isArray(capsule.unmodeled) ? capsule.unmodeled : []) pushUnknown(topic, "unmodeled");
  for (const e of usableEvidence) {
    if (e.dataGap) pushUnknown(`${e.kind}:${e.id} 无已解析效果文本`, "unresolved");
  }

  const omittedAll = [...omitted, ...textless];
  return {
    coverage: {
      complete: groups.length === 0 && usableEvidence.length > 0,
      evidence: usableEvidence.length,
      missing,
      ...(omittedAll.length ? { omitted: omittedAll } : {}),
    },
    evidence: usableEvidence,
    mechanics,
    workPlan: {
      groups,
      maxExtraCalls: groups.length ? 1 : 0,
      stopRule: "coverage.complete=true → 直接作答，不再调用 search/entity/entities/sql/schema",
    },
    outline: BRIEF_OUTLINE,
    outlineMarkdown: briefOutlineMarkdown(payload, usableEvidence),
    unknowns,
  };
}

function round1(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

/**
 * Authored objectives keep the assumptions of the plan they were derived from
 * (`speed: "standard"`) while their burst turn is already scaled to the
 * requested speed. Surface both facts instead of handing the model a header
 * that says "standard" next to an online burst turn.
 */
function normalizeObjectiveAssumptions(objective) {
  const assumptions = parseJson(objective.assumptions, {}) ?? {};
  if (assumptions.speed && assumptions.speed !== objective.speed) {
    assumptions.basisSpeed = assumptions.speed;
    assumptions.speed = objective.speed;
  }
  return assumptions;
}

/** Header for an objective-scoped response. Never mixes in the generic plan. */
function objectiveHeader(ctx, objective, victory, source, difficulty) {
  const speedProfile = hasTable(ctx, "kb_speed_profile")
    ? q1(
        ctx,
        `SELECT speed, total_turns, cost_multiplier FROM kb_speed_profile WHERE speed = ?;`,
        objective.speed,
      )
    : null;
  return {
    id: objective.objective_id,
    victory,
    source,
    civ: objective.civ_id ?? null,
    leader: objective.leader_id ?? null,
    speed: objective.speed,
    burstTurn: objective.burst_turn,
    burstEra: objective.burst_era,
    difficulty: difficulty ?? null,
    summary: objective.title ?? null,
    assumptions: normalizeObjectiveAssumptions(objective),
    confidence: objective.confidence ?? null,
    sourceFlag: objective.source_flag ?? "rule",
    ...(speedProfile
      ? {
          speedProfile: {
            totalTurns: speedProfile.total_turns,
            costMultiplier: speedProfile.cost_multiplier,
            note: "costMultiplier is a percentage of standard cost (online=50).",
          },
        }
      : {}),
  };
}

function planResult(ctx, source, opts) {
  if (!hasKb(ctx)) {
    throw new Error(
      "决策层尚未构建（缺少 kb_* 表）。请运行 `npm run kb:build` 或重新执行 `npm run build`。",
    );
  }
  const victory = String(opts.victory ?? "").trim().toLowerCase();
  if (!PLAN_VICTORIES.includes(victory)) {
    throw new Error(`unknown victory "${opts.victory}" (expected ${PLAN_VICTORIES.join(" / ")})`);
  }
  const planId = `${victory}:${source}`;
  const plan = q1(ctx, `SELECT * FROM kb_plan WHERE plan_id = ?;`, planId);
  if (!plan) throw new Error(`未找到计划 ${planId}；可先运行 npm run kb:build`);

  const speedArg = String(opts.speed ?? "").trim().toLowerCase();
  if (speedArg && !["standard", "online"].includes(speedArg)) {
    throw new Error(`unknown speed "${opts.speed}" (expected standard/online)`);
  }
  const speed = speedArg || "standard";

  let detail = opts.detail === "full" ? "full" : "summary";
  let view = String(opts.view ?? "").trim().toLowerCase();
  const eraId = normalizePlanEra(opts.era);
  if (opts.era && String(opts.era).toLowerCase() !== "burst" && !eraId) {
    throw new Error(`unknown era "${opts.era}" (expected burst/ancient/.../information or ERA_*)`);
  }
  if (!view) view = eraId ? "ladder" : "burst";
  if (!["burst", "ladder", "check", "civ", "focus", "all"].includes(view)) {
    throw new Error(`unknown view "${opts.view}" (expected burst/ladder/check/civ/focus/all)`);
  }
  // `all` is a convenience view; keep it summary-sized. Use one view at a time
  // for formula/provenance detail.
  if (view === "all" && detail === "full") detail = "summary";

  const civ = resolveCiv(ctx, source, opts.civ, opts.leader);
  const objective = loadObjective(ctx, victory, civ, opts.leader, speed);
  let targets = [];
  if (view === "burst" || view === "all") {
    targets = targets.concat(loadPlanTargets(ctx, planId, "burst"));
  }
  if (view === "ladder" || view === "all") {
    targets = targets.concat(loadPlanTargets(ctx, planId, "era", eraId));
  }
  const baseTargets = targets.map((t) => ({ ...t }));
  const civApplied = applyCivToTargets(ctx, source, baseTargets, civ, victory);

  const basePlan = {
    id: plan.plan_id,
    victory,
    source,
    // The generic plan is authored at standard speed; `query.speed` says what
    // the caller asked for. Never relabel the base plan as the requested speed.
    speed: plan.speed ?? "standard",
    difficulty: plan.difficulty,
    burstTurn: plan.burst_turn,
    burstEra: plan.burst_era,
    summary: plan.summary,
    assumptions: parseJson(plan.assumptions, {}),
  };
  // An objective-scoped response must not carry a second, contradictory header
  // (base plan T235 vs objective T65); the base plan only survives as a label.
  const speedProfileRow = hasTable(ctx, "kb_speed_profile")
    ? q1(
        ctx,
        `SELECT speed, total_turns, cost_multiplier FROM kb_speed_profile WHERE speed = ?;`,
        speed,
      )
    : null;
  const out = {
    plan: objective ? objectiveHeader(ctx, objective, victory, source, plan.difficulty) : basePlan,
    query: {
      view,
      era: eraId,
      detail,
      speed,
      ...(speedProfileRow
        ? {
            speedProfile: {
              totalTurns: speedProfileRow.total_turns,
              costMultiplier: speedProfileRow.cost_multiplier,
            },
          }
        : {}),
    },
  };
  if (objective && (view === "burst" || view === "all")) {
    // The generic plan is a label for the horizontal slice; a focus/check/ladder
    // answer is fully described by the objective header.
    out.basePlan = {
      id: basePlan.id,
      burstTurn: basePlan.burstTurn,
      burstEra: basePlan.burstEra,
      summary: basePlan.summary,
    };
  }

  if (view === "focus") {
    if (!objective) {
      throw new Error(
        `没有 ${victory} / ${speed} 的目标层（kb/objectives）。` +
          `可用 view='ladder' 看通用时代阶梯，或先为目标文明补 kb/objectives 数据。`,
      );
    }
    const payload = objectivePayload(ctx, objective);
    out.objective = payload.objective;
    out.path = payload.path;
    out.budget = payload.budget;
    out.supply = payload.supply;
    out.cut = payload.cut;
    out.scenario = payload.scenario;
    out.robustness = payload.robustness;
    out.eras = payload.eras;
    // Self-sufficient answer packet: evidence + mechanics + remaining gaps +
    // outline + explicit unknowns. This is what removes the 20+ exploratory
    // calls and the final-step re-derivation.
    out.brief = buildBrief(ctx, objective, payload, civ);
    out.checks = q(
      ctx,
      `SELECT era_id, turn_lo, turn_hi, dimension_id, value_lo, value_hi, message, remedy, severity
         FROM kb_check WHERE plan_id = ? ORDER BY priority, turn_lo LIMIT 6;`,
      planId,
    ).map(shapeCheck);
  } else if (objective) {
    // Every other view carries the constraint summary so the answer can cite
    // constraint ids without a second call.
    out.objective = {
      id: objective.objective_id,
      title: objective.title,
      burstTurn: objective.burst_turn,
      burstEra: objective.burst_era,
      constraints: q(
        ctx,
        `SELECT * FROM kb_constraint WHERE objective_id = ?
          ORDER BY COALESCE(binding_rank, 99) LIMIT 6;`,
        objective.objective_id,
      ).map(shapeConstraint),
    };
  }

  if (view === "burst" || view === "all") {
    const allBurstTargets = civApplied.targets.filter((t) => t.slice_kind === "burst");
    const isClosure = (t) => typeof t.rationale === "string" && t.rationale.includes("前置闭包");
    const closureTargets = allBurstTargets.filter(isClosure);
    const closureCounts = {
      tech: closureTargets.filter((t) => t.category === "tech").length,
      civic: closureTargets.filter((t) => t.category === "civic").length,
    };
    const burstTargets = allBurstTargets.filter((t) => !isClosure(t));
    const blocking = burstTargets.filter((t) => t.role === "blocking").map((t) => shapeTarget(t, detail));
    const enabling = burstTargets.filter((t) => t.role === "enabling").map((t) => shapeTarget(t, detail));
    const support = burstTargets.filter((t) => t.role === "support" || t.role === "optional").map((t) => shapeTarget(t, detail));
    out.burst = {
      summary: plan.summary,
      blocking,
      enabling,
      support,
      closureCounts,
      ...(detail === "full"
        ? {
            closure: closureTargets.map((t) => ({
              category: t.category,
              id: t.entity_id,
              label: t.label_zh,
            })),
          }
        : {}),
      budgets: loadBudgets(ctx, planId, "burst").map(shapeBudget),
      checks: q(
        ctx,
        `SELECT era_id, turn_lo, turn_hi, dimension_id, value_lo, value_hi, message, remedy, severity
           FROM kb_check WHERE plan_id = ? ORDER BY priority, turn_lo LIMIT 8;`,
        planId,
      ).map(shapeCheck),
    };
  }

  if (view === "ladder" || view === "all") {
    const eraTargets = civApplied.targets.filter((t) => t.slice_kind === "era");
    const eras = new Map();
    for (const t of eraTargets) {
      const key = t.era_id;
      if (!eras.has(key)) {
        eras.set(key, {
          era: key,
          turn: [t.turn_lo, t.turn_hi],
          metrics: [],
          entities: {},
        });
      }
      const entry = eras.get(key);
      if (t.dimension_id) {
        entry.metrics.push({
          dimension: t.dimension_id,
          band: [t.value_lo, t.value_hi],
          role: t.role,
        });
      } else {
        const cat = t.category;
        if (!entry.entities[cat]) entry.entities[cat] = [];
        entry.entities[cat].push({ id: t.entity_id, label: t.label_zh, qty: t.value_num ?? 1 });
      }
    }
    out.ladder = [...eras.values()];
    if (view === "ladder" && eraId) {
      out.ladder = out.ladder.filter((e) => e.era === eraId);
    }
    out.budgets = loadBudgets(ctx, planId, "era", eraId).map((b) => ({ ...shapeBudget(b), era: b.era_id }));
  }

  if (view === "check" || view === "all") {
    out.checks = q(
      ctx,
      `SELECT era_id, turn_lo, turn_hi, dimension_id, value_lo, value_hi, message, remedy, severity
         FROM kb_check WHERE plan_id = ? ORDER BY priority, turn_lo LIMIT ${view === "check" ? 400 : 8};`,
      planId,
    ).map(shapeCheck);
  }

  if (civ) {
    out.civ = {
      id: civ.civ_id,
      leader: civ.leader_id || null,
      name: civ.name_zh,
      summary: civ.summary,
      supportedVictories: parseJsonArray(civ.supported_victories),
      playstyleTags: parseJsonArray(civ.playstyle_tags),
      uniques: {
        units: parseJsonArray(civ.unique_unit),
        buildings: parseJsonArray(civ.unique_building),
        districts: parseJsonArray(civ.unique_district),
        improvements: parseJsonArray(civ.unique_improvement),
      },
      appliedDeltas: civApplied.applied,
      notes: civApplied.notes,
      deltas: civDeltas(ctx, source, victory, civ).slice(0, 20).map((d) => ({
        op: d.op,
        ref: parseJson(d.target_ref, {}),
        value: d.value_num ?? d.value_text ?? null,
        era: d.era_id,
        reason: d.reason,
      })),
      unmatched: civApplied.unmatched,
    };
  } else if (opts.civ || opts.leader) {
    out.civ = { found: false, query: opts.civ || opts.leader };
  }

  const objectiveRefs = out.path
    ? [...out.path.onPath, ...out.path.detour].map((n) => n.id)
    : [];
  out.refs = uniq([
    ...objectiveRefs,
    ...civApplied.targets.filter((t) => t.entity_id).map((t) => t.entity_id),
  ]).slice(0, 80);
  // Derivations belong to the generic plan (`domination:bbg`). Attaching them to
  // an objective-scoped focus response used to push the payload over budget,
  // after which the trimming logic halved `path.onPath` and hid half the civic
  // chain. Keep them only where the generic plan is what the caller asked for.
  if (detail === "full" && (!objective || view === "burst" || view === "all")) {
    out.derivations = q(
      ctx,
      `SELECT slice_kind, era_id, output_dimension_id, expression, value, unit, confidence
         FROM kb_derivation WHERE plan_id = ? ORDER BY slice_kind, era_id, derivation_id LIMIT 40;`,
      planId,
    ).map((d) => ({
      slice: d.slice_kind,
      era: d.era_id,
      dimension: d.output_dimension_id,
      expression: d.expression,
      value: d.value,
      unit: d.unit,
      confidence: d.confidence,
    }));
  }

  const visibleBurst = out.burst
    ? out.burst.blocking.length + out.burst.enabling.length + out.burst.support.length
    : 0;
  const visibleLadder = out.ladder
    ? out.ladder.reduce((sum, e) => sum + e.metrics.length + Object.values(e.entities).reduce((n, arr) => n + arr.length, 0), 0)
    : 0;
  out.counts = {
    targets: visibleBurst + visibleLadder,
    blocking: out.burst?.blocking.length ?? 0,
    enabling: out.burst?.enabling.length ?? 0,
    ...(out.path
      ? {
          onPath: out.path.onPath.length,
          detour: out.path.detour.length,
          dead: out.path.dead.length,
          focus: out.eras?.reduce((sum, e) => sum + e.items.length, 0) ?? 0,
        }
      : {}),
  };
  return out;
}

// ---------------------------------------------------------------------------
// Knowledge base facade
// ---------------------------------------------------------------------------
/**
 * Default meta is a ruleset + coverage summary, not a build log. The per-DLC
 * load order and the skipped-file list were ~5.5k of the 8k payload the model
 * had to read just to learn "bbg / locked".
 */
function slimBuild(build) {
  if (!build || typeof build !== "object") return build;
  const { loadOrder, ...rest } = build;
  if (rest.bbg && typeof rest.bbg === "object") {
    const { skipped, warnings, files, statements, textEntries, ...bbg } = rest.bbg;
    rest.bbg = bbg;
  }
  return rest;
}

export function createKnowledgeBase(dbPath, sourceName = "vanilla") {
  if (!isAbsolute(dbPath)) dbPath = resolve(dbPath);
  let stat = null;
  try {
    stat = statSync(dbPath);
  } catch {
    stat = null;
  }
  if (!stat?.isFile()) {
    throw new Error(
      `civi6-kb: database file not found: ${dbPath}` +
        (stat?.isDirectory() ? " (that path is a directory; point at .../data/civi6.sqlite)" : ""),
    );
  }
  const ctx = createContext(new DatabaseSync(dbPath, { readOnly: true }));

  function meta(opts = {}) {
    const buildRow = q1(ctx, "SELECT value FROM _meta WHERE key = 'build';");
    let build = null;
    if (buildRow?.value) {
      try {
        build = JSON.parse(String(buildRow.value));
      } catch {
        build = String(buildRow.value);
      }
    }

    if (!ctx.statsCache && hasTable(ctx, "_meta")) {
      const statsRow = q1(ctx, `SELECT value FROM _meta WHERE key = 'stats';`);
      if (statsRow?.value) {
        try {
          ctx.statsCache = JSON.parse(String(statsRow.value));
        } catch {
          ctx.statsCache = null;
        }
      }
    }

    const stats = ctx.statsCache;
    // Entity-type inventory is a maintenance view now that the per-entity tool is
    // gone; the model-facing inventory is `civi6_instance` → core.manifest.
    let entityTypes = null;
    if (opts.verbose) {
      entityTypes =
        stats?.entityTypes?.map((t) => ({ ...t })) ??
        SPECS.map((s) => ({
          type: s.type,
          table: s.table,
          count: hasTable(ctx, s.table) ? (q1(ctx, `SELECT COUNT(*) AS n FROM "${s.table}";`)?.n ?? 0) : 0,
        }));
      // The cached stats blob predates any newly added entity type; never hide a
      // type the plugin can actually serve.
      const knownTypes = new Set(entityTypes.map((t) => t.type));
      for (const spec of SPECS) {
        if (knownTypes.has(spec.type)) continue;
        entityTypes.push({
          type: spec.type,
          table: spec.table,
          count: hasTable(ctx, spec.table) ? (q1(ctx, `SELECT COUNT(*) AS n FROM "${spec.table}";`)?.n ?? 0) : 0,
        });
      }
    }
    const tables = stats?.tables ?? [];

    const out = {
      build: opts.verbose ? build : slimBuild(build),
      dbFile: dbPath,
      dataSource: sourceName,
      locked: true,
      tableCount: tables.length || ctx.tables.size,
      searchDocs: stats?.searchDocs ?? indexMeta(ctx).docs ?? 0,
      searchIndex: postingsAvailable(ctx) ? "precomputed" : "in-memory",
      ...(entityTypes ? { entityTypes } : {}),
    };

    const rulesetRow = hasTable(ctx, "_meta")
      ? q1(ctx, `SELECT value FROM _meta WHERE key = 'ruleset';`)
      : undefined;
    out.ruleset = rulesetRow?.value ? parseJson(rulesetRow.value, null) : null;

    const effectsRow = hasTable(ctx, "_meta")
      ? q1(ctx, `SELECT value FROM _meta WHERE key = 'effects';`)
      : undefined;
    const effectMeta = effectsRow?.value ? parseJson(effectsRow.value, null) : null;
    const buildBuiltAt = typeof build === "object" && build ? build.builtAt ?? null : null;
    out.effectCoverage = effectMeta
      ? {
          schemaVersion: effectMeta.schemaVersion ?? null,
          builtAt: effectMeta.builtAt ?? null,
          rawBuiltAt: effectMeta.rawBuiltAt ?? null,
          cards: effectMeta.cards ?? 0,
          effects: effectMeta.effects ?? 0,
          resolved: effectMeta.resolved ?? 0,
          unresolved: effectMeta.unresolved ?? 0,
          modifierTexts: effectMeta.modifierTexts ?? 0,
          requirementTexts: effectMeta.requirementTexts ?? 0,
          stale: !!(buildBuiltAt && effectMeta.rawBuiltAt && effectMeta.rawBuiltAt !== buildBuiltAt),
          note: "unresolved = 没有本地化 Summary 的原始 Modifier，属于审计数据；不要当作玩家效果引用",
        }
      : null;

    if (hasKb(ctx)) {
      try {
        const bRow = q1(ctx, `SELECT value FROM _meta WHERE key = 'kb.build';`);
        const vRow = q1(ctx, `SELECT value FROM _meta WHERE key = 'kb.validation';`);
        const b = bRow?.value ? JSON.parse(String(bRow.value)) : {};
        const v = vRow?.value ? JSON.parse(String(vRow.value)) : {};
        const rawBuiltAt = b.rawBuiltAt ?? null;
        const buildBuiltAt = typeof build === "object" && build ? build.builtAt ?? null : null;
        out.kb = {
          schemaVersion: b.schemaVersion ?? null,
          builtAt: b.builtAt ?? null,
          rawBuiltAt,
          plans: b.plans ?? 0,
          targets: b.targets ?? 0,
          budgets: b.budgets ?? 0,
          checks: b.checks ?? 0,
          cards: b.cards ?? 0,
          civs: b.civs ?? 0,
          validationOk: v.ok ?? null,
          errors: v.errors ?? 0,
          warnings: v.warnings ?? 0,
          stale: !!(rawBuiltAt && buildBuiltAt && rawBuiltAt !== buildBuiltAt),
        };
      } catch {
        out.kb = null;
      }
    } else {
      out.kb = null;
    }
    if (hasTable(ctx, "kb_speed_profile")) {
      out.speedProfiles = q(
        ctx,
        `SELECT speed, label_zh, total_turns, cost_multiplier, source_table
           FROM kb_speed_profile ORDER BY total_turns;`,
      ).map((r) => ({
        speed: r.speed,
        label: r.label_zh,
        totalTurns: r.total_turns,
        costMultiplier: r.cost_multiplier,
        source: r.source_table,
        note: "costMultiplier is a percentage of standard cost (online=50).",
      }));
    }
    if (opts.verbose) out.tables = tables;
    return out;
  }

  return {
    db: ctx.db,
    ctx,

    /** Introspection for benchmarks/diagnostics: query count since the last reset. */
    stats() {
      return { queries: ctx.queries, cachedStatements: ctx.statements.size, localizedTags: ctx.locCache.size };
    },
    resetStats() {
      ctx.queries = 0;
    },

    meta,

    /** Structured decision slice: victory + era/civ -> targets, budgets, checks. */
    plan(opts = {}) {
      return planResult(ctx, sourceName, opts);
    },

    /**
     * One bounded data class of the objective-free instance packet. Pass
     * section:'all' only in tests to get every class merged (the model never
     * needs it: core + the classes the question touches are the contract).
     */
    instance(opts = {}) {
      const section = String(opts?.section ?? "core");
      if (section !== "all") return buildInstanceSection(ctx, opts ?? {}, section);
      const pages = INSTANCE_CLASSES.map((entry) => buildInstanceSection(ctx, opts ?? {}, entry.section));
      const merged = { ...pages[0], content: {} };
      for (const page of pages) {
        Object.assign(merged.content, page.content ?? {});
      }
      return merged;
    },

    /** Resolve a packet handle (u37 / t72 / gp9) to its entity id; QA/tests only. */
    entityFromHandle(value) {
      return entityIdFromHandle(ctx, value);
    },

    /** Deterministic formula scratchpad (no data fetch). */
    eval(opts = {}) {
      return buildEvalResult(ctx, opts ?? {});
    },

    search(query, opts = {}) {
      const results = postingsAvailable(ctx)
        ? searchDocsByPostings(ctx, query, opts)
        : searchDocsInMemory(ctx, query, opts);
      return { query, embedding: false, count: results.length, results };
    },

    listEntities(type, opts = {}) {
      return listEntities(ctx, type, opts);
    },

    entityDetail(type, id, opts = {}) {
      return getEntityDetail(ctx, type, id, opts);
    },

    /** Batch detail: accepts ids or names; ambiguous names come back as candidates. */
    entityMany(type, ids, opts = {}) {
      if (!specByType.has(type)) throw new Error(`unknown entity type: ${type}`);
      const items = [];
      const notFound = [];
      const matchedBy = {};
      for (const raw of ids.map((v) => String(v))) {
        let id = raw;
        let detail = getEntityDetail(ctx, type, id, opts);
        if (!detail) {
          const candidates = findEntityCandidates(ctx, type, raw);
          if (candidates.length === 1) {
            id = candidates[0].id;
            detail = getEntityDetail(ctx, type, id, opts);
          } else if (candidates.length > 1) {
            notFound.push({ id: raw, ambiguous: true, candidates: candidates.slice(0, 5) });
            continue;
          }
        }
        if (!detail) {
          notFound.push({ id: raw });
          continue;
        }
        if (id !== raw) matchedBy[id] = raw;
        items.push(detail);
      }
      const out = { type, count: items.length, items };
      if (notFound.length) out.notFound = notFound;
      if (Object.keys(matchedBy).length) out.matchedBy = matchedBy;
      return out;
    },

    modifiers(type, id, opts = {}) {
      const spec = specByType.get(type);
      if (!spec) throw new Error(`unknown entity type: ${type}`);
      const all = resolveModifiers(ctx, collectModifierIds(ctx, spec, id));
      const offset = Math.max(Number(opts.offset) || 0, 0);
      const limit = clampInt(opts.limit, 50, 1, 200);
      const page = all.slice(offset, offset + limit);
      const out = { type, id, total: all.length, returned: page.length, offset, modifiers: page };
      if (offset + page.length < all.length) out.more = true;
      return out;
    },

    sql(sql, limit = 100) {
      const trimmed = (sql || "").trim();
      if (!trimmed) throw new Error("missing sql");
      if (!/^\s*(SELECT|WITH|EXPLAIN|PRAGMA)\b/i.test(trimmed)) {
        throw new Error("read-only mode: only SELECT/WITH/EXPLAIN/PRAGMA queries are allowed");
      }
      const body = trimmed.replace(/;+\s*$/, "");
      if (body.includes(";")) throw new Error("multiple statements are not allowed");
      const lim = clampInt(limit, 100, 1, 1000);
      const isSelectLike = /^(SELECT|WITH)\b/i.test(body);
      let finalSql = body;
      const params = [];
      if (isSelectLike && !/\bLIMIT\s+\d+\b/i.test(body)) {
        finalSql = `${body} LIMIT ?`;
        params.push(lim);
      }
      try {
        const rows = q(ctx, finalSql, ...params).map(compactRow);
        return { sql: trimmed, count: rows.length, rows };
      } catch (error) {
        // A missing table/column is a discovery question, not a dead end: the
        // caller gets candidates and columns and can fix the query next step.
        return sqlErrorPayload(ctx, trimmed, error);
      }
    },

    /** Table/view catalog: names, row counts and column names for SQL writing. */
    schema(opts = {}) {
      const limit = clampInt(opts.limit, 8, 1, 40);
      const term = String(opts.q ?? "").trim();
      const columnsOf = (table) =>
        q(ctx, `PRAGMA table_info("${table}");`).map((c) => ({
          name: c.name,
          type: c.type || null,
          pk: !!c.pk,
        }));
      const rowCount = (table) => q1(ctx, `SELECT COUNT(*) AS n FROM "${table}";`)?.n ?? 0;
      if (!term) {
        const rows = q(
          ctx,
          `SELECT name, type FROM sqlite_master WHERE type IN ('table','view')
            ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name LIMIT 20;`,
        );
        return {
          query: null,
          count: rows.length,
          tables: rows.map((r) => ({ name: r.name, type: r.type, rows: rowCount(r.name) })),
          note: "shortlist only; pass q to get columns (table-name matches get full columns, column matches get only the matched columns).",
        };
      }

      const like = `%${term}%`;
      const lower = term.toLowerCase();
      const tables = [];
      const seen = new Set();
      const nameRows = q(
        ctx,
        `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name LIKE ?
          ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name LIMIT ?;`,
        like,
        limit,
      );
      for (const r of nameRows) {
        if (tables.length >= limit) break;
        seen.add(r.name);
        tables.push({ name: r.name, type: r.type, rows: rowCount(r.name), columns: columnsOf(r.name) });
      }
      // Column-first lookup: "where is ResourceCost?" must not require a second
      // PRAGMA round trip. Only the matched columns are returned for these.
      if (tables.length < limit) {
        const sqlRows = q(
          ctx,
          `SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE ? ORDER BY name LIMIT 30;`,
          like,
        );
        for (const r of sqlRows) {
          if (tables.length >= limit) break;
          if (seen.has(r.name)) continue;
          const matchedColumns = columnsOf(r.name).filter((c) => c.name.toLowerCase().includes(lower));
          if (!matchedColumns.length) continue;
          seen.add(r.name);
          tables.push({ name: r.name, type: "table", rows: rowCount(r.name), matchedColumns });
        }
      }
      return {
        query: term,
        count: tables.length,
        tables,
        note: "table-name matches show full columns; column matches show only matchedColumns. Use civi6_sql once the name is known.",
      };
    },

    close() {
      ctx.statements.clear();
      ctx.locCache.clear();
      ctx.db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TYPE_ENUM = ENTITY_TYPES;
const LANG_ENUM = ["zh_Hans_CN", "en_US"];
const BELIEF_CLASSES = [
  "BELIEF_CLASS_PANTHEON",
  "BELIEF_CLASS_FOUNDER",
  "BELIEF_CLASS_FOLLOWER",
  "BELIEF_CLASS_WORSHIP",
  "BELIEF_CLASS_ENHANCER",
];

/**
 * Make a payload lossless-JSON safe: `undefined` properties are removed and
 * non-finite numbers become null. The host rejects tool output that contains
 * `undefined`, which is how `civi6_plan(view='check')` failed on any row whose
 * `remedy` was NULL.
 */
function sanitizeJson(value) {
  if (value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeJson);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    out[key] = sanitizeJson(child);
  }
  return out;
}

function jsonLength(value) {
  return JSON.stringify(value).length;
}

/**
 * Attach the budget report. `dropped` names every field that was compacted so
 * the model can ask for it back explicitly; `recover` is the parameter that
 * actually exists on the tool that produced the payload.
 */
function finalizePayload(value, { budget, dropped, recover }) {
  if (dropped.length) {
    value._budget = {
      limit: budget,
      dropped: [...new Set(dropped)],
      recover,
    };
  }
  const text = JSON.stringify(value);
  if (text.length <= budget) return text;
  value._budget = {
    ...(value._budget ?? {}),
    over: true,
    note:
      `载荷 ${text.length} 字符，超过预算 ${budget}；已无可丢弃的审计字段，` +
      `不再裁剪请求的数据。${recover}`,
  };
  return JSON.stringify(value);
}

/**
 * Serialize within `budget` without losing caller-requested data.
 *
 * `compact(clone, level)` is supplied by each tool and must only remove
 * audit/repeated fields, never whole requested items. Levels are cumulative.
 */
function fitPayload(value, opts = {}) {
  const budget = opts.budget ?? MAX_OUTPUT_CHARS;
  const clean = sanitizeJson(value);
  let text = JSON.stringify(clean);
  if (text.length <= budget) return text;
  if (!opts.compact) {
    return finalizePayload(clean, { budget, dropped: ["payload over budget"], recover: opts.recover ?? "" });
  }
  const clone = JSON.parse(text);
  const dropped = [];
  for (let level = 1; level <= 3; level++) {
    dropped.push(...(opts.compact(clone, level) ?? []));
    // Reserve room for the `_budget` report itself (~0.5k): the report must not
    // be what pushes an otherwise-fitting payload over the limit.
    if (jsonLength(clone) <= budget - 900) break;
  }
  return finalizePayload(clone, { budget, dropped, recover: opts.recover ?? "" });
}

function textBlock(value, def) {
  return [
    {
      type: "text",
      text: fitPayload(value, {
        budget: def?.budget ?? MAX_OUTPUT_CHARS,
        compact: def?.compact,
        recover: def?.recover,
      }),
    },
  ];
}

/**
 * Per-session work budget, set by a complete `civi6_plan(view='focus')` brief.
 * It is a visible counter, not a gate: every follow-up tool result carries
 * `_workBudget` so the model can see how far past the plan it is. A hard gate
 * is intentionally left out until a probe shows the counter is ignored.
 */
let WORK_STATE = null;

function workBudgetNote() {
  if (!WORK_STATE?.complete) return null;
  const softCap = WORK_STATE.maxExtraCalls + 2;
  const remaining = Math.max(0, softCap - WORK_STATE.extraCalls);
  return {
    extraCalls: WORK_STATE.extraCalls,
    remaining,
    note:
      remaining > 0
        ? "brief.coverage.complete；除非 workPlan.groups 要求，直接作答。"
        : "brief 已完整覆盖；请停止取数，按 brief.outlineMarkdown 作答。",
  };
}

function makeTool(def) {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => textBlock(value, def),
    },
    async execute(args) {
      const value = sanitizeJson(await def.execute(args ?? {}));
      if (
        WORK_STATE?.complete &&
        !["civi6_plan", "civi6_meta"].includes(def.name) &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        WORK_STATE.extraCalls += 1;
        value._workBudget = workBudgetNote();
      }
      return value;
    },
  };
}

function asItems(value) {
  if (Array.isArray(value?.items)) return value.items;
  return value && typeof value === "object" ? [value] : [];
}

/** Entity payload compaction: audit fields and repeated rows go before items. */
function compactEntityPayload(value, level) {
  const dropped = [];
  for (const item of asItems(value)) {
    if (!item || typeof item !== "object") continue;
    if (level === 1) {
      for (const key of ["coverage", "unresolved", "unresolvedCount", "effectBuiltAt", "rulesetId"]) {
        if (key in item) {
          delete item[key];
          dropped.push(`items[].${key}`);
        }
      }
      for (const effect of item.effects ?? []) {
        if (effect.source) delete effect.source;
        if (effect.text_en) delete effect.text_en;
      }
      if (item.description && item.description === item.description_en) delete item.description;
      if (item.related && typeof item.related === "object") {
        for (const [table, rows] of Object.entries(item.related)) {
          if (Array.isArray(rows) && rows.length > 3) {
            item.related[table] = rows.slice(0, 3);
            dropped.push(`related.${table}>3`);
          }
        }
      }
      if (Array.isArray(item.modifiers) && item.modifiers.length > 12) {
        item.modifiers = item.modifiers.slice(0, 12);
        dropped.push("modifiers>12");
      }
    } else if (level === 2) {
      if (item.related && typeof item.related === "object") {
        for (const [table, rows] of Object.entries(item.related)) {
          if (Array.isArray(rows) && rows.length > 1) {
            item.related[table] = rows.slice(0, 1);
            dropped.push(`related.${table}>1`);
          }
        }
      }
      if (Array.isArray(item.effects) && item.effects.length > 4) {
        item.effects = item.effects.slice(0, 4);
        dropped.push("effects>4");
      }
      if (Array.isArray(item.modifiers) && item.modifiers.length > 4) {
        item.modifiers = item.modifiers.slice(0, 4);
        dropped.push("modifiers>4");
      }
      // Raw row and curated attributes overlap; keep the curated view only.
      if (item.row && Array.isArray(item.attributes) && item.attributes.length) {
        delete item.row;
        dropped.push("row");
      }
    } else if (level === 3) {
      if (Array.isArray(item.effects) && item.effects.length > 1) {
        item.effects = item.effects.slice(0, 1);
        dropped.push("effects>1");
      }
      if (Array.isArray(item.modifiers)) {
        delete item.modifiers;
        dropped.push("modifiers");
      }
      // `upgrade`/`resource`/`buildings` carry the relations the answer needs;
      // the raw related rows are audit data by this point.
      if (item.related) {
        delete item.related;
        dropped.push("related");
      }
      if (item.description_en) {
        delete item.description_en;
        dropped.push("description_en");
      }
    }
  }
  return dropped;
}

/** Plan payload compaction: provenance and duplicate headers go before facts. */
function compactPlanPayload(value, level) {
  const dropped = [];
  if (level === 1) {
    if (value.derivations) {
      delete value.derivations;
      dropped.push("derivations");
    }
    if (value.civ?.deltas?.length) {
      value.civ.deltas = [];
      dropped.push("civ.deltas");
    }
    if (Array.isArray(value.refs) && value.refs.length > 24) {
      value.refs = value.refs.slice(0, 24);
      dropped.push("refs>24");
    }
    for (const era of value.eras ?? []) {
      for (const item of era.items ?? []) {
        if (item.source !== undefined) {
          delete item.source;
          dropped.push("eras[].items[].source");
        }
      }
    }
    for (const c of value.objective?.constraints ?? []) {
      if (c.waivedBy !== undefined) {
        delete c.waivedBy;
        dropped.push("objective.constraints[].waivedBy");
      }
    }
  } else if (level === 2) {
    if (value.civ) {
      delete value.civ;
      dropped.push("civ");
    }
    if (Array.isArray(value.robustness) && value.robustness.length > 6) {
      value.robustness = value.robustness.slice(0, 6);
      dropped.push("robustness>6");
    }
    if (Array.isArray(value.path?.detour) && value.path.detour.length > 6) {
      value.path.detour = value.path.detour.slice(0, 6);
      dropped.push("path.detour>6");
    }
  } else if (level === 3) {
    if (value.basePlan) {
      delete value.basePlan;
      dropped.push("basePlan");
    }
    if (value.counts) {
      delete value.counts;
      dropped.push("counts");
    }
  }
  return dropped;
}

function compactSearchPayload(value, level) {
  const dropped = [];
  const results = value.results ?? [];
  let clipped = false;
  const clip = (rows) =>
    rows.map((r) => {
      if (r.snippet && r.snippet.length > 240) {
        clipped = true;
        return { ...r, snippet: `${r.snippet.slice(0, 240)}…` };
      }
      return r;
    });
  const caps = { 1: 10, 2: 6, 3: 3 };
  const cap = caps[level];
  value.results = clip(results).slice(0, cap);
  if (results.length > cap) dropped.push(`results>${cap}`);
  if (clipped) dropped.push("snippet>240");
  return dropped;
}

function compactRowsPayload(value, level) {
  const dropped = [];
  const caps = { 1: 50, 2: 20, 3: 5 };
  const cap = caps[level];
  if (Array.isArray(value.rows) && value.rows.length > cap) {
    value.rows = value.rows.slice(0, cap);
    dropped.push(`rows>${cap}`);
  }
  if (Array.isArray(value.modifiers) && value.modifiers.length > cap) {
    value.modifiers = value.modifiers.slice(0, cap);
    dropped.push(`modifiers>${cap}`);
  }
  return dropped;
}

function compactSchemaPayload(value, level) {
  const dropped = [];
  const caps = { 1: 20, 2: 10, 3: 5 };
  const cap = caps[level];
  if (Array.isArray(value.tables) && value.tables.length > cap) {
    value.tables = value.tables.slice(0, cap);
    dropped.push(`tables>${cap}`);
  }
  return dropped;
}

/** One place per tool family: budget, compaction ladder and recovery hint. */
const RENDER = {
  instance: {
    budget: TOOL_BUDGETS.instance,
    recover: "该类超过预算时 execute 会直接报错；按 kind 拆小再取，不要交给传输层截断。",
  },
  entity: {
    budget: TOOL_BUDGETS.entity,
    compact: compactEntityPayload,
    recover: "items are never dropped; ask again with effects:'none' or modifiers:'none', or split ids.",
  },
  plan: {
    budget: TOOL_BUDGETS.plan,
    compact: compactPlanPayload,
    recover: "Use detail:'summary' (complete) or view:'ladder' with era:'ancient'...'information'.",
  },
  search: {
    budget: TOOL_BUDGETS.search,
    compact: compactSearchPayload,
    recover: "Narrow with type or a shorter q, or lower limit.",
  },
  sql: {
    budget: TOOL_BUDGETS.sql,
    compact: compactRowsPayload,
    recover: "Add a WHERE clause or a smaller LIMIT.",
  },
  modifiers: {
    budget: TOOL_BUDGETS.entity,
    compact: compactRowsPayload,
    recover: "Page with offset/limit.",
  },
  schema: {
    budget: TOOL_BUDGETS.schema,
    compact: compactSchemaPayload,
    recover: "Narrow q or lower limit.",
  },
};

/**
 * Exported for scripts/verify-plugin.mjs: apply the same budget contract the
 * model sees, without needing a host tool context.
 */
export function renderToolPayload(kind, value) {
  const config = RENDER[kind];
  if (!config) return fitPayload(value);
  return fitPayload(value, config);
}

function metaTool(getKb) {
  return makeTool({
    name: "civi6_meta",
    description:
      "Active Civilization VI ruleset, build provenance, effect/formula coverage, and speedProfiles (total turns and cost multiplier per speed). Cheap; call once per session. The inventory of data classes and their sizes lives in `civi6_instance` → core.manifest, not here. Pass verbose:true only when you also need the full table list, the entity-type inventory and the build load order.",
    parameters: {
      type: "object",
      properties: {
        verbose: { type: "boolean", description: "Include the full table list with row counts." },
      },
      required: [],
    },
    execute: (args) => {
      assertNoSource(args);
      return getKb().meta({ verbose: args.verbose === true });
    },
  });
}

/**
 * Objective-free instance packet.
 *
 * Hard constraints (civ / leader / speed / difficulty) decide what is fetched;
 * the victory line never does. Everything choosable is listed once with its
 * executable formula summary, plus neutral indexes so the model can locate a
 * row by era / yield / district instead of reading all of them.
 */
const INSTANCE_KINDS = [
  { kind: "technology", handle: "t", table: "Technologies", pk: "TechnologyType", name: "Name", era: "EraType", cost: "Cost" },
  { kind: "civic", handle: "c", table: "Civics", pk: "CivicType", name: "Name", era: "EraType", cost: "Cost" },
  { kind: "building", handle: "b", table: "Buildings", pk: "BuildingType", name: "Name", era: null, cost: "Cost" },
  { kind: "district", handle: "d", table: "Districts", pk: "DistrictType", name: "Name", era: null, cost: "Cost" },
  { kind: "unit", handle: "u", table: "Units", pk: "UnitType", name: "Name", era: null, cost: "Cost" },
  { kind: "policy", handle: "p", table: "Policies", pk: "PolicyType", name: "Name", era: null, cost: null },
  { kind: "government", handle: "g", table: "Governments", pk: "GovernmentType", name: "Name", era: null, cost: null },
  { kind: "belief", handle: "bl", table: "Beliefs", pk: "BeliefType", name: "Name", era: null, cost: null },
  { kind: "improvement", handle: "i", table: "Improvements", pk: "ImprovementType", name: "Name", era: null, cost: null },
  { kind: "resource", handle: "r", table: "Resources", pk: "ResourceType", name: "Name", era: null, cost: null },
  { kind: "terrain", handle: "te", table: "Terrains", pk: "TerrainType", name: "Name", era: null, cost: null },
  { kind: "feature", handle: "fe", table: "Features", pk: "FeatureType", name: "Name", era: null, cost: null },
  { kind: "project", handle: "pr", table: "Projects", pk: "ProjectType", name: "Name", era: null, cost: "Cost" },
  { kind: "promotion", handle: "pm", table: "UnitPromotions", pk: "UnitPromotionType", name: "Name", era: null, cost: null },
  { kind: "governor", handle: "gv", table: "Governors", pk: "GovernorType", name: "Name", era: null, cost: null },
  { kind: "governor_promotion", handle: "gp", table: "GovernorPromotions", pk: "GovernorPromotionType", name: "Name", era: null, cost: null },
];

/**
 * Fields appended to every row after the shared [h, id, name, era, cost, fx, unres]
 * prefix, so a row is already join'd: unlock, prerequisites and the stats that
 * decide timing are inline instead of being recoverable only from edge lists.
 * The order here IS the column order reported in `content[kind].columns`.
 */
const INSTANCE_FIELDS = {
  technology: ["req", "boost", "treeRow", "depth", "children", "unlocks", "eff"],
  civic: ["req", "boost", "treeRow", "depth", "children", "unlocks", "eff"],
  building: ["tech", "civic", "district", "tier", "py", "maint", "replaces", "eff"],
  district: ["tech", "civic", "replaces", "buildings", "eff"],
  unit: ["tech", "civic", "cs", "rc", "mv", "mt", "pc", "res", "resq", "resm", "py", "up", "replaces", "replacedBy", "eff"],
  project: ["tech", "civic", "district", "eff"],
  policy: ["tech", "civic", "slot", "eff"],
  government: ["tier", "slots", "civic", "eff"],
  belief: ["cls", "adopt", "eff"],
  improvement: ["tech", "civic", "eff"],
  resource: ["tech", "civic", "eff"],
  terrain: ["mv", "def", "appeal", "eff"],
  feature: ["nw", "mv", "def", "appeal", "eff"],
  promotion: ["cls", "lvl", "col", "req", "eff"],
  governor: ["eff"],
  governor_promotion: ["lvl", "col", "req", "gov", "eff"],
};

/** Raw table columns an instance kind needs beyond pk/name/era/cost/prereq. */
const INSTANCE_EXTRA_COLUMNS = {
  unit: ["Combat", "RangedCombat", "BaseMoves", "Maintenance", "PromotionClass", "StrategicResource", "PurchaseYield"],
  building: ["GovernmentTierRequirement", "PurchaseYield", "Maintenance"],
  policy: ["GovernmentSlotType"],
  government: ["Tier"],
  belief: ["BeliefClassType", "AdoptionOrder"],
  promotion: ["PromotionClass", "Level", "Column"],
  governor_promotion: ["Level", "Column"],
  technology: ["UITreeRow"],
  civic: ["UITreeRow"],
  terrain: ["MovementCost", "DefenseModifier", "Appeal"],
  feature: ["NaturalWonder", "MovementChange", "DefenseModifier", "Appeal"],
};

/** Column legend for codes that need a sentence beyond `meta.encoding`. */
const INSTANCE_LEGEND = {
  technology: {
    treeRow: "游戏内科技树纵坐标（同一行=同层替代线）",
    depth: "从无前置节点起算的树深",
    children: "后继科技句柄数组（前置边反向）",
    unlocks: "该科技解锁的句柄数组（单位/建筑/区域/项目/改良/资源）",
  },
  civic: {
    treeRow: "游戏内市政树纵坐标（同一行=同层替代线）",
    depth: "从无前置节点起算的树深",
    children: "后继市政句柄数组",
    unlocks: "该市政解锁的句柄数组（政策/政体/单位/建筑/区域/改良等）",
  },
  unit: {
    resq: "战略资源需求量（Units_XP2.ResourceCost）",
    resm: "每回合资源维护量",
    replaces: "该单位替代的基础单位（独特单位才有）",
    replacedBy: "被哪些独特单位替代（关系表，不看 id 前缀）",
  },
  district: {
    replaces: "该区域替代的基础区域（独特区域才有，继承其建筑）",
    buildings: "可建建筑句柄数组（含被替代区域的基础建筑链；独特建筑按自身 replaces 列区分）",
  },
  building: { replaces: "该建筑替代的基础建筑（独特建筑才有）" },
  government: { civic: "解锁该政体的市政", eff: "固有加成 + 积累加成（官方文本）" },
  terrain: { mv: "移动力消耗", def: "防御加成", appeal: "魅力" },
  feature: { nw: "是否自然奇观", mv: "移动力消耗变化", def: "防御加成", appeal: "魅力" },
};

/** Text kinds whose official description is the authoritative line. */
const EFF_DESCRIPTION_ONLY = new Set(["unit"]);
/** Kinds that keep every resolved effect-card line (adjacency/yield/trade included). */
const EFF_ALL_LINES = new Set([
  "district",
  "improvement",
  "building",
  "project",
  "policy",
  "government",
  "belief",
  "promotion",
  "governor",
  "governor_promotion",
  "technology",
  "civic",
  "resource",
  "terrain",
  "feature",
]);

const INSTANCE_OMITTED = [
  { what: "时代得分 / 黄金时代与决议", reason: "规则库无对应表（数据层未收录），不要给数值" },
  { what: "伟人个体名单与抢人顺序", reason: "个体伟人不在库内；只给伟人职业与基础成本" },
  { what: "自然奇观的独立清单", reason: "规则库无独立表；地形/地貌/自然奇观特征在 tiles 类（kind=terrain|feature），奇观本体不单列" },
  { what: "巨作清单", reason: "由巨作槽与伟人产出间接决定，不在库内" },
  {
    what: "未进 cityStates 的城邦宗主加成",
    reason:
      "CityStates 表只覆盖 18 个城邦（54 行＝基础/迭起兴衰/风云际会三层重复，已按 id 合并）；喀布尔、普雷斯拉夫等只有名称与 LOC_CIVILIZATION_*_BONUS 标签，且 XP1/XP2 文本版本混杂、未解析，不写数值",
  },
];

/**
 * Field-level honesty channel: what the rows deliberately do NOT carry. With no
 * SQL tool and no drill-down tool, this list is the only way the model can tell
 * "the packet is short here" from "the data does not exist" — leaving it out
 * invites memory-filling.
 */
const INSTANCE_GAPS = [
  { what: "单位升级金币价 / 信仰买价", reason: "只有 PurchaseYield（允许的币种）；价格公式不在规则库" },
  { what: "建筑购买价", reason: "同上：只有 PurchaseYield，没有价格" },
  { what: "政策槽数量", reason: "行内 slot 是槽位类别；数量随政体/科技变化，见 government.slots" },
  { what: "科技/市政 OR 型前置", reason: "req 是 TechnologyPrereqs / CivicPrereqs 的 AND 列表；RequirementSets 的 OR 组未展开" },
  { what: "每行 fx 超过 3 条的部分", reason: "fx 最多 3 条已解析公式摘要；更多口径见 eval，或按 unres 计数回答“数据层未解析”" },
  {
    what: "原始修饰符链 / unresolved 审计数据",
    reason: "包内只给已解析效果（eff/fx）与未解析条数（unres）；修饰符链属审计层，模型面不可达，不要凭记忆补写",
  },
  {
    what: "单位的通用能力清单",
    reason:
      "单位 ability 行由 TypeTags 标签闭包生成（含跨文明条件条目），不是该单位的能力归属；单位自身能力写在 unit 的 eff 描述里，其余按“数据层未解析”处理",
  },
  { what: "光环/叠加上限等隐藏机制", reason: "包内只有官方文本与公式；是否作用于自身、能否叠加不在数据层结论里，遇到时答“数据层未解析”" },
  { what: "总督就任/调任的成本与忠诚度机制", reason: "库里只有总督与晋升本身；机制数值不在规则库" },
];

const INSTANCE_OMITTED_NOTE = "omitted 是数据层没有的量；gaps 是包内没带的字段。两者之外，包内一定有一行——找不到就是看漏了 columns。";

function tableColumnsOf(ctx, table) {
  try {
    return new Set(q(ctx, `PRAGMA table_info("${table}");`).map((r) => r.name));
  } catch {
    return new Set();
  }
}

/**
 * Classes (= one section per decision surface) exist because the transport cuts a
 * single tool result at ~50k chars. The split is by purpose, not by row width:
 * the model fetches `core` once, then only the classes the question touches, and
 * each class says in `definition` what it is and in `whenToUse` when to ask for
 * it. A class that exceeds its budget fails loudly instead of being truncated.
 *
 * `whenToUse` appears twice (manifest + class payload) on purpose: the manifest
 * is the only selection surface available after fetching `core`, while the class
 * payload is read after the fetch. Both come from this single constant.
 */
const INSTANCE_CLASSES = [
  {
    section: "core",
    kinds: [],
    definition:
      "实例骨架：硬约束（文明/领袖/速度/难度）、速度档、时代表、胜利线口径、文明套件全文、中立索引（产出→句柄）、城邦、GlobalParameters 子集、伟人职业与基础成本、单位行动，以及 gaps/omitted 两张缺口清单与各类清单。不含任何可选项的完整行（那些在各内容类）。",
    whenToUse:
      "每次新实例的第一步：先取它，再按 manifest 的 whenToUse 决定还要哪些类。换文明/领袖/速度才重取；换胜利线不必重取。",
  },
  {
    section: "tech-tree",
    kinds: ["technology"],
    definition:
      "科技树结构：每个科技是节点，行含时代、成本、树位(treeRow)、树深(depth)、AND 前置(req)、后继(children)、解锁句柄(unlocks)、尤里卡(boost)、官方描述(eff)。不含 OR 型前置与政策/政体以外的解锁来源。",
    whenToUse:
      "要在某个时代规划科技路线、判断“这条线值不值得绕”、看某科技解锁了什么、算前置闭包时取；配 eval 的 gates 用。",
  },
  {
    section: "civic-tree",
    kinds: ["civic"],
    definition:
      "市政树结构：每个市政是节点，行含时代、成本、树位(treeRow)、树深(depth)、前置(req)、后继(children)、解锁句柄(unlocks，含政策与政体)、鼓舞(boost)、官方描述(eff)。政府解锁在 unlocks 里指向 multipliers 的政体行。",
    whenToUse:
      "要规划市政顺序、抢政体/政策槽、判断“先点哪个市政”时取；与 tech-tree 常成对取。",
  },
  {
    section: "units",
    kinds: ["unit"],
    definition:
      "单位：成本、战斗力(cs)、远程(rc)、移动(mv)、维护(mt)、晋升类(pc)、战略资源(res/resq/resm)、购买币种(py)、升级目标(up)、独特单位替代关系(replaces/replacedBy)、官方描述(eff)。不含晋升树（见 promotions）与升级金币价（见 gaps）。",
    whenToUse:
      "决定出什么兵、比较单位强弱、判断某独特单位是否替代了基础单位、算兵种升级链时取。",
  },
  {
    section: "districts",
    kinds: ["district"],
    definition:
      "区域：解锁科技/市政、替代关系(replaces)、可建建筑句柄(buildings)、官方描述与相邻加成文本(eff)。不含建筑本身的行（见 buildings）。",
    whenToUse:
      "要决定铺什么区域、判断相邻加成怎么叠、看某独特区域替代谁、确认区域里能造哪些建筑时取。",
  },
  {
    section: "buildings",
    kinds: ["building", "project"],
    definition:
      "城市可造物：建筑（成本、解锁、所属区域、政体等级要求、购买币种、维护、替代关系、全文）与项目（成本、解锁、所属区域、全文）。不含区域本身（见 districts）与购买价（见 gaps）。",
    whenToUse:
      "要决定城市里造什么、比较建筑造价与产出、看项目（含太空项目）的前置与成本时取；常与 districts 连用。",
  },
  {
    section: "tiles",
    kinds: ["improvement", "resource", "terrain", "feature"],
    definition:
      "地块层：改良（解锁、产出、相邻加成、全文）、资源（类别、产出行）、地形（移动/防御/魅力）、地貌（含自然奇观标记）。不含区域与建筑的行。注意：地形/地貌的 name 取自本地化表，可能被场景文本覆盖成别名（已知草地显示为“荒漠”），判断地形请以 id 字段为准。",
    whenToUse:
      "要规划改良、判断资源值不值得占、看地形/地貌与自然奇观条件时取；与 districts 的相邻加成配合使用。",
  },
  {
    section: "multipliers",
    kinds: ["policy", "government"],
    definition:
      "互斥加法：政策（槽位类别 slot、解锁科技/市政、全文）与政体（等级 tier、槽位数 slots、解锁市政、固有加成+积累加成全文）。不含信条（见 beliefs）与总督（见 governors）。",
    whenToUse:
      "要选政策卡、换政体、比较两个政体的加成、判断政体解锁时点（来自 civic-tree）时取。",
  },
  {
    section: "beliefs",
    kinds: ["belief"],
    definition:
      "信条：59 条万神殿/创始人/追随者/强化信条，含类别(cls)、采纳顺序(adopt)、官方全文(eff)。不含宗教压力与传教强度数值（见 core.params 的 RELIGION_*）。",
    whenToUse:
      "要选万神殿或追随者、问某信条的实际加成、比较两条互斥信条时取；与 multipliers 连用。",
  },
  {
    section: "promotions",
    kinds: ["promotion"],
    definition:
      "单位晋升：144 条晋升，含晋升类(cls)、等级(lvl)、列(col)、前置晋升(req)、官方全文(eff)。不含单位本身（见 units）与晋升类通用能力清单（见 gaps）。",
    whenToUse:
      "要规划某个兵种树的晋升顺序、看晋升前置、比较同级晋升时取；与 units 的 pc 列配合。",
  },
  {
    section: "governors",
    kinds: ["governor", "governor_promotion"],
    definition:
      "总督：8 名总督与 49 条总督晋升，含等级(lvl)、列(col)、前置(req)、权威归属(gov，来自 GovernorPromotionSets)、官方全文(eff)。归属只认 gov 列，不看 id 前缀。",
    whenToUse:
      "要决定派谁去哪座城、点哪条晋升、确认某晋升属于哪个总督（BBG 会改挂）时取。",
  },
];
const INSTANCE_SECTION_BUDGET = 44000;
const INSTANCE_CLASS_BY_SECTION = new Map(INSTANCE_CLASSES.map((entry) => [entry.section, entry]));

/**
 * Some LocalizedText rows are aliases ("{LOC_OTHER_TAG}") rather than sentences,
 * which leaked braces into names and city-state bonuses. Resolve up to four
 * levels of `{LOC_*}` references against the same language index.
 */
const INLINE_LOC_REF = /\{([A-Z][A-Z0-9_]*)\}/g;

function resolveLocalizedRefs(ctx, text, lang = "zh_Hans_CN") {
  if (typeof text !== "string" || !text.includes("{")) return text;
  let out = text;
  for (let pass = 0; pass < 4; pass++) {
    const refs = [...new Set([...out.matchAll(INLINE_LOC_REF)].map((m) => m[1]))].filter((tag) => tag.startsWith("LOC_"));
    if (!refs.length) break;
    const lookup = localizeMany(ctx, refs, lang);
    let changed = false;
    out = out.replace(INLINE_LOC_REF, (match, tag) => {
      const value = lookup(tag);
      if (!value || value === tag) return match;
      changed = true;
      return value;
    });
    if (!changed) break;
  }
  return out;
}

/** Strip Civ6 inline markup from raw localized text ([ICON_*], [NEWLINE], [COLOR*]). */
function scrubGameMarkup(text) {
  if (typeof text !== "string" || !text) return text;
  return text
    .replace(/\[NEWLINE\]/gi, " ")
    .replace(/\[(?:ICON|COLOR|ENDCOLOR)[^\]]*\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Mechanism rows, not effects: the formula layer renders "获得 X / 附加 X…" for
 * modifiers that grant an ability or attach a modifier. They must never outrank a
 * real formula in `fx`, and they are counted in `unres` so the model can say
 * "数据层未解析" instead of quoting a tag.
 */
const MECHANISM_TEMPLATES = new Set(["grant_ability", "attach_modifier", "grant_entity"]);

function isPlaceholderFormula(desc, template) {
  const text = String(desc ?? "").trim();
  if (!text || text === "获得能力") return true;
  if (text.startsWith("获得") || text.endsWith("…")) return true;
  return MECHANISM_TEMPLATES.has(String(template ?? ""));
}

function buildInstanceData(ctx, args) {
  if (!hasTable(ctx, "kb_formula") || !hasTable(ctx, "kb_formula_owner")) {
    throw new Error(
      "civi6_instance: 公式层缺失。请在插件卸载状态下运行 `npm run effects:build:bbg`（或 effects:build）重建效果事实层。",
    );
  }
  const build = parseJson(q1(ctx, "SELECT value FROM _meta WHERE key = 'build';")?.value, {}) ?? {};
  const effectsMeta = parseJson(q1(ctx, "SELECT value FROM _meta WHERE key = 'effects';")?.value, {}) ?? {};
  const rulesetMeta = parseJson(q1(ctx, "SELECT value FROM _meta WHERE key = 'ruleset';")?.value, {}) ?? {};
  // `_meta.build.source` is the game install path; the ruleset id is the key the
  // derived tables are keyed by, so resolve the civ board against that.
  const source = rulesetMeta.id ?? effectsMeta.rulesetId ?? "bbg";
  const speed = args.speed === "online" ? "online" : "standard";

  // --- instance parameters (hard constraints only) -------------------------
  const eraRows = hasTable(ctx, "Eras")
    ? q(ctx, "SELECT EraType, ChronologyIndex FROM Eras ORDER BY ChronologyIndex;")
    : [];
  const eraIndexByType = new Map(eraRows.map((r, i) => [String(r.EraType), i]));
  const eraName = new Map(eraRows.map((r, i) => [String(r.EraType), i]));
  const speedRow = hasTable(ctx, "kb_speed_profile")
    ? q1(ctx, "SELECT speed, total_turns, cost_multiplier FROM kb_speed_profile WHERE speed = ?;", speed)
    : null;
  const victories = hasTable(ctx, "kb_victory")
    ? q(ctx, "SELECT victory_id, name_zh, win_check, critical_percentage, default_burst_turn FROM kb_victory ORDER BY victory_id;")
    : [];
  const difficulties = hasTable(ctx, "Difficulties")
    ? q(ctx, "SELECT DifficultyType, Name FROM Difficulties ORDER BY DifficultyType;").map((r) => ({
        id: r.DifficultyType,
        name: r.Name ?? r.DifficultyType,
      }))
    : [];

  // --- civ kit (full effect text: the only "thick" part) -------------------
  let civRow = null;
  if (args.civ || args.leader) {
    if (hasTable(ctx, "kb_civ_profile")) {
      civRow = resolveCiv(ctx, source, args.civ, args.leader);
    }
  }
  const civKit = [];
  const pushKit = (kind, id, why) => {
    if (!kind || !id) return;
    const card = briefEvidenceCard(ctx, kind, id);
    const effects = card
      ? [...new Set(parseJsonArray(card.effects_json).map((e) => e.text_zh ?? e.text_en).filter(Boolean))]
      : [];
    civKit.push({
      kind,
      id,
      name_zh: entityLabel(ctx, kind, id),
      why,
      // The whole civ kit is ~2KB of text; the old 3-line cap was what forced a
      // per-trait drill-down call for every "what exactly does my civ do".
      effects,
      dataGap: effects.length === 0,
    });
  };
  if (civRow) {
    pushKit("civilization", civRow.civ_id, "文明");
    pushKit("leader", civRow.leader_id, "领袖");
    for (const id of parseJsonArray(civRow.unique_unit)) pushKit("unit", id, "特色单位");
    for (const id of parseJsonArray(civRow.unique_building)) pushKit("building", id, "特色建筑");
    for (const id of parseJsonArray(civRow.unique_district)) pushKit("district", id, "特色区域");
    for (const id of parseJsonArray(civRow.unique_improvement)) pushKit("improvement", id, "特色改良");
    for (const id of parseJsonArray(civRow.trait_ids)) pushKit("trait", id, "文明/领袖特性");
  }

  // --- formulas grouped by owner (the executable side) ---------------------
  const formulaRows = q(
    ctx,
    `SELECT o.owner_kind AS k, o.owner_id AS id, f.desc AS d, f.template AS t,
            f.dimension AS dim, f.value AS v, f.confidence AS c
       FROM kb_formula_owner o JOIN kb_formula f ON f.modifier_id = o.modifier_id;`,
  );
  const formulasByOwner = new Map();
  const dimIndex = new Map();
  for (const row of formulaRows) {
    const key = `${row.k}:${row.id}`;
    let list = formulasByOwner.get(key);
    if (!list) {
      list = [];
      formulasByOwner.set(key, list);
    }
    list.push(row);
    if (row.dim) {
      let dimList = dimIndex.get(row.dim);
      if (!dimList) {
        dimList = [];
        dimIndex.set(row.dim, dimList);
      }
      dimList.push({ key, v: (Number(row.v) || 0) * (Number(row.c) || 0.5) });
    }
  }
  // Attach the executable side to the civ kit too, so "Lavra gives X" is a
  // formula, not a sentence.
  for (const item of civKit) {
    const list = formulasByOwner.get(`${item.kind}:${item.id}`) ?? [];
    item.fx = list
      .slice()
      .filter((r) => !isPlaceholderFormula(r.d, r.t))
      .sort((a, b) => (Number(b.c) || 0) - (Number(a.c) || 0))
      .slice(0, 3)
      .map((r) => r.d)
      .join(";");
  }

  // --- authoritative text per row (`eff`) and unparsed-mechanism counts ------
  // The effect card is the only place the official sentence lives. It used to be
  // truncated to 32 chars (column `d`), which is what made a per-entity
  // drill-down unavoidable for beliefs / policies / governments.
  const effByOwner = new Map();
  if (hasTable(ctx, "effect_cards")) {
    for (const r of q(ctx, "SELECT card_id, effects_json FROM effect_cards;")) {
      const cardId = String(r.card_id ?? "");
      if (!cardId) continue;
      const colon = cardId.indexOf(":");
      const kind = colon > 0 ? cardId.slice(0, colon) : "";
      if (!EFF_DESCRIPTION_ONLY.has(kind) && !EFF_ALL_LINES.has(kind)) continue;
      const lines = [];
      for (const e of parseJsonArray(r.effects_json)) {
        const text = String(e.text_zh ?? e.text_en ?? "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        // Unit cards list tag-closure abilities from *other* civilizations; only
        // the unit's own description is authoritative for it.
        if (EFF_DESCRIPTION_ONLY.has(kind) && String(e.kind ?? "") !== "description") continue;
        lines.push(text);
      }
      if (lines.length) effByOwner.set(cardId, [...new Set(lines)]);
    }
  }

  // --- inline maps: the joins this packet used to expose as a handle graph --
  const pushInto = (map, key, value) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  const prereqOf = new Map();
  if (hasTable(ctx, "TechnologyPrereqs")) {
    for (const r of q(ctx, "SELECT Technology, PrereqTech FROM TechnologyPrereqs;")) {
      if (r.Technology && r.PrereqTech) pushInto(prereqOf, `technology:${String(r.Technology)}`, String(r.PrereqTech));
    }
  }
  if (hasTable(ctx, "CivicPrereqs")) {
    for (const r of q(ctx, "SELECT Civic, PrereqCivic FROM CivicPrereqs;")) {
      if (r.Civic && r.PrereqCivic) pushInto(prereqOf, `civic:${String(r.Civic)}`, String(r.PrereqCivic));
    }
  }
  const promotionPrereq = new Map();
  if (hasTable(ctx, "UnitPromotionPrereqs")) {
    for (const r of q(ctx, "SELECT UnitPromotion, PrereqUnitPromotion FROM UnitPromotionPrereqs;")) {
      if (r.UnitPromotion && r.PrereqUnitPromotion) {
        pushInto(promotionPrereq, String(r.UnitPromotion), String(r.PrereqUnitPromotion));
      }
    }
  }
  const upgradesTo = new Map();
  if (hasTable(ctx, "UnitUpgrades")) {
    for (const r of q(ctx, "SELECT Unit, UpgradeUnit FROM UnitUpgrades;")) {
      if (r.Unit && r.UpgradeUnit) pushInto(upgradesTo, String(r.Unit), String(r.UpgradeUnit));
    }
  }
  const boostsById = new Map();
  if (hasTable(ctx, "Boosts")) {
    const boostRows = q(ctx, "SELECT TechnologyType, CivicType, TriggerDescription FROM Boosts;");
    const boostTags = boostRows.map((r) => String(r.TriggerDescription ?? "")).filter((t) => t.startsWith("LOC_"));
    const boostLookup = boostTags.length ? localizeMany(ctx, boostTags, "zh_Hans_CN") : () => undefined;
    for (const r of boostRows) {
      const id = r.TechnologyType ?? r.CivicType;
      const text = scrubGameMarkup(resolveLocalizedRefs(ctx, String(boostLookup(String(r.TriggerDescription ?? "")) ?? ""))) || r.TriggerDescription;
      if (id && text) boostsById.set(String(id), String(text));
    }
  }
  const governmentSlots = new Map();
  if (hasTable(ctx, "Government_SlotCounts")) {
    for (const r of q(ctx, "SELECT GovernmentType, GovernmentSlotType, NumSlots FROM Government_SlotCounts;")) {
      const key = String(r.GovernmentType ?? "");
      if (!key) continue;
      const slots = governmentSlots.get(key) ?? {};
      const slot = String(r.GovernmentSlotType ?? "").replace(/^SLOT_/, "").toLowerCase() || "other";
      slots[slot] = Number(r.NumSlots) || 0;
      governmentSlots.set(key, slots);
    }
  }
  // Adoption order lives on the class, not on the belief row.
  const beliefAdopt = new Map();
  if (hasTable(ctx, "BeliefClasses")) {
    for (const r of q(ctx, "SELECT BeliefClassType, AdoptionOrder FROM BeliefClasses;")) {
      if (r.BeliefClassType) beliefAdopt.set(String(r.BeliefClassType), r.AdoptionOrder ?? null);
    }
  }
  let governorOwners = new Map();
  if (hasTable(ctx, "GovernorPromotions")) {
    const promotionIds = q(ctx, "SELECT GovernorPromotionType FROM GovernorPromotions;")
      .map((r) => String(r.GovernorPromotionType ?? ""))
      .filter(Boolean);
    if (promotionIds.length) governorOwners = governorOwnersOf(ctx, promotionIds);
  }

  // --- unique-unit / district / building replacement relations -------------
  // "甲胄替代骑士" is a relation, not an id prefix; without it the upgrade chain
  // reads as if the unit simply upgrades into a base unit.
  const REPLACE_TABLES = [
    ["UnitReplaces", "CivUniqueUnitType", "ReplacesUnitType"],
    ["DistrictReplaces", "CivUniqueDistrictType", "ReplacesDistrictType"],
    ["BuildingReplaces", "CivUniqueBuildingType", "ReplacesBuildingType"],
  ];
  const replacesOf = new Map();
  const replacedByOf = new Map();
  for (const [table, uniqueCol, baseCol] of REPLACE_TABLES) {
    if (!hasTable(ctx, table)) continue;
    for (const r of q(ctx, `SELECT "${uniqueCol}" AS u, "${baseCol}" AS b FROM "${table}";`)) {
      if (!r.u || !r.b) continue;
      pushInto(replacesOf, String(r.u), String(r.b));
      pushInto(replacedByOf, String(r.b), String(r.u));
    }
  }
  const unitResourceFacts = new Map();
  if (hasTable(ctx, "Units_XP2")) {
    for (const r of q(ctx, "SELECT UnitType, ResourceCost, ResourceMaintenanceAmount FROM Units_XP2;")) {
      if (r.UnitType) unitResourceFacts.set(String(r.UnitType), r);
    }
  }

  // --- tree unlocks: invert PrereqTech / PrereqCivic into node -> content ---
  const UNLOCK_SOURCES = [
    ["unit", "Units", "UnitType"],
    ["building", "Buildings", "BuildingType"],
    ["district", "Districts", "DistrictType"],
    ["project", "Projects", "ProjectType"],
    ["improvement", "Improvements", "ImprovementType"],
    ["resource", "Resources", "ResourceType"],
    ["policy", "Policies", "PolicyType"],
    ["government", "Governments", "GovernmentType"],
  ];
  const unlockEdges = new Map();
  for (const [kind, table, pk] of UNLOCK_SOURCES) {
    if (!hasTable(ctx, table)) continue;
    const cols = tableColumnsOf(ctx, table);
    const treeCols = [];
    if (cols.has("PrereqTech")) treeCols.push(["technology", "PrereqTech"]);
    if (cols.has("PrereqCivic")) treeCols.push(["civic", "PrereqCivic"]);
    if (!treeCols.length) continue;
    const select = [...new Set([pk, ...treeCols.map(([, col]) => col)])];
    for (const r of q(ctx, `SELECT ${select.map((c) => `"${c}"`).join(", ")} FROM "${table}";`)) {
      const id = String(r[pk] ?? "");
      if (!id) continue;
      for (const [tree, col] of treeCols) {
        const node = String(r[col] ?? "");
        if (node) pushInto(unlockEdges, `${tree}:${node}`, `${kind}:${id}`);
      }
    }
  }

  // --- content: every choosable entity, rows already join'd ----------------
  const handles = new Map(); // `${kind}:${id}` -> handle
  const content = {};
  const counts = {};
  const tags = [];
  const kindRows = new Map();
  for (const spec of INSTANCE_KINDS) {
    if (!hasTable(ctx, spec.table)) continue;
    const cols = tableColumnsOf(ctx, spec.table);
    if (!cols.has(spec.pk)) continue;
    const select = [spec.pk];
    for (const col of [spec.name, spec.era, spec.cost, "PrereqTech", "PrereqCivic", "PrereqDistrict"]) {
      if (col && cols.has(col)) select.push(col);
    }
    for (const col of INSTANCE_EXTRA_COLUMNS[spec.kind] ?? []) {
      if (cols.has(col)) select.push(col);
    }
    const rows = q(ctx, `SELECT ${[...new Set(select)].map((c) => `"${c}"`).join(", ")} FROM "${spec.table}";`);
    rows.sort((a, b) => String(a[spec.pk]).localeCompare(String(b[spec.pk])));
    const fields = INSTANCE_FIELDS[spec.kind] ?? [];
    const out = [];
    rows.forEach((row, i) => {
      const id = String(row[spec.pk] ?? "");
      if (!id) return;
      const handle = `${spec.handle}${i}`;
      handles.set(`${spec.kind}:${id}`, handle);
      const nameTag = spec.name && cols.has(spec.name) ? String(row[spec.name] ?? "") : "";
      if (nameTag.startsWith("LOC_")) tags.push(nameTag);
      let era = spec.era && cols.has(spec.era) ? String(row[spec.era] ?? "") : "";
      if (!era && cols.has("PrereqTech")) {
        const parent = String(row.PrereqTech ?? "");
        const parentRow = parent ? kindRows.get(`technology:${parent}`) : null;
        if (parentRow) era = parentRow.era;
      }
      if (!era && cols.has("PrereqCivic")) {
        const parent = String(row.PrereqCivic ?? "");
        const parentRow = parent ? kindRows.get(`civic:${parent}`) : null;
        if (parentRow) era = parentRow.era;
      }
      const eraIdx = era && eraIndexByType.has(era) ? eraIndexByType.get(era) : null;
      const list = formulasByOwner.get(`${spec.kind}:${id}`) ?? [];
      const realFormulas = [];
      let unparsedFormulas = 0;
      for (const item of list) {
        if (isPlaceholderFormula(item.d, item.t)) unparsedFormulas += 1;
        else realFormulas.push(item);
      }
      const fx = [...new Set(
        realFormulas
          .slice()
          .sort((a, b) => (Number(b.c) || 0) - (Number(a.c) || 0))
          .map((r) => r.d)
          .filter(Boolean),
      )]
        .slice(0, 3)
        .join(";");
      const cardKey = `${spec.kind}:${id}`;
      // `unres` only counts mechanism rows that had no real description and were
      // therefore dropped from `fx`; it never invalidates an `eff` sentence.
      const unres = unparsedFormulas;
      const eff = effByOwner.get(cardKey) ?? null;
      const raw = (col) => (col && cols.has(col) ? row[col] ?? null : null);
      const replaces = replacesOf.get(id) ?? null;
      const resourceRow = unitResourceFacts.get(id);
      const fieldValue = (field) => {
        switch (field) {
          case "req":
            return prereqOf.get(`${spec.kind}:${id}`) ?? promotionPrereq.get(id) ?? null;
          case "boost":
            return boostsById.get(id) ?? null;
          case "tech":
            return raw("PrereqTech");
          case "civic":
            return raw("PrereqCivic");
          case "district":
            return raw("PrereqDistrict");
          case "tier":
            return raw("GovernmentTierRequirement") ?? raw("Tier");
          case "py":
            return raw("PurchaseYield");
          case "maint":
            return raw("Maintenance");
          case "cs":
            return raw("Combat");
          case "rc":
            return raw("RangedCombat");
          case "mv":
            return raw("BaseMoves") ?? raw("MovementCost") ?? raw("MovementChange");
          case "mt":
            return raw("Maintenance");
          case "pc":
            return raw("PromotionClass");
          case "res":
            return raw("StrategicResource");
          case "resq":
            return resourceRow?.ResourceCost ?? null;
          case "resm":
            return resourceRow?.ResourceMaintenanceAmount ?? null;
          case "replaces":
            return replaces;
          case "replacedBy":
            return replacedByOf.get(id) ?? null;
          case "slot":
            return raw("GovernmentSlotType");
          case "cls":
            return raw("BeliefClassType") ?? raw("PromotionClass");
          case "adopt":
            return beliefAdopt.get(raw("BeliefClassType")) ?? raw("AdoptionOrder");
          case "lvl":
            return raw("Level");
          case "col":
            return raw("Column");
          case "slots":
            return governmentSlots.get(id) ?? null;
          case "up":
            return upgradesTo.get(id) ?? null;
          case "def":
            return raw("DefenseModifier");
          case "appeal":
            return raw("Appeal");
          case "nw":
            return raw("NaturalWonder");
          case "treeRow":
            return raw("UITreeRow");
          case "gov": {
            const owners = governorOwners.get(id) ?? [];
            return owners.length ? owners.map((entry) => entry.id) : null;
          }
          case "eff":
            return eff;
          // Filled in the tree post-pass, which needs every handle first.
          case "children":
          case "unlocks":
          case "buildings":
            return null;
          case "depth":
            return null;
          default:
            return null;
        }
      };
      const rowOut = [handle, id, nameTag, eraIdx, row[spec.cost] ?? null, fx, unres];
      for (const field of fields) rowOut.push(fieldValue(field));
      out.push(rowOut);
      kindRows.set(`${spec.kind}:${id}`, { id, era, row: rowOut });
    });
    content[spec.kind] = { columns: ["h", "id", "name", "era", "cost", "fx", "unres", ...fields], rows: out };
    counts[spec.kind] = out.length;
  }

  // --- district -> buildings index ----------------------------------------
  const buildingsByDistrict = {};
  const buildingsByDistrictReplaced = {};
  if (hasTable(ctx, "Buildings")) {
    for (const r of q(ctx, `SELECT BuildingType, PrereqDistrict FROM Buildings WHERE PrereqDistrict IS NOT NULL;`)) {
      const d = handles.get(`district:${r.PrereqDistrict}`);
      const b = handles.get(`building:${r.BuildingType}`);
      if (!d || !b) continue;
      (buildingsByDistrict[d] ??= []).push(b);
    }
  }

  // --- tree structure post-pass (needs every handle in place) --------------
  const treeStats = {};
  for (const tree of ["technology", "civic"]) {
    const nodeSection = content[tree];
    if (!nodeSection) continue;
    const at = (name) => nodeSection.columns.indexOf(name);
    const idAt = at("id");
    const reqAt = at("req");
    const childrenAt = at("children");
    const depthAt = at("depth");
    const unlocksAt = at("unlocks");
    const byId = new Map(nodeSection.rows.map((row) => [row[idAt], row]));
    const children = new Map();
    let edges = 0;
    for (const row of nodeSection.rows) {
      const parents = Array.isArray(row[reqAt]) ? row[reqAt] : [];
      for (const parent of parents) {
        if (!byId.has(parent)) continue;
        pushInto(children, parent, row[idAt]);
        edges += 1;
      }
    }
    for (const [parent, kids] of children) {
      const row = byId.get(parent);
      if (row && childrenAt >= 0) row[childrenAt] = kids;
    }
    // depth = longest path from a root; the stack guard keeps a data cycle from
    // hanging the build (the tree is a DAG in the shipped rulesets).
    const depth = new Map();
    const visit = (nodeId, stack) => {
      if (depth.has(nodeId)) return depth.get(nodeId);
      if (stack.has(nodeId) || stack.size > 40) return 0;
      const row = byId.get(nodeId);
      if (!row) return 0;
      stack.add(nodeId);
      const parents = (Array.isArray(row[reqAt]) ? row[reqAt] : []).filter((p) => byId.has(p));
      const value = parents.length ? 1 + Math.max(...parents.map((p) => visit(p, stack))) : 0;
      stack.delete(nodeId);
      depth.set(nodeId, value);
      return value;
    };
    let maxDepth = 0;
    for (const row of nodeSection.rows) {
      const value = visit(row[idAt], new Set());
      if (depthAt >= 0) row[depthAt] = value;
      maxDepth = Math.max(maxDepth, value);
    }
    if (unlocksAt >= 0) {
      for (const row of nodeSection.rows) {
        const targets = unlockEdges.get(`${tree}:${row[idAt]}`) ?? [];
        const list = [];
        for (const key of targets) {
          const handle = handles.get(key);
          if (handle) list.push(handle);
        }
        row[unlocksAt] = list.length ? list : null;
      }
    }
    treeStats[tree] = { nodes: nodeSection.rows.length, edges, maxDepth };
  }

  // --- district -> building handles (unique districts inherit the chain) ---
  if (content.district) {
    const section = content.district;
    const at = (name) => section.columns.indexOf(name);
    const idAt = at("id");
    const replacesAt = at("replaces");
    const buildingsAt = at("buildings");
    for (const row of section.rows) {
      if (buildingsAt < 0) break;
      const own = buildingsByDistrict[row[0]] ?? [];
      const replacedDistricts = Array.isArray(row[replacesAt]) ? row[replacesAt] : [];
      const inherited = [];
      for (const base of replacedDistricts) {
        const baseHandle = handles.get(`district:${base}`);
        if (!baseHandle) continue;
        buildingsByDistrictReplaced[baseHandle] = true;
        inherited.push(...(buildingsByDistrict[baseHandle] ?? []));
      }
      const all = [...new Set([...own, ...inherited])];
      row[buildingsAt] = all.length ? all : null;
    }
  }

  // --- yield -> owners index (neutral: categories, not victory lines) -----
  const byDimension = {};
  for (const [dim, list] of [...dimIndex.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => b.v - a.v);
    const picked = [];
    const seen = new Set();
    for (const item of list) {
      const handle = handles.get(item.key);
      if (!handle || seen.has(handle)) continue;
      seen.add(handle);
      picked.push(handle);
      if (picked.length >= 120) break;
    }
    if (picked.length) byDimension[dim] = picked;
  }

  // Resolve LOC names in one batched pass (plus alias tags, e.g. terrain names
  // whose localization is "{LOC_SOMETHING_ELSE}").
  if (tags.length) {
    const lookup = localizeMany(ctx, tags, "zh_Hans_CN");
    for (const section of Object.values(content)) {
      for (const row of section.rows) {
        if (typeof row[2] === "string" && row[2].startsWith("LOC_")) {
          row[2] = resolveLocalizedRefs(ctx, lookup(row[2]) ?? row[2]);
        }
      }
    }
  }

  // --- global parameters / great people / operations -----------------------
  // Neutral facts: hard-constraint-independent, and previously fetched by hand.
  const PARAM_HINTS = ["RELIGION_", "TOURISM_", "COMBAT_"];
  const params = hasTable(ctx, "GlobalParameters")
    ? q(ctx, "SELECT Name, Value FROM GlobalParameters ORDER BY Name;")
        .filter((r) => PARAM_HINTS.some((p) => String(r.Name).includes(p)))
        .map((r) => [String(r.Name), String(r.Value ?? "")])
    : [];
  const greatPersonClasses = hasTable(ctx, "GreatPersonClasses")
    ? q(ctx, "SELECT GreatPersonClassType, Name FROM GreatPersonClasses ORDER BY GreatPersonClassType;").map((r) => ({
        id: r.GreatPersonClassType,
        name: r.Name ?? r.GreatPersonClassType,
      }))
    : [];
  const gppBaseCost = hasTable(ctx, "Eras")
    ? q(ctx, "SELECT EraType, GreatPersonBaseCost FROM Eras WHERE GreatPersonBaseCost IS NOT NULL ORDER BY ChronologyIndex;").map(
        (r) => [r.EraType, r.GreatPersonBaseCost],
      )
    : [];
  const operations = hasTable(ctx, "UnitOperations")
    ? [...new Set(
        q(ctx, "SELECT OperationType FROM UnitOperations ORDER BY OperationType;").map((r) => String(r.OperationType ?? "")),
      )]
        .filter(Boolean)
        .map((id) => [id])
    : [];

  // --- city-states: environment, not choosable -----------------------------
  // CityStates carries one row per data layer (base / XP1 / XP2) for the same
  // civ, so the rows are merged by id and the newest bonus column wins.
  const cityStateRows = hasTable(ctx, "CityStates")
    ? q(
        ctx,
        "SELECT CivilizationType, CityStateCategory, Name, Bonus, Bonus_XP2 FROM CityStates ORDER BY CivilizationType;",
      )
    : [];
  const cityStateById = new Map();
  for (const r of cityStateRows) {
    const id = String(r.CivilizationType ?? "");
    if (!id) continue;
    const prev = cityStateById.get(id);
    const bonus = r.Bonus_XP2 ?? r.Bonus ?? null;
    if (!prev) cityStateById.set(id, { id, category: r.CityStateCategory, name: r.Name, bonus });
    else {
      if (!prev.bonus && bonus) prev.bonus = bonus;
      if (!prev.category && r.CityStateCategory) prev.category = r.CityStateCategory;
    }
  }
  const cityStateList = [...cityStateById.values()];
  const cityStateTags = cityStateList
    .flatMap((r) => [r.name, r.bonus])
    .filter((t) => typeof t === "string" && t.startsWith("LOC_"));
  const cityStateLookup = cityStateTags.length ? localizeMany(ctx, cityStateTags, "zh_Hans_CN") : () => undefined;
  const cityStates = cityStateList.map((r) => {
    const name = cityStateLookup(String(r.name ?? "")) ?? String(r.name ?? "");
    const bonus = cityStateLookup(String(r.bonus ?? ""));
    return [
      r.id,
      scrubGameMarkup(resolveLocalizedRefs(ctx, name)),
      String(r.category ?? ""),
      bonus ? scrubGameMarkup(resolveLocalizedRefs(ctx, bonus)) : r.bonus ? scrubGameMarkup(String(r.bonus)) : null,
    ];
  });

  // Sanity metric: how many edges are now carried inside rows, not as a graph.
  let inlineEdges = 0;
  let effChars = 0;
  let unresolvedRows = 0;
  for (const section of Object.values(content)) {
    const at = (name) => section.columns.indexOf(name);
    for (const name of ["req", "tech", "civic", "children", "unlocks"]) {
      const index = at(name);
      if (index < 0) continue;
      for (const row of section.rows) {
        const value = row[index];
        if (Array.isArray(value)) inlineEdges += value.length;
        else if (value) inlineEdges += 1;
      }
    }
    const effAt = at("eff");
    const unresAt = at("unres");
    for (const row of section.rows) {
      if (effAt >= 0 && Array.isArray(row[effAt])) {
        for (const line of row[effAt]) effChars += String(line).length;
      }
      if (unresAt >= 0 && Number(row[unresAt]) > 0) unresolvedRows += 1;
    }
  }

  return {
    meta: {
      ruleset: source,
      builtAt: build.builtAt ?? effectsMeta.builtAt ?? null,
      packetVersion: 3,
      encoding: {
        h: "句柄（t=科技 c=市政 b=建筑 d=区域 u=单位 p=政策 g=政体 bl=信条 i=改良 r=资源 te=地形 fe=地貌 pr=项目 pm=晋升 gv=总督 gp=总督晋升；数字为同类行号）。句柄只用于包内交叉索引（indexes / children / unlocks / buildings），不是取数入口",
        row: "行 = [h, id, name, era, cost, fx, unres, ...content[kind].columns 第 7 位起]；各 kind 字段不同，按 columns 取，不要按位置猜",
        name: "LOC 标签（由 name_zh 解析）或原名",
        era: "eras[] 下标（0 基）",
        cost: "该 kind 的主成本（科技=科技值，市政=文化值，其余=生产力）",
        fx: "已解析公式摘要（kb_formula 渲染，最多 3 条；占位行已滤掉）",
        unres: "因没有真实描述而被 fx 丢弃的机制行数。要数值且 fx 为空时用它回答“数据层未解析”；有 eff 时照常引用文本，两者不互斥",
        eff: "权威文本数组（effect_cards 已解析效果，官方描述/相邻加成/产出行等）",
        req: "前置 id 数组（科技/市政=前置科技/市政；晋升=前置晋升）",
        boost: "尤里卡/鼓舞触发文本",
        tech: "解锁科技 id（单位/建筑/区域/政策/项目/改良/资源）",
        civic: "解锁市政 id（含政体）",
        cs: "战斗力",
        rc: "远程战斗力",
        mv: "移动力（单位=BaseMoves，地形=移动消耗，地貌=移动变化）",
        mt: "维护费",
        pc: "晋升类",
        res: "战略资源",
        py: "允许的购买币种",
        up: "升级目标单位 id",
        tier: "政体/政府等级要求",
        slots: "政体槽位数（按类别）",
        slot: "政策槽位类别",
        cls: "类别（信条=创始人/追随者等，晋升=晋升类）",
        adopt: "信条采纳顺序",
        lvl: "等级",
        col: "列",
        gov: "所属总督 id（权威归属，不看 id 前缀）",
        cityStates: "[id, 名称, 城邦类型, 宗主加成文本]（环境参考）",
        params: "[GlobalParameters.Name, Value]",
      },
      formulaCoverage: effectsMeta.formulaCoverage ?? null,
    },
    instance: {
      civ: civRow?.civ_id ?? null,
      leader: civRow?.leader_id ?? null,
      speed,
      difficulty: args.difficulty ?? null,
      speedProfile: speedRow
        ? { totalTurns: speedRow.total_turns, costMultiplier: speedRow.cost_multiplier }
        : null,
      eras: eraRows.map((r, i) => ({ index: i, id: r.EraType })),
      difficulties,
      victories,
    },
    civKit,
    content,
    indexes: { dimension: byDimension },
    cityStates,
    omitted: INSTANCE_OMITTED,
    omittedNote: INSTANCE_OMITTED_NOTE,
    gaps: INSTANCE_GAPS,
    counts,
    params,
    greatPersonClasses,
    gppBaseCost,
    operations,
    integrity: {
      rows: Object.values(counts).reduce((a, b) => a + b, 0),
      formulas: formulaRows.length,
      inlineEdges,
      effChars,
      unresolvedRows,
      trees: treeStats,
    },
  };
}

/**
 * Assemble one bounded class page. `definition` says what the class is,
 * `whenToUse` says when to ask for it — two attributes, not one blob, so the
 * model can decide before fetching instead of inferring.
 */
function assembleInstanceSection(data, section) {
  const entry = INSTANCE_CLASS_BY_SECTION.get(section);
  if (!entry) {
    throw new Error(
      `civi6_instance: 未知数据类 "${section}"（可用：${INSTANCE_CLASSES.map((c) => c.section).join(" / ")}）`,
    );
  }
  const pages = {};
  const coreEntry = INSTANCE_CLASS_BY_SECTION.get("core");
  pages.core = {
    section: "core",
    definition: coreEntry.definition,
    whenToUse: coreEntry.whenToUse,
    meta: data.meta,
    instance: data.instance,
    civKit: data.civKit,
    indexes: data.indexes,
    cityStates: data.cityStates,
    omitted: data.omitted,
    omittedNote: data.omittedNote,
    gaps: data.gaps,
    counts: data.counts,
    integrity: data.integrity,
    params: data.params,
    greatPersonClasses: data.greatPersonClasses,
    gppBaseCost: data.gppBaseCost,
    operations: data.operations,
  };
  for (const classEntry of INSTANCE_CLASSES) {
    const { section: name, kinds } = classEntry;
    if (!kinds.length) continue;
    const content = {};
    const legend = {};
    for (const kind of kinds) {
      if (!data.content[kind]) continue;
      content[kind] = data.content[kind];
      if (INSTANCE_LEGEND[kind]) legend[kind] = INSTANCE_LEGEND[kind];
    }
    pages[name] = {
      section: name,
      definition: classEntry.definition,
      whenToUse: classEntry.whenToUse,
      content,
      ...(Object.keys(legend).length ? { legend } : {}),
    };
  }
  const measure = () => {
    const sizes = {};
    for (const [name, value] of Object.entries(pages)) sizes[name] = JSON.stringify(value).length;
    return sizes;
  };
  const buildManifest = (sizes) => ({
    classes: INSTANCE_CLASSES.map((entry) => ({
      section: entry.section,
      whenToUse: entry.whenToUse,
      rows: entry.kinds.reduce((n, kind) => n + (data.counts[kind] ?? 0), 0),
      bytes: sizes[entry.section] ?? 0,
    })),
    rows: data.integrity.rows,
    note:
      "先取 core，再按各类 whenToUse 只取问题涉及的 2~5 类，不要一次全取；全量包比按需取更贵。" +
      "换胜利线不重取，换文明/领袖/速度才重取。",
  });
  // core carries the manifest, so its own byte count is only correct after the
  // manifest exists; a second pass settles the digits.
  let sizes = measure();
  for (let pass = 0; pass < 2; pass++) {
    pages.core.manifest = buildManifest(sizes);
    sizes = measure();
  }
  const picked = pages[section];
  if (!picked) {
    throw new Error(`civi6_instance: 未知数据类 "${section}"（可用：${Object.keys(pages).join(" / ")}）`);
  }
  const text = JSON.stringify(picked);
  if (text.length > INSTANCE_SECTION_BUDGET) {
    const blocks = Object.entries(picked.content ?? {})
      .map(([kind, value]) => [kind, JSON.stringify(value).length])
      .sort((a, b) => b[1] - a[1]);
    throw new Error(
      `civi6_instance: 数据类 "${section}" 序列化为 ${text.length} 字符，超过 ${INSTANCE_SECTION_BUDGET} 上限` +
        `（最大块：${blocks.slice(0, 4).map(([kind, n]) => `${kind} ${n}`).join(" / ") || "core"}）。` +
        "请把该类再拆小，不要交给传输层截断。",
    );
  }
  return picked;
}

let INSTANCE_CACHE = null;

function buildInstanceSection(ctx, args, section) {
  const builtAt = q1(ctx, "SELECT value FROM _meta WHERE key = 'build';")?.value ?? "";
  const key = `${builtAt}|${args.civ ?? ""}|${args.leader ?? ""}|${args.speed ?? ""}|${args.difficulty ?? ""}`;
  if (!INSTANCE_CACHE || INSTANCE_CACHE.key !== key) {
    INSTANCE_CACHE = { key, data: buildInstanceData(ctx, args) };
  }
  return assembleInstanceSection(INSTANCE_CACHE.data, section);
}

function instanceTool(getKb) {
  return makeTool({
    name: "civi6_instance",
    description:
      "Objective-free instance packet, one data class per call. Fetch section='core' first: it carries the hard constraints (civ/leader/speed/difficulty), the civ kit full text, the neutral indexes, city-states, global parameters, and manifest.classes with each class's whenToUse/rows/bytes. Then fetch ONLY the 2-5 classes the question touches (tech-tree, civic-tree, units, districts, buildings, tiles, multipliers, beliefs, promotions, governors) — do not fetch all of them. Every class returns definition (what the class is and what it does NOT contain) and whenToUse (when to ask for it) as separate fields. Every row is already join'd: [h, id, name, era, cost, fx, unres, ...content[kind].columns from index 7]; eff is the authoritative official text, fx the parsed formula summary, unres the count of unparsed mechanism rows (when >0 answer '数据层未解析' and do not fill in). Read `columns`/`legend`, never guess a position. There is no SQL tool and no per-entity drill-down tool: this packet plus civi6_eval plus civi6_meta is the whole data surface. Changing victory line does NOT require a re-fetch; changing civ/leader/speed does. A class that would exceed its budget fails loudly instead of being truncated.",
    parameters: {
      type: "object",
      properties: {
        civ: { type: "string", description: "Civilization id or Chinese/English name (e.g. Russia / 俄罗斯)." },
        leader: { type: "string", description: "Leader id or name (optional)." },
        speed: { type: "string", enum: ["standard", "online"], description: "Game speed (hard constraint). Default standard." },
        difficulty: { type: "string", description: "Difficulty id (optional; listed in instance.difficulties)." },
        section: {
          type: "string",
          enum: INSTANCE_CLASSES.map((entry) => entry.section),
          description:
            "Data class to return. Start with 'core', then pick by manifest.classes[].whenToUse; each class also carries definition/whenToUse in its payload.",
        },
      },
      required: ["section"],
    },
    budget: INSTANCE_SECTION_BUDGET,
    execute: (args) => {
      assertNoSource(args);
      return buildInstanceSection(getKb().ctx, args ?? {}, String(args?.section ?? "core"));
    },
  });
}

const ENTITY_KIND_BY_PREFIX = [
  ["TECHNOLOGY_", "technology"],
  ["TECH_", "technology"],
  ["CIVIC_", "civic"],
  ["BUILDING_", "building"],
  ["DISTRICT_", "district"],
  ["UNIT_", "unit"],
  ["PROJECT_", "project"],
  ["POLICY_", "policy"],
  ["IMPROVEMENT_", "improvement"],
  ["RESOURCE_", "resource"],
  ["BELIEF_", "belief"],
  ["GOVERNMENT_", "government"],
];

function kindOfEntityId(id) {
  const text = String(id ?? "");
  for (const [prefix, kind] of ENTITY_KIND_BY_PREFIX) {
    if (text.startsWith(prefix)) return kind;
  }
  return "other";
}

/**
 * Packet handles are 1-2 letter kind prefixes + the row's index in pk order.
 * They are the cross-reference key inside the packet (indexes / tree.children /
 * tree.unlocks / district.buildings); `civi6_entity` used to accept them as a
 * drill-down entry and is no longer registered. The id list MUST be built with
 * the same sort as buildInstanceData (pk localeCompare), otherwise handles point
 * elsewhere.
 */
const HANDLE_KIND = {
  t: "technology",
  c: "civic",
  b: "building",
  d: "district",
  u: "unit",
  p: "policy",
  g: "government",
  bl: "belief",
  i: "improvement",
  r: "resource",
  te: "terrain",
  fe: "feature",
  pr: "project",
  pm: "promotion",
  gv: "governor",
  gp: "governor_promotion",
};
const HANDLE_ID_CACHE = new Map();

function entityIdFromHandle(ctx, value) {
  const match = /^([a-z]{1,2})(\d{1,4})$/.exec(String(value ?? "").trim());
  if (!match) return undefined;
  const kind = HANDLE_KIND[match[1]];
  if (!kind) return undefined;
  const spec = INSTANCE_KINDS.find((entry) => entry.kind === kind);
  if (!spec || !hasTable(ctx, spec.table)) return undefined;
  const key = `${spec.table}|${spec.pk}`;
  let ids = HANDLE_ID_CACHE.get(key);
  if (!ids) {
    ids = q(ctx, `SELECT "${spec.pk}" AS id FROM "${spec.table}";`)
      .map((row) => String(row.id ?? ""))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    HANDLE_ID_CACHE.set(key, ids);
  }
  return ids[Number(match[2])];
}

const COST_CURRENCY = {
  technology: "science",
  civic: "culture",
  building: "production",
  district: "production",
  unit: "production",
  project: "production",
  improvement: "production",
};

const COST_SPEC = {
  technology: ["Technologies", "TechnologyType", "Cost"],
  civic: ["Civics", "CivicType", "Cost"],
  building: ["Buildings", "BuildingType", "Cost"],
  district: ["Districts", "DistrictType", "Cost"],
  unit: ["Units", "UnitType", "Cost"],
  project: ["Projects", "ProjectType", "Cost"],
};

/**
 * Preload the prerequisite graph and costs once per eval call. Small tables
 * (77 techs / 61 civics / 138 buildings / 36 districts / 144 units / 40
 * projects), so a few queries beat N per-node lookups.
 */
function loadPlanGraph(ctx) {
  const costs = new Map();
  for (const [kind, [table, pk, col]] of Object.entries(COST_SPEC)) {
    if (!hasTable(ctx, table)) continue;
    const cols = tableColumnsOf(ctx, table);
    if (!cols.has(pk) || !cols.has(col)) continue;
    for (const r of q(ctx, `SELECT "${pk}" AS id, "${col}" AS cost FROM "${table}";`)) {
      const value = Number(r.cost);
      if (Number.isFinite(value) && value > 0) costs.set(String(r.id), value);
    }
  }
  const parents = new Map();
  const addEdge = (child, parent) => {
    if (!child || !parent) return;
    let list = parents.get(String(child));
    if (!list) {
      list = [];
      parents.set(String(child), list);
    }
    if (!list.includes(String(parent))) list.push(String(parent));
  };
  if (hasTable(ctx, "TechnologyPrereqs")) {
    for (const r of q(ctx, "SELECT Technology, PrereqTech FROM TechnologyPrereqs;")) addEdge(r.Technology, r.PrereqTech);
  }
  if (hasTable(ctx, "CivicPrereqs")) {
    for (const r of q(ctx, "SELECT Civic, PrereqCivic FROM CivicPrereqs;")) addEdge(r.Civic, r.PrereqCivic);
  }
  if (hasTable(ctx, "BuildingPrereqs")) {
    for (const r of q(ctx, "SELECT Building, PrereqBuilding FROM BuildingPrereqs;")) addEdge(r.Building, r.PrereqBuilding);
  }
  for (const [table, pk, cols] of [
    ["Buildings", "BuildingType", ["PrereqTech", "PrereqCivic", "PrereqDistrict"]],
    ["Districts", "DistrictType", ["PrereqTech", "PrereqCivic"]],
    ["Units", "UnitType", ["PrereqTech", "PrereqCivic"]],
    ["Projects", "ProjectType", ["PrereqTech", "PrereqCivic", "PrereqDistrict"]],
  ]) {
    if (!hasTable(ctx, table)) continue;
    const tableCols = tableColumnsOf(ctx, table);
    const use = cols.filter((c) => tableCols.has(c));
    if (!use.length) continue;
    for (const r of q(ctx, `SELECT "${pk}" AS id, ${use.map((c) => `"${c}"`).join(", ")} FROM "${table}";`)) {
      for (const c of use) addEdge(r.id, r[c]);
    }
  }
  return { costs, parents };
}

function closureOf(graph, seedIds, limit = 250) {
  const depth = new Map();
  const queue = [];
  for (const id of seedIds) {
    if (!id) continue;
    depth.set(String(id), 0);
    queue.push(String(id));
  }
  while (queue.length && depth.size < limit) {
    const id = queue.shift();
    const d = depth.get(id) ?? 0;
    for (const parent of graph.parents.get(id) ?? []) {
      if (depth.has(parent)) continue;
      depth.set(parent, d + 1);
      queue.push(parent);
    }
  }
  return depth;
}

function eraDeadline(ctx, source, eraId, eraIndex) {
  if (!hasTable(ctx, "kb_era_window")) return { turn: 50, source: "fallback", confidence: 0.3 };
  const row = eraId
    ? q1(ctx, "SELECT * FROM kb_era_window WHERE source = ? AND era_id = ?;", source, eraId)
    : q1(
        ctx,
        "SELECT * FROM kb_era_window WHERE source = ? AND era_index = ?;",
        source,
        (Number.isFinite(eraIndex) ? eraIndex : 0) + 1,
      );
  if (!row) return { turn: 50, source: "fallback", confidence: 0.3 };
  return {
    turn: Number(row.turn_hi) || 50,
    era: row.era_id,
    source: row.source_flag ?? "empirical",
    confidence: row.confidence ?? 0.5,
  };
}

/**
 * Deterministic scratchpad for candidate plans. It never fetches data: it only
 * composes the formula rows that `civi6_instance` already put in context.
 * Returns per-dimension totals plus the composition (who contributes what), so
 * the answer can cite arithmetic instead of doing it in prose.
 */
function buildEvalResult(ctx, args) {
  if (!hasTable(ctx, "kb_formula") || !hasTable(ctx, "kb_formula_owner")) {
    throw new Error("civi6_eval: 公式层缺失。请先运行 `npm run effects:build:bbg` 重建效果事实层。");
  }
  const builds = Array.isArray(args.builds) ? args.builds.map(String).filter(Boolean) : [];
  const cities = Number.isFinite(args.cities) ? Number(args.cities) : 1;
  const popPerCity = Number.isFinite(args.popPerCity) ? Number(args.popPerCity) : 1;
  const eraIndex = Number.isFinite(args.eraIndex) ? Number(args.eraIndex) : null;

  const rows = [];
  for (const part of chunk(uniq(builds), 300)) {
    rows.push(
      ...q(
        ctx,
        `SELECT o.owner_id AS id, o.owner_kind AS kind, f.dimension AS dim, f.op AS op,
                f.value AS v, f.per AS per, f.desc AS d, f.confidence AS c, f.fx_id AS fx
           FROM kb_formula_owner o JOIN kb_formula f ON f.modifier_id = o.modifier_id
          WHERE o.owner_id IN (${placeholders(part.length)});`,
        ...part,
      ),
    );
  }
  const found = new Set(rows.map((r) => r.id));
  const missing = builds.filter((id) => !found.has(id));

  const dims = new Map();
  for (const row of rows) {
    if (!row.dim) continue;
    const per = row.per ?? "city";
    const multiplier =
      per === "pop"
        ? cities * popPerCity
        : per === "era"
          ? cities * (eraIndex !== null ? eraIndex + 1 : 1)
          : per === "adjacent" || per === "resource" || per === "trade_route"
            ? cities
            : cities;
    const value = (Number(row.v) || 0) * multiplier;
    let bucket = dims.get(row.dim);
    if (!bucket) {
      bucket = { add: 0, percent: 0, assumed: 0, composition: [] };
      dims.set(row.dim, bucket);
    }
    if (row.op === "percent") bucket.percent += Number(row.v) || 0;
    else bucket.add += value;
    if (row.op === "attach" || row.op === "grant") continue;
    if (per === "adjacent" || per === "resource" || per === "trade_route") bucket.assumed += 1;
    bucket.composition.push({
      id: row.id,
      fx: row.fx,
      op: row.op,
      value: Math.round(value * 100) / 100,
      per,
      desc: row.d,
      confidence: row.c,
    });
  }

  const metrics = [];
  for (const [dim, bucket] of [...dims.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    bucket.composition.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const afterPercent = Math.round(bucket.add * (1 + bucket.percent / 100) * 100) / 100;
    metrics.push({
      dimension: dim,
      add: Math.round(bucket.add * 100) / 100,
      percent: Math.round(bucket.percent * 10) / 10,
      supply: afterPercent,
      assumedPerCopy: bucket.assumed,
      composition: bucket.composition.slice(0, 10),
      contributors: bucket.composition.length,
    });
  }

  const ruleset = parseJson(q1(ctx, "SELECT value FROM _meta WHERE key = 'ruleset';")?.value, {}) ?? {};
  const source = ruleset.id ?? "bbg";
  const supplyByDim = new Map(metrics.map((m) => [m.dimension, m.supply]));

  let demand = [];
  if (args.victory && hasTable(ctx, "kb_target")) {
    const planId = `${String(args.victory)}:${source}`;
    const eraId = args.eraId ? String(args.eraId) : null;
    demand = q(
      ctx,
      `SELECT dimension_id, entity_id, op, value_num, value_lo, value_hi, unit, source_flag, confidence, era_id, label_zh
         FROM kb_target
        WHERE plan_id = ? AND slice_kind = 'era' ${eraId ? "AND era_id = ?" : ""}
        ORDER BY era_id, dimension_id;`,
      ...(eraId ? [planId, eraId] : [planId]),
    ).map((r) => ({
      era: r.era_id,
      dimension: r.dimension_id,
      entity: r.entity_id ?? null,
      op: r.op,
      value: r.value_num ?? null,
      lo: r.value_lo ?? null,
      hi: r.value_hi ?? null,
      unit: r.unit ?? null,
      source: r.source_flag,
      confidence: r.confidence,
      label: r.label_zh ?? null,
    }));
  }

  // Demand is a per-era band; an unfiltered dump of all 8 eras is noise (and
  // blows the payload budget), so keep the candidate era unless explicitly asked.
  if (demand.length) {
    const eraForIndex = eraIndex !== null ? eraDeadline(ctx, source, null, eraIndex).era : null;
    if (args.eraId) demand = demand.filter((r) => r.era === String(args.eraId));
    else if (eraForIndex) demand = demand.filter((r) => r.era === eraForIndex);
    demand = demand.slice(0, 48);
  }

  // ---- required side: gate closure -> per-currency ledger ----------------
  const gates = Array.isArray(args.gates) ? args.gates.map(String).filter(Boolean) : [];
  const deadline = eraDeadline(ctx, source, args.eraId ? String(args.eraId) : null, eraIndex);
  let pathOut = null;
  let ledger = [];
  let cut = [];
  let scenarios = [];
  if (gates.length) {
    const graph = loadPlanGraph(ctx);
    const closure = closureOf(graph, gates, 250);
    const nodes = [];
    const requiredByCurrency = {};
    for (const [id, depth] of closure) {
      const cost = graph.costs.get(id) ?? 0;
      const kind = kindOfEntityId(id);
      const currency = COST_CURRENCY[kind] ?? "production";
      if (cost > 0) requiredByCurrency[currency] = (requiredByCurrency[currency] ?? 0) + cost;
      nodes.push({ id, kind, depth, cost, currency });
    }
    pathOut = {
      gates: gates.slice(0, 40),
      closure: nodes.length,
      onPath: nodes.filter((n) => n.depth === 0).map((n) => n.id).slice(0, 40),
      prereqs: nodes
        .filter((n) => n.depth > 0)
        .sort((a, b) => b.depth - a.depth || b.cost - a.cost)
        .slice(0, 40)
        .map((n) => n.id),
      totalCost: Object.fromEntries(Object.entries(requiredByCurrency).map(([k, v]) => [k, Math.round(v)])),
    };
    for (const [currency, amount] of Object.entries(requiredByCurrency).sort((a, b) => b[1] - a[1])) {
      const supply = supplyByDim.get(`${currency}_per_turn`) ?? 0;
      const requiredPerTurn = Math.round((amount / Math.max(1, deadline.turn)) * 100) / 100;
      const gap = Math.round((requiredPerTurn - supply) * 100) / 100;
      ledger.push({
        currency,
        required: Math.round(amount),
        deadlineTurn: deadline.turn,
        requiredPerTurn,
        supplyPerTurn: Math.round(supply * 100) / 100,
        gap,
        verdict: gap > requiredPerTurn * 0.5 ? "short" : gap > 0 ? "tight" : "ok",
      });
    }
    cut = nodes
      .filter((n) => n.cost > 0)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 5)
      .map((n, i) => {
        const supply = supplyByDim.get(`${n.currency}_per_turn`) ?? 0;
        return {
          rank: i + 1,
          id: n.id,
          kind: n.kind,
          cost: Math.round(n.cost),
          currency: n.currency,
          slipTurns: supply > 0 ? Math.ceil(n.cost / supply) : null,
          saves: { [n.currency]: Math.round(n.cost) },
        };
      });
    scenarios = [
      { id: "low", supplyFactor: 0.6 },
      { id: "base", supplyFactor: 1 },
      { id: "high", supplyFactor: 1.4 },
    ].map((s) => {
      const gaps = ledger.map((row) => ({
        currency: row.currency,
        gap: Math.round((row.requiredPerTurn - row.supplyPerTurn * s.supplyFactor) * 100) / 100,
      }));
      return {
        id: s.id,
        supplyFactor: s.supplyFactor,
        gaps,
        feasible: gaps.every((g) => g.gap <= 0),
      };
    });
  }

  return {
    assumptions: { cities, popPerCity, eraIndex, builds: builds.length, gates: gates.length },
    ledger,
    metrics,
    path: pathOut,
    cut,
    scenarios,
    demand,
    deadline,
    missingBuilds: missing,
    note:
      "供应 = Σ(公式值 × 份数) 后再乘百分比；per=adjacent/resource/trade_route 的份数按 1 城计（assumedPerCopy）。" +
      "需求 = gates 的前置闭包成本 ÷ 该时代截止回合（kb_era_window.turn_hi，empirical，保留 confidence）。" +
      "cut 的 slipTurns = 该节点成本 ÷ 对应产出的每回合供给（无供给则 null）。",
  };
}

function evalTool(getKb) {
  return makeTool({
    name: "civi6_eval",
    description:
      "Deterministic scratchpad over the formula layer. Supply side: a candidate build set + city/pop/era assumptions -> per-dimension supply with the top contributors. Required side: a gate set (techs/civics/buildings/units/projects) -> prerequisite closure, per-currency ledger (required vs supply per turn, gap, verdict), ranked cut list with slipTurns, and low/base/high scenarios. Fetches no data. Call it instead of doing arithmetic in prose.",
    parameters: {
      type: "object",
      properties: {
        builds: {
          type: "array",
          items: { type: "string" },
          description: "Supply-side entity ids from the instance packet (content[].rows[i][1], e.g. BUILDING_LIBRARY).",
        },
        gates: {
          type: "array",
          items: { type: "string" },
          description:
            "Required-side entity ids (e.g. TECH_EDUCATION, CIVIC_THEOLOGY, BUILDING_UNIVERSITY). Their prerequisite closure is costed and compared against supply.",
        },
        cities: { type: "integer", description: "How many cities have the build set. Default 1." },
        popPerCity: { type: "integer", description: "Population per city (used by per=pop formulas). Default 1." },
        eraIndex: { type: "integer", description: "Era index from instance.eras (0-based), for per=era formulas." },
        victory: {
          type: "string",
          enum: ["science", "culture", "religion", "domination", "diplomatic"],
          description: "Optional: attach the plan band demand for this victory line.",
        },
        eraId: { type: "string", description: "Optional era id (ERA_ANCIENT ...) to filter the demand band." },
      },
      required: ["builds"],
    },
    execute: (args) => {
      assertNoSource(args);
      return buildEvalResult(getKb().ctx, args ?? {});
    },
  });
}

function searchTool(getKb) {
  return makeTool({
    name: "civi6_search",
    description:
      "Lexical (BM25) search over entity documents. The index is bilingual, so one query is enough: do not send a Chinese and an English variant of the same question. Returns ids you can feed straight into civi6_entity. Restrict with type to keep results on target.",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search query, Chinese or English (2-6 distinctive terms works best)." },
        scope: {
          type: "string",
          enum: ["entity", "plan", "all"],
          description:
            "entity = raw entity and effect docs (default); plan = precomputed decision cards; all = both.",
        },
        type: { type: "string", enum: TYPE_ENUM, description: "Optional entity type to restrict results to (entity scope)." },
        limit: { type: "integer", description: "Max results, 1-100. Default 10." },
      },
      required: ["q"],
    },
    ...RENDER.search,
    execute: (args) => {
      assertNoSource(args);
      const kb = getKb();
      const limit = args.limit ?? 10;
      const scope = args.scope === "plan" || args.scope === "all" ? args.scope : "entity";
      const result =
        scope === "plan"
          ? kb.search(args.q ?? "", { type: "card", scope: "plan", full: true, limit })
          : scope === "all"
            ? kb.search(args.q ?? "", { scope: "all", limit })
            : kb.search(args.q ?? "", { type: args.type, scope: "entity", limit });
      // Snippets are for ranking, not for reading: the full text lives in
      // civi6_entity / brief.evidence. 200 chars keeps a hit list cheap.
      result.results = (result.results ?? []).map((r) =>
        r.snippet && r.snippet.length > 200 ? { ...r, snippet: `${r.snippet.slice(0, 200)}…` } : r,
      );
      return result;
    },
  });
}

function planTool(getKb) {
  return makeTool({
    name: "civi6_plan",
    description:
      "Decision slice for a victory. view='focus' is the reasoning layer AND the answer packet: objective capsule, per-era budget ledger, named supply sources, ranked cut order, scenario band, path, era focus, plus `brief` (verbatim evidence for the entities the answer needs, mechanics the data layer models, remaining work groups, a 6-section answer outline, and explicitly unmodelled topics). Start a how-to-play question with focus + detail:'summary'; if brief.coverage.complete is true, answer from it — do not search/fetch again. Other views: burst (horizontal gates), ladder (vertical era bands), check (checkpoints), civ (civilization board), all. Pass speed='online' to scale turns and tech/civic costs; pass civ/leader to load that civilization's objective (the response header then describes that objective).",
    parameters: {
      type: "object",
      properties: {
        victory: {
          type: "string",
          enum: ["science", "culture", "religion", "domination", "diplomatic"],
          description: "Victory line.",
        },
        civ: { type: "string", description: "Civilization id or Chinese/English name (optional)." },
        leader: { type: "string", description: "Leader id or name (optional)." },
        speed: {
          type: "string",
          enum: ["standard", "online"],
          description: "Game speed profile; online scales turns and tech/civic costs. Default standard.",
        },
        era: {
          type: "string",
          enum: ["burst", "ancient", "classical", "medieval", "renaissance", "industrial", "modern", "atomic", "information"],
          description: "Era filter; 'burst' or omitted with view='burst' returns the burst-point slice.",
        },
        view: {
          type: "string",
          enum: ["focus", "burst", "ladder", "check", "civ", "all"],
          description: "focus = objective + constraints + path + era focus (the reasoning layer); burst (default) = horizontal slice; ladder = vertical era ladder; check = checkpoints; civ = civilization base board; all = everything.",
        },
        detail: {
          type: "string",
          enum: ["summary", "full"],
          description:
            "summary = every contract-cited field (complete); full = summary plus provenance/derivation rows (larger, may be compacted). Default summary.",
        },
      },
      required: ["victory"],
    },
    ...RENDER.plan,
    execute: (args) => {
      assertNoSource(args);
      const result = getKb().plan({
        victory: args.victory,
        civ: args.civ,
        leader: args.leader,
        era: args.era,
        speed: args.speed,
        view: args.view,
        detail: args.detail,
      });
      // Arm/disarm the visible work budget from the brief's own coverage.
      if (result?.brief?.coverage) {
        WORK_STATE = {
          complete: result.brief.coverage.complete === true,
          maxExtraCalls: Number(result.brief.workPlan?.maxExtraCalls) || 0,
          extraCalls: 0,
        };
      } else {
        WORK_STATE = null;
      }
      return result;
    },
  });
}

function entitiesTool(getKb) {
  return makeTool({
    name: "civi6_entities",
    description:
      "List entities of one type with localized names, curated stats and optional one-line effects. q matches the id, the raw name tag and the localized Chinese/English name. Use effects:true for belief/building lists; use full:true only when every raw column is needed. Items of type='governor_promotion' include governors[] (authoritative owner); type='governor' lists the kit for that governor. For type='promotion', promotionClass lists one promotion tree (e.g. PROMOTION_CLASS_HEAVY_CAVALRY).",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: TYPE_ENUM, description: "Entity type." },
        q: { type: "string", description: "Optional substring filter on id or localized (zh/en) name." },
        limit: { type: "integer", description: "Max rows, 1-200. Default 30." },
        offset: { type: "integer", description: "Zero-based offset. Default 0." },
        full: { type: "boolean", description: "Return every raw column instead of the curated stats." },
        effects: { type: "boolean", description: "Include up to effectLimit canonical effect lines per row." },
        effectLimit: { type: "integer", description: "Effect lines per row, 1-20. Default 3." },
        beliefClass: {
          type: "string",
          enum: BELIEF_CLASSES,
          description: "For type='belief', restrict to one belief class.",
        },
        promotionClass: {
          type: "string",
          description: "For type='promotion', restrict to one promotion tree, e.g. PROMOTION_CLASS_HEAVY_CAVALRY.",
        },
      },
      required: ["type"],
    },
    ...RENDER.entity,
    execute: (args) => {
      assertNoSource(args);
      return getKb().listEntities(args.type, {
        q: args.q,
        limit: args.limit,
        offset: args.offset,
        full: args.full === true,
        effects: args.effects === true,
        effectLimit: args.effectLimit,
        beliefClass: args.beliefClass,
        promotionClass: args.promotionClass,
      });
    },
  });
}

function entityTool(getKb) {
  return makeTool({
    name: "civi6_entity",
    description:
      "Canonical detail for one or more entities: official description, curated stats, localized effects with provenance, and optional raw modifier details. Accepts exact ids (DISTRICT_CAMPUS), packet handles (u37 / t72 / bl3 / gp9), or names (学院, resolved automatically); pass ids:[...] to batch (every requested item is returned; oversized batches are compacted, not truncated). Use it for verbatim text and the full modifier chain only — cost, unlock, prerequisites and the deciding stats are already inline in civi6_instance rows. effects:'full' returns every effect line; modifiers:'full' adds the raw requirement/argument chain. Units also carry upgrade/resource facts, districts carry buildings[]. For type='governor_promotion', governors[] is the authoritative owner list (from GovernorPromotionSets; never infer it from the id); for type='governor', promotions[] is that governor's kit.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: TYPE_ENUM, description: "Entity type." },
        id: { type: "string", description: "One exact id or a name, e.g. DISTRICT_CAMPUS / 学院." },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Several ids/names in one call (preferred over repeated calls).",
        },
        modifiers: {
          type: "string",
          enum: ["summary", "full", "none"],
          description:
            "Raw modifier chain detail. Default none; summary adds one line per modifier; full adds arguments and requirement sets.",
        },
        effects: {
          type: "string",
          enum: ["summary", "full", "none"],
          description:
            "How much of the canonical effect card to return. Default summary (12 lines); full returns all; none omits.",
        },
      },
      required: ["type"],
    },
    ...RENDER.entity,
    execute: (args) => {
      assertNoSource(args);
      const kb = getKb();
      const requested = Array.isArray(args.ids) && args.ids.length ? args.ids : args.id ? [args.id] : [];
      if (!requested.length) throw new Error("provide id or ids");
      const ids = requested.map((raw) => entityIdFromHandle(kb.ctx, raw) ?? raw);
      const opts = {
        modifiers: args.modifiers === "summary" ? "summary" : args.modifiers === "full" ? "full" : "none",
        effects: args.effects === "full" ? "full" : args.effects === "none" ? "none" : "summary",
      };
      const batch = kb.entityMany(args.type, ids, opts);
      if (!Array.isArray(args.ids) && batch.items.length === 1) return batch.items[0];
      if (!batch.items.length) {
        const first = batch.notFound?.[0];
        throw new Error(
          `entity not found: ${args.type}/${ids[0]}` +
            (first?.candidates ? `; candidates: ${JSON.stringify(first.candidates)}` : ""),
        );
      }
      return batch;
    },
  });
}

function modifiersTool(getKb) {
  return makeTool({
    name: "civi6_modifiers",
    description:
      "Paged raw modifier/requirement chain for one entity. Use civi6_entity for player-facing effects; this tool is for auditing the underlying arguments and requirement sets. Units can have dozens; page with offset/limit.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: TYPE_ENUM, description: "Entity type." },
        id: { type: "string", description: "Exact entity id." },
        offset: { type: "integer", description: "Zero-based offset. Default 0." },
        limit: { type: "integer", description: "Max modifiers, 1-200. Default 50." },
      },
      required: ["type", "id"],
    },
    ...RENDER.modifiers,
    execute: (args) => {
      assertNoSource(args);
      return getKb().modifiers(args.type, args.id, { offset: args.offset, limit: args.limit });
    },
  });
}

function sqlTool(getKb) {
  return makeTool({
    name: "civi6_sql",
    description:
      "Read-only SQL (SELECT/WITH/EXPLAIN/PRAGMA) against the active ruleset DB — a last-resort escape hatch for numbers no curated tool exposes. Call civi6_schema first if you do not know the table/column names; a failing query returns the candidates and the columns instead of a bare error. Returns raw rows, not effect descriptions; use civi6_entity for player-facing effects. Governor ownership: query v_governor_promotion (or civi6_entity type='governor_promotion'); promotion ids keep vanilla prefixes, so the id text is NOT the owner.",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string", description: "Read-only SQL statement (SELECT/WITH/EXPLAIN/PRAGMA)." },
        limit: { type: "integer", description: "Max rows when no LIMIT is present, 1-1000. Default 100." },
      },
      required: ["sql"],
    },
    ...RENDER.sql,
    execute: (args) => {
      assertNoSource(args);
      return getKb().sql(args.sql ?? "", args.limit);
    },
  });
}

function schemaTool(getKb) {
  return makeTool({
    name: "civi6_schema",
    description:
      "Table/view catalog: names, row counts and column names/types. Use it once before writing civi6_sql, or when a SQL error says a table/column does not exist. q matches table names and column names; leave it out only when you really want the shortlist.",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "Substring matched against table names and column names, e.g. 'promotion' or 'GameSpeed'." },
        limit: { type: "integer", description: "Max tables, 1-40. Default 20." },
      },
      required: [],
    },
    ...RENDER.schema,
    execute: (args) => {
      assertNoSource(args);
      return getKb().schema({ q: args.q, limit: args.limit });
    },
  });
}

// ---------------------------------------------------------------------------
// Host plugin entry
// ---------------------------------------------------------------------------
/**
 * Resolve a configured database path. Relative values are anchored to this
 * plugin's directory, so `../data/civi6.sqlite` / `../data/civi6-bbg.sqlite`
 * mean the same thing on every machine and regardless of the host process cwd.
 * A value that only exists relative to the process cwd still works as a fallback.
 */
function resolveDbPath(configured, workspaceRoot) {
  if (!configured) return undefined;
  if (isAbsolute(configured)) return configured;
  if (workspaceRoot) {
    const workspaceRelative = resolve(workspaceRoot, configured);
    if (existsSync(workspaceRelative)) return workspaceRelative;
  }
  const pluginRelative = resolve(PLUGIN_DIR, configured);
  if (existsSync(pluginRelative)) return pluginRelative;
  return resolve(configured);
}

/** The ruleset is a configuration fact; reject stale per-call source args. */
function assertNoSource(args) {
  if (args && typeof args === "object" && Object.prototype.hasOwnProperty.call(args, "source")) {
    throw new Error(
      "civi6-kb: ruleset is locked by plugin config. Change `ruleset` and reload; per-call source switching is not allowed.",
    );
  }
}

/** Read just the metadata needed for the prompt/validation, then close. */
function readMetaSummary(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const read = (key) => {
      try {
        const row = db.prepare(`SELECT value FROM _meta WHERE key = ?;`).get(key);
        return row?.value ? JSON.parse(String(row.value)) : null;
      } catch {
        return null;
      }
    };
    return { ruleset: read("ruleset"), build: read("build"), kb: read("kb.build"), effects: read("effects") };
  } catch {
    return { ruleset: null, build: null, kb: null, effects: null };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function buildReasoningPrompt() {
  return `## Civ6 工作协议（一次取数，公式算账）
“怎么玩 / 时代规划 / 取舍”类问题，数据只取一次，其余全靠公式与账本。

1. 第 1 步只取 civi6_instance({ civ, leader, speed, difficulty, section:'core' })：它由硬约束决定，含文明套件全文、城邦、中立索引、GlobalParameters 子集，以及 gaps/omitted 两张“这里没有”的清单。然后读 core.manifest.classes 里每一类的 whenToUse 与 bytes，只再取问题真正涉及的 2~5 类（tech-tree / civic-tree / units / districts / buildings / tiles / multipliers / beliefs / promotions / governors），不要一次全取。换胜利线不重取；换文明或速度才重取。
2. 每类都自带 definition（这一类是什么、不含什么）与 whenToUse（什么时候取），按需读，不要靠猜。行按 content[kind].columns 读，不要按位置猜：官方全文（eff）、已解析公式摘要（fx）、未解析计数（unres）、解锁科技/市政（tech/civic）、前置（req）、单位战力/移动/维护/晋升类/战略资源/升级与取代（cs/rc/mv/mt/pc/res/up/replaces/replacedBy）、政策槽（slot）、信条类别（cls）、政体等级与槽位数（tier/slots）、晋升等级与列（lvl/col）、科技树位与解锁（treeRow/depth/children/unlocks）、总督归属（gov）、城邦宗主加成（cityStates）。数据面只有 instance / eval / meta，没有 SQL 工具，也没有单实体放大镜工具。
3. 算账一律调用 civi6_eval：builds 给供给侧、gates 给需求侧（会展开前置闭包并计成本），返回 ledger（每币种 required / requiredPerTurn / supplyPerTurn / gap / verdict）、cut（砍单与 slipTurns）、scenarios（low/base/high）与 composition（谁贡献了多少，带 fx_id）。想让某单位/建筑进 plan，就把它的 tech/civic 直接喂给 gates。禁止心算，禁止把描述文字当数字。
4. 要某个数值确实不在包里时，先查 core.gaps 与 core.omitted——写在那里的一律回答“数据层未收录”，不得用记忆补；两者都没有就是看漏了行，回去按 columns 找。行内 unres 是“没有真实描述、已从 fx 丢弃的机制行数”：要数值却没有 fx、且 unres>0 时答“数据层未解析”，但不要因此否定同一行的 eff 文本。
5. 答案固定 6 段：约束方程 / 供给计划 / 砍单 / 情景 / 路径 / 验收；每段引用 civi6_eval 字段与行内字段，末行“数据依据：BBG 7.5.1 / <entity ids 或句柄>”。`;
}

function buildRulesetPrompt(ruleset, build) {
  if (!ruleset) {
    return "## Civ6 规则不可用\n当前 Civ6 知识库不可用（缺少数据库/规则清单/效果层）。禁止凭记忆回答文明6事实；请先运行构建并重载插件。";
  }
  const label = ruleset.labelZh ?? ruleset.id;
  const builtAt = build?.builtAt ?? ruleset.builtAt ?? "unknown";
  const excluded = Array.isArray(ruleset.excludedOptionalMods) ? ruleset.excludedOptionalMods : [];
  return `## Civ6 规则锁定
本会话唯一规则：${label}（${ruleset.id}，构建于 ${builtAt}）。
- 风云际会（Gathering Storm）是本规则的基础资料片，不是另一个可选数据源；本 KB 没有“无资料片基础版”。
- 所有文明6数值、成本、产出、前置、效果描述必须来自本轮 civi6_* 工具返回。禁止用预训练知识、禁止直接读 data/*.sqlite、禁止复用本会话中没有工具出处的旧结论。
- 数值纪律：凡是数（产出/成本/加成/伤害）一律来自工具返回的结构化字段或公式行（dimension + op + value）；文本只用于说明与审计，禁止从文字心算。
- 内部 ID 的前缀不编码归属：例如 GOVERNOR_PROMOTION_EDUCATOR_* 在 BBG 里可能属于其他总督。总督/晋升归属只认 civi6_instance 的 governors 类里 gov 列（或 v_governor_promotion 视图），禁止按 ID 前缀、名称片段或旧对话推断。
- 行内 eff 是已解析的权威效果文本，fx 是可执行公式；unres 只是未解析机制计数（>0 即“数据层未解析”）。用户问效果时只引用 eff/fx，不要用记忆补写隐藏机制。
- 决策数值来自 civi6_eval 的公式组合与计划带（empirical/rule），引用时保留 confidence/source。
- 回答含文明6事实时，末尾加：数据依据：${label} / <entity ids>。
- 用户要另一套规则时，说明需修改插件配置 ruleset 并重载，不能按调用切换。${excluded.length ? `\n- 可选子模组未启用：${excluded.join("、")}。` : ""}`;
}

export function apply(ctx, config = {}) {
  config = config ?? {};

  const configuredRoot = config.workspaceRoot ? String(config.workspaceRoot) : undefined;
  const workspaceRoot = configuredRoot
    ? isAbsolute(configuredRoot)
      ? configuredRoot
      : resolve(PLUGIN_DIR, configuredRoot)
    : undefined;

  const paths = {};
  for (const source of SOURCES) {
    const configured =
      (config.dbPaths && config.dbPaths[source]) ||
      (source === "vanilla" ? config.dbPath : undefined) ||
      (source === "vanilla" ? process.env.CIVI6_DB_PATH : process.env.CIVI6_BBG_DB_PATH) ||
      DEFAULT_DB_PATHS[source];
    paths[source] = resolveDbPath(configured, workspaceRoot);
  }

  const ruleset = normalizeRuleset(config.ruleset ?? config.dataSource ?? process.env.CIVI6_DATA_SOURCE) ?? "vanilla";
  const activePath = paths[ruleset];
  if (!activePath) {
    throw new Error(`civi6-kb: no database path configured for ruleset "${ruleset}"`);
  }
  const strictGrounding = config.strictGrounding !== false;
  const effectCardsRequired = config.effectCardsRequired !== false;
  const summary = readMetaSummary(activePath);
  const label = summary.ruleset?.labelZh ?? ruleset;

  const effectCardsHint = ruleset === "bbg"
    ? " Run `npm run effects:build:bbg` (with the plugin unloaded) to build the effect layer."
    : " Run `npm run effects:build` (with the plugin unloaded) to build the effect layer.";

  function validateKb(kb) {
    const meta = kb.meta();
    const build = meta.build && typeof meta.build === "object" ? meta.build : null;
    if (!meta.ruleset) {
      throw new Error("civi6-kb: database has no _meta.ruleset; rebuild it with `npm run build` / `npm run build:bbg`.");
    }
    if (meta.ruleset.id !== ruleset) {
      throw new Error(
        `civi6-kb: configured ruleset "${ruleset}" but database says "${meta.ruleset.id}" (${meta.dbFile}).`,
      );
    }
    if (build?.dataSource && build.dataSource !== ruleset) {
      throw new Error(
        `civi6-kb: configured ruleset "${ruleset}" but _meta.build.dataSource is "${build.dataSource}".`,
      );
    }
    if (meta.kb?.stale) {
      throw new Error(
        `civi6-kb: decision layer is stale (kb rawBuiltAt != build.builtAt). Rebuild KB for ${ruleset}.`,
      );
    }
    if (effectCardsRequired && (!meta.effectCoverage || meta.effectCoverage.stale)) {
      throw new Error(`civi6-kb: effect layer is missing or stale.${effectCardsHint}`);
    }
    if (ruleset === "bbg" && build?.bbg?.baseBuiltAt && paths.vanilla) {
      const base = readMetaSummary(paths.vanilla);
      if (base.build?.builtAt && base.build.builtAt !== build.bbg.baseBuiltAt) {
        throw new Error(
          "civi6-kb: BBG base is stale (vanilla DB was rebuilt after BBG). " +
            "Unload the plugin and run `npm run rebuild:bbg`.",
        );
      }
    }
    return meta;
  }

  let cachedKb = null;
  function getKb() {
    if (cachedKb) return cachedKb;
    let kb;
    try {
      kb = createKnowledgeBase(activePath, ruleset);
      validateKb(kb);
      cachedKb = kb;
      return kb;
    } catch (error) {
      try {
        kb?.close();
      } catch {
        /* ignore */
      }
      const message = error instanceof Error ? error.message : String(error);
      const hint =
        ruleset === "bbg"
          ? ' Build it with "npm run build:bbg" (run "npm run fetch:bbg" first if BBG sources are missing).'
          : ' Build it with "npm run build".';
      throw new Error(`${message}${hint}`);
    }
  }

  // The model sees the lock in every assembled prompt, not just in tool output.
  ctx.effect(() => {
    const dispose = ctx.systemPrompt.section({
      name: "civi6:ruleset-lock",
      order: 700,
      text: buildRulesetPrompt(summary.ruleset, summary.build),
    });
    return () => dispose();
  });

  // The reasoning contract: answers about "how to play / era planning" must be
  // built from the tool's objective layer, never from memory. The wording is
  // intentionally imperative and cites tool fields so it can be checked.
  ctx.effect(() => {
    const dispose = ctx.systemPrompt.section({
      name: "civi6:reasoning-contract",
      order: 710,
      text: buildReasoningPrompt(),
    });
    return () => dispose();
  });

  // Strict grounding: make direct DB access through the shell fail loudly, and
  // reject any stale per-call source argument on civi6_* tools.
  if (strictGrounding) {
    const activeLower = String(activePath).replace(/\\/g, "/").toLowerCase();
    const allowMaintenance =
      /\bnpm\s+run\s+(build|rebuild|build:bbg|rebuild:bbg|build:all|fetch:bbg|reindex|reindex:bbg|effects:build|effects:build:bbg|kb:build|kb:build:bbg|verify|kb:verify|verify:effects)\b/i;
    ctx.effect(() => {
      const dispose = ctx.tools.guard((exec) => {
        if (typeof exec.name === "string" && exec.name.startsWith("civi6_")) {
          const args = exec.arguments;
          if (args && typeof args === "object" && Object.prototype.hasOwnProperty.call(args, "source")) {
            return "civi6-kb: ruleset is locked by plugin config. Change `ruleset` and reload; per-call source is not allowed.";
          }
          return undefined;
        }
        if (exec.name !== "pwsh" && exec.name !== "bash") return undefined;
        const args = exec.arguments;
        const command = args && typeof args === "object" && typeof args.command === "string" ? args.command : "";
        if (!command) return undefined;
        const normalized = command.replace(/\\/g, "/").toLowerCase();
        const touches =
          normalized.includes(activeLower) ||
          normalized.includes("civi6.sqlite") ||
          normalized.includes("civi6-bbg.sqlite");
        if (!touches) return undefined;
        if (allowMaintenance.test(normalized)) return undefined;
        return (
          `civi6-kb: direct Civ6 database access is disabled by strictGrounding. ` +
          `Active ruleset: ${label}. Use the civi6_* tools instead.`
        );
      });
      return () => dispose();
    });
  }

  // Model-facing surface (3 tools): data once as self-describing classes
  // (instance), arithmetic (eval), provenance (meta).
  // `civi6_sql` is deliberately NOT registered: as long as a raw query escape
  // hatch exists, the packet never has to be good enough — the measured session
  // (62 SQL calls after a complete fetch) is the counterexample.
  // `civi6_entity` is deliberately NOT registered either: with `eff` inlined per
  // row it had no remaining job except shipping the raw modifier chain, which the
  // protocol forbids as an effect source. It stays as an internal QA API (the
  // measured session needed 39 of those calls for ~180KB of text).
  // The old exploration surface (plan / search / entities / modifiers / schema)
  // is no longer registered either: it existed to compensate for the missing packet.
  ctx.tools.register(metaTool(getKb));
  ctx.tools.register(instanceTool(getKb));
  ctx.tools.register(evalTool(getKb));

  ctx.effect(() => () => {
    try {
      cachedKb?.close();
    } catch {
      /* ignore */
    }
    cachedKb = null;
  });
}
