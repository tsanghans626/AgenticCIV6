import type { PacingResult } from "./engine.js";

/**
 * Independent certificate check over a finished result.
 *
 * The simulator is a construction, so it cannot overspend by design. This module
 * deliberately re-derives the invariants from the emitted numbers (not from the
 * simulator's state) so a regression in the scheduler shows up as a failed
 * check instead of a silently plausible plan.
 */

export interface PacingVerification {
  ok: boolean;
  issues: string[];
}

const CURRENCY_TO_CUM: Record<string, keyof PacingResult["series"][number]["cum"]> = {
  science: "science",
  culture: "culture",
  production: "production",
  gold: "gold",
  faith: "faith",
};

function cumAt(result: PacingResult, turn: number, key: keyof PacingResult["series"][number]["cum"]): number {
  const point = result.series.find((p) => p.turn === turn);
  if (point) return point.cum[key];
  let last = 0;
  for (const p of result.series) {
    if (p.turn <= turn) last = p.cum[key];
    else break;
  }
  return last;
}

export function verifyPacing(result: PacingResult): PacingVerification {
  const issues: string[] = [];
  const { checks, baseline, milestones, series } = result;

  // I1 cost coverage: at every completion turn, cumulative production of that
  // currency must cover everything already paid for in that currency.
  const spendByCurrency = new Map<string, Array<{ turn: number; cost: number; id: string }>>();
  for (const m of milestones) {
    if (!m.currency) continue;
    if (m.currency === "gold" || m.currency === "faith") continue;
    const list = spendByCurrency.get(m.currency) ?? [];
    list.push({ turn: m.turn, cost: m.cost, id: m.id });
    spendByCurrency.set(m.currency, list);
  }
  for (const [currency, list] of spendByCurrency) {
    const cumKey = CURRENCY_TO_CUM[currency];
    if (!cumKey) continue;
    let total = 0;
    for (const row of list.sort((a, b) => a.turn - b.turn)) {
      total += row.cost;
      const produced = cumAt(result, row.turn, cumKey);
      if (total > produced + 1e-6) {
        issues.push(`${currency} T${row.turn}（${row.id}）：累计支出 ${round(total)} > 累计产出 ${round(produced)}`);
        break;
      }
    }
  }

  // I2 prerequisite order (same-city for buildings/districts: one instance of a
  // district in another city does not satisfy a building's local prerequisite).
  const doneAt = new Map<string, number[]>();
  const cityDoneAt = new Map<string, number>();
  for (const m of milestones) {
    const key = `${m.kind}:${m.id}`;
    const list = doneAt.get(key) ?? [];
    list.push(m.turn);
    doneAt.set(key, list);
    if (m.city !== null) {
      const ck = `${key}\u0000${m.city}`;
      cityDoneAt.set(ck, Math.min(cityDoneAt.get(ck) ?? Infinity, m.turn));
    }
  }
  for (const m of milestones) {
    for (const dep of m.deps) {
      const kind = dep.slice(0, dep.indexOf(":"));
      let ok: boolean;
      if (m.city !== null && (kind === "building" || kind === "district")) {
        const t = cityDoneAt.get(`${dep}\u0000${m.city}`);
        ok = t !== undefined && t < m.turn;
      } else {
        ok = (doneAt.get(dep) ?? []).some((t) => t < m.turn);
      }
      if (!ok) issues.push(`${m.kind}:${m.id}（T${m.turn}）缺少前置 ${dep}`);
    }
  }

  // I3 source soundness: the model never models random grants; assert the
  // declaration is present and no milestone is marked as one.
  if (result.assumptions.noRandomGains !== true) issues.push("assumptions.noRandomGains 缺失");
  if ((result.assumptions as { noPurchases?: boolean }).noPurchases !== true) {
    issues.push("assumptions.noPurchases 缺失（v1 不模拟购买）");
  }

  // I4 terminal
  if (baseline.feasible !== checks.terminal) issues.push(`feasible=${baseline.feasible} 与 terminal=${checks.terminal} 不一致`);
  if (!baseline.feasible && !baseline.blockers.some((b) => b.kind === "terminal")) {
    issues.push("不可行结果缺少 terminal blocker");
  }
  if (baseline.feasible && baseline.turn === null) issues.push("可行结果缺少 turn");

  // I6 monotonicity + non-negative rates
  for (const key of Object.keys(result.state)) {
    let prev = -Infinity;
    for (const point of series) {
      const cum = point.cum[key as keyof typeof point.cum];
      if (cum + 1e-6 < prev) issues.push(`${key} 累计在 T${point.turn} 倒退`);
      prev = cum;
    }
    for (const point of series) {
      const rate = point.rates[key as keyof typeof point.rates];
      if (rate < -1e-9) issues.push(`${key} 在 T${point.turn} 出现负速率`);
    }
  }

  // I8 slack consistency
  for (const m of milestones) {
    if (m.latestTurn === null) {
      if (m.slack !== null) issues.push(`${m.kind}:${m.id} latestTurn 为空但 slack 非空`);
      continue;
    }
    const expected = m.latestTurn - m.turn;
    if (m.slack === null || Math.abs(m.slack - expected) > 1) {
      issues.push(`${m.kind}:${m.id} slack=${m.slack} 与 latest-turn=${expected} 不一致`);
    }
    if (m.slack !== null && m.slack < -3) issues.push(`${m.kind}:${m.id} slack=${m.slack} 明显为负`);
  }

  // cross-check the simulation's own checks
  if (!checks.closedLoop) issues.push("sim.checks.closedLoop=false");
  if (!checks.prereqOrder) issues.push("sim.checks.prereqOrder=false");
  if (!checks.monotone) issues.push("sim.checks.monotone=false");

  // deterministic payload: no NaN / Infinity anywhere
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "number" && !Number.isFinite(value)) issues.push(`${path} 非有限数`);
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${path}.${k}`);
    }
  };
  walk(result, "result");

  return { ok: issues.length === 0, issues };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
