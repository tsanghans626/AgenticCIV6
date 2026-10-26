import type { KnowledgeDb } from "./db.js";

export type ModifierResolverName =
  | "direct"
  | "unit"
  | "civilization"
  | "leader"
  | "greatperson"
  | "none";

export interface EntitySpec {
  type: string;
  table: string;
  pk: string;
  loc: string;
  stats: string[];
  /** related tables included in the detail payload */
  related: { table: string; fk: string }[];
  /** tables rendered into the search document */
  docTables: { table: string; fk: string; valueCol: string; mode: "entity" | "yield"; amountCol?: string }[];
  modifierResolver: ModifierResolverName;
}

export const SPECS: EntitySpec[] = [
  {
    type: "unit", table: "Units", pk: "UnitType", loc: "LOC_UNIT_",
    stats: ["Cost","Combat","RangedCombat","BaseMoves","BaseSightRange","Maintenance","Domain","FormationClass","PromotionClass","PrereqTech","PrereqCivic","StrategicResource","Range","Bombard","AirSlots","AntiAirCombat","ReligiousStrength","SpreadCharges","BuildCharges"],
    related: [
      { table: "UnitUpgrades", fk: "Unit" },
      { table: "UnitReplaces", fk: "CivUniqueUnitType" },
      { table: "TypeTags", fk: "Type" },
    ],
    docTables: [
      { table: "UnitUpgrades", fk: "Unit", valueCol: "UpgradeUnit", mode: "entity" },
      { table: "UnitReplaces", fk: "CivUniqueUnitType", valueCol: "ReplacesUnitType", mode: "entity" },
      { table: "TypeTags", fk: "Type", valueCol: "Tag", mode: "entity" },
    ],
    modifierResolver: "unit",
  },
  {
    type: "building", table: "Buildings", pk: "BuildingType", loc: "LOC_BUILDING_",
    stats: ["Cost","Maintenance","PrereqDistrict","PrereqTech","PrereqCivic","Housing","Entertainment","RegionalRange","IsWonder","CitizenSlots","OuterDefenseStrength","DefenseModifier"],
    related: [
      { table: "Building_YieldChanges", fk: "BuildingType" },
      { table: "Building_GreatPersonPoints", fk: "BuildingType" },
      { table: "BuildingPrereqs", fk: "Building" },
    ],
    docTables: [
      { table: "Building_YieldChanges", fk: "BuildingType", valueCol: "YieldType", mode: "yield", amountCol: "YieldChange" },
      { table: "Building_GreatPersonPoints", fk: "BuildingType", valueCol: "GreatPersonClassType", mode: "entity", amountCol: "PointsPerTurn" },
    ],
    modifierResolver: "direct",
  },
  {
    type: "district", table: "Districts", pk: "DistrictType", loc: "LOC_DISTRICT_",
    stats: ["Cost","Maintenance","PrereqTech","PrereqCivic","RequiresPopulation","OnePerCity","Aqueduct","InternalOnly","ZOC","Housing","CitizenSlots","AirSlots"],
    related: [
      { table: "District_Adjacencies", fk: "DistrictType" },
      { table: "District_CitizenYieldChanges", fk: "DistrictType" },
      { table: "District_TradeRouteYields", fk: "DistrictType" },
    ],
    docTables: [
      { table: "District_CitizenYieldChanges", fk: "DistrictType", valueCol: "YieldType", mode: "yield", amountCol: "YieldChange" },
    ],
    modifierResolver: "direct",
  },
  {
    type: "civilization", table: "Civilizations", pk: "CivilizationType", loc: "LOC_CIVILIZATION_",
    stats: ["Adjective","Ethnicity"],
    related: [
      { table: "CivilizationTraits", fk: "CivilizationType" },
      { table: "CivilizationLeaders", fk: "CivilizationType" },
    ],
    docTables: [
      { table: "CivilizationTraits", fk: "CivilizationType", valueCol: "TraitType", mode: "entity" },
      { table: "CivilizationLeaders", fk: "CivilizationType", valueCol: "LeaderType", mode: "entity" },
    ],
    modifierResolver: "civilization",
  },
  {
    type: "leader", table: "Leaders", pk: "LeaderType", loc: "LOC_LEADER_",
    stats: ["InheritFrom","Sex","SameSexPercentage"],
    related: [{ table: "LeaderTraits", fk: "LeaderType" }],
    docTables: [{ table: "LeaderTraits", fk: "LeaderType", valueCol: "TraitType", mode: "entity" }],
    modifierResolver: "leader",
  },
  {
    type: "trait", table: "Traits", pk: "TraitType", loc: "LOC_TRAIT_",
    stats: ["InternalOnly"],
    related: [],
    docTables: [],
    modifierResolver: "direct",
  },
  {
    type: "technology", table: "Technologies", pk: "TechnologyType", loc: "LOC_TECH_",
    stats: ["Cost","EraType","UITreeRow","Critical"],
    related: [
      { table: "TechnologyPrereqs", fk: "Technology" },
      { table: "Boosts", fk: "TechnologyType" },
    ],
    docTables: [
      { table: "TechnologyPrereqs", fk: "Technology", valueCol: "PrereqTech", mode: "entity" },
      { table: "Boosts", fk: "TechnologyType", valueCol: "Boost", mode: "entity" },
    ],
    modifierResolver: "direct",
  },
  {
    type: "civic", table: "Civics", pk: "CivicType", loc: "LOC_CIVIC_",
    stats: ["Cost","EraType","UITreeRow"],
    related: [
      { table: "CivicPrereqs", fk: "Civic" },
      { table: "Boosts", fk: "CivicType" },
    ],
    docTables: [
      { table: "CivicPrereqs", fk: "Civic", valueCol: "PrereqCivic", mode: "entity" },
      { table: "Boosts", fk: "CivicType", valueCol: "Boost", mode: "entity" },
    ],
    modifierResolver: "direct",
  },
  {
    type: "policy", table: "Policies", pk: "PolicyType", loc: "LOC_POLICY_",
    stats: ["GovernmentSlotType","PrereqCivic","PrereqTech","RequiresGovernmentUnlock"],
    related: [],
    docTables: [],
    modifierResolver: "direct",
  },
  {
    type: "government", table: "Governments", pk: "GovernmentType", loc: "LOC_GOVERNMENT_",
    stats: ["PrereqCivic","Tier","OtherGovernmentIntolerance","InfluencePointsPerTurn"],
    related: [{ table: "Government_SlotCounts", fk: "GovernmentType" }],
    docTables: [{ table: "Government_SlotCounts", fk: "GovernmentType", valueCol: "GovernmentSlotType", mode: "entity", amountCol: "NumSlots" }],
    modifierResolver: "direct",
  },
  {
    type: "improvement", table: "Improvements", pk: "ImprovementType", loc: "LOC_IMPROVEMENT_",
    stats: ["PrereqTech","PrereqCivic","Buildable","Housing","Appeal","DefenseModifier","OnePerCity","Domain"],
    related: [
      { table: "Improvement_YieldChanges", fk: "ImprovementType" },
      { table: "Improvement_ValidTerrains", fk: "ImprovementType" },
      { table: "Improvement_ValidFeatures", fk: "ImprovementType" },
      { table: "Improvement_ValidResources", fk: "ImprovementType" },
    ],
    docTables: [
      { table: "Improvement_YieldChanges", fk: "ImprovementType", valueCol: "YieldType", mode: "yield", amountCol: "YieldChange" },
    ],
    modifierResolver: "direct",
  },
  {
    type: "resource", table: "Resources", pk: "ResourceType", loc: "LOC_RESOURCE_",
    stats: ["ResourceClassType","Happiness","Frequency","PrereqTech","PrereqCivic"],
    related: [{ table: "Resource_YieldChanges", fk: "ResourceType" }],
    docTables: [{ table: "Resource_YieldChanges", fk: "ResourceType", valueCol: "YieldType", mode: "yield", amountCol: "YieldChange" }],
    modifierResolver: "none",
  },
  {
    type: "terrain", table: "Terrains", pk: "TerrainType", loc: "LOC_TERRAIN_",
    stats: ["MovementCost","DefenseModifier","Appeal","Mountain","Hills","Water","Impassable"],
    related: [{ table: "Terrain_YieldChanges", fk: "TerrainType" }],
    docTables: [{ table: "Terrain_YieldChanges", fk: "TerrainType", valueCol: "YieldType", mode: "yield", amountCol: "YieldChange" }],
    modifierResolver: "none",
  },
  {
    type: "feature", table: "Features", pk: "FeatureType", loc: "LOC_FEATURE_",
    stats: ["NaturalWonder","DefenseModifier","Appeal","Impassable","Removable","Forest"],
    related: [{ table: "Feature_YieldChanges", fk: "FeatureType" }],
    docTables: [{ table: "Feature_YieldChanges", fk: "FeatureType", valueCol: "YieldType", mode: "yield", amountCol: "YieldChange" }],
    modifierResolver: "none",
  },
  {
    type: "greatperson", table: "GreatPersonIndividuals", pk: "GreatPersonIndividualType", loc: "LOC_GREAT_PERSON_INDIVIDUAL_",
    stats: ["GreatPersonClassType","EraType","ActionCharges"],
    related: [],
    docTables: [],
    modifierResolver: "greatperson",
  },
];

