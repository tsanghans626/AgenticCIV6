import type { ScenarioLedger } from "./ledger.js";
import { ledgerCell } from "./ledger.js";

/**
 * L3f: scenario band and decision robustness.
 *
 * Randomness is not modelled as noise on a single number; it is modelled as
 * alternative supply worlds (no culture resources, early war, governor late).
 * Each authored decision is then classified:
 *
 *   invariant  — the era's constraint closes in every scenario, so the action
 *                is safe to plan around;
 *   contingent — it only closes in some scenarios, so the trigger is recorded
 *                and the answer must state it.
 */

export interface DecisionRef {
  refId: string;
  kind: string;
  eraId: string;
  metric: string;
}

export interface RobustnessRow {
  decisionRef: string;
  decisionKind: string;
  invariant: boolean;
  flipsIn: string[];
  trigger: string | null;
}

export function classifyRobustness(
  ledgers: ScenarioLedger[],
  decisions: DecisionRef[],
): RobustnessRow[] {
  const out: RobustnessRow[] = [];
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (!decision.refId || seen.has(decision.refId)) continue;
    seen.add(decision.refId);
    const flips: string[] = [];
    let evaluated = 0;
    for (const ledger of ledgers) {
      const cell = ledgerCell(ledger, decision.eraId, decision.metric);
      if (!cell) continue;
      evaluated++;
      if (cell.verdict === "short") flips.push(ledger.scenario.id);
    }
    if (!evaluated) continue;
    out.push({
      decisionRef: decision.refId,
      decisionKind: decision.kind,
      invariant: flips.length === 0,
      flipsIn: flips,
      trigger: flips.length
        ? `${decision.metric} 在 ${decision.eraId} 出现缺口（${flips.join("/")}）`
        : null,
    });
  }
  return out;
}
