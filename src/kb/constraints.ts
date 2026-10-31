import type { KnowledgeDb } from "../db.js";
import type { BuiltPath } from "./path.js";
import type { ObjectiveSpec } from "./spec.js";
import type { ScenarioLedger, SupplyRow } from "./ledger.js";

/**
 * L3b: constraints, now a projection of the ledger.
 *
 * The old version compared one lifetime sum with a constant supply anchor:
 *
 *   tightness = required / (supplyRate × window)
 *
 * That stays as the *reported shape* (the tool and the validator expect it),
 * but the numbers now come from the ledger: the worst era supplies both the
 * required amount and the window, and `supplyRate` is the integrated supply
 * divided by that window. Culture therefore stops looking "fine" on online
 * speed just because the window was never scaled.
 *
 * Constraints that the ledger cannot derive (e.g. great-person points) are
 * still authored directly.
 */

export interface ConstraintRow {
  key: string;
  metric: string;
  unit: string | null;
  required: number;
  requiredSource: string;
  supplyRate: number;
  supplySource: string;
  window: number;
  tightness: number;
  slack: number;
  bindingRank: number | null;
  waivedBy: string | null;
  notes: string | null;
  confidence: number;
}

export interface LeverRow {
  constraintKey: string;
  actionKind: string;
  refId: string;
  deltaPerUnit: number | null;
  costProduction: number | null;
  costGold: number | null;
  requires: string | null;
  why: string | null;
}

export interface ConstraintsResult {
  rows: ConstraintRow[];
  levers: LeverRow[];
  /** currency -> binding constraint key (used by the focus layer) */
  bindingByCurrency: Map<string, string>;
}