/** Localize a text tag for a language (fallback to English, then raw tag). */
export function localize(kb: KnowledgeDb, tag: unknown, lang: string): string | undefined {
  if (typeof tag !== "string" || tag.length === 0) return undefined;
  const row = kb.get<{ Text: string }>(
    `SELECT Text FROM LocalizedText WHERE Tag = ? AND Language = ? LIMIT 1;`,
    tag,
    lang,
  );
  if (row?.Text) return row.Text;
  if (lang !== "en_US") {
    const en = kb.get<{ Text: string }>(`SELECT Text FROM LocalizedText WHERE Tag = ? AND Language = 'en_US' LIMIT 1;`, tag);
    if (en?.Text) return en.Text;
  }
  return undefined;
}

function yieldName(kb: KnowledgeDb, yieldType: string, lang: string): string {
  return localize(kb, `LOC_YIELD_${yieldType}_NAME`, lang) ?? yieldType;
}

function renderStats(row: Record<string, unknown>, columns: string[]): string {
  const parts: string[] = [];
  for (const c of columns) {
    const v = row[c];
    if (v === null || v === undefined || v === "" || v === false) continue;
    parts.push(`${c} ${v}`);
  }
  return parts.join(", ");
}

interface NameIndexEntry { en: string; zh: string }

