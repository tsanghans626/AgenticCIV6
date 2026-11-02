import type { KnowledgeDb } from "../db.js";
import type { DataSource } from "../config.js";
import {
  PACING_DIMENSIONS,
  type Assurance,
  type PacingBaselineSpec,
  type PacingDimension,
  type PacingSpecs,
} from "./spec.js";

/**
 * Graph + effect index for the pacing model.
 *
 * Everything here is a read of the decision layer; no authored numbers. Costs
 * are normalized to the requested speed once, at load time, so the simulator
 * never rescales anything (the same contract as `civi6_eval.basis`).
 */

export type Currency = "science" | "culture" | "production" | "gold" | "faith";
export const CURRENCIES: Currency[] = ["science", "culture", "production", "gold", "faith"];

export function nodeKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

export function splitKey(key: string): { kind: string; id: string } {
  const i = key.indexOf(":");
  return { kind: key.slice(0, i), id: key.slice(i + 1) };
}

export interface PaceNode {
  kind: string;
  id: string;
  labelZh: string;
  eraId: string | null;
  eraIndex: number;
  costs: Partial<Record<Currency, number>>;
  costBasis: string;
  maxInstances: number | null;
  spaceRace: number;
}

export interface PaceEffect {
  ownerKind: string;
  ownerId: string;
  dimension: PacingDimension;
  op: "add" | "percent";
  value: number;
  per: string | null;
  scope: "city" | "player" | "district";
  condition: string | null;
  modifierType: string;
}

export interface SpeedBasis {
  speed: string;
  labelZh: string;
  totalTurns: number;
  costMultiplier: number;
  turnScale: number;
  source: string;
}

export interface CivProjection {
  civId: string;
  leaderId: string | null;
  labelZh: string;
  nameEn: string | null;
  traits: string[];
  uniqueUnits: string[];
  uniqueBuildings: string[];
  uniqueDistricts: string[];
  /** base id -> unique id (only when the unique node exists in kb_node) */
  replacements: Map<string, string>;
  /** unique id -> base id (for floor/assumption fallback) */
  uniqueToBase: Map<string, string>;
}

export interface ExcludedReport {
  effects: number;
  byReason: Record<string, number>;
  byModifierType: Record<string, number>;
}

export interface PaceGraph {
  source: DataSource;
  speed: SpeedBasis;
  assurance: Assurance;
  nodes: Map<string, PaceNode>;
  parents: Map<string, string[]>;
  children: Map<string, string[]>;
  effects: PaceEffect[];
  effectsByOwner: Map<string, PaceEffect[]>;
  buildingMeta: Map<string, { district: string | null; maxInstances: number | null }>;
  unitMeta: Map<string, { combat: number; maintenance: number }>;
  projectMeta: Map<string, { district: string | null; spaceRace: number }>;
  policyUnlocks: Map<string, string[]>;
  params: Record<string, number>;
  eras: Array<{ id: string; index: number; turnLo: number; turnHi: number }>;
  startingUnits: Array<{ id: string; qty: number }>;
  civ: CivProjection;
  plan: { burstTurn: number; burstEra: string } | null;
  excluded: ExcludedReport;
}

