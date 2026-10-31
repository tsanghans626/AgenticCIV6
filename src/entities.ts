import type { KnowledgeDb } from "./db.js";

export type ModifierResolverName =
  | "direct"
  | "unit"
  | "civilization"
  | "leader"
  | "greatperson"
  | "belief"
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
  {
    type: "belief", table: "Beliefs", pk: "BeliefType", loc: "LOC_BELIEF_",
    stats: ["BeliefClassType"],
    related: [{ table: "BeliefModifiers", fk: "BeliefType" }],
    docTables: [],
    modifierResolver: "belief",
  },
  {
    // Governor ownership is a separate relation (GovernorPromotionSets), not a
    // property of the promotion id. BBG reassigns promotions between governors
    // while keeping the vanilla id prefix, so the promotion entity must expose
    // its owners explicitly instead of letting callers infer them from the id.
    type: "governor", table: "Governors", pk: "GovernorType", loc: "LOC_GOVERNOR_",
    stats: [],
    related: [{ table: "GovernorPromotionSets", fk: "GovernorType" }],
    docTables: [],
    modifierResolver: "none",
  },
  {
    type: "governor_promotion", table: "GovernorPromotions", pk: "GovernorPromotionType", loc: "LOC_GOVERNOR_PROMOTION_",
    stats: ["Level", "Column"],
    related: [{ table: "GovernorPromotionSets", fk: "GovernorPromotion" }],
    docTables: [],
    modifierResolver: "direct",
  },
];

/**
 * The one join that defines governor ownership: a promotion can belong to zero
 * or more governors (GovernorPromotionSets), and the id prefix is never
 * authoritative. The search document and the SQL view below expose the same
 * relation.
 */
const GOVERNOR_OWNER_SQL = `
  SELECT s.GovernorPromotion AS promotion, s.GovernorType AS governor
    FROM GovernorPromotionSets s
    JOIN Governors g ON g.GovernorType = s.GovernorType;`;

/** Create the raw-SQL compatibility view so ad-hoc queries cannot read the id prefix as ownership. */
function ensureGovernorView(kb: KnowledgeDb): void {
  if (
    !kb.hasTable("GovernorPromotions") ||
    !kb.hasTable("GovernorPromotionSets") ||
    !kb.hasTable("Governors")
  ) {
    return;
  }
  kb.exec(`DROP VIEW IF EXISTS "v_governor_promotion";`);
  kb.exec(`
    CREATE VIEW "v_governor_promotion" AS
    SELECT p.GovernorPromotionType AS promotion_id,
           p.Level AS level,
           p."Column" AS promotion_column,
           s.GovernorType AS governor_id,
           (SELECT Text FROM LocalizedText WHERE Tag = p.Name AND Language = 'zh_Hans_CN' LIMIT 1) AS name_zh,
           (SELECT Text FROM LocalizedText WHERE Tag = p.Description AND Language = 'zh_Hans_CN' LIMIT 1) AS description_zh,
           (SELECT Text FROM LocalizedText WHERE Tag = g.Name AND Language = 'zh_Hans_CN' LIMIT 1) AS governor_name_zh
      FROM GovernorPromotions p
      LEFT JOIN GovernorPromotionSets s ON s.GovernorPromotion = p.GovernorPromotionType
      LEFT JOIN Governors g ON g.GovernorType = s.GovernorType;
  `);
}

interface GovernorDocContext {
  ownersByPromotion: Map<string, string[]>;
  promotionsByGovernor: Map<string, string[]>;
}

/** Build the localized id -> label maps once per index rebuild. */
function buildGovernorDocContext(kb: KnowledgeDb, nameIndex: Map<string, NameIndexEntry>): GovernorDocContext {
  const ownersByPromotion = new Map<string, string[]>();
  const promotionsByGovernor = new Map<string, string[]>();
  if (!kb.hasTable("GovernorPromotionSets") || !kb.hasTable("Governors")) {
    return { ownersByPromotion, promotionsByGovernor };
  }
  const label = (id: string) => {
    const e = nameIndex.get(id);
    return e ? `${e.zh}（${id}）` : id;
  };
  for (const row of kb.all<{ promotion: string; governor: string }>(GOVERNOR_OWNER_SQL)) {
    const owner = label(row.governor);
    const list = ownersByPromotion.get(row.promotion) ?? [];
    if (!list.includes(owner)) list.push(owner);
    ownersByPromotion.set(row.promotion, list);
    const promotions = promotionsByGovernor.get(row.governor) ?? [];
    const promotion = label(row.promotion);
    if (!promotions.includes(promotion)) promotions.push(promotion);
    promotionsByGovernor.set(row.governor, promotions);
  }
  return { ownersByPromotion, promotionsByGovernor };
}

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
  governorContext?: GovernorDocContext,
): string {
  const id = String(row[spec.pk]);
  const en = localize(kb, row.Name ?? `${spec.loc}${id}_NAME`, "en_US") ?? id;
  const zh = localize(kb, row.Name ?? `${spec.loc}${id}_NAME`, "zh_Hans_CN") ?? en;
  const card = kb.hasTable("effect_cards")
    ? kb.get<{ description_zh: string | null; description_en: string | null; effects_json: string | null }>(
        `SELECT description_zh, description_en, effects_json FROM effect_cards WHERE card_id = ?;`,
        `${spec.type}:${id}`,
      )
    : undefined;
  const descEn = card?.description_en ?? (row.Description ? localize(kb, row.Description, "en_US") ?? "" : "");
  const descZh = card?.description_zh ?? (row.Description ? localize(kb, row.Description, "zh_Hans_CN") ?? "" : "");

  const chunks: string[] = [en, zh];
  // Ownership goes before the long description so a 200-char search snippet
  // still answers "whose promotion is this?".
  if (spec.type === "governor_promotion" && governorContext) {
    const owners = governorContext.ownersByPromotion.get(id);
    if (owners?.length) chunks.push(`归属：${owners.join("、")}`);
  }
  if (spec.type === "governor" && governorContext) {
    const promotions = governorContext.promotionsByGovernor.get(id);
    if (promotions?.length) chunks.push(`晋升：${promotions.join("、")}`);
  }
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

  // The build-time effect layer is the canonical, player-facing text. Append it
  // so BM25 can find "神社 +2 生产力" without the model having to know tables.
  if (card?.effects_json) {
    try {
      for (const effect of JSON.parse(card.effects_json) as { text_zh?: string; text_en?: string }[]) {
        if (effect.text_zh && !chunks.includes(effect.text_zh)) chunks.push(effect.text_zh);
        if (effect.text_en && !chunks.includes(effect.text_en)) chunks.push(effect.text_en);
      }
    } catch {
      /* corrupted card: entity doc still works */
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
  // A BBG build starts from a copy of the vanilla DB; clear stale entity
  // documents before rebuilding so deleted entities cannot linger. Plan cards
  // are owned by the KB layer and must survive an entity-index rebuild.
  kb.db.exec(`DELETE FROM "search_docs" WHERE "type" <> 'card';`);
  ensureGovernorView(kb);
  const nameIndex = buildNameIndex(kb);
  const governorContext = buildGovernorDocContext(kb, nameIndex);
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
        const doc = buildDoc(kb, spec, row, nameIndex, governorContext);
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


