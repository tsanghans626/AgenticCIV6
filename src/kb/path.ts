import type { KnowledgeDb } from "../db.js";
import { closureOf } from "./closure.js";
import { kindOfId } from "./node.js";
import type { CapabilitySpec, ObjectiveSpec } from "./spec.js";

/**
 * L3: the critical path (tree) behind an objective.
 *
 * Gates are expanded through the prerequisite closure into one node set. Every
 * node is classified so the model can tell "on the path" from "a priced detour"
 * and from "a dead end we deliberately skip":
 *
 *   on_path — required by at least one blocking gate
 *   detour  — required only by an enabling gate, or declared as a priced group
 *   dead    — explicitly excluded (e.g. Stirrups for the Tagma civic line)
 *
 * The classification is the structural guarantee behind advice like "skip
 * Stirrups" or "Mercenaries costs 810 culture" — it is data, not memory.
 */

export interface NodeCost {
  production?: number;
  science?: number;
  culture?: number;
  gold?: number;
  faith?: number;
}

export interface PathNode {
  kind: string;
  id: string;
  role: "on_path" | "detour" | "dead";
  groupId: string | null;
  depth: number;
  eraDue: number | null;
  cost: NodeCost;
  enables: string[];
  why: string | null;
}

export interface BuiltPath {
  objectiveId: string;
  nodes: PathNode[];
  totalCost: NodeCost;
  detourCost: Record<string, NodeCost>;
  dead: Array<{ kind: string; id: string; why: string }>;
  waivedConstraints: string[];
  addedByCapability: Array<{ id: string; why: string }>;
}

interface NodeMeta {
  kind: string;
  id: string;
  eraIndex: number | null;
  cost: NodeCost;
  costBasis: string;
}

const CURRENCIES: Array<keyof NodeCost> = ["science", "culture", "production", "gold", "faith"];

function currencyOf(kind: string): keyof NodeCost | null {
  if (kind === "tech") return "science";
  if (kind === "civic") return "culture";
  if (["unit", "district", "building", "project", "improvement"].includes(kind)) return "production";
  return null;
}

function addCost(into: NodeCost, key: keyof NodeCost, value: number | null | undefined): void {
  if (!value) return;
  into[key] = (into[key] ?? 0) + Number(value);
}

function scaleCost(cost: NodeCost, multiplier: number): NodeCost {
  const out: NodeCost = {};
  for (const [key, value] of Object.entries(cost)) {
    if (typeof value !== "number" || !value) continue;
    const scaled = key === "science" || key === "culture"
      ? Math.round(value * multiplier * 10) / 10
      : value;
    out[key as keyof NodeCost] = scaled;
  }
  return out;
}

function nodeKey(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
}

function emptyCost(): NodeCost {
  return {};
}

export function loadNodeMeta(kb: KnowledgeDb): Map<string, NodeMeta> {
  const out = new Map<string, NodeMeta>();
  for (const r of kb.all<{
    kind: string; id: string; era_index: number | null;
    cost_production: number | null; cost_science: number | null; cost_culture: number | null;
    cost_gold: number | null; cost_faith: number | null; cost_basis: string;
  }>(
    `SELECT kind, id, era_index, cost_production, cost_science, cost_culture,
            cost_gold, cost_faith, cost_basis FROM kb_node;`,
  )) {
    out.set(nodeKey(r.kind, r.id), {
      kind: r.kind,
      id: r.id,
      eraIndex: r.era_index === null ? null : Number(r.era_index),
      cost: {
        production: r.cost_production ?? undefined,
        science: r.cost_science ?? undefined,
        culture: r.cost_culture ?? undefined,
        gold: r.cost_gold ?? undefined,
        faith: r.cost_faith ?? undefined,
      },
      costBasis: r.cost_basis,
    });
  }
  return out;
}

