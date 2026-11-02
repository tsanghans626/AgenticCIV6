import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SourceFlag, VictoryId } from "../kb/spec.js";

/**
 * Pacing baseline specs (`kb/pacing/*.json`).
 *
 * This layer is deliberately separate from `KbSpecs`: the pacing generator is a
 * query-time model, not a table builder. The only authored facts are the
 * baseline assumptions (floors + source policy) and one goal spec per victory.
 * Everything else (costs, prerequisites, yields, civ kits, speeds, eras) is read
 * from the decision layer at run time.
 */

export type Assurance = "standard" | "strict";

export type PacingDimension =
  | "science_per_turn"
  | "culture_per_turn"
  | "gold_per_turn"
  | "production_per_turn"
  | "food_per_turn"
  | "faith_per_turn"
  | "tourism_per_turn"
  | "great_person_points"
  | "diplomatic_victory_points"
  | "housing"
  | "amenities";

export const PACING_DIMENSIONS: PacingDimension[] = [
  "science_per_turn",
  "culture_per_turn",
  "gold_per_turn",
  "production_per_turn",
  "food_per_turn",
  "faith_per_turn",
  "tourism_per_turn",
  "great_person_points",
  "diplomatic_victory_points",
  "housing",
  "amenities",
];

export interface TileFloor {
  foodPerPop: number;
  productionPerPop: number;
  housingPerCity: number;
}

export interface PacingAssumptions {
  difficulty: string;
  mapProfile: string;
  opponents: number;
  startingEra: string;
  population: { sciencePerPop: number; culturePerPop: number; goldPerPop: number };
  tileFloor: Record<Assurance, TileFloor>;
  districtFloor: Record<Assurance, Record<string, Partial<Record<PacingDimension, number>>>>;
  cityCenter: { food: number; production: number; gold: number };
  foodConsumptionPerPop: number;
  growth: { threshold: number; multiplier: number; exponent: number };
  housingBase: number;
  districtSlotPerPop: number;
  settlerPopFloor: number;
  highPopThreshold: number;
  campusHighAdjacencyFloor: number;
}

export interface SourcePolicy {
  allowModifierTypes: string[];
  excludedOwnerKinds: string[];
  /** requirement-set id -> condition key understood by the model */
  knownConditions: Record<string, string>;
}

export interface PacingBaselineSpec {
  version: number;
  labelZh: string;
  assumptions: PacingAssumptions;
  sources: SourcePolicy;
  tick: { maxPasses: number; epsilon: number };
  output: { sampleStep: number; maxMilestones: number; maxActions: number };
}

export interface SpaceRaceTerminal {
  kind: "space-race";
  spaceport: string;
  /** number of spaceports built to parallelise the project chain (default 1) */
  spaceports?: number;
  projects: string[];
  flight: { baseTurns: number; perLaser: number; laserProjects: string[]; maxLasers?: number; scaleWithSpeed?: boolean };
}

export interface YieldTargetTerminal {
  kind: "yield-target";
  metric: PacingDimension;
  mode: "cumulative" | "per-turn";
  target: { value: number; sourceFlag: SourceFlag; note?: string };
}

export interface UnitsTerminal {
  kind: "units";
  units: Array<{ id: string; qty: number }>;
}

export interface CongressTerminal {
  kind: "congress";
  pointsRequired: number;
  pointsPerCongress: number;
  firstCongressTurn: number;
  everyTurns: number;
}

export type TerminalSpec =
  | SpaceRaceTerminal
  | YieldTargetTerminal
  | UnitsTerminal
  | CongressTerminal;

export interface VictoryPacingSpec {
  victoryId: VictoryId;
  nameZh: string;
  version: number;
  guarantee: "full" | "self-side";
  terminal: TerminalSpec;
  bottlenecks: PacingDimension[];
  boosters: { districts: string[]; buildings: string[] };
  policies: string[];
  government: string | null;
  cityTarget: Array<{ turn: number; cities: number }>;
  reference: { turn: number; sourceFlag: SourceFlag; confidence: number; note?: string };
}

export interface PacingSpecs {
  root: string;
  baseline: PacingBaselineSpec;
  victories: Map<VictoryId, VictoryPacingSpec>;
}

const VICTORY_IDS: VictoryId[] = ["science", "culture", "religion", "domination", "diplomatic"];

export function victorySpecFile(root: string, victoryId: VictoryId): string {
  return join(root, "kb", "pacing", `${victoryId}.json`);
}

export function baselineSpecFile(root: string): string {
  return join(root, "kb", "pacing", "baseline.json");
}

