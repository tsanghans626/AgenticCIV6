import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "../config.js";

export type VictoryId = "science" | "culture" | "religion" | "domination" | "diplomatic";
export type Role = "blocking" | "enabling" | "support" | "optional";
export type SourceFlag = "db" | "rule" | "derived" | "empirical";
export type TargetOp = "=" | ">=" | "<=" | "between" | "contains" | "ratio";
/** Game-speed profile id. `online` is half the standard turn window. */
export type SpeedId = "standard" | "online";

/** One authored speed profile (turn window + tech/civic cost multiplier). */
export interface SpeedProfileSpec {
  speed: SpeedId;
  labelZh?: string;
  totalTurns: number;
  /** Percent, 100 = standard. Comes from `Gamespeeds.CostMultiplier`. */
  costMultiplier: number;
}

export interface EntityReq {
  id: string;
  qty?: number;
  role?: Role;
  rationale?: string;
}

export interface MetricReq {
  dimension: string;
  op?: TargetOp;
  value?: number;
  lo?: number;
  hi?: number;
  role?: Role;
  formula?: string;
  rationale?: string;
  sourceFlag?: SourceFlag;
  confidence?: number;
  checkHint?: string;
  remedy?: string;
}

export interface EraBand {
  lo: number;
  hi: number;
}

/** Per-city / per-empire build program used by the reverse-derivation engine. */
export interface InfraSpec {
  cities?: number;
  popPerCity?: number;
  perCity?: Record<string, number>;
  empire?: Record<string, number>;
  units?: Record<string, number>;
  policies?: string[];
  government?: string;
  /** Assumed production per city at the burst point. */
  perCityProd?: number;
  perPopScience?: number;
  perPopCulture?: number;
  perPopGold?: number;
  tradeRoutes?: number;
  goldPerRoute?: number;
  luxuries?: number;
  entertainmentAmenities?: number;
  /** Extra housing sources beyond the water baseline, per city. */
  housingPerCity?: number;
}

export interface BurstSpec {
  turn: number;
  eraId: string;
  window: number;
  margin?: number;
  projects?: EntityReq[];
  techs?: EntityReq[];
  civics?: EntityReq[];
  policies?: EntityReq[];
  governments?: EntityReq[];
  districts?: EntityReq[];
  buildings?: EntityReq[];
  units?: EntityReq[];
  greatPeople?: EntityReq[];
  metrics?: MetricReq[];
  infrastructure?: InfraSpec;
  rationale?: string;
  includeTechClosure?: boolean;
  includeCivicClosure?: boolean;
}

export interface EraSpec {
  eraId: string;
  turnLo: number;
  turnHi: number;
  cities?: EraBand;
  population?: EraBand;
  science?: EraBand;
  culture?: EraBand;
  production?: EraBand;
  goldNet?: EraBand;
  faith?: EraBand;
  metrics?: MetricReq[];
  techs?: string[];
  civics?: string[];
  policies?: string[];
  districts?: string[];
  buildings?: string[];
  notes?: string;
}

export interface PlanSpec {
  victoryId: VictoryId;
  nameZh?: string;
  burst: BurstSpec;
  eras: EraSpec[];
  assumptions?: Record<string, unknown>;
  /** Optional per-ruleset overrides; arrays replace, objects merge. */
  overrides?: {
    vanilla?: Partial<Omit<PlanSpec, "victoryId">>;
    bbg?: Partial<Omit<PlanSpec, "victoryId">>;
  };
}

export interface CivDeltaSpec {
  victoryId: VictoryId;
  op: "replace" | "add" | "multiply" | "remove" | "note";
  targetRef: { category: string; entityId?: string; dimensionId?: string };
  valueNum?: number;
  valueLo?: number;
  valueHi?: number;
  valueText?: string;
  eraId?: string;
  reason?: string;
  sourceFlag?: SourceFlag;
  confidence?: number;
}

