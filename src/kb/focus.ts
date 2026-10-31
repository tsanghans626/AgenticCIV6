import type { KnowledgeDb } from "../db.js";
import type { BuiltPath, PathNode } from "./path.js";
import type { ConstraintRow, LeverRow } from "./constraints.js";
import type { EraWindowSpec, ObjectiveSpec, PlanSpec, SpeedProfileSpec } from "./spec.js";
import type { Labeler } from "./labels.js";
import type { ScenarioLedger } from "./ledger.js";
import { ledgerCell } from "./ledger.js";
import { kindOfId } from "./node.js";

/**
 * L3c: era focus (the backward-scheduled answer shape).
 *
 * For each era window we take the path nodes that come due, rank them by
 * "currency tightness × this node's share of that currency", and emit at most
 * three focus actions. Every row carries the ledger gap of its era, so an
 * action that is scheduled in an era the budget cannot pay for is visible
 * instead of being presented as a plan.
 */

export interface FocusRow {
  focusId: string;
  eraId: string;
  eraIndex: number | null;
  turnLo: number | null;
  turnHi: number | null;
  rank: number;
  constraintKey: string | null;
  actionKind: string;
  refId: string;
  refLabel: string;
  why: string;
  cost: string | null;
  alternative: string | null;
  abandonIf: string | null;
  checkpoint: string | null;
  ledgerGap: number | null;
  supplyDelta: number | null;
  sourceFlag: string;
  confidence: number;
}

