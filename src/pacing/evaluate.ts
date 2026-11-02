import type { ActionInterval, Milestone } from "./engine.js";
import type { PacingFormula } from "./formula.js";
import { PACING_STATE_KEYS, type PacingStateKey } from "./functions.js";

/**
 * Evaluator for the emitted pacing function set.
 *
 * The generated `.mjs` module is the reference implementation; this module is
 * the same semantics as a callable API so the DSH plugin can evaluate a
 * function set without shipping executable JS to the model. `scripts/verify-
 * pacing.mjs` pins every integer turn against the generated module.
 *
 * Boundary policy (identical to the module and `functions.ts`):
 *   t < 1        -> cumulative 0, rate 0, no actions
 *   1 <= t <= T  -> exact turn
 *   t > T        -> last value (no extrapolation), reported as `clamped`
 *   non-finite t -> TypeError
 */

const ACTION_KINDS = ["research", "civic", "build", "district", "project", "unit", "settle"] as const;
const MILESTONE_KINDS = ["tech", "civic", "building", "district", "project", "unit"] as const;
const MILESTONE_ROLES = ["terminal", "enabler", "booster"] as const;

const CURRENCY: Record<string, string> = {
  tech: "science",
  civic: "culture",
  building: "production",
  district: "production",
  project: "production",
  unit: "production",
};
const WHY: Record<string, string> = {
  terminal: "终局链",
  enabler: "前置/解锁",
  booster: "瓶颈产出",
};

export const PACE_CALL_FNS = [
  "cumulative",
  "rate",
  "state",
  "cities",
  "population",
  "research",
  "civic",
  "builds",
  "actionsAt",
  "milestones",
  "nextMilestone",
  "milestone",
  "baseline",
  "checks",
  "assumptions",
  "basis",
  "input",
] as const;

export type PaceCallFn = (typeof PACE_CALL_FNS)[number];

/** One executor call. Extra fields are rejected by `validatePaceCall`. */
export interface PaceCallInput {
  fn: PaceCallFn;
  t?: number;
  key?: PacingStateKey;
  from?: number;
  to?: number;
  limit?: number;
  id?: string;
}

export interface PaceCallResult {
  value: unknown;
  /** True when a turn query exceeded `T` and the last value was returned. */
  clamped?: boolean;
}

const TURN_FNS = new Set<PaceCallFn>([
  "cumulative",
  "rate",
  "state",
  "cities",
  "population",
  "research",
  "civic",
  "builds",
  "actionsAt",
  "nextMilestone",
]);
const KEY_FNS = new Set<PaceCallFn>(["cumulative", "rate"]);
const LIMIT_FNS = new Set<PaceCallFn>(["builds", "actionsAt", "milestones", "milestone"]);
const META_FNS = new Set<PaceCallFn>(["baseline", "checks", "assumptions", "basis", "input"]);

function callFail(message: string): never {
  throw new Error(`PaceCall: ${message}`);
}

function numberArg(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    callFail(`${name} 必须是有限数字。`);
  }
  return value;
}

function limitArg(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    callFail("limit 必须是 1..100 的整数。");
  }
  return value;
}

/**
 * Validate one call before any evaluation. Throws with a field-level message;
 * the tool wraps it with the call index so a batch never fails silently.
 */
export function validatePaceCall(call: unknown): asserts call is PaceCallInput {
  if (!call || typeof call !== "object") callFail("每条调用必须是对象。");
  const value = call as Record<string, unknown>;
  const fn = value.fn;
  if (typeof fn !== "string" || !(PACE_CALL_FNS as readonly string[]).includes(fn)) {
    callFail(`未知 fn "${String(fn)}"；可用：${PACE_CALL_FNS.join(" / ")}。`);
  }
  const kind = fn as PaceCallFn;
  if (TURN_FNS.has(kind)) numberArg(value.t, "t");
  if (KEY_FNS.has(kind) && value.key !== undefined) {
    if (!(PACING_STATE_KEYS as readonly string[]).includes(String(value.key))) {
      callFail(`key 必须是 ${PACING_STATE_KEYS.join(" / ")} 之一。`);
    }
  }
  if (LIMIT_FNS.has(kind)) limitArg(value.limit);
  if (kind === "milestones") {
    if (value.from !== undefined) numberArg(value.from, "from");
    if (value.to !== undefined) numberArg(value.to, "to");
  }
  if (kind === "milestone") {
    if (typeof value.id !== "string" || !value.id.trim()) callFail("milestone 需要非空 id。");
  }
  if (META_FNS.has(kind)) {
    // Metadata calls take no turn arguments; reject a stray t so a typo cannot
    // silently return the whole metadata instead of the intended value.
    if (value.t !== undefined) callFail(`${kind} 不接受 t。`);
  }
}

/**
 * Shape check for a literal `functionSet` supplied by a caller. The handle path
 * rebuilds a trusted formula, so this is only needed when data crosses the tool
 * boundary.
 */