const METRIC_UNIT: Record<string, string> = {
  science_per_turn: "瓶",
  culture_per_turn: "琴",
  production_per_turn: "锤",
  gold_per_turn: "金",
  faith_per_turn: "鸽",
  great_person_points: "点",
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function supplySummary(sources: SupplyRow[]): string {
  return sources
    .filter((s) => s.copies > 0)
    .map((s) => `${s.refId || s.sourceId}×${s.copies}@T${s.fromTurn}`)
    .join(" + ");
}

export function buildConstraints(
  kb: KnowledgeDb,
  objective: ObjectiveSpec,
  objectiveId: string,
  path: BuiltPath,
  ledger: ScenarioLedger,
  supplies: SupplyRow[],
): ConstraintsResult {
  const rows: ConstraintRow[] = [];
  const byMetric = new Map<string, { required: number; supply: number; window: number; gap: number }>();

  // 1) ledger projection: the worst era per metric defines the reported row.
  for (const metric of new Set(ledger.rows.map((r) => r.metric))) {
    const cells = ledger.rows.filter((r) => r.metric === metric);
    if (!cells.length) continue;
    const worst = [...cells].sort((a, b) => b.gap - a.gap || a.eraIndex - b.eraIndex)[0];
    byMetric.set(metric, {
      required: worst.requiredCum,
      supply: worst.supplyCum,
      window: worst.windowTurns,
      gap: worst.gap,
    });
  }

  for (const [metric, value] of byMetric) {
    if (value.required <= 0) continue;
    const supplyRate = round2(value.supply / Math.max(1, value.window));
    const tightness = round2(value.required / Math.max(1e-9, value.supply));
    const sources = supplies.filter((s) => s.metric === metric);
    rows.push({
      key: `${objectiveId}:${metric}`,
      metric,
      unit: METRIC_UNIT[metric] ?? null,
      required: value.required,
      requiredSource: `ledger:${objectiveId}`,
      supplyRate,
      supplySource: sources.length ? supplySummary(sources) : "legacy anchor",
      window: value.window,
      tightness,
      slack: round2(value.supply - value.required),
      bindingRank: null,
      waivedBy: null,
      notes: sources.length
        ? `按时代累计；最差时代窗口 ${value.window} 回合`
        : objective.constraints?.find((c) => c.metric === metric)?.notes ?? null,
      confidence: sources.some((s) => s.sourceFlag === "db") ? 0.7 : 0.5,
    });
  }

  // 2) authored constraints the ledger does not derive (e.g. prophet points)
  const derivedMetrics = new Set(byMetric.keys());
  for (const spec of objective.constraints ?? []) {
    if (derivedMetrics.has(spec.metric)) continue;
    const required = spec.required ?? 0;
    const supplyRate = spec.supplyRate ?? 0;
    const window = spec.window ?? objective.burstTurn;
    const tightness = supplyRate > 0 ? required / (supplyRate * window) : 0;
    rows.push({
      key: `${objectiveId}:${spec.metric}`,
      metric: spec.metric,
      unit: spec.unit ?? METRIC_UNIT[spec.metric] ?? null,
      required: round2(required),
      requiredSource: "authored",
      supplyRate,
      supplySource: spec.notes ?? "authored anchor",
      window,
      tightness: round2(tightness),
      slack: round2(supplyRate * window - required),
      bindingRank: null,
      waivedBy: null,
      notes: spec.notes ?? null,
      confidence: spec.sourceFlag === "empirical" ? 0.5 : 0.7,
    });
  }

  // 3) capability waivers
  for (const key of path.waivedConstraints) {
    for (const row of rows) {
      if (row.key === key || row.metric === key) row.waivedBy = "capability";
    }
  }

  // 4) binding ranking over non-waived, anchored rows
  const ranked = rows
    .filter((r) => !r.waivedBy && r.supplyRate > 0)
    .sort((a, b) => b.tightness - a.tightness);
  ranked.forEach((r, i) => {
    r.bindingRank = i + 1;
  });

  const bindingByCurrency = new Map<string, string>();
  for (const r of ranked.slice(0, 3)) bindingByCurrency.set(r.metric, r.key);

  // 5) levers: cheapest known ways to move each constraint
  const levers: LeverRow[] = [];
  if (kb.hasTable("kb_effect") && kb.hasTable("kb_node")) {
    for (const metric of new Set(rows.map((r) => r.metric))) {
      const effectRows = kb.all<{
        owner_kind: string; owner_id: string; dimension_id: string;
        value: number; cost_production: number | null;
      }>(
        `SELECT e.owner_kind, e.owner_id, e.dimension_id, e.value, n.cost_production
           FROM kb_effect e
           LEFT JOIN kb_node n ON n.kind = e.owner_kind AND n.id = e.owner_id
          WHERE e.dimension_id = ? AND e.effect_kind IN ('flat','gpp')
          ORDER BY (n.cost_production IS NULL), n.cost_production, e.owner_id;`,
        metric,
      );
      const constraint = rows.find((r) => r.metric === metric);
      if (!constraint) continue;
      for (const e of effectRows.slice(0, 6)) {
        levers.push({
          constraintKey: constraint.key,
          actionKind: "building",
          refId: e.owner_id,
          deltaPerUnit: Number(e.value) || null,
          costProduction: e.cost_production === null ? null : Number(e.cost_production),
          costGold: null,
          requires: null,
          why: `每条 +${e.value} ${METRIC_UNIT[metric] ?? ""}`,
        });
      }
      if (metric === "great_person_points" && kb.hasTable("Project_GreatPersonPoints")) {
        for (const p of kb.all<{ ProjectType: string; Points: number; cost: number | null }>(
          `SELECT g.ProjectType, g.Points, n.cost_production AS cost
             FROM Project_GreatPersonPoints g
             LEFT JOIN kb_node n ON n.kind = 'project' AND n.id = g.ProjectType
            WHERE g.GreatPersonClassType = 'GREAT_PERSON_CLASS_PROPHET';`,
        )) {
          levers.push({
            constraintKey: constraint.key,
            actionKind: "project",
            refId: p.ProjectType,
            deltaPerUnit: Number(p.Points) || null,
            costProduction: p.cost === null ? null : Number(p.cost),
            costGold: null,
            requires: null,
            why: `一次完成 +${p.Points} 点`,
          });
        }
      }
    }
  }

  return { rows, levers, bindingByCurrency };
}
