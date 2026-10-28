import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "civi6-kb";
export const inject = ["tools"];

/** Directory of this plugin file; relative dbPath values are anchored here. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/** The two ruleset databases the plugin can query. */
const SOURCES = ["vanilla", "bbg"];
const DEFAULT_DB_PATHS = {
  vanilla: "../data/civi6.sqlite",
  bbg: "../data/civi6-bbg.sqlite",
};

const SOURCE_PARAM = {
  type: "string",
  enum: SOURCES,
  description:
    "Which ruleset database to query: vanilla (原版) or bbg (BBG). Defaults to the configured data source.",
};

function withSource(properties) {
  return { ...properties, source: SOURCE_PARAM };
}

/** Accept the canonical names plus the Chinese/aliased forms people type. */
function normalizeSource(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const source = String(value).trim().toLowerCase();
  if (source === "vanilla" || source === "原版" || source === "base") return "vanilla";
  if (source === "bbg" || source === "better balanced game") return "bbg";
  throw new Error(`civi6-kb: unknown data source "${value}" (expected "vanilla" or "bbg")`);
}

/** Hard cap on the JSON a single tool call returns to the model (~3k tokens). */
const MAX_OUTPUT_CHARS = 12000;

// ---------------------------------------------------------------------------
// Entity specs (mirrors src/entities.ts SPECS). Each entry describes one
// knowledge-base entity type: its backing table, primary key, localization
// prefix, stat columns, related tables for detail payloads, and how its
// modifier effect chain is resolved.
// ---------------------------------------------------------------------------
const SPECS = [
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

  let where = "";
  const params = [];
  if (opts.q) {
    where = `WHERE "${spec.pk}" LIKE ? OR "Name" LIKE ?`;
    params.push(`%${opts.q}%`, `%${opts.q}%`);
  }
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
  return { total, returned: items.length, offset, items };
}

