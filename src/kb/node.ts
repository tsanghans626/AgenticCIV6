import type { KnowledgeDb } from "../db.js";
import type { Labeler } from "./labels.js";

/**
 * L2a: unified node space.
 *
 * Techs, civics, units, districts, buildings, policies, governments and
 * projects are normalised into ONE table so the path/constraint layers can
 * reason about "the critical path" without per-kind special cases. Era and
 * cost come from the raw mirror; `kb_cost` supplies production/gold, the
 * Technologies/Civics tables supply science/culture.
 *
 * `cost_basis` is deliberately explicit:
 *   flat       — fixed table cost
 *   progress   — district/unit cost that scales with tech progress (formula
 *                itself is not resolved in the DB; only model+param are known)
 *   unresolved — derived from a parameter pair we do not model
 */
export interface NodeStats {
  nodes: number;
  /** Nodes that carry an inspiration/eureka row (coverage probe). */
  boosted: number;
}

interface NodeRow {
  kind: string;
  id: string;
  era_id: string | null;
  era_index: number | null;
  cost_production: number | null;
  cost_science: number | null;
  cost_culture: number | null;
  cost_gold: number | null;
  cost_faith: number | null;
  cost_basis: string;
  boost_percent?: number | null;
  boost_trigger_zh?: string | null;
}

const KIND_TABLES: Array<[string, string, string]> = [
  ["unit", "Units", "UnitType"],
  ["building", "Buildings", "BuildingType"],
  ["district", "Districts", "DistrictType"],
  ["policy", "Policies", "PolicyType"],
  ["government", "Governments", "GovernmentType"],
  ["project", "Projects", "ProjectType"],
  ["improvement", "Improvements", "ImprovementType"],
];

