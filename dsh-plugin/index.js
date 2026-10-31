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

/** Hard cap on the JSON a single tool call returns to the model (~3k tokens). */
const MAX_OUTPUT_CHARS = 12000;

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
    clauses.push(`("${spec.pk}" LIKE ? OR "Name" LIKE ?)`);
    params.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  if (type === "belief" && opts.beliefClass) {
    clauses.push(`"BeliefClassType" = ?`);
    params.push(String(opts.beliefClass));
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
    remedy: c.remedy ?? undefined,
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

function round1(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
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

  const out = {
    plan: {
      id: plan.plan_id,
      victory,
      source,
      burstTurn: plan.burst_turn,
      burstEra: plan.burst_era,
      speed,
      difficulty: plan.difficulty,
      summary: plan.summary,
      assumptions: parseJson(plan.assumptions, {}),
    },
    query: { view, era: eraId, detail, speed },
  };

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
  if (detail === "full") {
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
    const entityTypes =
      stats?.entityTypes ??
      SPECS.map((s) => ({
        type: s.type,
        table: s.table,
        count: hasTable(ctx, s.table) ? (q1(ctx, `SELECT COUNT(*) AS n FROM "${s.table}";`)?.n ?? 0) : 0,
      }));
    const tables = stats?.tables ?? [];

    const out = {
      build,
      dbFile: dbPath,
      dataSource: sourceName,
      locked: true,
      tableCount: tables.length || ctx.tables.size,
      searchDocs: stats?.searchDocs ?? indexMeta(ctx).docs ?? 0,
      searchIndex: postingsAvailable(ctx) ? "precomputed" : "in-memory",
      entityTypes,
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
      const rows = q(ctx, finalSql, ...params).map(compactRow);
      return { sql: trimmed, count: rows.length, rows };
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
 * Serialize with a hard size budget. Oversized payloads lose trailing array
 * entries (and say so) instead of being cut mid-JSON.
 */
function largestArray(value) {
  let best = null;
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (Array.isArray(child)) {
        if (child.length > 1 && (!best || child.length > best.value.length)) {
          best = { container: node, key, value: child };
        }
      } else if (child && typeof child === "object") {
        walk(child);
      }
    }
  };
  walk(value);
  return best;
}

function fitPayload(value) {
  const text = JSON.stringify(value);
  if (text.length <= MAX_OUTPUT_CHARS) return text;

  // Shrink the largest nested array until the JSON fits. Keeping valid JSON is
  // more useful to the model than a mid-string cut, and this works for both
  // flat tool payloads and nested plan slices (`burst.blocking`, `ladder[i]`).
  let clone;
  try {
    clone = JSON.parse(text);
  } catch {
    return `${text.slice(0, MAX_OUTPUT_CHARS)}…(truncated)`;
  }
  let out = text;
  for (let guard = 0; guard < 40; guard++) {
    const best = largestArray(clone);
    if (!best) break;
    const keep = Math.max(1, Math.floor(best.value.length / 2));
    best.container[best.key] = best.value.slice(0, keep);
    clone.truncated = true;
    clone.note = `输出超过 ${MAX_OUTPUT_CHARS} 字符预算，已按数组截断；用更小的 limit 或更精确的查询取剩余部分`;
    out = JSON.stringify(clone);
    if (out.length <= MAX_OUTPUT_CHARS) return out;
  }
  return `${out.slice(0, MAX_OUTPUT_CHARS)}…(truncated)`;
}

function textBlock(value) {
  return [{ type: "text", text: fitPayload(value) }];
}

function makeTool(def) {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => textBlock(value),
    },
    async execute(args) {
      return def.execute(args ?? {});
    },
  };
}

function metaTool(getKb) {
  return makeTool({
    name: "civi6_meta",
    description:
      "Active Civilization VI ruleset, build provenance, entity types and effect coverage. Cheap; call once per session. Pass verbose:true only when the full table inventory is needed.",
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

function searchTool(getKb) {
  return makeTool({
    name: "civi6_search",
    description:
      "Lexical (BM25) search over entity documents, Chinese + English, e.g. '学院 相邻加成' or 'nuclear weapon'. Returns ids you can feed straight into civi6_entity. Restrict with type to keep results on target.",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search query, Chinese or English." },
        scope: {
          type: "string",
          enum: ["entity", "plan", "all"],
          description:
            "entity = raw entity and effect docs (default); plan = precomputed decision cards; all = both.",
        },
        type: { type: "string", enum: TYPE_ENUM, description: "Optional entity type to restrict results to (entity scope)." },
        limit: { type: "integer", description: "Max results, 1-100. Default 20." },
      },
      required: ["q"],
    },
    execute: (args) => {
      assertNoSource(args);
      const kb = getKb();
      const scope = args.scope === "plan" || args.scope === "all" ? args.scope : "entity";
      if (scope === "plan") {
        return kb.search(args.q ?? "", { type: "card", scope: "plan", full: true, limit: args.limit });
      }
      if (scope === "all") {
        return kb.search(args.q ?? "", { scope: "all", limit: args.limit });
      }
      return kb.search(args.q ?? "", { type: args.type, scope: "entity", limit: args.limit });
    },
  });
}

function planTool(getKb) {
  return makeTool({
    name: "civi6_plan",
    description:
      "Decision slice for a victory. view='focus' is the reasoning layer: objective capsule, per-era budget ledger (required vs integrated supply per currency, with the gap), named supply sources, ranked cut order with slip cost, scenario band with decision robustness, and 3 era-focus actions per era. Other views: burst (horizontal gates), ladder (vertical era bands), check (checkpoints), civ (civilization board), all. Pass speed='online' to scale turns and tech/civic costs; pass civ/leader to load that civilization's objective when one is authored.",
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
          description: "summary omits formula/provenance; full includes them.",
        },
      },
      required: ["victory"],
    },
    execute: (args) => {
      assertNoSource(args);
      return getKb().plan({
        victory: args.victory,
        civ: args.civ,
        leader: args.leader,
        era: args.era,
        speed: args.speed,
        view: args.view,
        detail: args.detail,
      });
    },
  });
}