export interface LoadPacingOptions {
  source: DataSource;
  speed: string;
  assurance: Assurance;
  civId: string;
  leaderId?: string | null;
  victoryId: string;
  baseline: PacingBaselineSpec;
  specs: PacingSpecs;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function hasCol(kb: KnowledgeDb, table: string, column: string): boolean {
  return kb.hasTable(table) && kb.tableColumns(table).some((c) => c.toLowerCase() === column.toLowerCase());
}

function parseList(value: unknown): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function loadSpeed(kb: KnowledgeDb, wanted: string): SpeedBasis {
  const rows = kb.hasTable("kb_speed_profile")
    ? kb.all<{ speed: string; label_zh: string; total_turns: number; cost_multiplier: number }>(
        `SELECT speed, label_zh, total_turns, cost_multiplier FROM kb_speed_profile;`,
      )
    : [];
  const byId = new Map(rows.map((r) => [String(r.speed), r]));
  const standard =
    rows.find((r) => num(r.cost_multiplier) === 100) ??
    rows.slice().sort((a, b) => num(b.total_turns) - num(a.total_turns))[0];
  const row = byId.get(wanted);
  if (!row) {
    throw new Error(
      `速度 "${wanted}" 未注册。可用：${rows.map((r) => r.speed).join(" / ") || "none"}（扩展速度档请改 kb/speeds.json 并重建决策层）`,
    );
  }
  const baseTurns = standard ? num(standard.total_turns) : 0;
  return {
    speed: wanted,
    labelZh: String(row.label_zh ?? wanted),
    totalTurns: num(row.total_turns),
    costMultiplier: num(row.cost_multiplier) > 0 ? num(row.cost_multiplier) / 100 : 1,
    turnScale: baseTurns > 0 ? num(row.total_turns) / baseTurns : 1,
    source: "kb_speed_profile (Gamespeeds.CostMultiplier)",
  };
}

function loadParams(kb: KnowledgeDb): Record<string, number> {
  const out: Record<string, number> = {};
  if (!kb.hasTable("GlobalParameters")) return out;
  for (const r of kb.all<{ Name: string; Value: string }>(`SELECT Name, Value FROM GlobalParameters;`)) {
    const n = Number(r.Value);
    if (Number.isFinite(n)) out[String(r.Name)] = n;
  }
  return out;
}

function loadEras(kb: KnowledgeDb, source: DataSource): PaceGraph["eras"] {
  if (kb.hasTable("kb_era_window")) {
    const rows = kb.all<{ era_id: string; era_index: number; turn_lo: number; turn_hi: number }>(
      `SELECT era_id, era_index, turn_lo, turn_hi FROM kb_era_window WHERE source = ? ORDER BY era_index;`,
      source,
    );
    if (rows.length) {
      return rows.map((r) => ({
        id: String(r.era_id),
        index: num(r.era_index),
        turnLo: num(r.turn_lo),
        turnHi: num(r.turn_hi),
      }));
    }
  }
  const fallback = [
    ["ERA_ANCIENT", 1, 1, 50],
    ["ERA_CLASSICAL", 2, 45, 95],
    ["ERA_MEDIEVAL", 3, 90, 140],
    ["ERA_RENAISSANCE", 4, 135, 185],
    ["ERA_INDUSTRIAL", 5, 180, 215],
    ["ERA_MODERN", 6, 210, 240],
    ["ERA_ATOMIC", 7, 235, 255],
    ["ERA_INFORMATION", 8, 250, 280],
  ] as const;
  return fallback.map(([id, index, turnLo, turnHi]) => ({ id, index, turnLo, turnHi }));
}

function loadMeta(
  kb: KnowledgeDb,
): Pick<PaceGraph, "buildingMeta" | "unitMeta" | "projectMeta"> {
  const buildingMeta = new Map<string, { district: string | null; maxInstances: number | null }>();
  if (kb.hasTable("Buildings")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT BuildingType, PrereqDistrict, MaxPlayerInstances FROM Buildings;`,
    )) {
      buildingMeta.set(String(r.BuildingType), {
        district: r.PrereqDistrict ? String(r.PrereqDistrict) : null,
        maxInstances:
          r.MaxPlayerInstances === null || r.MaxPlayerInstances === undefined ? null : num(r.MaxPlayerInstances),
      });
    }
  }
  const unitMeta = new Map<string, { combat: number; maintenance: number }>();
  if (kb.hasTable("Units")) {
    for (const r of kb.all<Record<string, unknown>>(`SELECT UnitType, Combat, Maintenance FROM Units;`)) {
      unitMeta.set(String(r.UnitType), {
        combat: num(r.Combat),
        maintenance: num(r.Maintenance),
      });
    }
  }
  const projectMeta = new Map<string, { district: string | null; spaceRace: number }>();
  if (kb.hasTable("Projects")) {
    for (const r of kb.all<Record<string, unknown>>(`SELECT ProjectType, PrereqDistrict, SpaceRace FROM Projects;`)) {
      projectMeta.set(String(r.ProjectType), {
        district: r.PrereqDistrict ? String(r.PrereqDistrict) : null,
        spaceRace: num(r.SpaceRace),
      });
    }
  }
  return { buildingMeta, unitMeta, projectMeta };
}

function loadNodes(kb: KnowledgeDb, meta: Pick<PaceGraph, "buildingMeta" | "projectMeta">): Map<string, PaceNode> {
  const nodes = new Map<string, PaceNode>();
  for (const r of kb.all<Record<string, unknown>>(
    `SELECT kind, id, label_zh, era_id, era_index, cost_production, cost_science, cost_culture,
            cost_gold, cost_faith, cost_basis FROM kb_node;`,
  )) {
    const kind = String(r.kind);
    const id = String(r.id);
    const costs: Partial<Record<Currency, number>> = {};
    for (const [col, cur] of [
      ["cost_science", "science"],
      ["cost_culture", "culture"],
      ["cost_production", "production"],
      ["cost_gold", "gold"],
      ["cost_faith", "faith"],
    ] as const) {
      const v = r[col];
      if (v !== null && v !== undefined && num(v) > 0) costs[cur] = num(v);
    }
    const eraId = r.era_id ? String(r.era_id) : null;
    const project = kind === "project" ? meta.projectMeta.get(id) : undefined;
    const building = kind === "building" ? meta.buildingMeta.get(id) : undefined;
    nodes.set(nodeKey(kind, id), {
      kind,
      id,
      labelZh: String(r.label_zh ?? id),
      eraId,
      eraIndex: num(r.era_index),
      costs,
      costBasis: String(r.cost_basis ?? "flat"),
      maxInstances: building?.maxInstances ?? null,
      spaceRace: project?.spaceRace ?? 0,
    });
  }
  return nodes;
}

function loadEdges(kb: KnowledgeDb): { parents: Map<string, string[]>; children: Map<string, string[]> } {
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  if (!kb.hasTable("kb_unlock")) return { parents, children };
  for (const r of kb.all<{ child_kind: string; child_id: string; parent_kind: string; parent_id: string }>(
    `SELECT child_kind, child_id, parent_kind, parent_id FROM kb_unlock;`,
  )) {
    const child = nodeKey(String(r.child_kind), String(r.child_id));
    const parent = nodeKey(String(r.parent_kind), String(r.parent_id));
    const pl = parents.get(child) ?? [];
    if (!pl.includes(parent)) pl.push(parent);
    parents.set(child, pl);
    const cl = children.get(parent) ?? [];
    if (!cl.includes(child)) cl.push(child);
    children.set(parent, cl);
  }
  return { parents, children };
}

function loadEffects(
  kb: KnowledgeDb,
  baseline: PacingBaselineSpec,
): { effects: PaceEffect[]; excluded: ExcludedReport } {
  const excluded: ExcludedReport = { effects: 0, byReason: {}, byModifierType: {} };
  const bump = (map: Record<string, number>, key: string) => {
    map[key] = (map[key] ?? 0) + 1;
  };
  const allowTypes = new Set(baseline.sources.allowModifierTypes);
  const excludedOwners = new Set(baseline.sources.excludedOwnerKinds);
  const dims = new Set<string>(PACING_DIMENSIONS);
  const seen = new Set<string>();
  const effects: PaceEffect[] = [];

  const rows = kb.all<{
    owner_kind: string;
    owner_id: string;
    dimension: string;
    op: string;
    value: number;
    per: string | null;
    scope: string;
    modifier_type: string;
    condition_set_id: string | null;
    src_table: string;
  }>(
    `SELECT o.owner_kind, o.owner_id, f.dimension, f.op, f.value, f.per, f.scope,
            f.modifier_type, f.condition_set_id, f.src_table
       FROM kb_formula f JOIN kb_formula_owner o ON o.modifier_id = f.modifier_id
      WHERE f.dimension IS NOT NULL;`,
  );

  for (const r of rows) {
    if (!dims.has(String(r.dimension))) continue;
    if (r.op !== "add" && r.op !== "percent") continue;
    const ownerKind = String(r.owner_kind);
    if (excludedOwners.has(ownerKind)) continue;
    const scope = String(r.scope);
    if (scope !== "city" && scope !== "player" && scope !== "district") continue;

    const isTableYield = String(r.src_table) === "Building_YieldChanges";
    if (!isTableYield && !allowTypes.has(String(r.modifier_type))) {
      excluded.effects++;
      bump(excluded.byReason, "modifier-type");
      bump(excluded.byModifierType, String(r.modifier_type));
      continue;
    }

    let condition: string | null = null;
    if (r.condition_set_id) {
      const key = baseline.sources.knownConditions[String(r.condition_set_id)];
      if (!key) {
        excluded.effects++;
        bump(excluded.byReason, "unknown-condition");
        continue;
      }
      condition = key;
    }

    const per = r.per ? String(r.per) : null;
    if (per && per !== "pop" && per !== "era" && per !== "city" && per !== "turn") {
      excluded.effects++;
      bump(excluded.byReason, "per-scope");
      continue;
    }

    const key = `${ownerKind}\u0000${r.owner_id}\u0000${r.dimension}\u0000${r.op}\u0000${num(r.value)}\u0000${per ?? ""}\u0000${scope}\u0000${condition ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    effects.push({
      ownerKind,
      ownerId: String(r.owner_id),
      dimension: String(r.dimension) as PacingDimension,
      op: r.op as "add" | "percent",
      value: num(r.value),
      per,
      scope: scope as "city" | "player" | "district",
      condition,
      modifierType: String(r.modifier_type),
    });
  }
  return { effects, excluded };
}

function loadCiv(
  kb: KnowledgeDb,
  nodes: Map<string, PaceNode>,
  civId: string,
  leaderId?: string | null,
): CivProjection {
  const rows = kb.all<Record<string, unknown>>(`SELECT * FROM kb_civ_profile WHERE civ_id = ?;`, civId);
  const row = leaderId ? rows.find((r) => String(r.leader_id) === leaderId) ?? rows[0] : rows[0];
  if (!row) throw new Error(`未知文明：${civId}（kb_civ_profile 无记录）`);
  const replacements = new Map<string, string>();
  for (const r of kb.all<{ base_id: string; unique_id: string }>(
    `SELECT DISTINCT base_id, unique_id FROM kb_civ_entity_map WHERE civ_id = ? AND base_id <> unique_id;`,
    civId,
  )) {
    const base = String(r.base_id);
    const unique = String(r.unique_id);
    if (
      nodes.has(nodeKey("district", unique)) ||
      nodes.has(nodeKey("building", unique)) ||
      nodes.has(nodeKey("unit", unique))
    ) {
      replacements.set(base, unique);
    }
  }
  const uniqueToBase = new Map<string, string>();
  for (const [base, unique] of replacements) uniqueToBase.set(unique, base);
  return {
    civId,
    leaderId: row.leader_id ? String(row.leader_id) : null,
    labelZh: String(row.name_zh ?? civId),
    nameEn: row.name_en ? String(row.name_en) : null,
    traits: parseList(row.trait_ids),
    uniqueUnits: parseList(row.unique_unit),
    uniqueBuildings: parseList(row.unique_building),
    uniqueDistricts: parseList(row.unique_district),
    replacements,
    uniqueToBase,
  };
}

function loadStartingUnits(kb: KnowledgeDb, startingEra: string): Array<{ id: string; qty: number }> {
  const out: Array<{ id: string; qty: number }> = [];
  if (!kb.hasTable("MajorStartingUnits")) return out;
  for (const r of kb.all<Record<string, unknown>>(
    `SELECT Unit, Quantity, AiOnly FROM MajorStartingUnits WHERE Era = ?;`,
    startingEra,
  )) {
    if (num(r.AiOnly) > 0) continue;
    const id = String(r.Unit ?? "");
    if (!id) continue;
    const qty = r.Quantity === null || r.Quantity === undefined ? 1 : num(r.Quantity);
    if (qty <= 0) continue;
    const prev = out.find((u) => u.id === id);
    if (prev) prev.qty += qty;
    else out.push({ id, qty });
  }
  return out;
}

function loadPlan(
  kb: KnowledgeDb,
  source: DataSource,
  victoryId: string,
): { burstTurn: number; burstEra: string } | null {
  if (!kb.hasTable("kb_plan")) return null;
  const row = kb.get<{ burst_turn: number; burst_era: string }>(
    `SELECT burst_turn, burst_era FROM kb_plan WHERE victory_id = ? AND source = ? LIMIT 1;`,
    victoryId,
    source,
  );
  return row ? { burstTurn: num(row.burst_turn), burstEra: String(row.burst_era) } : null;
}

export function loadPaceGraph(kb: KnowledgeDb, opts: LoadPacingOptions): PaceGraph {
  const { source, speed, assurance, civId, leaderId, baseline } = opts;
  const meta = loadMeta(kb);
  const nodes = loadNodes(kb, meta);
  const { parents, children } = loadEdges(kb);
  const { effects, excluded } = loadEffects(kb, baseline);
  const effectsByOwner = new Map<string, PaceEffect[]>();
  for (const e of effects) {
    const key = `${e.ownerKind}:${e.ownerId}`;
    const list = effectsByOwner.get(key) ?? [];
    list.push(e);
    effectsByOwner.set(key, list);
  }
  const policyUnlocks = new Map<string, string[]>();
  for (const [child, list] of parents) {
    const { kind, id } = splitKey(child);
    if (kind === "policy") policyUnlocks.set(id, list);
  }
  return {
    source,
    speed: loadSpeed(kb, speed),
    assurance,
    nodes,
    parents,
    children,
    effects,
    effectsByOwner,
    ...meta,
    policyUnlocks,
    params: loadParams(kb),
    eras: loadEras(kb, source),
    startingUnits: loadStartingUnits(kb, baseline.assumptions.startingEra),
    civ: loadCiv(kb, nodes, civId, leaderId),
    plan: loadPlan(kb, source, opts.victoryId),
    excluded,
  };
}

/** Resolve a node id through the civ's unique replacements. */
export function resolveId(graph: PaceGraph, id: string): string {
  return graph.civ.replacements.get(id) ?? id;
}

export function nodeFor(graph: PaceGraph, kind: string, id: string): PaceNode | null {
  const resolved = resolveId(graph, id);
  return graph.nodes.get(nodeKey(kind, resolved)) ?? graph.nodes.get(nodeKey(kind, id)) ?? null;
}

export function costAtSpeed(graph: PaceGraph, node: PaceNode, currency: Currency): number {
  return (node.costs[currency] ?? 0) * graph.speed.costMultiplier;
}

export function worldEraAt(graph: PaceGraph, turn: number): number {
  const scaled = Math.max(1, Math.round(turn / Math.max(graph.speed.turnScale, 1e-9)));
  let index = 1;
  for (const era of graph.eras) {
    if (scaled >= era.turnLo) index = Math.max(index, era.index);
  }
  return index;
}

/** Era-based science/culture cost modifier (TECH/CIVIC_COST_PERCENT_CHANGE_*). */
export function eraCostFactor(graph: PaceGraph, node: PaceNode, currency: Currency, worldEra: number): number {
  if (currency !== "science" && currency !== "culture") return 1;
  if (!node.eraIndex) return 1;
  const prefix = currency === "science" ? "TECH" : "CIVIC";
  const before = graph.params[`${prefix}_COST_PERCENT_CHANGE_BEFORE_GAME_ERA`] ?? 0;
  const after = graph.params[`${prefix}_COST_PERCENT_CHANGE_AFTER_GAME_ERA`] ?? 0;
  if (node.eraIndex < worldEra) return 1 + before / 100;
  if (node.eraIndex > worldEra) return 1 + after / 100;
  return 1;
}

export function costOfNode(graph: PaceGraph, node: PaceNode, currency: Currency, worldEra: number): number {
  return costAtSpeed(graph, node, currency) * eraCostFactor(graph, node, currency, worldEra);
}

export function hasColumn(kb: KnowledgeDb, table: string, column: string): boolean {
  return hasCol(kb, table, column);
}