export function validatePaceFormula(value: unknown): asserts value is PacingFormula {
  if (!value || typeof value !== "object") {
    throw new Error("functionSet 必须是对象（civi6.pacing/formula/v1）。");
  }
  const formula = value as Partial<PacingFormula>;
  if (formula.schema !== "civi6.pacing/formula/v1") {
    throw new Error(`functionSet.schema 必须是 "civi6.pacing/formula/v1"，收到 "${String(formula.schema)}"。`);
  }
  if (typeof formula.T !== "number" || !Number.isInteger(formula.T) || formula.T < 0) {
    throw new Error("functionSet.T 必须是非负整数。");
  }
  if (!formula.base || typeof formula.base !== "object") {
    throw new Error("functionSet.base 缺失。");
  }
  for (const key of PACING_STATE_KEYS) {
    if (typeof (formula.base as Record<string, unknown>)[key] !== "number") {
      throw new Error(`functionSet.base.${key} 必须是数字。`);
    }
  }
  for (const field of ["delta", "counts", "ids", "labels", "actions", "milestones", "meta"] as const) {
    if (!formula[field] || typeof formula[field] !== "object") {
      throw new Error(`functionSet.${field} 缺失。`);
    }
  }
  for (const key of PACING_STATE_KEYS) {
    if (!Array.isArray((formula.delta as Record<string, unknown>)[key])) {
      throw new Error(`functionSet.delta.${key} 必须是数组。`);
    }
  }
  const counts = formula.counts as Record<string, unknown>;
  for (const key of ["cities", "population"]) {
    if (!Array.isArray(counts[key])) throw new Error(`functionSet.counts.${key} 必须是数组。`);
  }
  for (const field of ["ids", "labels", "actions", "milestones"] as const) {
    if (!Array.isArray(formula[field])) throw new Error(`functionSet.${field} 必须是数组。`);
  }
  const meta = formula.meta as Record<string, unknown>;
  for (const field of ["baseline", "checks", "assumptions", "basis", "input"]) {
    if (!meta[field] || typeof meta[field] !== "object") {
      throw new Error(`functionSet.meta.${field} 缺失。`);
    }
  }
}

function normalizeTurn(t: number | undefined): number {
  const n = Math.floor(Number(t));
  if (!Number.isFinite(n)) throw new TypeError("t 必须是数字");
  return n;
}

function clampTurn(n: number, T: number): number {
  if (n < 1) return 0;
  return n > T ? T : n;
}

function cumulativeAt(formula: PacingFormula, key: PacingStateKey, n: number): number {
  const turn = clampTurn(n, formula.T);
  if (turn <= 0) return 0;
  let value = formula.base[key] * turn;
  const changes = formula.delta[key] ?? [];
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (change[0] > turn) break;
    value += change[1] * (turn - change[0] + 1);
  }
  return value;
}

function rateAt(formula: PacingFormula, key: PacingStateKey, n: number): number {
  const turn = clampTurn(n, formula.T);
  if (turn <= 0) return 0;
  let value = formula.base[key];
  const changes = formula.delta[key] ?? [];
  for (let i = 0; i < changes.length; i++) {
    if (changes[i][0] > turn) break;
    value += changes[i][1];
  }
  return value;
}

function stepAt(formula: PacingFormula, key: "cities" | "population", n: number): number {
  const turn = clampTurn(n, formula.T);
  if (turn <= 0) return 0;
  const points = formula.counts[key] ?? [];
  let value = points.length ? points[0][1] : 0;
  for (let i = 0; i < points.length; i++) {
    if (points[i][0] > turn) break;
    value = points[i][1];
  }
  return value;
}

function toAction(formula: PacingFormula, a: PacingFormula["actions"][number]): ActionInterval {
  return {
    from: a[0],
    to: a[1],
    kind: (ACTION_KINDS[a[2]] ?? "build") as ActionInterval["kind"],
    id: formula.ids[a[3]] ?? "",
    label: formula.labels[a[3]] ?? formula.ids[a[3]] ?? "",
    count: a[4],
  };
}

function actionsAt(formula: PacingFormula, n: number): ActionInterval[] {
  if (n < 1) return [];
  return formula.actions.filter((a) => a[0] <= n && n <= a[1]).map((a) => toAction(formula, a));
}

function builds(formula: PacingFormula, n: number): ActionInterval[] {
  return actionsAt(formula, n).filter(
    (a) => a.kind === "build" || a.kind === "district" || a.kind === "project" || a.kind === "unit",
  );
}

function actionRef(formula: PacingFormula, kind: "research" | "civic", n: number): { id: string; label: string } | null {
  if (n < 1) return null;
  const action = formula.actions.find((a) => ACTION_KINDS[a[2]] === kind && a[0] <= n && n <= a[1]);
  if (!action) return null;
  return { id: formula.ids[action[3]] ?? "", label: formula.labels[action[3]] ?? formula.ids[action[3]] ?? "" };
}