function buildNameIndex(kb: KnowledgeDb): Map<string, NameIndexEntry> {
  const idx = new Map<string, NameIndexEntry>();
  for (const spec of SPECS) {
    if (!kb.hasTable(spec.table)) continue;
    const rows = kb.all<Record<string, unknown>>(`SELECT * FROM "${spec.table}";`);
    for (const row of rows) {
      const id = row[spec.pk];
      if (typeof id !== "string") continue;
      const tag = row.Name ?? `${spec.loc}${id}_NAME`;
      idx.set(id, {
        en: localize(kb, tag, "en_US") ?? id,
        zh: localize(kb, tag, "zh_Hans_CN") ?? localize(kb, tag, "en_US") ?? id,
      });
    }
  }
  return idx;
}

function resolveRef(kb: KnowledgeDb, nameIndex: Map<string, NameIndexEntry>, v: unknown): string {
  if (typeof v !== "string") return "";
  const e = nameIndex.get(v);
  if (e) return e.zh !== e.en ? `${e.en}/${e.zh}` : e.en;
  if (v.startsWith("LOC_")) return localize(kb, v, "zh_Hans_CN") ?? v;
  return v;
}

function buildDoc(
  kb: KnowledgeDb,
  spec: EntitySpec,
  row: Record<string, unknown>,
  nameIndex: Map<string, NameIndexEntry>,
): string {
  const id = String(row[spec.pk]);
  const en = localize(kb, row.Name ?? `${spec.loc}${id}_NAME`, "en_US") ?? id;
  const zh = localize(kb, row.Name ?? `${spec.loc}${id}_NAME`, "zh_Hans_CN") ?? en;
  const descEn = row.Description ? localize(kb, row.Description, "en_US") ?? "" : "";
  const descZh = row.Description ? localize(kb, row.Description, "zh_Hans_CN") ?? "" : "";

  const chunks: string[] = [en, zh];
  if (descEn) chunks.push(descEn);
  if (descZh) chunks.push(descZh);
  const stats = renderStats(row, spec.stats);
  if (stats) chunks.push(stats);

  for (const dt of spec.docTables) {
    if (!kb.hasTable(dt.table)) continue;
    const related = kb.all<Record<string, unknown>>(
      `SELECT * FROM "${dt.table}" WHERE "${dt.fk}" = ?;`,
      id,
    );
    for (const r of related) {
      if (dt.mode === "yield") {
        const yn = yieldName(kb, String(r[dt.valueCol]), "en_US");
        const amt = dt.amountCol ? r[dt.amountCol] : undefined;
        chunks.push(`${yn}${amt !== undefined && amt !== null && amt !== "" ? " " + amt : ""}`);
      } else {
        const name = resolveRef(kb, nameIndex, r[dt.valueCol]);
        const amt = dt.amountCol ? r[dt.amountCol] : undefined;
        chunks.push(`${name}${amt !== undefined && amt !== null && amt !== "" ? " " + amt : ""}`);
      }
    }
  }

  // District adjacency is a two-hop relation (District_Adjacencies -> Adjacency_YieldChanges).
  if (spec.type === "district" && kb.hasTable("District_Adjacencies") && kb.hasTable("Adjacency_YieldChanges")) {
    const adjs = kb.all<{ YieldChangeId: string }>(
      `SELECT YieldChangeId FROM District_Adjacencies WHERE DistrictType = ?;`,
      id,
    );
    for (const a of adjs) {
      const adj = kb.get<Record<string, unknown>>(`SELECT * FROM Adjacency_YieldChanges WHERE ID = ?;`, a.YieldChangeId);
      if (!adj) continue;
      const desc = adj.Description ? localize(kb, adj.Description, "zh_Hans_CN") ?? "" : "";
      const yn = yieldName(kb, String(adj.YieldType ?? ""), "en_US");
      const amt = adj.YieldChange;
      const t = desc ? `${desc} ${yn} ${amt}` : `${yn} ${amt}`;
      chunks.push(t.trim());
    }
  }
  return chunks.filter(Boolean).join("\n");
}

