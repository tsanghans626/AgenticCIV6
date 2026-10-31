import type { KnowledgeDb } from "../db.js";
import type { BuiltPath, NodeCost } from "./path.js";
import type {
  EraWindowSpec,
  InspirationSpec,
  ObjectiveSpec,
  ScenarioSpec,
  SpeedProfileSpec,
  SupplySourceSpec,
} from "./spec.js";

/**
 * L3d: the budget ledger.
 *
 * The old constraint layer compared one lifetime sum against one constant
 * supply rate (`required / (supplyRate × window)`). That cannot answer the two
 * questions a player actually asks — "which era runs short?" and "where does
 * the yield come from?" — so this layer instead:
 *
 *   1. splits supply into named sources (building / resource / belief / policy /
 *      governor), each with copies and a turn it comes online;
 *   2. integrates supply over turns (ramp), not a constant;
 *   3. compares it with the cumulative path cost due in each era;
 *   4. emits a gap per era, which the cut layer and the focus layer consume.
 *
 * Everything here is a decision-model estimate; the provenance of each input
 * (db / rule / empirical) is preserved on the row.
 */

export const LEDGER_METRICS = [
  "culture_per_turn",
  "science_per_turn",
  "production_per_turn",
  "faith_per_turn",
] as const;

export type LedgerMetric = (typeof LEDGER_METRICS)[number];

const CURRENCY_OF: Record<LedgerMetric, keyof NodeCost> = {
  culture_per_turn: "culture",
  science_per_turn: "science",
  production_per_turn: "production",
  faith_per_turn: "faith",
};

export interface LedgerRow {
  eraId: string;
  eraIndex: number;
  metric: LedgerMetric;
  requiredCum: number;
  requiredGross: number;
  boostCredit: number;
  supplyCum: number;
  gap: number;
  verdict: "ok" | "short";
  requiredPerTurn: number;
  supplyPerTurn: number;
  windowTurns: number;
  bindingRank: number | null;
}

export interface ScenarioLedger {
  scenario: ScenarioSpec;
  rows: LedgerRow[];
  feasible: boolean;
  burstGap: number;
  firstGap: LedgerRow | null;
}

