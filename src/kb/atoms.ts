import type { KnowledgeDb } from "../db.js";
import type { DataSource } from "../config.js";

/**
 * L1 atomic layer: normalise the raw mirror's direct facts into three
 * query-friendly tables.
 *
 *   kb_effect  entity -> yield (flat / powered / adjacency / trade route / GPP)
 *   kb_cost    entity -> production, gold, faith, upkeep
 *   kb_unlock  entity -> prerequisite (tech / civic / district / building / resource / era)
 *
 * Deliberately does NOT try to resolve the full Modifier/Requirement graph;
 * complex conditional effects stay in the raw tables and are reachable through
 * the existing `civi6_modifiers` tool.
 */

export interface AtomStats {
  effects: number;
  costs: number;
  unlocks: number;
}

const YIELD_DIM: Record<string, string> = {
  YIELD_SCIENCE: "science_per_turn",
  YIELD_CULTURE: "culture_per_turn",
  YIELD_FAITH: "faith_per_turn",
  YIELD_GOLD: "gold_per_turn",
  YIELD_PRODUCTION: "production_per_turn",
  YIELD_FOOD: "food_per_turn",
  YIELD_TOURISM: "tourism_per_turn",
  YIELD_DIPLOMATIC_FAVOR: "favor_per_turn",
  YIELD_GREAT_PERSON_POINTS: "great_person_points",
  YIELD_HOUSING: "housing",
  YIELD_AMENITIES: "amenities",
};

