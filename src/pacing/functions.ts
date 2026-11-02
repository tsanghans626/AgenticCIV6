import type { ActionInterval, Milestone, PacingResult, RatePoint } from "./engine.js";

/**
 * Callable view of a pacing result.
 *
 * The result object is a serializable IR (segments / intervals). This module
 * compiles that IR into functions so consumers never re-implement the
 * piecewise math, interval lookup, or out-of-range policy.
 *
 * Boundary policy (deliberately explicit, mirrors `interp1d`'s fill_value):
 *   t < 1        -> cumulative 0, rate 0, no actions
 *   1 <= t <= T  -> exact turn
 *   t > T        -> last value (no extrapolation)
 *   non-finite t -> TypeError
 */

export const PACING_STATE_KEYS = [
  "science",
  "culture",
  "gold",
  "production",
  "food",
  "faith",
  "tourism",
] as const;

export type PacingStateKey = (typeof PACING_STATE_KEYS)[number];
export type PacingRate = Record<PacingStateKey, number>;
export type PacingCumulative = Record<PacingStateKey, number>;

export interface PacingActionRef {
  id: string;
  label: string;
}

export interface PacingSnapshot {
  turn: number;
  cumulative: PacingCumulative;
  rate: PacingRate;
  cities: number;
  population: number;
  research: PacingActionRef | null;
  civic: PacingActionRef | null;
  builds: ActionInterval[];
}

export interface PacingFunctions {
  T: number;
  science(t: number): number;
  culture(t: number): number;
  gold(t: number): number;
  production(t: number): number;
  food(t: number): number;
  faith(t: number): number;
  tourism(t: number): number;
  cities(t: number): number;
  population(t: number): number;
  rate(t: number): PacingRate;
  rateOf(key: PacingStateKey, t: number): number;
  state(t: number): PacingSnapshot;
  research(t: number): PacingActionRef | null;
  civic(t: number): PacingActionRef | null;
  builds(t: number): ActionInterval[];
  actionsAt(t: number): ActionInterval[];
  milestonesUntil(t: number): Milestone[];
  nextMilestone(t: number): Milestone | null;
  input: PacingResult["input"];
  basis: PacingResult["basis"];
  baseline: PacingResult["baseline"];
  checks: PacingResult["checks"];
  assumptions: PacingResult["assumptions"];
  data: PacingResult;
}

export function normalizePacingTurn(t: number): number {
  const n = Math.floor(Number(t));
  if (!Number.isFinite(n)) throw new TypeError("t 必须是数字");
  return n;
}

function segmentIndex(segments: Array<{ from: number; to: number }>, n: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].from <= n) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function pacingCumulativeAt(
  result: PacingResult,
  key: PacingStateKey,
  t: number,
): number {
  const n = normalizePacingTurn(t);
  if (n < 1) return 0;
  const segments = result.state[key]?.segments ?? [];
  if (!segments.length) return 0;
  const idx = segmentIndex(segments, n);
  if (idx < 0) return 0;
  const segment = segments[idx];
  if (n <= segment.to) return segment.cumFrom + segment.rate * (n - segment.from + 1);
  return segment.cumTo;
}

export function pacingRateAt(result: PacingResult, key: PacingStateKey, t: number): number {
  const n = normalizePacingTurn(t);
  if (n < 1) return 0;
  const segments = result.state[key]?.segments ?? [];
  if (!segments.length) return 0;
  const idx = segmentIndex(segments, n);
  if (idx < 0) return 0;
  return segments[idx].rate;
}

export function pacingSeriesPointAt(result: PacingResult, n: number): RatePoint | null {
  const series = result.series;
  if (!series.length || n < 1) return null;
  if (n <= series[0].turn) return series[0];
  let lo = 0;
  let hi = series.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].turn <= n) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return series[found];
}

function actionRef(action: ActionInterval | undefined): PacingActionRef | null {
  return action ? { id: action.id, label: action.label } : null;
}

export function pacingActionAt(
  result: PacingResult,
  kind: "research" | "civic",
  t: number,
): PacingActionRef | null {
  const n = normalizePacingTurn(t);
  if (n < 1) return null;
  return actionRef(result.actions.find((a) => a.kind === kind && a.from <= n && n <= a.to));
}

export function makePacingFunctions(result: PacingResult): PacingFunctions {
  const last = result.series[result.series.length - 1];
  const T = last ? last.turn : 0;

  const cumulative = (key: PacingStateKey) => (t: number) => pacingCumulativeAt(result, key, t);
  const rateOf = (key: PacingStateKey) => (t: number) => pacingRateAt(result, key, t);

  const rate = (t: number): PacingRate => {
    const n = normalizePacingTurn(t);
    const out = {} as PacingRate;
    for (const key of PACING_STATE_KEYS) out[key] = pacingRateAt(result, key, n);
    return out;
  };

  const actionsAt = (t: number): ActionInterval[] => {
    const n = normalizePacingTurn(t);
    if (n < 1) return [];
    return result.actions.filter((a) => a.from <= n && n <= a.to);
  };

  const builds = (t: number): ActionInterval[] =>
    actionsAt(t).filter((a) => a.kind === "build" || a.kind === "district" || a.kind === "project" || a.kind === "unit");

  const milestonesUntil = (t: number): Milestone[] => {
    const n = normalizePacingTurn(t);
    if (n < 1) return [];
    return result.milestones.filter((m) => m.turn <= n);
  };

  const nextMilestone = (t: number): Milestone | null => {
    const n = normalizePacingTurn(t);
    return result.milestones.find((m) => m.turn > n) ?? null;
  };

  const state = (t: number): PacingSnapshot => {
    const n = normalizePacingTurn(t);
    const point = pacingSeriesPointAt(result, n);
    const cumulativeOut = {} as PacingCumulative;
    const rateOut = {} as PacingRate;
    for (const key of PACING_STATE_KEYS) {
      cumulativeOut[key] = pacingCumulativeAt(result, key, n);
      rateOut[key] = pacingRateAt(result, key, n);
    }
    return {
      turn: n,
      cumulative: cumulativeOut,
      rate: rateOut,
      cities: point?.cities ?? 0,
      population: point?.population ?? 0,
      research: pacingActionAt(result, "research", n),
      civic: pacingActionAt(result, "civic", n),
      builds: builds(n),
    };
  };

  return {
    T,
    science: cumulative("science"),
    culture: cumulative("culture"),
    gold: cumulative("gold"),
    production: cumulative("production"),
    food: cumulative("food"),
    faith: cumulative("faith"),
    tourism: cumulative("tourism"),
    cities: (t) => pacingSeriesPointAt(result, normalizePacingTurn(t))?.cities ?? 0,
    population: (t) => pacingSeriesPointAt(result, normalizePacingTurn(t))?.population ?? 0,
    rate,
    rateOf: (key, t) => pacingRateAt(result, key, t),
    state,
    research: (t) => pacingActionAt(result, "research", t),
    civic: (t) => pacingActionAt(result, "civic", t),
    builds,
    actionsAt,
    milestonesUntil,
    nextMilestone,
    input: result.input,
    basis: result.basis,
    baseline: result.baseline,
    checks: result.checks,
    assumptions: result.assumptions,
    data: result,
  };
}