export function loadPacingSpecs(root: string): PacingSpecs {
  const baseFile = baselineSpecFile(root);
  if (!existsSync(baseFile)) throw new Error(`缺少基准口径：${baseFile}`);
  const baseline = JSON.parse(readFileSync(baseFile, "utf8")) as PacingBaselineSpec;

  const victories = new Map<VictoryId, VictoryPacingSpec>();
  const dir = join(root, "kb", "pacing");
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json") || name === "baseline.json") continue;
      const spec = JSON.parse(readFileSync(join(dir, name), "utf8")) as VictoryPacingSpec;
      if (spec.victoryId) victories.set(spec.victoryId, spec);
    }
  }
  return { root, baseline, victories };
}

const DIMENSION_SET = new Set<string>(PACING_DIMENSIONS);

export function validatePacingSpecs(specs: PacingSpecs): string[] {
  const errors: string[] = [];
  const b = specs.baseline;
  if (!b.assumptions) errors.push("baseline.json 缺少 assumptions");
  if (!b.sources) errors.push("baseline.json 缺少 sources");
  if (!(b.tick?.maxPasses >= 1)) errors.push("baseline.json tick.maxPasses 必须 >= 1");
  for (const key of ["standard", "strict"] as const) {
    const floor = b.assumptions?.tileFloor?.[key];
    if (!floor) errors.push(`baseline.json 缺少 tileFloor.${key}`);
  }
  for (const [id, spec] of specs.victories) {
    if (!VICTORY_IDS.includes(id)) errors.push(`未知 victoryId：${id}`);
    if (!spec.nameZh) errors.push(`${id}: 缺少 nameZh`);
    if (!spec.bottlenecks?.length) errors.push(`${id}: 缺少 bottlenecks`);
    for (const dim of spec.bottlenecks ?? []) {
      if (!DIMENSION_SET.has(dim)) errors.push(`${id}: 未知 bottleneck ${dim}`);
    }
    if (!spec.cityTarget?.length) errors.push(`${id}: 缺少 cityTarget`);
    let prev = -Infinity;
    for (const row of spec.cityTarget ?? []) {
      if (!(row.turn > 0) || !(row.cities >= 0)) errors.push(`${id}: cityTarget 非法行`);
      if (row.turn < prev) errors.push(`${id}: cityTarget 回合不单调`);
      prev = row.turn;
    }
    if (!(spec.reference?.turn > 0)) errors.push(`${id}: reference.turn 必须为正`);
    const terminal = spec.terminal;
    if (!terminal) {
      errors.push(`${id}: 缺少 terminal`);
      continue;
    }
    if (terminal.kind === "space-race") {
      if (!terminal.spaceport) errors.push(`${id}: spaceport 缺失`);
      if (!terminal.projects?.length) errors.push(`${id}: projects 为空`);
      if (!(terminal.flight?.baseTurns >= 0)) errors.push(`${id}: flight.baseTurns 非法`);
    } else if (terminal.kind === "yield-target") {
      if (!DIMENSION_SET.has(terminal.metric)) errors.push(`${id}: 未知 terminal.metric`);
      if (!(terminal.target?.value > 0)) errors.push(`${id}: target.value 必须为正`);
    } else if (terminal.kind === "units") {
      if (!terminal.units?.length) errors.push(`${id}: units 为空`);
      for (const u of terminal.units ?? []) if (!(u.qty > 0)) errors.push(`${id}: ${u.id} qty 非法`);
    } else if (terminal.kind === "congress") {
      if (!(terminal.pointsRequired > 0)) errors.push(`${id}: pointsRequired 非法`);
      if (!(terminal.pointsPerCongress > 0)) errors.push(`${id}: pointsPerCongress 非法`);
      if (!(terminal.everyTurns > 0)) errors.push(`${id}: everyTurns 非法`);
    } else {
      errors.push(`${id}: 未知 terminal.kind ${(terminal as { kind?: string }).kind}`);
    }
  }
  for (const id of VICTORY_IDS) {
    if (!specs.victories.has(id)) errors.push(`缺少胜利规格：kb/pacing/${id}.json`);
  }
  return errors;
}

/** Interpolate the authored city-count ramp. */
export function citiesAt(spec: VictoryPacingSpec, turn: number): number {
  const rows = spec.cityTarget;
  if (!rows.length) return 1;
  if (turn <= rows[0].turn) return rows[0].cities;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const next = rows[i];
    if (turn <= next.turn) {
      const t = (turn - prev.turn) / Math.max(1, next.turn - prev.turn);
      return prev.cities + (next.cities - prev.cities) * t;
    }
  }
  return rows[rows.length - 1].cities;
}