const NODE_METRIC: Record<string, string> = {
  science: "science_per_turn",
  culture: "culture_per_turn",
  production: "production_per_turn",
  gold: "gold_per_turn",
  faith: "faith_per_turn",
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function costText(cost: Record<string, number | undefined>): string | null {
  const parts = Object.entries(cost)
    .filter(([, v]) => typeof v === "number" && v > 0)
    .map(([k, v]) => `${k} ${round1(Number(v))}`);
  return parts.length ? parts.join(" / ") : null;
}

function scoreNode(node: PathNode, byMetric: Map<string, ConstraintRow>): number {
  let score = 0;
  for (const [currency, value] of Object.entries(node.cost)) {
    if (typeof value !== "number" || value <= 0) continue;
    const metric = NODE_METRIC[currency];
    const constraint = metric ? byMetric.get(metric) : undefined;
    const tightness = constraint?.tightness ?? 0.25;
    score += value * tightness;
  }
  return score;
}

export function buildEraFocus(
  kb: KnowledgeDb,
  labeler: Labeler,
  objective: ObjectiveSpec,
  objectiveId: string,
  path: BuiltPath,
  constraints: ConstraintRow[],
  levers: LeverRow[],
  speed: SpeedProfileSpec,
  eras: EraWindowSpec[],
  plan: PlanSpec | undefined,
  turnScale: number,
  ledger: ScenarioLedger,
): FocusRow[] {
  const byMetric = new Map(constraints.map((c) => [c.metric, c]));
  const binding = constraints
    .filter((c) => !c.waivedBy && c.bindingRank === 1)
    .sort((a, b) => b.tightness - a.tightness)[0]
    ?? constraints.filter((c) => !c.waivedBy).sort((a, b) => b.tightness - a.tightness)[0]
    ?? null;
  const burstIndex = eras.find((e) => e.eraId === objective.burstEra)?.eraIndex ?? Number.MAX_SAFE_INTEGER;
  const nodeById = new Map(path.nodes.map((n) => [n.id, n]));
  const rows: FocusRow[] = [];

  const erasInScope = eras
    .filter((e) => e.eraIndex <= burstIndex)
    .sort((a, b) => a.eraIndex - b.eraIndex);

  function eraCell(eraId: string, metric: string | null | undefined) {
    if (!metric) return null;
    return ledgerCell(ledger, eraId, metric) ?? null;
  }

  function worstEraCell(eraId: string) {
    const cells = ledger.rows.filter((r) => r.eraId === eraId);
    return [...cells].sort((a, b) => b.gap - a.gap)[0] ?? null;
  }

  for (const era of erasInScope) {
    const due = path.nodes.filter((n) => n.eraDue === era.eraIndex && n.role !== "dead");
    const ranked = [...due].sort((a, b) => scoreNode(b, byMetric) - scoreNode(a, byMetric));
    const turnLo = Math.max(1, Math.round(era.turnLo * turnScale));
    const turnHi = Math.max(turnLo, Math.round(era.turnHi * turnScale));
    const worst = worstEraCell(era.eraId);

    const overrides = (objective.eraFocusOverrides ?? []).filter((f) => f.eraId === era.eraId);
    if (overrides.length) {
      for (const o of overrides.slice(0, 3).sort((a, b) => a.rank - b.rank)) {
        const resolvedKey = o.constraintKey
          ? constraints.find((c) => c.key === o.constraintKey)?.key
            ?? constraints.find((c) => c.metric === o.constraintKey)?.key
            ?? binding?.key
            ?? null
          : binding?.key ?? null;
        const constraint = constraints.find((c) => c.key === resolvedKey) ?? null;
        const cell = eraCell(era.eraId, constraint?.metric) ?? worst;
        const node = nodeById.get(o.refId);
        // Costs are always derived from the (speed-scaled) node; a hand-written
        // costText is only allowed for non-node actions such as notes.
        const cost = node
          ? costText(node.cost as Record<string, number | undefined>)
          : o.costText ?? null;
        rows.push({
          focusId: `${objectiveId}:${era.eraId}:${o.rank}`,
          eraId: era.eraId,
          eraIndex: era.eraIndex,
          turnLo,
          turnHi,
          rank: o.rank,
          constraintKey: resolvedKey,
          actionKind: o.actionKind,
          refId: o.refId,
          refLabel: o.actionKind === "node"
            ? labeler.pair(kindOfId(o.refId) ?? "tech", o.refId).zh || o.refId
            : o.refId,
          why: o.why,
          cost,
          alternative: o.alternative ?? null,
          abandonIf: o.abandonIf ?? null,
          checkpoint: o.checkpoint ?? (cell ? `${cell.metric} 缺口 ${cell.gap}` : null),
          ledgerGap: cell ? cell.gap : null,
          supplyDelta: cell && cell.gap > 0 ? cell.gap : 0,
          sourceFlag: o.sourceFlag ?? "rule",
          confidence: 0.65,
        });
      }
      continue;
    }

    const planEra = plan?.eras.find((e) => e.eraId === era.eraId);
    ranked.slice(0, 3).forEach((node, i) => {
      const dominant = Object.entries(node.cost)
        .filter(([, v]) => typeof v === "number" && v > 0)
        .sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] ?? "production";
      const metric = NODE_METRIC[dominant] ?? "production_per_turn";
      const constraint = byMetric.get(metric);
      const cell = eraCell(era.eraId, metric) ?? worst;
      const lever = levers
        .filter((l) => constraint && l.constraintKey === constraint.key && l.refId !== node.id)
        .sort((a, b) => (a.costProduction ?? Infinity) - (b.costProduction ?? Infinity))[0];
      const band = planEra
        ? (planEra as unknown as Record<string, { lo: number; hi: number } | undefined>)[
            metric === "culture_per_turn" ? "culture"
              : metric === "science_per_turn" ? "science"
                : metric === "production_per_turn" ? "production"
                  : metric === "gold_per_turn" ? "goldNet" : ""
          ]
        : undefined;
      const checkpoint = cell
        ? `${cell.metric} 需 ${cell.requiredPerTurn}/回合，可得 ${cell.supplyPerTurn}/回合（缺口 ${cell.gap}）`
        : band
          ? `${metric} 应在 ${band.lo}-${band.hi}`
          : constraint
            ? `${metric} ≥ ${Math.ceil(constraint.required / Math.max(1, constraint.window))}`
            : null;
      rows.push({
        focusId: `${objectiveId}:${era.eraId}:${i + 1}`,
        eraId: era.eraId,
        eraIndex: era.eraIndex,
        turnLo,
        turnHi,
        rank: i + 1,
        constraintKey: constraint?.key ?? null,
        actionKind: "node",
        refId: node.id,
        refLabel: labeler.pair(node.kind, node.id).zh,
        why:
          `服务 ${metric}（紧张度 ${constraint ? constraint.tightness.toFixed(2) : "n/a"}）` +
          (node.role === "detour" ? `；绕路（${node.groupId ?? "misc"}）` : "") +
          (node.why ? `；${node.why}` : ""),
        cost: costText(node.cost as Record<string, number | undefined>),
        alternative: lever
          ? `${labeler.pair(kindOfId(lever.refId) ?? "building", lever.refId).zh || lever.refId}（${lever.actionKind}，成本 ${lever.costProduction ?? "?"}，收益 ${lever.deltaPerUnit ?? "?"}）`
          : null,
        abandonIf:
          node.role === "detour"
            ? "该绕路组不是绑定约束时整组跳过"
            : constraint && constraint.slack > 0
              ? "约束已松弛（slack>0）时可延后到下一时代"
              : "绑定约束上的强制节点，不能跳过",
        checkpoint,
        ledgerGap: cell ? cell.gap : null,
        supplyDelta: cell && cell.gap > 0 ? cell.gap : 0,
        sourceFlag: "derived",
        confidence: 0.6,
      });
    });

    if (!ranked.length) {
      const cell = worst;
      rows.push({
        focusId: `${objectiveId}:${era.eraId}:note`,
        eraId: era.eraId,
        eraIndex: era.eraIndex,
        turnLo,
        turnHi,
        rank: 1,
        constraintKey: binding?.key ?? null,
        actionKind: "note",
        refId: `era:${era.eraId}`,
        refLabel: "该时代无到期路径节点",
        why: "路径排期在此时代没有必须完成的新节点；把产能投给绑定约束的杠杆。",
        cost: null,
        alternative: null,
        abandonIf: null,
        checkpoint: cell
          ? `${cell.metric} 需 ${cell.requiredPerTurn}/回合，可得 ${cell.supplyPerTurn}/回合（缺口 ${cell.gap}）`
          : binding
            ? `${binding.metric} ≥ ${Math.ceil(binding.required / Math.max(1, binding.window))}`
            : null,
        ledgerGap: cell ? cell.gap : null,
        supplyDelta: cell && cell.gap > 0 ? cell.gap : 0,
        sourceFlag: "derived",
        confidence: 0.5,
      });
    }
  }

  return rows;
}
