import type { BuiltPath, NodeCost } from "./path.js";
import type { ObjectiveSpec } from "./spec.js";
import type { LedgerMetric, ScenarioLedger } from "./ledger.js";

/**
 * L3e: the cut order.
 *
 * A budget gap has exactly two honest answers: add supply, or move the goal.
 * This layer prices both:
 *
 *   defer — postpone an on-path node past the burst. It saves that node's cost
 *           before the burst but delays every gate behind it; the delay is
 *           `saved / supply_per_turn`, so it is arithmetic, not a guess.
 *   drop  — remove a detour group or a non-blocking gate. It saves the group's
 *           full cost and does not slip the burst, but loses the capability
 *           the group bought (upgrade discount, temples, ...).
 *
 * Authored `cutOrder` entries are validated against the path so the list can
 * never reference a node the objective does not contain.
 */

export interface CutRow {
  rank: number;
  cutKind: "defer" | "drop";
  refId: string | null;
  groupId: string | null;
  saves: Record<string, number>;
  lose: string;
  trigger: string | null;
  slipTurns: number | null;
}

export interface CutResult {
  rows: CutRow[];
  /** Currency the cut list was aimed at, e.g. culture. */
  targetCurrency: string | null;
  /** Gap that remains after every authored cut is applied. */
  remainingGap: number;
  /** True when the authored cuts are enough to close the gap. */
  sufficient: boolean;
}

const CURRENCY_OF: Record<LedgerMetric, keyof NodeCost> = {
  culture_per_turn: "culture",
  science_per_turn: "science",
  production_per_turn: "production",
  faith_per_turn: "faith",
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Build the ordered cut list for one scenario. `gap` is the first short era's
 * gap (negative number zero if feasible).
 */
export function buildCuts(
  objective: ObjectiveSpec,
  path: BuiltPath,
  ledger: ScenarioLedger,
): CutResult {
  const firstGap = ledger.firstGap;
  if (!firstGap) {
    return { rows: [], targetCurrency: null, remainingGap: 0, sufficient: true };
  }
  // Prefer the burst-era gap when the burst itself is short; otherwise the
  // earliest short era is the one worth cutting against.
  const burstIndex = Math.max(...ledger.rows.map((r) => r.eraIndex));
  const burstCells = ledger.rows.filter((r) => r.eraIndex === burstIndex);
  const burstShort = [...burstCells].sort((a, b) => b.gap - a.gap)[0];
  const target = burstShort && burstShort.gap > 0 ? burstShort : firstGap;
  const targetCurrency = CURRENCY_OF[target.metric];
  let remaining = Math.max(0, target.gap);
  const rows: CutRow[] = [];

  const entries = [...(objective.cutOrder ?? [])].sort(
    (a, b) => (a.order ?? 99) - (b.order ?? 99),
  );

  for (const entry of entries) {
    if (remaining <= 0) break;
    if (entry.kind === "defer") {
      const node = path.nodes.find(
        (n) => n.role === "on_path" && n.id === entry.refId,
      );
      if (!node) continue;
      // Only nodes that are already due by the gap era can reduce that gap.
      if (node.eraDue !== null && node.eraDue > target.eraIndex) continue;
      const saves: Record<string, number> = {};
      for (const [currency, value] of Object.entries(node.cost)) {
        if (typeof value === "number" && value > 0) saves[currency] = round1(value);
      }
      const saved = saves[targetCurrency] ?? 0;
      if (saved <= 0) continue;
      const slip = target.supplyPerTurn > 0
        ? Math.ceil(saved / target.supplyPerTurn)
        : null;
      rows.push({
        rank: rows.length + 1,
        cutKind: "defer",
        refId: node.id,
        groupId: null,
        saves,
        lose: entry.lose,
        trigger: entry.trigger ?? null,
        slipTurns: slip,
      });
      remaining = round1(remaining - saved);
      continue;
    }

    // drop: a detour group priced by the path layer. Dropping it frees
    // production/faith but does NOT reduce the on-path requirement, so it is
    // reported as freed capacity rather than gap closure.
    const group = entry.group ?? "";
    const bucket = path.detourCost[group];
    if (!bucket) continue;
    const saves: Record<string, number> = {};
    for (const [currency, value] of Object.entries(bucket)) {
      if (typeof value === "number" && value > 0) saves[currency] = round1(value);
    }
    const saved = saves[targetCurrency] ?? 0;
    if (saved <= 0) continue;
    rows.push({
      rank: rows.length + 1,
      cutKind: "drop",
      refId: null,
      groupId: group,
      saves,
      lose: entry.lose,
      trigger: entry.trigger ?? null,
      slipTurns: null,
    });
  }

  return {
    rows,
    targetCurrency,
    remainingGap: round1(Math.max(0, remaining)),
    sufficient: remaining <= 0,
  };
}

/** Guard used by validation: a defer must point at an on-path node. */
export function deferNodeExists(path: BuiltPath, id: string | undefined): boolean {
  if (!id) return false;
  return path.nodes.some((n) => n.role === "on_path" && n.id === id);
}

/** Guard used by validation: a drop must point at a priced detour group. */
export function dropGroupExists(path: BuiltPath, group: string | undefined): boolean {
  if (!group) return false;
  return Object.prototype.hasOwnProperty.call(path.detourCost, group);
}