function yieldDimension(yieldType: unknown): string {
  const raw = String(yieldType ?? "").trim();
  if (!raw) return "unknown";
  return (
    YIELD_DIM[raw] ??
    `yield_${raw.toLowerCase().replace(/^yield_/, "").replace(/[^a-z0-9_]/g, "_")}`
  );
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

function insertMany(
  kb: KnowledgeDb,
  table: string,
  columns: string[],
  rows: unknown[][],
): number {
  if (!rows.length) return 0;
  const sql = `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns
    .map(() => "?")
    .join(", ")});`;
  const stmt = kb.db.prepare(sql);
  kb.begin();
  try {
    for (const row of rows) {
      stmt.run(
        ...row.map((v) => {
          if (v === undefined) return null;
          if (typeof v === "boolean") return v ? 1 : 0;
          if (typeof v === "number") return v;
          if (v === null) return null;
          return typeof v === "string" ? v : JSON.stringify(v);
        }),
      );
    }
  } finally {
    kb.commit();
  }
  return rows.length;
}

interface Edge {
  childKind: string;
  childId: string;
  parentKind: string;
  parentId: string;
  relation: string;
  sourceTable: string;
}

function addEdges(kb: KnowledgeDb, edges: Edge[]): number {
  const seen = new Set<string>();
  const rows: unknown[][] = [];
  for (const e of edges) {
    if (!e.childId || !e.parentId) continue;
    const key = `${e.childKind}|${e.childId}|${e.parentKind}|${e.parentId}|${e.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([e.childKind, e.childId, e.parentKind, e.parentId, e.relation, e.sourceTable]);
  }
  return insertMany(
    kb,
    "kb_unlock",
    ["child_kind", "child_id", "parent_kind", "parent_id", "relation", "source_table"],
    rows,
  );
}

function buildEffects(kb: KnowledgeDb): number {
  const rows: unknown[][] = [];
  const push = (
    ownerKind: string,
    ownerId: unknown,
    dimension: string,
    effectKind: string,
    value: unknown,
    value2: unknown,
    condition: unknown,
    reqSet: unknown,
    sourceTable: string,
    sourcePk: unknown,
    sourceCol: string,
  ) => {
    const id = str(ownerId);
    const n = num(value);
    if (!id || n === null || n === 0) return;
    rows.push([
      ownerKind,
      id,
      dimension,
      effectKind,
      n,
      num(value2),
      str(condition),
      str(reqSet),
      sourceTable,
      str(sourcePk),
      sourceCol,
      1.0,
    ]);
  };

  if (kb.hasTable("Building_YieldChanges")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT BuildingType, YieldType, YieldChange FROM Building_YieldChanges;`,
    )) {
      push("building", r.BuildingType, yieldDimension(r.YieldType), "flat", r.YieldChange, null, null, null,
        "Building_YieldChanges", r.BuildingType, "YieldChange");
    }
  }
  if (kb.hasTable("Building_YieldChangesBonusWithPower")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT BuildingType, YieldType, YieldChange FROM Building_YieldChangesBonusWithPower;`,
    )) {
      push("building", r.BuildingType, yieldDimension(r.YieldType), "powered", r.YieldChange, null, "powered", null,
        "Building_YieldChangesBonusWithPower", r.BuildingType, "YieldChange");
    }
  }
  if (kb.hasTable("District_CitizenYieldChanges")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT DistrictType, YieldType, YieldChange FROM District_CitizenYieldChanges;`,
    )) {
      push("district", r.DistrictType, yieldDimension(r.YieldType), "per_citizen", r.YieldChange, null, null, null,
        "District_CitizenYieldChanges", r.DistrictType, "YieldChange");
    }
  }
  if (kb.hasTable("District_Adjacencies") && kb.hasTable("Adjacency_YieldChanges")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT d.DistrictType, a.*
         FROM District_Adjacencies d JOIN Adjacency_YieldChanges a ON a.ID = d.YieldChangeId;`,
    )) {
      const condition: Record<string, unknown> = {};
      for (const key of [
        "TilesRequired", "OtherDistrictAdjacent", "AdjacentSeaResource", "AdjacentTerrain",
        "AdjacentFeature", "AdjacentRiver", "AdjacentWonder", "AdjacentNaturalWonder",
        "AdjacentImprovement", "AdjacentDistrict", "AdjacentResource", "AdjacentResourceClass",
        "Self", "Description",
      ]) {
        if (r[key] !== null && r[key] !== undefined && r[key] !== "") condition[key] = r[key];
      }
      push("district", r.DistrictType, yieldDimension(r.YieldType), "adjacency", r.YieldChange,
        r.TilesRequired, JSON.stringify(condition), null, "Adjacency_YieldChanges", r.ID, "YieldChange");
    }
  }
  if (kb.hasTable("Building_GreatPersonPoints")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT BuildingType, GreatPersonClassType, PointsPerTurn FROM Building_GreatPersonPoints;`,
    )) {
      push("building", r.BuildingType, "great_person_points", "gpp", r.PointsPerTurn, null,
        str(r.GreatPersonClassType), null, "Building_GreatPersonPoints", r.BuildingType, "PointsPerTurn");
    }
  }
  if (kb.hasTable("District_GreatPersonPoints")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT DistrictType, GreatPersonClassType, PointsPerTurn FROM District_GreatPersonPoints;`,
    )) {
      push("district", r.DistrictType, "great_person_points", "gpp", r.PointsPerTurn, null,
        str(r.GreatPersonClassType), null, "District_GreatPersonPoints", r.DistrictType, "PointsPerTurn");
    }
  }
  if (kb.hasTable("District_TradeRouteYields")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT DistrictType, YieldType, YieldChangeAsOrigin, YieldChangeAsDomesticDestination,
              YieldChangeAsInternationalDestination FROM District_TradeRouteYields;`,
    )) {
      const dim = yieldDimension(r.YieldType);
      push("district", r.DistrictType, dim, "trade_route", r.YieldChangeAsOrigin, null, "origin",
        null, "District_TradeRouteYields", r.DistrictType, "YieldChangeAsOrigin");
      push("district", r.DistrictType, dim, "trade_route", r.YieldChangeAsDomesticDestination, null,
        "domestic_destination", null, "District_TradeRouteYields", r.DistrictType, "YieldChangeAsDomesticDestination");
      push("district", r.DistrictType, dim, "trade_route", r.YieldChangeAsInternationalDestination, null,
        "international_destination", null, "District_TradeRouteYields", r.DistrictType, "YieldChangeAsInternationalDestination");
    }
  }
  for (const [table, kind, fk] of [
    ["Improvement_YieldChanges", "improvement", "ImprovementType"],
    ["Resource_YieldChanges", "resource", "ResourceType"],
    ["Feature_YieldChanges", "feature", "FeatureType"],
    ["Terrain_YieldChanges", "terrain", "TerrainType"],
    ["GreatWork_YieldChanges", "greatwork", "GreatWorkType"],
  ] as const) {
    if (!kb.hasTable(table)) continue;
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT "${fk}" AS owner, YieldType, YieldChange FROM "${table}";`,
    )) {
      push(kind, r.owner, yieldDimension(r.YieldType), "flat", r.YieldChange, null, null, null,
        table, r.owner, "YieldChange");
    }
  }

  return insertMany(
    kb,
    "kb_effect",
    ["owner_kind", "owner_id", "dimension_id", "effect_kind", "value", "value2", "condition",
      "requirement_set_id", "source_table", "source_pk", "source_col", "confidence"],
    rows,
  );
}

function buildCosts(kb: KnowledgeDb): number {
  const rows: unknown[][] = [];
  const goldMultiplier = num(
    kb.get<{ Value: string }>(`SELECT Value FROM GlobalParameters WHERE Name = 'GOLD_PURCHASE_MULTIPLIER';`)?.Value,
  ) ?? 2;

  const add = (
    refKind: string,
    refId: unknown,
    currency: string,
    amount: unknown,
    opts: {
      basis?: string;
      progressionModel?: unknown;
      progressionParam?: unknown;
      purchaseMultiplier?: number | null;
      isPerTurn?: boolean;
      sourceTable: string;
      sourceCol: string;
    },
  ) => {
    const id = str(refId);
    const n = num(amount);
    if (!id || n === null || n === 0) return;
    rows.push([
      refKind, id, currency, Math.abs(n), opts.basis ?? "flat",
      str(opts.progressionModel), num(opts.progressionParam),
      opts.purchaseMultiplier ?? null, null, opts.isPerTurn ? 1 : 0,
      opts.sourceTable, opts.sourceCol, 1.0,
    ]);
  };

  for (const r of kb.all<Record<string, unknown>>(
    `SELECT UnitType, Cost, Maintenance, CostProgressionModel, CostProgressionParam1, PurchaseYield
       FROM Units;`,
  )) {
    const cost = num(r.Cost);
    add("unit", r.UnitType, "production", cost, {
      basis: r.CostProgressionModel ? "progress" : "flat",
      progressionModel: r.CostProgressionModel,
      progressionParam: r.CostProgressionParam1,
      purchaseMultiplier: r.PurchaseYield === "YIELD_GOLD" ? goldMultiplier : null,
      sourceTable: "Units", sourceCol: "Cost",
    });
    if (cost && cost > 0) {
      const isFaith = r.PurchaseYield === "YIELD_FAITH";
      add("unit", r.UnitType, isFaith ? "faith" : "gold", cost * (isFaith ? 1 : goldMultiplier), {
        basis: "purchase",
        purchaseMultiplier: isFaith ? 1 : goldMultiplier,
        sourceTable: "Units", sourceCol: "Cost",
      });
    }
    add("unit", r.UnitType, "gold", r.Maintenance, {
      basis: "per_turn", isPerTurn: true, sourceTable: "Units", sourceCol: "Maintenance",
    });
  }
  for (const r of kb.all<Record<string, unknown>>(
    `SELECT BuildingType, Cost, Maintenance, PurchaseYield, IsWonder FROM Buildings;`,
  )) {
    const cost = num(r.Cost);
    add("building", r.BuildingType, "production", cost, {
      purchaseMultiplier: r.PurchaseYield === "YIELD_GOLD" ? goldMultiplier : null,
      sourceTable: "Buildings", sourceCol: "Cost",
    });
    if (cost && cost > 0 && !Number(r.IsWonder)) {
      const isFaith = r.PurchaseYield === "YIELD_FAITH";
      add("building", r.BuildingType, isFaith ? "faith" : "gold", cost * (isFaith ? 1 : goldMultiplier), {
        basis: "purchase",
        purchaseMultiplier: isFaith ? 1 : goldMultiplier,
        sourceTable: "Buildings", sourceCol: "Cost",
      });
    }
    add("building", r.BuildingType, "gold", r.Maintenance, {
      basis: "per_turn", isPerTurn: true, sourceTable: "Buildings", sourceCol: "Maintenance",
    });
  }
  for (const r of kb.all<Record<string, unknown>>(
    `SELECT DistrictType, Cost, Maintenance, CostProgressionModel, CostProgressionParam1 FROM Districts;`,
  )) {
    add("district", r.DistrictType, "production", r.Cost, {
      basis: r.CostProgressionModel ? "progress" : "flat",
      progressionModel: r.CostProgressionModel,
      progressionParam: r.CostProgressionParam1,
      sourceTable: "Districts", sourceCol: "Cost",
    });
    add("district", r.DistrictType, "gold", r.Maintenance, {
      basis: "per_turn", isPerTurn: true, sourceTable: "Districts", sourceCol: "Maintenance",
    });
  }
  for (const r of kb.all<Record<string, unknown>>(`SELECT ProjectType, Cost FROM Projects;`)) {
    add("project", r.ProjectType, "production", r.Cost, {
      sourceTable: "Projects", sourceCol: "Cost",
    });
  }

  return insertMany(
    kb,
    "kb_cost",
    ["ref_kind", "ref_id", "currency", "amount", "basis", "progression_model", "progression_param",
      "purchase_multiplier", "era_id", "is_per_turn", "source_table", "source_col", "confidence"],
    rows,
  );
}

function buildUnlocks(kb: KnowledgeDb): number {
  const edges: Edge[] = [];
  const add = (
    childKind: string, childId: unknown, parentKind: string, parentId: unknown,
    relation: string, sourceTable: string,
  ) => {
    const c = str(childId);
    const p = str(parentId);
    if (c && p) edges.push({ childKind, childId: c, parentKind, parentId: p, relation, sourceTable });
  };

  for (const r of kb.all<Record<string, unknown>>(
    `SELECT TechnologyType, EraType FROM Technologies;`,
  )) {
    add("tech", r.TechnologyType, "era", r.EraType, "era", "Technologies");
  }
  if (kb.hasTable("TechnologyPrereqs")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT Technology, PrereqTech FROM TechnologyPrereqs;`,
    )) add("tech", r.Technology, "tech", r.PrereqTech, "tech", "TechnologyPrereqs");
  }
  for (const r of kb.all<Record<string, unknown>>(`SELECT CivicType, EraType FROM Civics;`)) {
    add("civic", r.CivicType, "era", r.EraType, "era", "Civics");
  }
  if (kb.hasTable("CivicPrereqs")) {
    for (const r of kb.all<Record<string, unknown>>(`SELECT Civic, PrereqCivic FROM CivicPrereqs;`)) {
      add("civic", r.Civic, "civic", r.PrereqCivic, "civic", "CivicPrereqs");
    }
  }
  for (const r of kb.all<Record<string, unknown>>(
    `SELECT DistrictType, PrereqTech, PrereqCivic FROM Districts;`,
  )) {
    add("district", r.DistrictType, "tech", r.PrereqTech, "tech", "Districts");
    add("district", r.DistrictType, "civic", r.PrereqCivic, "civic", "Districts");
  }
  for (const r of kb.all<Record<string, unknown>>(
    `SELECT BuildingType, PrereqTech, PrereqCivic, PrereqDistrict FROM Buildings;`,
  )) {
    add("building", r.BuildingType, "tech", r.PrereqTech, "tech", "Buildings");
    add("building", r.BuildingType, "civic", r.PrereqCivic, "civic", "Buildings");
    add("building", r.BuildingType, "district", r.PrereqDistrict, "district", "Buildings");
  }
  if (kb.hasTable("BuildingPrereqs")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT Building, PrereqBuilding FROM BuildingPrereqs;`,
    )) add("building", r.Building, "building", r.PrereqBuilding, "building", "BuildingPrereqs");
  }
  for (const r of kb.all<Record<string, unknown>>(
    `SELECT ProjectType, PrereqTech, PrereqCivic, PrereqDistrict, RequiredBuilding FROM Projects;`,
  )) {
    add("project", r.ProjectType, "tech", r.PrereqTech, "tech", "Projects");
    add("project", r.ProjectType, "civic", r.PrereqCivic, "civic", "Projects");
    add("project", r.ProjectType, "district", r.PrereqDistrict, "district", "Projects");
    add("project", r.ProjectType, "building", r.RequiredBuilding, "building", "Projects");
  }
  for (const r of kb.all<Record<string, unknown>>(
    `SELECT UnitType, PrereqTech, PrereqCivic, PrereqDistrict, StrategicResource FROM Units;`,
  )) {
    add("unit", r.UnitType, "tech", r.PrereqTech, "tech", "Units");
    add("unit", r.UnitType, "civic", r.PrereqCivic, "civic", "Units");
    add("unit", r.UnitType, "district", r.PrereqDistrict, "district", "Units");
    add("unit", r.UnitType, "resource", r.StrategicResource, "resource", "Units");
  }
  for (const r of kb.all<Record<string, unknown>>(
    `SELECT PolicyType, PrereqCivic, PrereqTech FROM Policies;`,
  )) {
    add("policy", r.PolicyType, "civic", r.PrereqCivic, "civic", "Policies");
    add("policy", r.PolicyType, "tech", r.PrereqTech, "tech", "Policies");
  }
  for (const r of kb.all<Record<string, unknown>>(
    `SELECT GovernmentType, PrereqCivic FROM Governments;`,
  )) add("government", r.GovernmentType, "civic", r.PrereqCivic, "civic", "Governments");
  for (const r of kb.all<Record<string, unknown>>(
    `SELECT ImprovementType, PrereqTech, PrereqCivic FROM Improvements;`,
  )) {
    add("improvement", r.ImprovementType, "tech", r.PrereqTech, "tech", "Improvements");
    add("improvement", r.ImprovementType, "civic", r.PrereqCivic, "civic", "Improvements");
  }
  if (kb.hasTable("UnitReplaces")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT CivUniqueUnitType, ReplacesUnitType FROM UnitReplaces;`,
    )) add("unit", r.CivUniqueUnitType, "unit", r.ReplacesUnitType, "replaces", "UnitReplaces");
  }
  if (kb.hasTable("BuildingReplaces")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT CivUniqueBuildingType, ReplacesBuildingType FROM BuildingReplaces;`,
    )) add("building", r.CivUniqueBuildingType, "building", r.ReplacesBuildingType, "replaces", "BuildingReplaces");
  }
  if (kb.hasTable("DistrictReplaces")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT CivUniqueDistrictType, ReplacesDistrictType FROM DistrictReplaces;`,
    )) add("district", r.CivUniqueDistrictType, "district", r.ReplacesDistrictType, "replaces", "DistrictReplaces");
  }

  return addEdges(kb, edges);
}

/** Rebuild the L1 atom tables for the current database. */
export function buildAtoms(kb: KnowledgeDb, _source: DataSource): AtomStats {
  kb.exec(`DELETE FROM kb_effect; DELETE FROM kb_cost; DELETE FROM kb_unlock;`);
  const effects = buildEffects(kb);
  const costs = buildCosts(kb);
  const unlocks = buildUnlocks(kb);
  return { effects, costs, unlocks };
}