/** Collect the full closure of one root into `map`, classified by role. */
function absorb(
  kb: KnowledgeDb,
  kind: string,
  id: string,
  role: "on_path" | "detour",
  why: string | null,
  groupId: string | null,
  map: Map<string, { kind: string; id: string; role: "on_path" | "detour"; depth: number; why: string | null; groupId: string | null }>,
): void {
  const closure = closureOf(kb, kind, id);
  const hasRoot = closure.some((n) => n.kind === kind && n.id === id);
  const list = hasRoot ? closure : [{ kind, id, depth: 0 }, ...closure];
  for (const node of list) {
    // Era tags and strategic-resource requirements are annotations, not
    // actionable path nodes; keeping them would put "ERA_ANCIENT" and
    // "RESOURCE_IRON" in the research order.
    if (node.kind === "era" || node.kind === "resource") continue;
    const key = nodeKey(node.kind, node.id);
    const prev = map.get(key);
    if (prev) {
      if (role === "on_path" && prev.role !== "on_path") {
        prev.role = "on_path";
        prev.why = why;
      }
      prev.depth = Math.max(prev.depth, node.depth);
      continue;
    }
    map.set(key, { kind: node.kind, id: node.id, role, depth: node.depth, why, groupId });
  }
}

function capabilityFor(objective: ObjectiveSpec, caps: CapabilitySpec[]): CapabilitySpec[] {
  if (!objective.civId) return [];
  return caps.filter((c) => {
    // Capabilities are civ-level; leader-specific ones are already merged into
    // the civ spec that matched the objective.
    return true;
  });
}

/**
 * Build the path for one objective under one speed profile.
 * `objectiveId` is the speed-qualified id written to the KB.
 */