function collectModifierIds(ctx, spec, id) {
  const directByFk = (table, fk, values) => {
    if (!hasTable(ctx, table) || !values.length) return [];
    return selectIn(ctx, (ph) => `SELECT ModifierId FROM "${table}" WHERE "${fk}" IN (${ph});`, values).map(
      (r) => r.ModifierId,
    );
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
    case "none":
      return [];
    case "direct":
    default: {
      const table = DIRECT_MODIFIER_TABLE[spec.type];
      return table ? directByFk(table, spec.pk, [id]) : [];
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
    const args = (argsByMod.get(mod.ModifierId) ?? []).map(toJson);
    const row = stringByMod.get(mod.ModifierId);
    if (row?.Text) return substitute(row.Text, args);
    const pairs = args
      .filter((a) => typeof a.Name === "string" && a.Value != null)
      .map((a) => `${a.Name}=${prettyValue(a.Value)}`);
    return pairs.length ? `${mod.ModifierType} (${pairs.join(", ")})` : String(mod.ModifierType ?? "");
  }

  function describeRequirement(requirementId) {
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

  const nameTag = row.Name ?? `${spec.loc}${id}_NAME`;
  const descTag = row.Description ?? `${spec.loc}${id}_DESCRIPTION`;
  const zh = localizeMany(ctx, [nameTag, descTag], "zh_Hans_CN");
  const en = localizeMany(ctx, [nameTag, descTag], "en_US");
  detail.name = en(nameTag) ?? id;
  detail.name_zh = zh(nameTag) ?? id;
  if (row.Description) {
    detail.description = en(descTag) ?? null;
    detail.description_zh = zh(descTag) ?? null;
  }

  // Modifier chains can be huge (a single unit pulls in ~46 modifiers), so the
  // default is a one-line summary per modifier; ask for "full" when the whole
  // requirement chain matters.
  const mode = opts.modifiers ?? "summary";
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
    let description;
    if (row?.Text) description = substitute(row.Text, args);
    else {
      const pairs = args
        .filter((a) => typeof a.Name === "string" && a.Value != null)
        .map((a) => `${a.Name}=${pretty(a.Value)}`);
      description = pairs.length ? `${mod.ModifierType} (${pairs.join(", ")})` : String(mod.ModifierType ?? "");
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

  const type = opts.type && specByType.has(opts.type) ? opts.type : undefined;
  const dfByTerm = new Map(
    selectIn(ctx, (ph) => `SELECT term, df FROM search_terms WHERE term IN (${ph});`, terms).map((r) => [r.term, r.df]),
  );
  if (!dfByTerm.size) return [];

  const rows = selectIn(
    ctx,
    (ph) =>
      `SELECT p.term AS term, p.doc_id AS doc_id, p.tf AS tf, d.len AS len
         FROM search_postings p JOIN search_docs d ON d.id = p.doc_id
        WHERE ${type ? "d.type = ? AND " : ""}p.term IN (${ph});`,
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
    scores.set(r.doc_id, (scores.get(r.doc_id) ?? 0) + idf * ((r.tf * (BM25_K1 + 1)) / denom));
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
      return {
        id: d.id,
        type: d.type,
        name: d.name,
        name_zh: d.name_zh,
        score: Math.round(score * 1000) / 1000,
        snippet: String(d.doc ?? "").slice(0, 200),
      };
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
    if (opts.type && d.doc.type !== opts.type) continue;
    let score = 0;
    for (const t of qTokens) {
      const df = index.df.get(t);
      if (df === undefined) continue;
      const tf = d.tf.get(t) ?? 0;
      if (tf === 0) continue;
      const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
      const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * d.len) / (index.avgdl || 1));
      score += idf * ((tf * (BM25_K1 + 1)) / denom);
    }
    if (score > 0) scored.push({ doc: d.doc, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, clampInt(opts.limit, 20, 1, 100)).map((r) => ({
    id: r.doc.id,
    type: r.doc.type,
    name: r.doc.name,
    name_zh: r.doc.name_zh,
    score: Math.round(r.score * 1000) / 1000,
    snippet: r.doc.doc.slice(0, 200),
  }));
}

// ---------------------------------------------------------------------------
// Knowledge base facade
// ---------------------------------------------------------------------------
export function createKnowledgeBase(dbPath) {
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
      tableCount: tables.length || ctx.tables.size,
      searchDocs: stats?.searchDocs ?? indexMeta(ctx).docs ?? 0,
      searchIndex: postingsAvailable(ctx) ? "precomputed" : "in-memory",
      entityTypes,
    };
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

/**
 * Serialize with a hard size budget. Oversized payloads lose trailing array
 * entries (and say so) instead of being cut mid-JSON.
 */
function fitPayload(value) {
  const text = JSON.stringify(value);
  if (text.length <= MAX_OUTPUT_CHARS) return text;

  for (const key of ["items", "rows", "results", "modifiers", "related", "tables"]) {
    const arr = value?.[key];
    if (!Array.isArray(arr) || arr.length < 2) continue;
    let n = arr.length;
    while (n > 1) {
      const candidate = JSON.stringify({
        ...value,
        [key]: arr.slice(0, n),
        truncated: true,
        returned: n,
        note: `输出超过 ${MAX_OUTPUT_CHARS} 字符预算，已截断；用更小的 limit 或更精确的查询取剩余部分`,
      });
      if (candidate.length <= MAX_OUTPUT_CHARS) return candidate;
      n = Math.max(1, Math.floor(n / 2));
    }
  }
  return `${text.slice(0, MAX_OUTPUT_CHARS)}…(truncated)`;
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

function metaTool(getKb, sourceInfo) {
  return makeTool({
    name: "civi6_meta",
    description:
      "Knowledge-base metadata: build info, entity types with row counts, doc count. Also reports the active data source and which sources are available. Cheap; use it once to see what exists. Pass verbose:true only when you truly need the full 450+ table inventory.",
    parameters: {
      type: "object",
      properties: withSource({
        verbose: { type: "boolean", description: "Include the full table list with row counts." },
      }),
      required: [],
    },
    execute: (args) => {
      const source = normalizeSource(args.source) ?? sourceInfo.defaultSource;
      const kb = getKb(source);
      const out = kb.meta({ verbose: args.verbose === true });
      out.dataSource = source;
      out.availableSources = SOURCES.map((name) => ({
        source: name,
        dbFile: sourceInfo.paths[name],
        exists: existsSync(sourceInfo.paths[name]),
      }));
      return out;
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
      properties: withSource({
        q: { type: "string", description: "Search query, Chinese or English." },
        type: { type: "string", enum: TYPE_ENUM, description: "Optional entity type to restrict results to." },
        limit: { type: "integer", description: "Max results, 1-100. Default 20." },
      }),
      required: ["q"],
    },
    execute: (args) => getKb(args.source).search(args.q ?? "", { type: args.type, limit: args.limit }),
  });
}

function entitiesTool(getKb) {
  return makeTool({
    name: "civi6_entities",
    description:
      "List entities of one type with localized names and curated stats (id, name, name_zh, stats). Filter by id/name substring with q. Use full:true only when every raw column is needed; the default limit of 30 keeps responses small.",
    parameters: {
      type: "object",
      properties: withSource({
        type: { type: "string", enum: TYPE_ENUM, description: "Entity type." },
        q: { type: "string", description: "Optional substring filter on id or name." },
        limit: { type: "integer", description: "Max rows, 1-200. Default 30." },
        offset: { type: "integer", description: "Zero-based offset. Default 0." },
        full: { type: "boolean", description: "Return every raw column instead of the curated stats." },
      }),
      required: ["type"],
    },
    execute: (args) =>
      getKb(args.source).listEntities(args.type, {
        q: args.q,
        limit: args.limit,
        offset: args.offset,
        full: args.full === true,
      }),
  });
}

function entityTool(getKb) {
  return makeTool({
    name: "civi6_entity",
    description:
      "Detail for one or more entities: base row, related tables, and a one-line summary per modifier (modifierCount tells you how many there are). Accepts exact ids (DISTRICT_CAMPUS) or names (学院, resolved automatically); pass ids:[...] to fetch several at once instead of calling repeatedly. Use modifiers:'full' for the whole requirement/argument chain, or the civi6_modifiers tool for a paged chain.",
    parameters: {
      type: "object",
      properties: withSource({
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
            "How much of the modifier chain to inline. Default summary; full inlines arguments and requirement sets.",
        },
      }),
      required: ["type"],
    },
    execute: (args) => {
      const kb = getKb(args.source);
      const ids = Array.isArray(args.ids) && args.ids.length ? args.ids : args.id ? [args.id] : [];
      if (!ids.length) throw new Error("provide id or ids");
      const opts = { modifiers: args.modifiers === "full" ? "full" : args.modifiers === "none" ? "none" : "summary" };
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
      "Paged modifier/requirement effect chain for one entity (civilization abilities, leader traits, unit abilities, building/district/policy effects) with localized descriptions, arguments and requirement sets. Units can have dozens; page with offset/limit.",
    parameters: {
      type: "object",
      properties: withSource({
        type: { type: "string", enum: TYPE_ENUM, description: "Entity type." },
        id: { type: "string", description: "Exact entity id." },
        offset: { type: "integer", description: "Zero-based offset. Default 0." },
        limit: { type: "integer", description: "Max modifiers, 1-200. Default 50." },
      }),
      required: ["type", "id"],
    },
    execute: (args) =>
      getKb(args.source).modifiers(args.type, args.id, { offset: args.offset, limit: args.limit }),
  });
}

function sqlTool(getKb) {
  return makeTool({
    name: "civi6_sql",
    description:
      "Read-only SQL (SELECT/WITH/EXPLAIN/PRAGMA) for precise numeric queries and table introspection, e.g. \"SELECT UnitType, Combat FROM Units WHERE Combat >= 60\". Write statements are rejected.",
    parameters: {
      type: "object",
      properties: withSource({
        sql: { type: "string", description: "Read-only SQL statement (SELECT/WITH/EXPLAIN/PRAGMA)." },
        limit: { type: "integer", description: "Max rows when no LIMIT is present, 1-1000. Default 100." },
      }),
      required: ["sql"],
    },
    execute: (args) => getKb(args.source).sql(args.sql ?? "", args.limit),
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
function resolveDbPath(configured) {
  if (!configured) return undefined;
  if (isAbsolute(configured)) return configured;
  const pluginRelative = resolve(PLUGIN_DIR, configured);
  if (existsSync(pluginRelative)) return pluginRelative;
  return resolve(configured);
}

export function apply(ctx, config = {}) {
  config = config ?? {};

  const paths = {};
  for (const source of SOURCES) {
    const configured =
      (config.dbPaths && config.dbPaths[source]) ||
      (source === "vanilla" ? config.dbPath : undefined) ||
      (source === "vanilla" ? process.env.CIVI6_DB_PATH : process.env.CIVI6_BBG_DB_PATH) ||
      DEFAULT_DB_PATHS[source];
    paths[source] = resolveDbPath(configured);
  }
  const defaultSource = normalizeSource(config.dataSource ?? process.env.CIVI6_DATA_SOURCE) ?? "vanilla";

  const kbCache = new Map();
  function getKb(sourceArg) {
    const source = normalizeSource(sourceArg) ?? defaultSource;
    const cached = kbCache.get(source);
    if (cached) return cached;
    try {
      const kb = createKnowledgeBase(paths[source]);
      kbCache.set(source, kb);
      return kb;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint =
        source === "bbg"
          ? ' Build it with "npm run build:bbg" (run "npm run fetch:bbg" first if BBG sources are missing).'
          : ' Build it with "npm run build".';
      throw new Error(`${message}${hint}`);
    }
  }

  const sourceInfo = { defaultSource, paths };
  ctx.tools.register(metaTool(getKb, sourceInfo));
  ctx.tools.register(searchTool(getKb));
  ctx.tools.register(entitiesTool(getKb));
  ctx.tools.register(modifiersTool(getKb));
  ctx.tools.register(entityTool(getKb));
  ctx.tools.register(sqlTool(getKb));

  ctx.effect(() => () => {
    for (const kb of kbCache.values()) {
      try {
        kb.close();
      } catch {
        /* ignore */
      }
    }
    kbCache.clear();
  });
}