export interface CivEntityMapSpec {
  slotKind: "district" | "building" | "unit" | "improvement";
  baseId: string;
  uniqueId: string;
  replacesId?: string;
}

export interface CivSpec {
  civId: string;
  leaderId?: string;
  supportedVictories?: VictoryId[];
  playstyleTags?: string[];
  summary?: string;
  entityMap?: CivEntityMapSpec[];
  deltas?: CivDeltaSpec[];
  /** Traits expressed as transforms on constraints/paths (see ObjectiveSpec). */
  capabilities?: CapabilitySpec[];
}

// ---------------------------------------------------------------------------
// Objective layer: the goal capsule plus the tree/constraint reasoning that is
// derived from it. See kb/README.md §3.4.
// ---------------------------------------------------------------------------

export type GateKind = "unit" | "node" | "metric" | "capability";

/** One "must be true" condition at the burst point. */
export interface GateSpec {
  kind: GateKind;
  /** entity id (unit/node), dimension id (metric) or capability id. */
  id?: string;
  qty?: number;
  metric?: string;
  op?: TargetOp;
  value?: number;
  role?: Role;
  rationale?: string;
}

export interface ObjectiveConstraintSpec {
  /** Currency or metric the constraint is measured in. */
  metric: string;
  /** Baseline supply per turn, e.g. culture per turn anchors. */
  supplyRate?: number;
  unit?: string;
  /** Optional window override (turns). Defaults to burst turn. */
  window?: number;
  /** Optional authored requirement; otherwise derived from the path. */
  required?: number;
  notes?: string;
  sourceFlag?: SourceFlag;
}

export interface DeadEndSpec {
  /** tech | civic | unit | district | building | policy | government */
  kind: string;
  id: string;
  why: string;
}

export interface DetourSpec {
  groupId: string;
  ids: string[];
  why: string;
  alternative?: string;
}

export interface EraFocusOverrideSpec {
  eraId: string;
  rank: number;
  constraintKey?: string;
  actionKind: "node" | "lever" | "note";
  refId: string;
  why: string;
  /** Optional display override; when omitted the cost is derived from the node
   *  at the active speed and era penalty (never hand-written). */
  costText?: string;
  alternative?: string;
  abandonIf?: string;
  checkpoint?: string;
  sourceFlag?: SourceFlag;
}

// ---------------------------------------------------------------------------
// L2c supply ledger: every currency the objective consumes must be traced to
// named sources (building / district / resource / belief / policy / governor),
// each with how many copies, when the first copy comes online and the cost.
// A scalar "supplyRate" anchor is only a legacy fallback.
// ---------------------------------------------------------------------------

export interface SupplySourceSpec {
  sourceId: string;
  /** e.g. culture_per_turn */
  metric: string;
  kind: string;
  refId: string;
  /** Yield per copy per turn. */
  perUnit: number;
  /** Copies in the base scenario (default 1). For perPop sources this is the
   *  assumed city population. */
  copies?: number;
  copiesLo?: number;
  copiesHi?: number;
  /** Standard-speed turn the first copy starts producing. */
  fromTurn?: number;
  /** True when the multiplier is population, not separate buildings. */
  perPop?: boolean;
  requires?: string;
  /** Provenance string, e.g. kb_effect:building:BUILDING_MONUMENT:culture_per_turn */
  dataRef?: string;
  sourceFlag?: SourceFlag;
  confidence?: number;
  note?: string;
}

/** One priced way to close a budget gap. */
export interface CutSpec {
  /** defer = postpone an on-path node past the burst (burst slips). */
  kind: "defer" | "drop";
  /** Node id for defer, detour group id for drop. */
  refId?: string;
  group?: string;
  saves: Record<string, number>;
  /** What is lost by taking this cut. */
  lose: string;
  order?: number;
  trigger?: string;
}

export interface ScenarioSpec {
  id: string;
  label: string;
  /** sourceId -> copies override. */
  supplyOverrides?: Record<string, number>;
  /** Multiplier on required cost (world-era lead, difficulty). Default 1. */
  costMultiplier?: number;
  /** Whether available inspirations are credited. Default false. */
  creditInspirations?: boolean;
  assumptions?: Record<string, unknown>;
  note?: string;
}