export interface SupplyRow {
  metric: LedgerMetric;
  sourceId: string;
  kind: string;
  refId: string;
  perUnit: number;
  copies: number;
  fromTurn: number;
  perPop: boolean;
  requires: string | null;
  dataRef: string | null;
  sourceFlag: string;
  confidence: number;
  note: string | null;
  supplyCum: number;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function scaleTurn(turn: number, turnScale: number): number {
  return Math.max(1, Math.round(turn * turnScale));
}

/** Default scenario used when an objective does not author any. */
export function scenarioList(objective: ObjectiveSpec): ScenarioSpec[] {
  if (objective.scenarios?.length) return objective.scenarios;
  return [{ id: "base", label: "基准（通用阶梯）", supplyOverrides: {}, costMultiplier: 1 }];
}

export function burstEraIndex(eras: EraWindowSpec[], burstEra: string): number {
  return eras.find((e) => e.eraId === burstEra)?.eraIndex ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Expand authored supply sources for one scenario: copies may be overridden per
 * scenario and `fromTurn` is authored at standard speed, so it scales.
 */
export function expandSupply(
  objective: ObjectiveSpec,
  scenario: ScenarioSpec,
  turnScale: number,
): SupplyRow[] {
  const rows: SupplyRow[] = [];
  for (const spec of objective.supply ?? []) {
    const overridden = scenario.supplyOverrides?.[spec.sourceId];
    const copies = Math.max(0, overridden ?? spec.copies ?? 1);
    rows.push({
      metric: spec.metric as LedgerMetric,
      sourceId: spec.sourceId,
      kind: spec.kind,
      refId: spec.refId,
      perUnit: spec.perUnit,
      copies,
      fromTurn: scaleTurn(spec.fromTurn ?? 1, turnScale),
      perPop: spec.perPop === true,
      requires: spec.requires ?? null,
      dataRef: spec.dataRef ?? null,
      sourceFlag: spec.sourceFlag ?? "empirical",
      confidence: spec.confidence ?? 0.5,
      note: spec.note ?? null,
      supplyCum: 0,
    });
  }
  return rows;
}

function legacyRate(objective: ObjectiveSpec, metric: LedgerMetric): number {
  return objective.constraints?.find((c) => c.metric === metric)?.supplyRate ?? 0;
}

/** Total supply produced by `turn` (inclusive), integrating the ramp. */
export function supplyAt(sources: SupplyRow[], turn: number): number {
  let total = 0;
  for (const s of sources) {
    const active = Math.max(0, turn - s.fromTurn + 1);
    total += s.perUnit * s.copies * active;
  }
  return total;
}

export interface LedgerOptions {
  objective: ObjectiveSpec;
  path: BuiltPath;
  speed: SpeedProfileSpec;
  eras: EraWindowSpec[];
  turnScale: number;
  /** Scaled burst turn (the declared wave turn). */
  burstTurn: number;
  /** nodeKey (`kind\0id`) -> Boosts.Boost percent, for inspiration credit. */
  nodeBoosts: Map<string, number>;
  /** objectiveId, only used for diagnostics. */
  objectiveId: string;
}

function creditsFor(objective: ObjectiveSpec, scenario: ScenarioSpec): Map<string, number> {
  const inspiration: InspirationSpec | undefined = objective.inspiration;
  if (!scenario.creditInspirations || !inspiration || inspiration.mode === "none") return new Map();
  return new Map(Object.entries(inspiration.credits ?? {}));
}

/**
 * Build the ledger for one scenario. Required cost is the cumulative on-path
 * cost due by the end of each era; supply is the integrated yield of the
 * scenario's sources up to the same turn.
 */
export function buildScenarioLedger(
  kb: KnowledgeDb,
  opts: LedgerOptions,
  scenario: ScenarioSpec,
): ScenarioLedger {
  const { objective, path, eras, turnScale } = opts;
  const costMultiplier = scenario.costMultiplier ?? 1;
  const credits = creditsFor(objective, scenario);
  const supplies = expandSupply(objective, scenario, turnScale);
  const inScope = eras
    .filter((e) => e.eraIndex <= burstEraIndex(eras, objective.burstEra))
    .sort((a, b) => a.eraIndex - b.eraIndex);

  const metrics = LEDGER_METRICS.filter((metric) => {
    const currency = CURRENCY_OF[metric];
    return (path.totalCost[currency] ?? 0) > 0 || supplies.some((s) => s.metric === metric);
  });

  const rows: LedgerRow[] = [];
  const scopeBurstIndex = burstEraIndex(eras, objective.burstEra);
  for (const era of inScope) {
    const eraEnd = scaleTurn(era.turnHi, turnScale);
    // The burst era is gated by the declared wave turn, not by the era band's
    // end: a T110 wave inside the 90-140 band must be paid for by T110.
    const windowTurns = era.eraIndex === scopeBurstIndex
      ? Math.max(1, Math.min(eraEnd, opts.burstTurn))
      : eraEnd;
    for (const metric of metrics) {
      const currency = CURRENCY_OF[metric];
      let gross = 0;
      let net = 0;
      for (const node of path.nodes) {
        if (node.role !== "on_path") continue;
        if (node.eraDue === null || node.eraDue > era.eraIndex) continue;
        const value = Number(node.cost[currency] ?? 0);
        if (!value) continue;
        gross += value * costMultiplier;
        const credit = credits.get(node.id);
        net += value * costMultiplier * (1 - (credit ?? 0) / 100);
      }
      const metricSources = supplies.filter((s) => s.metric === metric);
      const supplyCum = metricSources.length
        ? supplyAt(metricSources, windowTurns)
        : legacyRate(objective, metric) * windowTurns;
      const gap = round1(net - supplyCum);
      rows.push({
        eraId: era.eraId,
        eraIndex: era.eraIndex,
        metric,
        requiredCum: round1(net),
        requiredGross: round1(gross),
        boostCredit: round1(gross - net),
        supplyCum: round1(supplyCum),
        gap,
        verdict: gap <= 0 ? "ok" : "short",
        requiredPerTurn: round2(net / Math.max(1, windowTurns)),
        supplyPerTurn: round2(supplyCum / Math.max(1, windowTurns)),
        windowTurns,
        bindingRank: null,
      });
    }

    // Binding rank is per era: the currency with the least slack relative to
    // its own supply (tightness), so the ranking never compares 琴 with 锤.
    const ranked = rows
      .filter((r) => r.eraId === era.eraId && r.requiredCum > 0 && r.supplyCum > 0)
      .sort((a, b) => b.requiredCum / b.supplyCum - a.requiredCum / a.supplyCum);
    ranked.forEach((r, i) => {
      r.bindingRank = i + 1;
    });
  }

  const burstIndex = scopeBurstIndex;
  const burstRows = rows.filter((r) => r.eraIndex === burstIndex);
  const feasible = burstRows.every((r) => r.gap <= 0);
  const burstGap = burstRows.reduce((max, r) => Math.max(max, r.gap), 0);
  const firstGap = [...rows]
    .filter((r) => r.verdict === "short")
    .sort((a, b) => a.eraIndex - b.eraIndex || b.gap - a.gap)[0] ?? null;

  void kb;
  return { scenario, rows, feasible, burstGap: round1(burstGap), firstGap };
}

/** Look up one ledger cell (used by the focus layer). */
export function ledgerCell(
  ledger: ScenarioLedger,
  eraId: string,
  metric: string,
): LedgerRow | undefined {
  return ledger.rows.find((r) => r.eraId === eraId && r.metric === metric);
}