/** Build the entity index: search_docs table + populated docs. Returns doc count. */
export function buildEntityIndex(kb: KnowledgeDb): number {
  kb.db.exec(`
    CREATE TABLE IF NOT EXISTS "search_docs" (
      "id" TEXT PRIMARY KEY,
      "type" TEXT NOT NULL,
      "name" TEXT,
      "name_zh" TEXT,
      "doc" TEXT,
      "meta" TEXT
    );
  `);
  const nameIndex = buildNameIndex(kb);
  const ins = kb.db.prepare(
    `INSERT OR REPLACE INTO "search_docs" ("id","type","name","name_zh","doc","meta") VALUES (?,?,?,?,?,?);`,
  );
  let count = 0;
  kb.begin();
  try {
    for (const spec of SPECS) {
      if (!kb.hasTable(spec.table)) continue;
      const rows = kb.all<Record<string, unknown>>(`SELECT * FROM "${spec.table}";`);
      for (const row of rows) {
        const id = String(row[spec.pk]);
        const en = localize(kb, row.Name ?? `${spec.loc}${id}_NAME`, "en_US") ?? id;
        const zh = localize(kb, row.Name ?? `${spec.loc}${id}_NAME`, "zh_Hans_CN") ?? en;
        const doc = buildDoc(kb, spec, row, nameIndex);
        const meta = JSON.stringify({ type: spec.type, id });
        ins.run(`${spec.type}:${id}`, spec.type, en, zh, doc, meta);
        count++;
      }
    }
  } finally {
    kb.commit();
  }
  return count;
}