export interface InspirationSpec {
  /** none = never credit; authored = credit the listed civics only. */
  mode: "none" | "authored";
  credits?: Record<string, number>;
}

/**
 * The objective is the single source of truth for "what must be true by T*".
 * Paths, constraints and era focus are all derived from it at build time.
 */
export interface ObjectiveSpec {
  objectiveId: string;
  victoryId: VictoryId;
  civId?: string;
  leaderId?: string;
  /** Authored speed; the engine emits one row per profile in speeds.json. */
  speed?: SpeedId;
  burstTurn: number;
  burstEra: string;
  title?: string;
  gates: GateSpec[];
  constraints?: ObjectiveConstraintSpec[];
  /** L2c: named supply sources. When absent the legacy `supplyRate` anchor is used. */
  supply?: SupplySourceSpec[];
  scenarios?: ScenarioSpec[];
  cutOrder?: CutSpec[];
  inspiration?: InspirationSpec;
  /** strict (default) fails the build when the base scenario cannot close at
   *  the burst era; report only records the gap. */
  feasibility?: "strict" | "report";
  deadEnds?: DeadEndSpec[];
  detours?: DetourSpec[];
  eraFocusOverrides?: EraFocusOverrideSpec[];
  assumptions?: Record<string, unknown>;
}

export type CapabilityOp = "waive" | "convert" | "retarget" | "amplify" | "precondition";

/**
 * A civilization trait expressed as a transform on the reasoning layers:
 *   waive        — remove a gate/constraint (the trait makes it unnecessary)
 *   retarget     — move a requirement between tree branches (add/remove nodes)
 *   precondition — add required nodes the trait depends on
 *   convert      — a yield/precondition becomes a capability (recorded, not a target)
 *   amplify      — multiplier on a constraint's supply or requirement
 */
export interface CapabilitySpec {
  op: CapabilityOp;
  traitId: string;
  targetRef?: { kind?: string; id?: string };
  /** Node ids to add to the path (closure expanded). */
  add?: string[];
  /** Node ids or constraint keys to drop. */
  remove?: string[];
  value?: number;
  requires?: Record<string, unknown>;
  /** Verbatim effect text (effects[].text_zh) from the effect card. */
  effectTextZh?: string;
  why?: string;
  confidence?: number;
}

export interface VictorySpec {
  victoryId: VictoryId;
  nameZh: string;
  nameEn: string;
  rawVictoryType: string;
  winCheck: string;
  criticalPercentage?: number;
  burstDefinition: string;
  defaultBurstTurn: number;
  sourceFlag: SourceFlag;
  confidence: number;
}

export interface EraWindowSpec {
  eraId: string;
  eraIndex: number;
  turnLo: number;
  turnHi: number;
  assumedWindow: number;
}

export interface DimensionSpec {
  dimensionId: string;
  nameZh: string;
  nameEn?: string;
  unit?: string;
  valueType: "int" | "real" | "bool";
  aggregation: "sum" | "count" | "max" | "min" | "mean" | "last";
  direction: "higher" | "lower" | "band";
  observation?: string;
  notes?: string;
}

export interface KbSpecs {
  root: string;
  dimensions: DimensionSpec[];
  victories: VictorySpec[];
  eras: EraWindowSpec[];
  plans: PlanSpec[];
  civs: CivSpec[];
  speeds: SpeedProfileSpec[];
  objectives: ObjectiveSpec[];
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function readJsonDir<T>(dir: string, label: string): T[] {
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      out.push(readJson<T>(file));
    } catch (error) {
      throw new Error(`无法解析 ${label} JSON：${file}\n${(error as Error).message}`);
    }
  }
  return out;
}