export function buildPathForObjective(
  kb: KnowledgeDb,
  objective: ObjectiveSpec,
  objectiveId: string,
  nodes: Map<string, NodeMeta>,
  capabilities: CapabilitySpec[],
  speedMultiplier = 1,
): BuiltPath {
  const reachable = new Map<string, {
    kind: string; id: string; role: "on_path" | "detour"; depth: number;
    why: string | null; groupId: string | null;
  }>();

  // 0) capability removals run first: a removed gate root drops its whole gate
  //    (otherwise the siege line would linger as "detour" after being waived).
  const removeSet = new Set<string>();
  for (const cap of capabilityFor(objective, capabilities)) {
    for (const id of cap.remove ?? []) {
      if (/^[a-z][a-z0-9_.:-]+$/.test(id) && !kindOfId(id)) continue; // constraint key
      const kind = kindOfId(id);
      if (kind) removeSet.add(nodeKey(kind, id));
    }
  }

  // 1) gates -> closure
  for (const gate of objective.gates) {
    const role: "on_path" | "detour" = gate.role === "blocking" ? "on_path" : "detour";
    const why = gate.rationale ?? null;
    if (gate.kind === "unit" || gate.kind === "node") {
      const kind = gate.kind === "unit" ? "unit" : kindOfId(gate.id ?? "");
      if (!kind || !gate.id) continue;
      if (removeSet.has(nodeKey(kind, gate.id))) continue;
      absorb(kb, kind, gate.id, role, why, null, reachable);
    }
  }

  // 2) explicit detour groups
  for (const detour of objective.detours ?? []) {
    for (const id of detour.ids) {
      const kind = kindOfId(id);
      if (!kind) continue;
      absorb(kb, kind, id, "detour", detour.why, detour.groupId, reachable);
    }
  }

  // 3) capabilities: add / remove nodes, waive constraints
  const waivedConstraints: string[] = [];
  const addedByCapability: Array<{ id: string; why: string }> = [];
  const dead = new Map<string, { kind: string; id: string; why: string }>();
  for (const cap of capabilityFor(objective, capabilities)) {
    for (const id of cap.remove ?? []) {
      if (/^[a-z][a-z0-9_.:-]+$/.test(id) && !kindOfId(id)) {
        waivedConstraints.push(id);
        continue;
      }
      const kind = kindOfId(id);
      if (!kind) continue;
      dead.set(nodeKey(kind, id), { kind, id, why: cap.why ?? `${cap.op}: ${cap.traitId}` });
    }
    for (const id of cap.add ?? []) {
      const kind = kindOfId(id);
      if (!kind) continue;
      absorb(kb, kind, id, "on_path", cap.why ?? null, null, reachable);
      addedByCapability.push({ id, why: cap.why ?? "" });
    }
  }

  // 4) explicit dead ends win over reachability
  for (const d of objective.deadEnds ?? []) {
    const kind = kindOfId(d.id) ?? d.kind;
    dead.set(nodeKey(kind, d.id), { kind, id: d.id, why: d.why });
  }
  for (const key of dead.keys()) reachable.delete(key);

  // 5) era_due: own era, or max era of prerequisites inside the path
  const inside = (kind: string, id: string) => reachable.has(nodeKey(kind, id));
  const parentsOf = new Map<string, Array<{ kind: string; id: string }>>();
  if (kb.hasTable("kb_unlock")) {
    for (const r of kb.all<{ child_kind: string; child_id: string; parent_kind: string; parent_id: string }>(
      `SELECT child_kind, child_id, parent_kind, parent_id FROM kb_unlock WHERE relation NOT IN ('replaces','era');`,
    )) {
      const key = nodeKey(r.child_kind, r.child_id);
      if (!reachable.has(key)) continue;
      if (!inside(r.parent_kind, r.parent_id)) continue;
      const list = parentsOf.get(key) ?? [];
      list.push({ kind: r.parent_kind, id: r.parent_id });
      parentsOf.set(key, list);
    }
  }

  const eraDue = new Map<string, number>();
  for (const key of reachable.keys()) {
    eraDue.set(key, nodes.get(key)?.eraIndex ?? 0);
  }
  // Relax: era_due(node) = max(own, era_due(parents)). Bounded by node count.
  for (let pass = 0; pass < Math.min(reachable.size, 64); pass++) {
    let changed = false;
    for (const [key, parents] of parentsOf) {
      let due = eraDue.get(key) ?? 0;
      for (const p of parents) {
        const pDue = eraDue.get(nodeKey(p.kind, p.id)) ?? 0;
        if (pDue > due) due = pDue;
      }
      if (due !== (eraDue.get(key) ?? 0)) {
        eraDue.set(key, due);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 6) topological order: prerequisites (deeper closure depth) first.
  const ordered = [...reachable.values()].sort((a, b) => {
    if (b.depth !== a.depth) return b.depth - a.depth;
    return nodeKey(a.kind, a.id).localeCompare(nodeKey(b.kind, b.id));
  });

  // 7) enable lists (who is unlocked by this node) + cumulative cost
  const children = new Map<string, string[]>();
  for (const [key, parents] of parentsOf) {
    for (const p of parents) {
      const pk = nodeKey(p.kind, p.id);
      const list = children.get(pk) ?? [];
      list.push(key);
      children.set(pk, list);
    }
  }

  const total: NodeCost = emptyCost();
  const out: PathNode[] = [];
  for (const node of ordered) {
    const key = nodeKey(node.kind, node.id);
    const meta = nodes.get(key);
    const cost: NodeCost = scaleCost({ ...(meta?.cost ?? {}) }, speedMultiplier);
    // A gate may require several copies of the same unit; charge the extra
    // ones here and keep the node's own unit cost out of `total` to avoid
    // double counting.
    const gate = objective.gates.find((g) => g.kind === "unit" && g.id === node.id);
    const qty = gate?.qty ?? 1;
    if (gate && qty > 1) {
      cost.production = (cost.production ?? 0) + (meta?.cost.production ?? 0) * (qty - 1);
    }
    // Only the critical path counts toward the constraint demand; detours are
    // priced separately so "skip this group" has a concrete number.
    if (node.role === "on_path") {
      for (const c of CURRENCIES) addCost(total, c, cost[c] ?? null);
    }
    out.push({
      kind: node.kind,
      id: node.id,
      role: node.role,
      groupId: node.groupId,
      depth: node.depth,
      eraDue: eraDue.get(key) ?? null,
      cost,
      enables: (children.get(key) ?? []).map((k) => k.split("\u0000")[1]).slice(0, 6),
      why: node.why,
    });
  }

  // 8) detour pricing per group
  const detourCost: Record<string, NodeCost> = {};
  for (const node of out) {
    if (node.role !== "detour") continue;
    const group = node.groupId ?? "misc";
    const bucket = detourCost[group] ?? emptyCost();
    for (const c of CURRENCIES) addCost(bucket, c, node.cost[c] ?? null);
    detourCost[group] = bucket;
  }

  const deadNodes = [...dead.values()];
  // Explicit detour totals are also reported for detour nodes added by
  // capability preconditions (they land on_path, so no separate bucket).

  void currencyOf; // reserved for future per-kind rules

  return {
    objectiveId,
    nodes: out,
    totalCost: total,
    detourCost,
    dead: deadNodes,
    waivedConstraints,
    addedByCapability,
  };
}