function entitiesTool(getKb) {
  return makeTool({
    name: "civi6_entities",
    description:
      "List entities of one type with localized names, curated stats and optional one-line effects. Filter by id/name substring with q. Use effects:true for belief/building lists; use full:true only when every raw column is needed. Items of type='governor_promotion' include governors[] (authoritative owner); type='governor' lists the kit for that governor.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: TYPE_ENUM, description: "Entity type." },
        q: { type: "string", description: "Optional substring filter on id or name." },
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
      },
      required: ["type"],
    },
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
      });
    },
  });
}

function entityTool(getKb) {
  return makeTool({
    name: "civi6_entity",
    description:
      "Canonical detail for one or more entities: official description, stats, localized effects with provenance, and raw modifier details. Accepts exact ids (DISTRICT_CAMPUS) or names (学院, resolved automatically); pass ids:[...] to fetch several at once. effects:'full' returns every effect line; modifiers:'full' adds the raw requirement/argument chain. For type='governor_promotion', governors[] is the authoritative owner list (from GovernorPromotionSets; never infer it from the id); for type='governor', promotions[] is that governor's kit.",
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
    execute: (args) => {
      assertNoSource(args);
      const kb = getKb();
      const ids = Array.isArray(args.ids) && args.ids.length ? args.ids : args.id ? [args.id] : [];
      if (!ids.length) throw new Error("provide id or ids");
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
      "Read-only SQL (SELECT/WITH/EXPLAIN/PRAGMA) against the active ruleset DB for exact numeric checks and table introspection. Returns raw rows, not effect descriptions; use civi6_entity for player-facing effects. Governor ownership: query v_governor_promotion (or civi6_entity type='governor_promotion'); promotion ids keep vanilla prefixes, so the id text is NOT the owner.",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string", description: "Read-only SQL statement (SELECT/WITH/EXPLAIN/PRAGMA)." },
        limit: { type: "integer", description: "Max rows when no LIMIT is present, 1-1000. Default 100." },
      },
      required: ["sql"],
    },
    execute: (args) => {
      assertNoSource(args);
      return getKb().sql(args.sql ?? "", args.limit);
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
  return `## Civ6 推理契约（算账优先，结构决定功能）
“怎么玩 / 时代规划 / 取舍”类问题必须先取结构、再回答；结构来自 civi6_plan(view='focus')，不是记忆。
回答必须包含以下 6 段，缺一段视为未回答：

1. 约束方程：逐时代引用 budget[].required / supply / gap / perTurn，按 gap 从大到小；不许只给节点成本，也不许把未被约束引用的产出当目标。
2. 供给计划：引用 supply[]（来源 / 每回合 / 到位回合 / 价格 / dataRef），说清靠哪些建筑、政策、教条、地块、伟人或总督达成；供给是积分不是常数。总督来源必须引用 civi6_entity(type='governor_promotion') 返回的 governors 归属，不得从晋升 ID 前缀推断。
3. 砍单：只要某时代 gap>0，就必须引用 cut[] 的前 N 项：省多少、代价是什么、目标推迟几回合（slipTurns）；砍完仍不够时直接说“该爆发点不可行”，并给出最早可行时代。
4. 情景：至少引用 scenario[] 的 base 与一个不利情景，说明哪些决策 invariant、哪些 contingent 以及翻盘触发条件（robustness[]）。
5. 路径：只引用 path.onPath / path.detour / path.dead；死路必须带 why；不得凭记忆增删节点。
6. 验收：每时代 checkpoint 数值 + 未达标后的下一步。

规则：
- 目标层未收录或 budget 为空时，明说“数据层未解析/未收录”，改用 view='ladder' 并标注为通用模型；不许凭记忆补时间轴。
- 联机速度：tech/civic 成本按 speed 缩放，回合窗口按 250/500 缩放；引用 cost 时必须用工具返回的数值，不得心算换算。
- 约束紧张度、供给速率、slipTurns 都是决策模型估计，不是游戏规则数值；引用时保留 confidence/source。`;
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
- 效果描述逐字引用 effects[].text_zh；不得改写数字或心算。
- 内部 ID 的前缀不编码归属：例如 GOVERNOR_PROMOTION_EDUCATOR_* 在 BBG 里可能属于其他总督。总督/晋升归属只认 civi6_entity 返回的 governors[]（列表/详情）或 v_governor_promotion 视图，禁止按 ID 前缀、名称片段或旧对话推断。
- effects 是已解析的权威效果；unresolved 只是原始机制审计数据。用户问效果时只引用 effects；若追问隐藏/完整机制且涉及 unresolved，再说明“数据层未解析”，不得补写。
- civi6_plan 的数值是决策模型估计，不是游戏规则数值；引用时保留 confidence/source。
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

  ctx.tools.register(metaTool(getKb));
  ctx.tools.register(planTool(getKb));
  ctx.tools.register(searchTool(getKb));
  ctx.tools.register(entitiesTool(getKb));
  ctx.tools.register(modifiersTool(getKb));
  ctx.tools.register(entityTool(getKb));
  ctx.tools.register(sqlTool(getKb));

  ctx.effect(() => () => {
    try {
      cachedKb?.close();
    } catch {
      /* ignore */
    }
    cachedKb = null;
  });
}
