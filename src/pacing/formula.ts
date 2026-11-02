import type { PacingResult } from "./engine.js";
import { PACING_STATE_KEYS, type PacingStateKey } from "./functions.js";

/**
 * Minimal formula basis for the generated module.
 *
 * The module must not embed the sampled result (`series`, `state`, `actions`,
 * `milestones`, `data`) — that grows with turns × dimensions and duplicates the
 * same facts four times. Instead we keep the smallest source of truth:
 *
 *   cumulative state  = base·t + Σ Δrate·(t − turn + 1)      (hinge basis)
 *   cities/population = step function
 *   actions/milestones = indexed event tuples + shared ids/labels
 *
 * Everything else is derived when the generated module is called. `--format=json`
 * remains the full, exact result contract.
 */

export const PACING_FORMULA_SCHEMA = "civi6.pacing/formula/v1";

export const ACTION_KINDS = [
  "research",
  "civic",
  "build",
  "district",
  "project",
  "unit",
  "settle",
] as const;

export const MILESTONE_KINDS = ["tech", "civic", "building", "district", "project", "unit"] as const;
export const MILESTONE_ROLES = ["terminal", "enabler", "booster"] as const;

export type PacingActionKind = (typeof ACTION_KINDS)[number];
export type PacingMilestoneKind = (typeof MILESTONE_KINDS)[number];
export type PacingMilestoneRole = (typeof MILESTONE_ROLES)[number];

export interface PacingFormula {
  schema: typeof PACING_FORMULA_SCHEMA;
  T: number;
  /** first-segment rate per dimension */
  base: Record<PacingStateKey, number>;
  /** [turn, rate delta] per dimension; cumulative is base·t + Σ Δ·(t − turn + 1) */
  delta: Record<PacingStateKey, Array<[number, number]>>;
  counts: {
    cities: Array<[number, number]>;
    population: Array<[number, number]>;
  };
  ids: string[];
  labels: string[];
  /** [from, to, actionKindIdx, idIdx, count] */
  actions: Array<[number, number, number, number, number]>;
  /** [turn, latestTurn (-1 = null), milestoneKindIdx, idIdx, cost, roleIdx, city (0 = null)] */
  milestones: Array<[number, number, number, number, number, number, number]>;
  meta: {
    input: PacingResult["input"];
    basis: PacingResult["basis"];
    baseline: PacingResult["baseline"];
    checks: PacingResult["checks"];
    assumptions: PacingResult["assumptions"];
    provenance: {
      ruleset: PacingResult["provenance"]["ruleset"];
      kbBuiltAt: string | null;
      rawBuiltAt: string | null;
      specVersion: number;
      excludedEffects: number;
      excludedByReason: Record<string, number>;
    };
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function steps(series: PacingResult["series"], pick: (p: PacingResult["series"][number]) => number): Array<[number, number]> {
  if (!series.length) return [[1, 0]];
  const out: Array<[number, number]> = [[1, pick(series[0])]];
  let prev = pick(series[0]);
  for (const point of series) {
    const value = pick(point);
    if (value !== prev) {
      out.push([point.turn, value]);
      prev = value;
    }
  }
  return out;
}

/**
 * Compile a `PacingResult` into the minimal basis used by the generated module.
 * Pure: no I/O, deterministic for the same result.
 */
export function buildPacingFormula(result: PacingResult): PacingFormula {
  const base = {} as Record<PacingStateKey, number>;
  const delta = {} as Record<PacingStateKey, Array<[number, number]>>;
  for (const key of PACING_STATE_KEYS) {
    const segments = result.state[key]?.segments ?? [];
    base[key] = round6(segments[0]?.rate ?? 0);
    const changes: Array<[number, number]> = [];
    let prev = segments[0]?.rate ?? 0;
    for (let i = 1; i < segments.length; i++) {
      const value = round6(segments[i].rate - prev);
      if (value !== 0) changes.push([segments[i].from, value]);
      prev = segments[i].rate;
    }
    delta[key] = changes;
  }

  const ids: string[] = [];
  const labelById = new Map<string, string>();
  const remember = (id: string, label: string | null | undefined) => {
    if (!id) return;
    if (!labelById.has(id)) {
      ids.push(id);
      labelById.set(id, label ?? id);
    } else if (label && labelById.get(id) === id) {
      labelById.set(id, label);
    }
  };
  for (const action of result.actions) remember(action.id, action.label);
  for (const milestone of result.milestones) remember(milestone.id, milestone.labelZh);
  const idIndex = new Map(ids.map((id, index) => [id, index]));

  const actionKinds = ACTION_KINDS as readonly string[];
  const milestoneKinds = MILESTONE_KINDS as readonly string[];
  const roles = MILESTONE_ROLES as readonly string[];

  return {
    schema: PACING_FORMULA_SCHEMA,
    T: result.series.length ? result.series[result.series.length - 1].turn : 0,
    base,
    delta,
    counts: {
      cities: steps(result.series, (p) => p.cities),
      population: steps(result.series, (p) => p.population),
    },
    ids,
    labels: ids.map((id) => labelById.get(id) ?? id),
    actions: result.actions.map(
      (a): [number, number, number, number, number] => [
        a.from,
        a.to,
        actionKinds.indexOf(a.kind),
        idIndex.get(a.id) ?? 0,
        a.count,
      ],
    ),
    milestones: result.milestones.map(
      (m): [number, number, number, number, number, number, number] => [
        m.turn,
        m.latestTurn ?? -1,
        milestoneKinds.indexOf(m.kind),
        idIndex.get(m.id) ?? 0,
        m.cost,
        roles.indexOf(m.role),
        m.city ?? 0,
      ],
    ),
    meta: {
      input: result.input,
      basis: result.basis,
      baseline: result.baseline,
      checks: result.checks,
      assumptions: result.assumptions,
      provenance: {
        ruleset: result.provenance.ruleset,
        kbBuiltAt: result.provenance.kbBuiltAt,
        rawBuiltAt: result.provenance.rawBuiltAt,
        specVersion: result.provenance.specVersion,
        excludedEffects: result.provenance.excludedEffects,
        excludedByReason: result.provenance.excludedByReason,
      },
    },
  };
}