/** Load every curated KB spec from `<workspace>/kb`. */
export function loadKbSpecs(root: string = WORKSPACE_ROOT): KbSpecs {
  const kbDir = join(root, "kb");
  const dimensionsFile = join(kbDir, "dimensions.json");
  const victoriesFile = join(kbDir, "victories.json");
  const erasFile = join(kbDir, "eras.json");
  if (!existsSync(dimensionsFile)) throw new Error(`缺少维度字典：${dimensionsFile}`);
  if (!existsSync(victoriesFile)) throw new Error(`缺少胜利判据：${victoriesFile}`);
  if (!existsSync(erasFile)) throw new Error(`缺少时代窗口：${erasFile}`);

  const dimensions = readJson<DimensionSpec[]>(dimensionsFile);
  const victories = readJson<VictorySpec[]>(victoriesFile);
  const eras = readJson<EraWindowSpec[]>(erasFile);
  const plans = readJsonDir<PlanSpec>(join(kbDir, "plans"), "计划");
  const rawCivs = readJsonDir<CivSpec | CivSpec[]>(join(kbDir, "civs"), "文明");
  const civs: CivSpec[] = [];
  for (const entry of rawCivs) {
    if (Array.isArray(entry)) civs.push(...entry);
    else civs.push(entry);
  }
  const speedsFile = join(kbDir, "speeds.json");
  const speeds = existsSync(speedsFile)
    ? readJson<SpeedProfileSpec[]>(speedsFile)
    : ([{ speed: "standard", totalTurns: 500, costMultiplier: 100 }] as SpeedProfileSpec[]);
  const rawObjectives = readJsonDir<ObjectiveSpec | ObjectiveSpec[]>(join(kbDir, "objectives"), "目标");
  const objectives: ObjectiveSpec[] = [];
  for (const entry of rawObjectives) {
    if (Array.isArray(entry)) objectives.push(...entry);
    else objectives.push(entry);
  }
  return { root: kbDir, dimensions, victories, eras, plans, civs, speeds, objectives };
}