function toMilestone(formula: PacingFormula, m: PacingFormula["milestones"][number]): Milestone {
  const kind = (MILESTONE_KINDS[m[2]] ?? "tech") as Milestone["kind"];
  const latestTurn = m[1] < 0 ? null : m[1];
  const role = (MILESTONE_ROLES[m[5]] ?? "enabler") as Milestone["role"];
  return {
    turn: m[0],
    kind,
    id: formula.ids[m[3]] ?? "",
    labelZh: formula.labels[m[3]] ?? formula.ids[m[3]] ?? "",
    cost: m[4],
    currency: (CURRENCY[kind] as Milestone["currency"]) ?? null,
    role,
    latestTurn,
    slack: latestTurn === null ? null : latestTurn - m[0],
    why: WHY[role] ?? "",
    city: m[6] || null,
    deps: [],
  };
}

function milestoneWindow(
  formula: PacingFormula,
  from: number,
  to: number,
  limit: number,
): { total: number; rows: Milestone[] } {
  const rows = formula.milestones.filter((m) => m[0] >= from && m[0] <= to);
  return { total: rows.length, rows: rows.slice(0, limit).map((m) => toMilestone(formula, m)) };
}

function milestoneById(formula: PacingFormula, id: string, limit: number): { total: number; rows: Milestone[] } {
  const rows = formula.milestones.filter((m) => formula.ids[m[3]] === id);
  return { total: rows.length, rows: rows.slice(0, limit).map((m) => toMilestone(formula, m)) };
}

function stateAt(formula: PacingFormula, n: number) {
  const cumulative = {} as Record<PacingStateKey, number>;
  const rate = {} as Record<PacingStateKey, number>;
  for (const key of PACING_STATE_KEYS) {
    cumulative[key] = cumulativeAt(formula, key, n);
    rate[key] = rateAt(formula, key, n);
  }
  return {
    turn: n,
    cumulative,
    rate,
    cities: stepAt(formula, "cities", n),
    population: stepAt(formula, "population", n),
    research: actionRef(formula, "research", n),
    civic: actionRef(formula, "civic", n),
    builds: builds(formula, n),
  };
}

/**
 * Evaluate one call against a function set. The caller must have validated the
 * formula shape once; `validatePaceCall` runs here per call.
 */
export function evaluatePacingFormula(formula: PacingFormula, call: PaceCallInput): PaceCallResult {
  validatePaceCall(call);
  if (call.fn === "milestones") {
    const from = call.from ?? 1;
    const to = call.to ?? formula.T;
    const limit = call.limit ?? 20;
    const total = formula.milestones.filter((m) => m[0] >= from && m[0] <= to).length;
    return {
      value: total > 0 ? milestoneWindow(formula, from, to, limit) : { total: 0, rows: [] },
      ...(to > formula.T ? { clamped: true } : {}),
    };
  }
  if (call.fn === "milestone") {
    return { value: milestoneById(formula, String(call.id), call.limit ?? 50) };
  }
  if (call.fn === "nextMilestone") {
    const n = normalizeTurn(call.t);
    const next = formula.milestones.find((m) => m[0] > n);
    return { value: next ? toMilestone(formula, next) : null };
  }
  if (call.fn === "baseline") return { value: formula.meta.baseline };
  if (call.fn === "checks") return { value: formula.meta.checks };
  if (call.fn === "assumptions") return { value: formula.meta.assumptions };
  if (call.fn === "basis") return { value: formula.meta.basis };
  if (call.fn === "input") return { value: formula.meta.input };

  const n = normalizeTurn(call.t);
  const clamped = n > formula.T ? { clamped: true } : {};
  if (call.fn === "actionsAt" || call.fn === "builds") {
    const rows = call.fn === "actionsAt" ? actionsAt(formula, n) : builds(formula, n);
    const limit = call.limit ?? 50;
    return { value: rows.slice(0, limit), ...clamped };
  }
  if (call.fn === "state") return { value: stateAt(formula, n), ...clamped };
  if (call.fn === "cities") return { value: stepAt(formula, "cities", n), ...clamped };
  if (call.fn === "population") return { value: stepAt(formula, "population", n), ...clamped };
  if (call.fn === "research") return { value: actionRef(formula, "research", n), ...clamped };
  if (call.fn === "civic") return { value: actionRef(formula, "civic", n), ...clamped };
  if (call.fn === "cumulative") {
    if (call.key) return { value: cumulativeAt(formula, call.key, n), ...clamped };
    const out = {} as Record<PacingStateKey, number>;
    for (const key of PACING_STATE_KEYS) out[key] = cumulativeAt(formula, key, n);
    return { value: out, ...clamped };
  }
  if (call.fn === "rate") {
    if (call.key) return { value: rateAt(formula, call.key, n), ...clamped };
    const out = {} as Record<PacingStateKey, number>;
    for (const key of PACING_STATE_KEYS) out[key] = rateAt(formula, key, n);
    return { value: out, ...clamped };
  }
  throw new Error(`PaceCall: 未处理的 fn "${String(call.fn)}"。`);
}
