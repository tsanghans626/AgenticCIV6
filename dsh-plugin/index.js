import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const name = "civi6-kb";
export const inject = ["tools"];

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

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------
function all(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

function get(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function hasTable(db, name) {
  return !!get(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;", name);
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

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n)) return def;
  return Math.min(Math.max(n, min), max);
}

// ---------------------------------------------------------------------------
// Localization
// ---------------------------------------------------------------------------
function localize(db, tag, lang) {
  if (typeof tag !== "string" || tag.length === 0) return undefined;
  const row = get(db, "SELECT Text FROM LocalizedText WHERE Tag = ? AND Language = ? LIMIT 1;", tag, lang);
  if (row?.Text) return row.Text;
  if (lang !== "en_US") {
    const en = get(db, "SELECT Text FROM LocalizedText WHERE Tag = ? AND Language = 'en_US' LIMIT 1;", tag);
    if (en?.Text) return en.Text;
  }
  return undefined;
}

function entityName(db, spec, id, lang) {
  const row = get(db, `SELECT * FROM "${spec.table}" WHERE "${spec.pk}" = ?;`, id);
  const tag = row?.Name ?? `${spec.loc}${id}_NAME`;
  return localize(db, tag, lang) ?? id;
}

function entityDescription(db, spec, id, lang) {
  const row = get(db, `SELECT * FROM "${spec.table}" WHERE "${spec.pk}" = ?;`, id);
  const tag = row?.Description ?? `${spec.loc}${id}_DESCRIPTION`;
  return localize(db, tag, lang);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------
function listEntities(db, type, opts = {}) {
  const spec = specByType.get(type);
  if (!spec || !hasTable(db, spec.table)) return { total: 0, items: [] };
  const limit = clampInt(opts.limit, 50, 1, 500);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const lang = opts.lang || "zh_Hans_CN";

  let where = "";
  const params = [];
  if (opts.q) {
    where = `WHERE "${spec.pk}" LIKE ? OR "${spec.table}"."Name" LIKE ?`;
    params.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  const total = get(db, `SELECT COUNT(*) AS n FROM "${spec.table}" ${where};`, ...params)?.n ?? 0;
  const rows = all(
    db,
    `SELECT * FROM "${spec.table}" ${where} ORDER BY "${spec.pk}" LIMIT ? OFFSET ?;`,
    ...params,
    limit,
    offset,
  );
  const items = rows.map((row) => {
    const id = String(row[spec.pk]);
    return toJson({
      id,
      type,
      name: localize(db, row.Name ?? `${spec.loc}${id}_NAME`, "en_US") ?? id,
      name_zh: localize(db, row.Name ?? `${spec.loc}${id}_NAME`, "zh_Hans_CN") ?? id,
      ...row,
    });
  });
  return { total, items };
}

function getEntityDetail(db, type, id, lang = "zh_Hans_CN") {
  const spec = specByType.get(type);
  if (!spec || !hasTable(db, spec.table)) return undefined;
  const row = get(db, `SELECT * FROM "${spec.table}" WHERE "${spec.pk}" = ?;`, id);
  if (!row) return undefined;

  const related = {};
  for (const r of spec.related) {
    if (!hasTable(db, r.table)) continue;
    related[r.table] = all(db, `SELECT * FROM "${r.table}" WHERE "${r.fk}" = ?;`, id).map(toJson);
  }

  const modifierIds = collectModifierIds(db, spec, id);
  const modifiers = resolveModifiers(db, modifierIds);

  return toJson({
    id,
    type,
    name: localize(db, row.Name ?? `${spec.loc}${id}_NAME`, "en_US") ?? id,
    name_zh: localize(db, row.Name ?? `${spec.loc}${id}_NAME`, "zh_Hans_CN") ?? id,
    description: row.Description ? (localize(db, row.Description, "en_US") ?? null) : null,
    description_zh: row.Description ? (localize(db, row.Description, "zh_Hans_CN") ?? null) : null,
    row: row,
    related,
    modifiers,
  });
}

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------
function substitute(text, args) {
  let out = text;
  for (const a of args) {
    if (typeof a.Name === "string" && a.Value != null) {
      out = out.replaceAll(`{${a.Name}}`, String(a.Value));
    }
  }
  return out;
}

function prettyValue(db, v) {
  const s = String(v);
  if (s.startsWith("YIELD_")) {
    const name = get(db, "SELECT Text FROM LocalizedText WHERE Tag = ? AND Language = 'zh_Hans_CN' LIMIT 1;", `LOC_${s}_NAME`);
    if (name?.Text) return `${name.Text}(${s})`;
  }
  if (s.startsWith("LOC_")) {
    const name = get(db, "SELECT Text FROM LocalizedText WHERE Tag = ? AND Language = 'zh_Hans_CN' LIMIT 1;", s);
    if (name?.Text) return name.Text;
  }
  return s;
}

function describeModifier(db, modifierId, modifierType, args) {
  if (hasTable(db, "ModifierStrings")) {
    const row =
      get(db, "SELECT Text FROM ModifierStrings WHERE ModifierId = ? AND Context = 'Summary' LIMIT 1;", modifierId) ??
      get(db, "SELECT Text FROM ModifierStrings WHERE ModifierId = ? LIMIT 1;", modifierId);
    if (row?.Text) return substitute(row.Text, args);
  }
  const parts = args
    .filter((a) => typeof a.Name === "string" && a.Value != null)
    .map((a) => `${a.Name}=${prettyValue(db, a.Value)}`);
  return parts.length ? `${modifierType} (${parts.join(", ")})` : modifierType;
}

function describeRequirement(db, requirementId, args) {
  if (!hasTable(db, "RequirementStrings")) return undefined;
  const row =
    get(db, "SELECT Text FROM RequirementStrings WHERE RequirementId = ? AND Context = 'Summary' LIMIT 1;", requirementId) ??
    get(db, "SELECT Text FROM RequirementStrings WHERE RequirementId = ? LIMIT 1;", requirementId);
  return row?.Text ? substitute(row.Text, args) : undefined;
}

function resolveRequirementSet(db, setId) {
  if (!hasTable(db, "RequirementSets")) return null;
  const set = get(db, "SELECT * FROM RequirementSets WHERE RequirementSetId = ?;", setId);
  if (!set) return null;

  const reqs = hasTable(db, "RequirementSetRequirements")
    ? all(db, "SELECT RequirementId FROM RequirementSetRequirements WHERE RequirementSetId = ?;", setId)
    : [];
  const requirements = reqs.map((r) => {
    const req = get(db, "SELECT * FROM Requirements WHERE RequirementId = ?;", r.RequirementId);
    const args = hasTable(db, "RequirementArguments")
      ? all(db, "SELECT * FROM RequirementArguments WHERE RequirementId = ?;", r.RequirementId).map(toJson)
      : [];
    return {
      requirementId: r.RequirementId,
      requirementType: req?.RequirementType ?? null,
      description: describeRequirement(db, r.RequirementId, args) ?? null,
      arguments: args,
    };
  });
  return { requirementSetId: setId, requirementSetType: set.RequirementSetType, requirements };
}

function resolveModifiers(db, modifierIds) {
  const out = [];
  const seen = new Set();
  if (!hasTable(db, "Modifiers")) return out;

  for (const mid of modifierIds) {
    if (!mid || seen.has(mid)) continue;
    seen.add(mid);
    const mod = get(db, "SELECT * FROM Modifiers WHERE ModifierId = ?;", mid);
    if (!mod) continue;
    const args = hasTable(db, "ModifierArguments")
      ? all(db, "SELECT * FROM ModifierArguments WHERE ModifierId = ?;", mid).map(toJson)
      : [];
    const ownerId = typeof mod.OwnerRequirementSetId === "string" ? mod.OwnerRequirementSetId : null;
    const subjectId = typeof mod.SubjectRequirementSetId === "string" ? mod.SubjectRequirementSetId : null;
    out.push({
      modifierId: mid,
      modifierType: String(mod.ModifierType ?? ""),
      description: describeModifier(db, mid, String(mod.ModifierType ?? ""), args) ?? null,
      runOnce: mod.RunOnce ?? null,
      permanent: mod.Permanent ?? null,
      ownerRequirementSetId: ownerId,
      subjectRequirementSetId: subjectId,
      ownerRequirement: ownerId ? resolveRequirementSet(db, ownerId) : null,
      subjectRequirement: subjectId ? resolveRequirementSet(db, subjectId) : null,
      arguments: args,
    });
  }
  return out;
}

function collectModifierIds(db, spec, id) {
  const directByFk = (table, fk, value) =>
    hasTable(db, table)
      ? all(db, `SELECT ModifierId FROM "${table}" WHERE "${fk}" = ?;`, value).map((r) => r.ModifierId)
      : [];

  switch (spec.modifierResolver) {
    case "unit": {
      const unitTags = hasTable(db, "TypeTags")
        ? all(db, "SELECT Tag FROM TypeTags WHERE Type = ?;", id).map((r) => r.Tag)
        : [];
      if (unitTags.length === 0) return [];
      const placeholders = unitTags.map(() => "?").join(",");
      const abilities = all(
        db,
        `SELECT Type FROM TypeTags WHERE Tag IN (${placeholders}) AND Type IN (SELECT UnitAbilityType FROM UnitAbilities);`,
        ...unitTags,
      );
      if (abilities.length === 0) return [];
      const aPlaceholders = abilities.map(() => "?").join(",");
      return all(
        db,
        `SELECT ModifierId FROM UnitAbilityModifiers WHERE UnitAbilityType IN (${aPlaceholders});`,
        ...abilities.map((a) => a.Type),
      ).map((r) => r.ModifierId);
    }
    case "civilization": {
      const traits = hasTable(db, "CivilizationTraits")
        ? all(db, "SELECT TraitType FROM CivilizationTraits WHERE CivilizationType = ?;", id).map((r) => r.TraitType)
        : [];
      const out = [];
      for (const traitId of traits) out.push(...directByFk("TraitModifiers", "TraitType", traitId));
      return out;
    }
    case "leader": {
      const traits = hasTable(db, "LeaderTraits")
        ? all(db, "SELECT TraitType FROM LeaderTraits WHERE LeaderType = ?;", id).map((r) => r.TraitType)
        : [];
      const out = [];
      for (const traitId of traits) out.push(...directByFk("TraitModifiers", "TraitType", traitId));
      return out;
    }
    case "greatperson": {
      return [
        ...directByFk("GreatPersonIndividualBirthModifiers", "GreatPersonIndividualType", id),
        ...directByFk("GreatPersonIndividualActionModifiers", "GreatPersonIndividualType", id),
      ];
    }
    case "none":
      return [];
    case "direct":
    default: {
      const table = DIRECT_MODIFIER_TABLE[spec.type];
      return table ? directByFk(table, spec.pk, id) : [];
    }
  }
}

// ---------------------------------------------------------------------------
// BM25 search (offline lexical search over search_docs)
// ---------------------------------------------------------------------------
function tokenize(text) {
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

function buildBm25(docs) {
  const df = new Map();
  const bmDocs = docs.map((doc) => {
    const tokens = tokenize(doc.doc);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return { doc, tokens: tf, len: tokens.length };
  });
  const avgdl = bmDocs.length ? bmDocs.reduce((s, d) => s + d.len, 0) / bmDocs.length : 1;
  return { docs: bmDocs, df, avgdl, N: bmDocs.length };
}

const K1 = 1.5;
const B = 0.75;

function rankBm25(index, query, limit) {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const scored = [];
  for (const d of index.docs) {
    let score = 0;
    for (const t of new Set(qTokens)) {
      const df = index.df.get(t);
      if (df === undefined) continue;
      const tf = d.tokens.get(t) ?? 0;
      if (tf === 0) continue;
      const idf = Math.log(1 + (index.N - df + 0.5) / (df + 0.5));
      const denom = tf + K1 * (1 - B + (B * d.len) / index.avgdl);
      score += idf * ((tf * (K1 + 1)) / denom);
    }
    if (score > 0) scored.push({ doc: d.doc, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Knowledge base facade
// ---------------------------------------------------------------------------
export function createKnowledgeBase(dbPath) {
  if (!isAbsolute(dbPath)) dbPath = resolve(dbPath);
  if (!existsSync(dbPath)) {
    throw new Error(`civi6-kb: database file not found: ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });

  // Lazily built search index cache (the DB is read-only and static).
  let docsCache = null;
  let indexCache = null;
  function loadIndex() {
    if (indexCache) return indexCache;
    const rows = all(db, "SELECT id, type, name, name_zh, doc FROM search_docs;");
    docsCache = rows.map((r) => ({
      id: String(r.id),
      type: String(r.type),
      name: String(r.name ?? ""),
      name_zh: String(r.name_zh ?? ""),
      doc: String(r.doc ?? ""),
    }));
    indexCache = buildBm25(docsCache);
    return indexCache;
  }

  return {
    db,

    meta() {
      const buildRow = get(db, "SELECT value FROM _meta WHERE key = 'build';");
      const tables = all(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")
        .map((r) => ({ name: r.name, rows: get(db, `SELECT COUNT(*) AS n FROM "${r.name}";`)?.n ?? 0 }));
      const entityTypes = SPECS.map((s) => ({
        type: s.type,
        table: s.table,
        count: hasTable(db, s.table) ? get(db, `SELECT COUNT(*) AS n FROM "${s.table}";`)?.n ?? 0 : 0,
      }));
      return {
        build: buildRow?.value ? (() => { try { return JSON.parse(buildRow.value); } catch { return buildRow.value; } })() : null,
        dbFile: dbPath,
        tableCount: tables.length,
        tables,
        entityTypes,
      };
    },

    search(query, opts = {}) {
      const limit = clampInt(opts.limit, 20, 1, 100);
      loadIndex();
      let docs = docsCache;
      if (opts.type) docs = docs.filter((d) => d.type === opts.type);
      const index = buildBm25(docs);
      const results = rankBm25(index, query, limit).map((r) => ({
        id: r.doc.id,
        type: r.doc.type,
        name: r.doc.name,
        name_zh: r.doc.name_zh,
        score: Math.round(r.score * 1000) / 1000,
        snippet: r.doc.doc.slice(0, 240),
      }));
      return { query, embedding: false, count: results.length, results };
    },

    listEntities(type, opts = {}) {
      return listEntities(db, type, opts);
    },

    entityDetail(type, id, lang = "zh_Hans_CN") {
      return getEntityDetail(db, type, id, lang);
    },

    modifiers(type, id) {
      const spec = specByType.get(type);
      if (!spec) throw new Error(`unknown entity type: ${type}`);
      const modifierIds = collectModifierIds(db, spec, id);
      const modifiers = resolveModifiers(db, modifierIds);
      return { type, id, count: modifiers.length, modifiers };
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
      const rows = all(db, finalSql, ...params).map(toJson);
      return { sql: trimmed, count: rows.length, rows };
    },

    close() {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TYPE_ENUM = ENTITY_TYPES;
const LANG_ENUM = ["zh_Hans_CN", "en_US"];

function textBlock(value) {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

function looseObjectSchema() {
  return { type: "object", additionalProperties: true };
}

function makeTool(def) {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    output: {
      schema: looseObjectSchema(),
      render: (_args, value) => textBlock(value),
    },
    async execute(args) {
      return def.execute(args);
    },
  };
}

function metaTool(getKb) {
  return makeTool({
    name: "civi6_meta",
    description:
      "Get the Civilization VI knowledge base metadata: build info, the inventory of tables (name + row count), and the entity types with their row counts. Use this to discover what data is available before querying.",
    parameters: { type: "object", properties: {}, required: [] },
    execute: () => getKb().meta(),
  });
}

function searchTool(getKb) {
  return makeTool({
    name: "civi6_search",
    description:
      "Full-text search the Civilization VI knowledge base (Chinese and English) using BM25 lexical search over entity documents. Returns matching entities with relevance scores and text snippets. Use this for concept lookups like '学院 相邻加成' or 'nuclear weapon'.",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search query, Chinese or English." },
        type: { type: "string", enum: TYPE_ENUM, description: "Optional entity type to restrict results to." },
        limit: { type: "integer", description: "Max results, 1-100. Default 20." },
      },
      required: ["q"],
    },
    execute: (args) => getKb().search(args.q, { type: args.type, limit: args.limit }),
  });
}

function entitiesTool(getKb) {
  return makeTool({
    name: "civi6_entities",
    description:
      "List entities of one type (unit, building, district, civilization, leader, trait, technology, civic, policy, government, improvement, resource, terrain, feature, greatperson). Optionally filter by an id/name substring. Returns localized Chinese and English names plus the raw columns.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: TYPE_ENUM, description: "Entity type." },
        q: { type: "string", description: "Optional substring filter on id or name." },
        limit: { type: "integer", description: "Max rows, 1-500. Default 50." },
        offset: { type: "integer", description: "Zero-based offset. Default 0." },
        lang: { type: "string", enum: LANG_ENUM, description: "Preferred name language. Default zh_Hans_CN." },
      },
      required: ["type"],
    },
    execute: (args) => getKb().listEntities(args.type, { q: args.q, limit: args.limit, offset: args.offset, lang: args.lang }),
  });
}

function entityTool(getKb) {
  return makeTool({
    name: "civi6_entity",
    description:
      "Get the full detail for one entity: its base row, related tables (e.g. yield changes, prerequisites, tags), and its resolved modifier effect chain. Provide the entity type and its exact id (e.g. type 'district', id 'DISTRICT_CAMPUS').",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: TYPE_ENUM, description: "Entity type." },
        id: { type: "string", description: "Exact entity id, e.g. DISTRICT_CAMPUS, UNIT_WARRIOR, CIVILIZATION_KOREA." },
        lang: { type: "string", enum: LANG_ENUM, description: "Preferred description language. Default zh_Hans_CN." },
      },
      required: ["type", "id"],
    },
    execute: (args) => {
      const detail = getKb().entityDetail(args.type, args.id, args.lang || "zh_Hans_CN");
      if (!detail) throw new Error(`entity not found: ${args.type}/${args.id}`);
      return detail;
    },
  });
}

function modifiersTool(getKb) {
  return makeTool({
    name: "civi6_modifiers",
    description:
      "Get the modifier/requirement effect chain for one entity (civilization abilities, leader traits, unit abilities, building/district/policy effects, etc.). Returns resolved modifiers with localized descriptions and requirement sets.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: TYPE_ENUM, description: "Entity type." },
        id: { type: "string", description: "Exact entity id." },
      },
      required: ["type", "id"],
    },
    execute: (args) => getKb().modifiers(args.type, args.id),
  });
}

function sqlTool(getKb) {
  return makeTool({
    name: "civi6_sql",
    description:
      "Run a read-only SQL query against the Civilization VI knowledge base (SQLite). Only SELECT/WITH/EXPLAIN/PRAGMA are allowed; write operations are rejected and the connection itself is read-only. Use for precise numeric queries (e.g. 'SELECT UnitType, Combat FROM Units WHERE Combat >= 60') and for table introspection (e.g. \"PRAGMA table_info('Units')\").",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string", description: "Read-only SQL statement (SELECT/WITH/EXPLAIN/PRAGMA)." },
        limit: { type: "integer", description: "Max rows when no LIMIT is present in the SQL, 1-1000. Default 100." },
      },
      required: ["sql"],
    },
    execute: (args) => getKb().sql(args.sql, args.limit),
  });
}

// ---------------------------------------------------------------------------
// Host plugin entry
// ---------------------------------------------------------------------------
export function apply(ctx, config = {}) {
  const dbPath = config.dbPath || process.env.CIVI6_DB_PATH;

  let kb = null;
  function getKb() {
    if (kb) return kb;
    if (!dbPath) {
      throw new Error(
        "civi6-kb: no database path configured. Set config.dbPath in the bundle patch " +
          "(e.g. /path/to/civi6/data/civi6.sqlite) or set the CIVI6_DB_PATH environment variable.",
      );
    }
    kb = createKnowledgeBase(dbPath);
    return kb;
  }

  ctx.tools.register(metaTool(getKb));
  ctx.tools.register(searchTool(getKb));
  ctx.tools.register(entitiesTool(getKb));
  ctx.tools.register(entityTool(getKb));
  ctx.tools.register(modifiersTool(getKb));
  ctx.tools.register(sqlTool(getKb));

  ctx.effect(() => () => {
    try {
      kb?.close();
    } catch {
      /* ignore */
    }
  });
}