export function validateSpecs(specs: KbSpecs): string[] {
  const errors: string[] = [];
  const dims = new Set(specs.dimensions.map((d) => d.dimensionId));
  const victories = new Set(specs.victories.map((v) => v.victoryId));
  const eras = new Set(specs.eras.map((e) => e.eraId));

  if (dims.size !== specs.dimensions.length) errors.push("dimensions.json 存在重复 dimensionId");
  if (victories.size !== specs.victories.length) errors.push("victories.json 存在重复 victoryId");
  if (eras.size !== specs.eras.length) errors.push("eras.json 存在重复 eraId");

  for (const spec of specs.plans) {
    const label = planLabel(spec);
    if (!victories.has(spec.victoryId)) errors.push(`${label}: 未知 victoryId`);
    if (!eras.has(spec.burst.eraId)) errors.push(`${label}: 未知爆发点时代 ${spec.burst.eraId}`);
    if (!(spec.burst.turn > 0) || !(spec.burst.window > 0)) {
      errors.push(`${label}: burst.turn / burst.window 必须为正数`);
    }
    if (!spec.eras.length) errors.push(`${label}: 缺少时代阶梯`);
    let prev = -Infinity;
    for (const era of spec.eras) {
      if (!eras.has(era.eraId)) errors.push(`${label}: 未知时代 ${era.eraId}`);
      if (era.turnLo < prev) errors.push(`${label}: 时代回合带不单调（${era.eraId}）`);
      if (era.turnLo > era.turnHi) errors.push(`${label}: ${era.eraId} turnLo > turnHi`);
      prev = era.turnLo;
      for (const [name, band] of Object.entries({
        cities: era.cities,
        population: era.population,
        science: era.science,
        culture: era.culture,
        production: era.production,
        goldNet: era.goldNet,
        faith: era.faith,
      })) {
        if (band && band.lo > band.hi) errors.push(`${label}: ${era.eraId} ${name} lo > hi`);
      }
    }
    for (const m of spec.burst.metrics ?? []) {
      if (!dims.has(m.dimension)) errors.push(`${label}: 未知 metric 维度 ${m.dimension}`);
    }
    for (const era of spec.eras) {
      for (const m of era.metrics ?? []) {
        if (!dims.has(m.dimension)) errors.push(`${label}: ${era.eraId} 未知 metric 维度 ${m.dimension}`);
      }
    }
  }

  for (const civ of specs.civs) {
    if (!civ.civId.startsWith("CIVILIZATION_")) errors.push(`civ ${civ.civId}: civId 应以 CIVILIZATION_ 开头`);
    for (const d of civ.deltas ?? []) {
      if (!victories.has(d.victoryId)) errors.push(`civ ${civ.civId}: 未知 victoryId ${d.victoryId}`);
    }
    for (const c of civ.capabilities ?? []) {
      if (!c.traitId?.startsWith("TRAIT_")) errors.push(`civ ${civ.civId}: capability traitId 应以 TRAIT_ 开头`);
      if (!["waive", "convert", "retarget", "amplify", "precondition"].includes(c.op)) {
        errors.push(`civ ${civ.civId}: 未知 capability op ${String(c.op)}`);
      }
      for (const id of [...(c.add ?? []), ...(c.remove ?? [])]) {
        if (!/^[A-Z][A-Z0-9_]+$/.test(id)) errors.push(`civ ${civ.civId}: capability 节点 id 非法 ${id}`);
      }
    }
  }

  // ---- speed profiles -------------------------------------------------
  const speedIds = new Set<string>();
  for (const s of specs.speeds) {
    if (speedIds.has(s.speed)) errors.push(`speeds.json: 重复 speed ${s.speed}`);
    speedIds.add(s.speed);
    if (!(s.totalTurns > 0)) errors.push(`speeds.json: ${s.speed} totalTurns 必须为正`);
    if (!(s.costMultiplier > 0)) errors.push(`speeds.json: ${s.speed} costMultiplier 必须为正`);
  }

  // ---- objectives (the reasoning layer's entry point) ------------------
  const objectiveIds = new Set<string>();
  for (const o of specs.objectives) {
    const label = `objective ${o.objectiveId}`;
    if (objectiveIds.has(o.objectiveId)) errors.push(`${label}: objectiveId 重复`);
    objectiveIds.add(o.objectiveId);
    if (!victories.has(o.victoryId)) errors.push(`${label}: 未知 victoryId ${o.victoryId}`);
    if (!eras.has(o.burstEra)) errors.push(`${label}: 未知 burstEra ${o.burstEra}`);
    if (!(o.burstTurn > 0)) errors.push(`${label}: burstTurn 必须为正`);
    if (!o.gates?.length) errors.push(`${label}: 至少需要一个 gate`);
    for (const g of o.gates ?? []) {
      if (!["unit", "node", "metric", "capability"].includes(g.kind)) errors.push(`${label}: 未知 gate kind ${g.kind}`);
      if ((g.kind === "unit" || g.kind === "node") && !g.id) errors.push(`${label}: ${g.kind} gate 缺少 id`);
      if (g.kind === "metric" && !g.metric) errors.push(`${label}: metric gate 缺少 metric`);
    }
    for (const d of o.deadEnds ?? []) {
      if (!d.kind || !d.id) errors.push(`${label}: deadEnd 缺少 kind/id`);
      if (!d.why) errors.push(`${label}: deadEnd ${d.id} 缺少 why（死路必须解释）`);
    }
    for (const d of o.detours ?? []) {
      if (!d.ids?.length) errors.push(`${label}: detour ${d.groupId} 为空`);
      if (!d.why) errors.push(`${label}: detour ${d.groupId} 缺少 why`);
    }
    for (const f of o.eraFocusOverrides ?? []) {
      if (!eras.has(f.eraId)) errors.push(`${label}: 未知 eraId ${f.eraId}`);
      if (!(f.rank >= 1 && f.rank <= 3)) errors.push(`${label}: eraFocus rank 越界 ${f.rank}`);
      if (!f.why) errors.push(`${label}: eraFocus 覆盖缺少 why`);
    }
    if (o.speed && !speedIds.has(o.speed)) errors.push(`${label}: 未知 speed ${o.speed}`);

    // ---- supply ledger / cuts / scenarios -----------------------------
    const sourceIds = new Set<string>();
    for (const s of o.supply ?? []) {
      if (!s.sourceId) errors.push(`${label}: supply 缺少 sourceId`);
      if (sourceIds.has(s.sourceId)) errors.push(`${label}: supply sourceId 重复 ${s.sourceId}`);
      sourceIds.add(s.sourceId);
      if (!dims.has(s.metric)) errors.push(`${label}: supply ${s.sourceId} 未知 metric ${s.metric}`);
      if (!s.refId) errors.push(`${label}: supply ${s.sourceId} 缺少 refId`);
      if (!(s.perUnit > 0)) errors.push(`${label}: supply ${s.sourceId} perUnit 必须为正`);
      if (s.copies !== undefined && !(s.copies >= 0)) errors.push(`${label}: supply ${s.sourceId} copies 不能为负`);
      if (s.fromTurn !== undefined && !(s.fromTurn >= 1)) errors.push(`${label}: supply ${s.sourceId} fromTurn 必须 >= 1`);
    }

    const scenarioIds = new Set<string>();
    for (const sc of o.scenarios ?? []) {
      if (!sc.id) errors.push(`${label}: scenario 缺少 id`);
      if (scenarioIds.has(sc.id)) errors.push(`${label}: scenario id 重复 ${sc.id}`);
      scenarioIds.add(sc.id);
      if (!sc.label) errors.push(`${label}: scenario ${sc.id} 缺少 label`);
      if (sc.costMultiplier !== undefined && !(sc.costMultiplier > 0)) {
        errors.push(`${label}: scenario ${sc.id} costMultiplier 必须为正`);
      }
      for (const key of Object.keys(sc.supplyOverrides ?? {})) {
        if (!sourceIds.has(key)) errors.push(`${label}: scenario ${sc.id} 覆盖了未知来源 ${key}`);
      }
    }
    if (o.scenarios?.length && !scenarioIds.has("base")) {
      errors.push(`${label}: scenarios 必须包含 base`);
    }

    for (const c of o.cutOrder ?? []) {
      if (c.kind !== "defer" && c.kind !== "drop") errors.push(`${label}: cut kind 非法 ${String(c.kind)}`);
      if (c.kind === "defer" && !c.refId) errors.push(`${label}: defer 砍单缺少 refId`);
      if (c.kind === "drop" && !c.group) errors.push(`${label}: drop 砍单缺少 group`);
      if (!c.lose) errors.push(`${label}: 砍单 ${c.refId ?? c.group} 缺少 lose（必须说明失去什么）`);
      const saves = Object.values(c.saves ?? {});
      if (!saves.length || saves.every((v) => !(v > 0))) {
        errors.push(`${label}: 砍单 ${c.refId ?? c.group} 的 saves 必须至少一项为正`);
      }
    }

    if (o.inspiration) {
      if (!["none", "authored"].includes(o.inspiration.mode)) {
        errors.push(`${label}: inspiration.mode 非法`);
      }
      for (const [id, pct] of Object.entries(o.inspiration.credits ?? {})) {
        if (!(pct >= 0 && pct <= 100)) errors.push(`${label}: inspiration ${id} 百分比越界`);
      }
    }
    if (o.feasibility && !["strict", "report"].includes(o.feasibility)) {
      errors.push(`${label}: feasibility 非法 ${o.feasibility}`);
    }
  }
  return errors;
}

export function planLabel(spec: PlanSpec): string {
  return spec.nameZh ? `${spec.victoryId}(${spec.nameZh})` : spec.victoryId;
}

export function eraById(specs: KbSpecs, eraId: string): EraWindowSpec | undefined {
  return specs.eras.find((e) => e.eraId === eraId);
}