export function buildNodes(kb: KnowledgeDb, labeler: Labeler): NodeStats {
  kb.exec(`DELETE FROM kb_node;`);
  const eraIndex = new Map<string, number>();
  if (kb.hasTable("Eras")) {
    for (const r of kb.all<{ EraType: string; ChronologyIndex: number }>(
      `SELECT EraType, ChronologyIndex FROM Eras;`,
    )) {
      if (r.EraType) eraIndex.set(r.EraType, Number(r.ChronologyIndex) || 0);
    }
  }

  const rows = new Map<string, NodeRow>();
  const put = (row: NodeRow) => {
    if (!row.id) return;
    const key = `${row.kind}\u0000${row.id}`;
    const prev = rows.get(key);
    if (prev) {
      // Merge: keep the first non-null value per cost column.
      for (const k of ["cost_production", "cost_science", "cost_culture", "cost_gold", "cost_faith"] as const) {
        if (prev[k] === null && row[k] !== null) prev[k] = row[k];
      }
      if (!prev.era_id && row.era_id) {
        prev.era_id = row.era_id;
        prev.era_index = row.era_index;
      }
      return;
    }
    rows.set(key, row);
  };

  // tech / civic: era + science/culture cost straight from the mirror.
  for (const r of kb.all<{ id: string; era: string | null; cost: number | null }>(
    `SELECT TechnologyType AS id, EraType AS era, Cost AS cost FROM Technologies;`,
  )) {
    put({
      kind: "tech", id: r.id,
      era_id: r.era, era_index: r.era ? eraIndex.get(r.era) ?? null : null,
      cost_production: null, cost_science: Number(r.cost) || null,
      cost_culture: null, cost_gold: null, cost_faith: null, cost_basis: "flat",
    });
  }
  for (const r of kb.all<{ id: string; era: string | null; cost: number | null }>(
    `SELECT CivicType AS id, EraType AS era, Cost AS cost FROM Civics;`,
  )) {
    put({
      kind: "civic", id: r.id,
      era_id: r.era, era_index: r.era ? eraIndex.get(r.era) ?? null : null,
      cost_production: null, cost_science: null,
      cost_culture: Number(r.cost) || null, cost_gold: null, cost_faith: null, cost_basis: "flat",
    });
  }

  // production/gold/faith cost for every other kind, from kb_cost.
  for (const r of kb.all<{
    ref_kind: string; ref_id: string; currency: string; amount: number;
    basis: string; is_per_turn: number;
  }>(
    `SELECT ref_kind, ref_id, currency, amount, basis, is_per_turn FROM kb_cost;`,
  )) {
    if (Number(r.is_per_turn)) continue;
    if (!["unit", "building", "district", "policy", "government", "project", "improvement"].includes(r.ref_kind)) continue;
    const key = `${r.ref_kind}\u0000${r.ref_id}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        kind: r.ref_kind, id: r.ref_id, era_id: null, era_index: null,
        cost_production: null, cost_science: null, cost_culture: null,
        cost_gold: null, cost_faith: null,
        cost_basis: r.basis === "progress" ? "progress" : "flat",
      };
      rows.set(key, row);
    }
    if (r.basis === "progress") row.cost_basis = "progress";
    if (r.currency === "production") row.cost_production = Number(r.amount);
    else if (r.currency === "gold") row.cost_gold = Number(r.amount);
    else if (r.currency === "faith") row.cost_faith = Number(r.amount);
  }

  // Ensure every entity kind exists even without a cost row (e.g. Project with Cost 0).
  for (const [kind, table, pk] of KIND_TABLES) {
    if (!kb.hasTable(table)) continue;
    for (const r of kb.all<Record<string, unknown>>(`SELECT "${pk}" AS id FROM "${table}";`)) {
      if (!r.id) continue;
      const key = `${kind}\u0000${r.id}`;
      if (!rows.has(key)) {
        rows.set(key, {
          kind, id: String(r.id), era_id: null, era_index: null,
          cost_production: null, cost_science: null, cost_culture: null,
          cost_gold: null, cost_faith: null, cost_basis: "flat",
        });
      }
    }
  }

  // Era for non-tech nodes: inherit the highest era among direct tech/civic parents.
  const directEra = new Map<string, number>();
  if (kb.hasTable("kb_unlock")) {
    for (const r of kb.all<{ child_kind: string; child_id: string; parent_id: string }>(
      `SELECT child_kind, child_id, parent_id FROM kb_unlock WHERE relation IN ('tech','civic');`,
    )) {
      const parentKey = `tech\u0000${r.parent_id}`;
      const altKey = `civic\u0000${r.parent_id}`;
      const parent = rows.get(parentKey) ?? rows.get(altKey);
      const idx = parent?.era_index ?? null;
      if (idx === null) continue;
      const key = `${r.child_kind}\u0000${r.child_id}`;
      directEra.set(key, Math.max(directEra.get(key) ?? 0, idx));
    }
  }
  for (const [key, idx] of directEra) {
    const row = rows.get(key);
    if (!row || row.era_index !== null) continue;
    row.era_index = idx;
    row.era_id = null;
  }

  // Inspirations / eurekas: `Boosts.Boost` is the percent of cost granted
  // (Base rows use 50). The ledger uses this to credit only authored boosts.
  if (kb.hasTable("Boosts")) {
    const text = new Map<string, string>();
    if (kb.hasTable("LocalizedText")) {
      for (const r of kb.all<{ Tag: string; Text: string }>(
        `SELECT Tag, Text FROM LocalizedText WHERE Language = 'zh_Hans_CN';`,
      )) {
        if (r.Tag) text.set(r.Tag, r.Text);
      }
    }
    for (const b of kb.all<{ kind: string; id: string; boost: number | null; trigger: string | null }>(
      `SELECT CASE WHEN TechnologyType IS NOT NULL THEN 'tech' ELSE 'civic' END AS kind,
              COALESCE(TechnologyType, CivicType) AS id,
              Boost AS boost, TriggerDescription AS trigger
         FROM Boosts
        WHERE COALESCE(TechnologyType, CivicType) IS NOT NULL;`,
    )) {
      if (!b.id) continue;
      const row = rows.get(`${b.kind}\u0000${b.id}`);
      if (!row) continue;
      row.boost_percent = b.boost === null ? null : Number(b.boost);
      row.boost_trigger_zh = b.trigger ? text.get(b.trigger) ?? null : null;
    }
  }

  const stmt = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_node (kind, id, label_zh, label_en, era_id, era_index,
       cost_production, cost_science, cost_culture, cost_gold, cost_faith, cost_basis,
       boost_percent, boost_trigger_zh, confidence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);`,
  );
  let count = 0;
  kb.begin();
  try {
    for (const row of rows.values()) {
      const label = labeler.pair(row.kind, row.id);
      stmt.run(
        row.kind, row.id, label.zh, label.en, row.era_id, row.era_index,
        row.cost_production, row.cost_science, row.cost_culture, row.cost_gold, row.cost_faith,
        row.cost_basis, row.boost_percent ?? null, row.boost_trigger_zh ?? null, 1.0,
      );
      count++;
    }
  } finally {
    kb.commit();
  }
  return {
    nodes: count,
    boosted: [...rows.values()].filter(
      (r) => r.boost_percent !== null && r.boost_percent !== undefined,
    ).length,
  };
}

/** Best-effort kind resolution for a bare entity id. */
export function kindOfId(id: string): string | null {
  const raw = String(id ?? "").toUpperCase();
  const prefix = raw.split("_")[0];
  switch (prefix) {
    case "TECH": return "tech";
    case "CIVIC": return "civic";
    case "UNIT": return "unit";
    case "BUILDING": return "building";
    case "DISTRICT": return "district";
    case "POLICY": return "policy";
    case "GOVERNMENT": return "government";
    case "PROJECT": return "project";
    case "IMPROVEMENT": return "improvement";
    case "GREAT": return "greatperson";
    default: return null;
  }
}
