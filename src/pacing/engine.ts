import type { KnowledgeDb } from "../db.js";
import type { DataSource } from "../config.js";
import { loadPaceGraph, nodeKey, resolveId, splitKey, worldEraAt, type Currency, type PaceGraph, type PaceNode } from "./graph.js";
import { computeRates, type CityRates, type CityView, type EmpireRates } from "./model.js";
import { citiesAt, loadPacingSpecs, validatePacingSpecs, type PacingDimension, type PacingSpecs, type VictoryPacingSpec } from "./spec.js";
import type { VictoryId } from "../kb/spec.js";

/**
 * Baseline pacing engine.
 *
 * Two passes, one certificate:
 *
 *   1. forward: a deterministic turn-by-turn construction. Nothing is added to
 *      the state unless it was paid for by a source that is already owned, so
 *      the emitted schedule is a witness of reachability by construction.
 *   2. backward: latest-start propagation from the realised terminal turn, so
 *      every node carries "must be done by T" plus slack (CPM late dates).
 *
 * The two are iterated a bounded number of times (forward -> backward -> forward)
 * because the urgency labels improve the ordering; the best feasible pass wins.
 * No optimality is claimed.
 */

export type MilestoneKind = "tech" | "civic" | "building" | "district" | "project" | "unit";

export interface Milestone {
  turn: number;
  kind: MilestoneKind;
  id: string;
  labelZh: string;
  cost: number;
  currency: Currency | null;
  role: "terminal" | "enabler" | "booster";
  latestTurn: number | null;
  slack: number | null;
  why: string;
  deps: string[];
  city: number | null;
}

export interface ActionInterval {
  from: number;
  to: number;
  kind: "research" | "civic" | "build" | "district" | "project" | "unit" | "settle";
  id: string;
  label: string;
  count: number;
}

export interface RatePoint {
  turn: number;
  rates: { science: number; culture: number; gold: number; production: number; food: number; faith: number; tourism: number };
  cum: { science: number; culture: number; gold: number; production: number; food: number; faith: number; tourism: number };
  cities: number;
  population: number;
}

export interface Blocker {
  kind: "terminal" | "economy" | "data" | "target";
  message: string;
  detail?: string;
}

export interface PacingChecks {
  closedLoop: boolean;
  prereqOrder: boolean;
  sourceSound: boolean;
  terminal: boolean;
  deterministic: true;
  monotone: boolean;
  slackConsistent: boolean;
  details: string[];
}

export interface PacingResult {
  schema: "civi6.pacing/v1";
  input: {
    source: DataSource;
    civId: string;
    leaderId: string | null;
    victoryId: VictoryId;
    speed: string;
    assurance: "standard" | "strict";
    targetTurn: number | null;
  };
  basis: {
    speed: string;
    labelZh: string;
    totalTurns: number;
    costMultiplier: number;
    turnScale: number;
    source: string;
  };
  civ: {
    civId: string;
    leaderId: string | null;
    labelZh: string;
    nameEn: string | null;
    traits: string[];
    uniqueDistricts: string[];
    uniqueBuildings: string[];
    uniqueUnits: string[];
    replacements: Array<{ baseId: string; uniqueId: string }>;
  };
  baseline: {
    feasible: boolean;
    guarantee: "full" | "self-side";
    turn: number | null;
    selfTurn: number | null;
    burstTurn: number | null;
    referenceTurn: number;
    window: number;
    blockers: Blocker[];
  };
  milestones: Milestone[];
  actions: ActionInterval[];
  state: Record<string, { unit: string; segments: Array<{ from: number; to: number; rate: number; cumFrom: number; cumTo: number }>; expression: string; final: number }>;
  series: RatePoint[];
  checks: PacingChecks;
  assumptions: Record<string, unknown>;
  provenance: {
    ruleset: DataSource;
    kbBuiltAt: string | null;
    rawBuiltAt: string | null;
    specVersion: number;
    generatedAt: string;
    excludedEffects: number;
    excludedByReason: Record<string, number>;
  };
}

export interface PacingOptions {
  source: DataSource;
  civId: string;
  leaderId?: string | null;
  victoryId: VictoryId;
  speed: string;
  assurance?: "standard" | "strict";
  targetTurn?: number | null;
  root?: string;
}

interface BuildItem {
  kind: MilestoneKind;
  id: string;
  labelZh: string;
  costs: Partial<Record<Currency, number>>;
}

interface SimCity {
  id: number;
  founded: number;
  pop: number;
  foodProgress: number;
  buildings: Set<string>;
  districts: Set<string>;
  item: BuildItem | null;
  progress: number;
  startTurn: number;
}

interface TechState {
  id: string;
  progress: number;
  startTurn: number;
}

interface SimEvent {
  turn: number;
  startTurn: number;
  kind: MilestoneKind | "settle";
  id: string;
  labelZh: string;
  cost: number;
  currency: Currency | null;
  role: Milestone["role"];
  city: number | null;
}

function parentIds(graph: PaceGraph, key: string, kind?: string): string[] {
  const list = graph.parents.get(key) ?? [];
  return list
    .map((p) => splitKey(p))
    .filter((p) => !kind || p.kind === kind)
    .map((p) => p.id);
}

function closureOf(graph: PaceGraph, seeds: string[], limit = 400): Set<string> {
  const out = new Set<string>();
  const queue = [...seeds];
  while (queue.length && out.size < limit) {
    const key = queue.shift()!;
    if (out.has(key)) continue;
    out.add(key);
    for (const parent of graph.parents.get(key) ?? []) {
      if (!out.has(parent)) queue.push(parent);
    }
  }
  return out;
}

function nodeOfKey(graph: PaceGraph, key: string): PaceNode | null {
  return graph.nodes.get(key) ?? null;
}

function kindRank(kind: MilestoneKind): number {
  return { project: 0, district: 1, building: 2, unit: 3, tech: 4, civic: 5 }[kind];
}

export class PacingSimulation {
  readonly graph: PaceGraph;
  readonly spec: VictoryPacingSpec;
  readonly baseline: PacingSpecs["baseline"];
  readonly maxTurns: number;
  readonly targetTurn: number | null;
  readonly referenceTurn: number;
  readonly required: Set<string>;
  readonly boosterNodes: Set<string>;
  readonly boosterTechs: Set<string>;

  turn = 1;
  cities: SimCity[] = [];
  techs = new Set<string>();
  civics = new Set<string>();
  policies = new Set<string>();
  government: string | null = null;
  units = new Map<string, number>();
  gold = 0;
  faith = 0;
  cumulative: Record<string, number> = {};
  techState: TechState | null = null;
  civicState: TechState | null = null;
  events: SimEvent[] = [];
  series: RatePoint[] = [];
  deadTechs = new Set<string>();
  deadItems = new Set<string>();
  lastRates: EmpireRates | null = null;
  lastPerCity: CityRates[] = [];
  terminalBurstTurn: number | null = null;
  terminalSelfTurn: number | null = null;
  winTurn: number | null = null;
  blockers: Blocker[] = [];
  deadlines = new Map<string, number>();
  maxPolicySlots = 4;
  settledTarget = 0;

  constructor(graph: PaceGraph, spec: VictoryPacingSpec, baseline: PacingSpecs["baseline"], targetTurn: number | null) {
    this.graph = graph;
    this.spec = spec;
    this.baseline = baseline;
    this.maxTurns = Math.max(1, Math.round(graph.speed.totalTurns));
    this.targetTurn = targetTurn;
    this.referenceTurn = Math.max(1, Math.round(spec.reference.turn * graph.speed.turnScale));
    this.required = this.computeRequired();
    this.boosterNodes = this.computeBoosters();
    this.boosterTechs = this.computeBoosterTechs();
    for (const dim of [
      "science_per_turn",
      "culture_per_turn",
      "gold_per_turn",
      "production_per_turn",
      "food_per_turn",
      "faith_per_turn",
      "tourism_per_turn",
    ]) {
      this.cumulative[dim] = 0;
    }
  }

  private computeRequired(): Set<string> {
    const seeds: string[] = [];
    const terminal = this.spec.terminal;
    if (terminal.kind === "space-race") {
      seeds.push(nodeKey("district", resolveId(this.graph, terminal.spaceport)));
      for (const id of terminal.projects) seeds.push(nodeKey("project", resolveId(this.graph, id)));
    } else if (terminal.kind === "units") {
      for (const u of terminal.units) seeds.push(nodeKey("unit", resolveId(this.graph, u.id)));
    }
    return closureOf(this.graph, seeds);
  }

  private computeBoosters(): Set<string> {
    const out = new Set<string>();
    for (const id of this.spec.boosters.districts) out.add(nodeKey("district", resolveId(this.graph, id)));
    for (const id of this.spec.boosters.buildings) out.add(nodeKey("building", resolveId(this.graph, id)));
    return out;
  }

  private computeBoosterTechs(): Set<string> {
    const out = new Set<string>();
    for (const key of this.boosterNodes) {
      for (const parent of this.graph.parents.get(key) ?? []) {
        const { kind, id } = splitKey(parent);
        if (kind === "tech") out.add(id);
      }
    }
    return out;
  }

  // -- state helpers --------------------------------------------------------

  private cityView(city: SimCity): CityView {
    return { id: city.id, pop: city.pop, buildings: city.buildings, districts: city.districts };
  }

  private rateInput() {
    const a = this.baseline.assumptions;
    const floors = a.districtFloor[this.graph.assurance];
    return {
      graph: this.graph,
      assurance: this.graph.assurance,
      worldEra: worldEraAt(this.graph, this.turn),
      cities: this.cities.map((c) => this.cityView(c)),
      techs: this.techs,
      civics: this.civics,
      policies: this.policies,
      government: this.government,
      units: this.units,
      districtFloor: floors,
      population: a.population,
      cityCenter: a.cityCenter,
      tileFloor: a.tileFloor[this.graph.assurance],
      housingBase: a.housingBase,
      foodConsumptionPerPop: a.foodConsumptionPerPop,
      highPopThreshold: a.highPopThreshold,
      campusHighAdjacencyFloor: a.campusHighAdjacencyFloor,
    };
  }

  computeRatesNow() {
    const computed = computeRates(this.rateInput());
    this.lastRates = computed.empire;
    this.lastPerCity = computed.perCity;
    return computed;
  }

  // -- availability --------------------------------------------------------

  private parentsDone(key: string): boolean {
    const childId = splitKey(key).id;
    for (const parentKey of this.graph.parents.get(key) ?? []) {
      const { kind, id } = splitKey(parentKey);
      if (resolveId(this.graph, id) === resolveId(this.graph, childId)) continue;
      if (kind === "tech" && !this.techs.has(id)) return false;
      if (kind === "civic" && !this.civics.has(id)) return false;
      if (kind === "district" && !this.cities.some((c) => c.districts.has(resolveId(this.graph, id)))) return false;
      if (kind === "building" && !this.cities.some((c) => c.buildings.has(resolveId(this.graph, id)))) return false;
    }
    return true;
  }

  private techAvailable(id: string): boolean {
    if (this.techs.has(id)) return false;
    return parentIds(this.graph, nodeKey("tech", id), "tech").every((p) => this.techs.has(p));
  }

  private civicAvailable(id: string): boolean {
    if (this.civics.has(id)) return false;
    return parentIds(this.graph, nodeKey("civic", id), "civic").every((p) => this.civics.has(p));
  }

  private districtSlotCap(pop: number): number {
    return 1 + Math.floor((Math.max(1, pop) - 1) / Math.max(1, this.baseline.assumptions.districtSlotPerPop));
  }

  /** Prerequisites that must be satisfied in the *same* city (tech/civic are global). */
  private parentsDoneInCity(city: SimCity, key: string): boolean {
    const childId = splitKey(key).id;
    for (const parentKey of this.graph.parents.get(key) ?? []) {
      const { kind, id } = splitKey(parentKey);
      const resolved = resolveId(this.graph, id);
      // A unique replacement can list its own base as a prerequisite in the raw
      // tables (Seowon <- Campus). That edge is a replaces-artifact, not a gate.
      if (resolved === resolveId(this.graph, childId)) continue;
      if (kind === "tech" && !this.techs.has(id)) return false;
      if (kind === "civic" && !this.civics.has(id)) return false;
      if (kind === "district" && !city.districts.has(resolved)) return false;
      if (kind === "building" && !city.buildings.has(resolved)) return false;
    }
    return true;
  }

  private buildingAllowed(city: SimCity, id: string): boolean {
    if (city.buildings.has(id)) return false;
    const meta = this.graph.buildingMeta.get(id);
    if (!meta) return false;
    if (meta.maxInstances === 1) return false; // wonders/one-offs are not baseline boosters
    if (meta.district) {
      const wanted = resolveId(this.graph, meta.district);
      if (!city.districts.has(wanted)) return false;
    }
    return this.parentsDoneInCity(city, nodeKey("building", id));
  }

  private districtAllowed(city: SimCity, id: string): boolean {
    if (city.districts.has(id)) return false;
    if (city.districts.size >= this.districtSlotCap(city.pop)) return false;
    return this.parentsDoneInCity(city, nodeKey("district", id));
  }

  // -- choices -------------------------------------------------------------

  private chooseTech(): void {
    if (!this.cities.length) return;
    const candidates: Array<{ id: string; key: string; cost: number; priority: number; deadline: number }> = [];
    for (const node of this.graph.nodes.values()) {
      if (node.kind !== "tech") continue;
      if (!this.techAvailable(node.id)) continue;
      const key = nodeKey("tech", node.id);
      const cost = node.costs.science ? node.costs.science * this.graph.speed.costMultiplier : 0;
      if (!cost) continue;
      const required = this.required.has(key);
      const booster = this.boosterTechs.has(node.id);
      const deadline = this.deadlines.get(key) ?? Number.POSITIVE_INFINITY;
      candidates.push({ id: node.id, key, cost, priority: required ? 0 : booster ? 1 : 2, deadline });
    }
    if (!candidates.length) return;
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.deadline !== b.deadline) return a.deadline - b.deadline;
      if (a.cost !== b.cost) return a.cost - b.cost;
      return a.id.localeCompare(b.id);
    });
    const pick = candidates[0];
    this.techState = { id: pick.id, progress: 0, startTurn: this.turn };
  }

  private chooseCivic(): void {
    if (!this.cities.length) return;
    const candidates: Array<{ id: string; key: string; cost: number; priority: number; deadline: number }> = [];
    for (const node of this.graph.nodes.values()) {
      if (node.kind !== "civic") continue;
      if (!this.civicAvailable(node.id)) continue;
      const key = nodeKey("civic", node.id);
      const cost = node.costs.culture ? node.costs.culture * this.graph.speed.costMultiplier : 0;
      if (!cost) continue;
      const deadline = this.deadlines.get(key) ?? Number.POSITIVE_INFINITY;
      candidates.push({ id: node.id, key, cost, priority: 0, deadline });
    }
    if (!candidates.length) return;
    candidates.sort((a, b) => {
      if (a.deadline !== b.deadline) return a.deadline - b.deadline;
      if (a.cost !== b.cost) return a.cost - b.cost;
      return a.id.localeCompare(b.id);
    });
    this.civicState = { id: candidates[0].id, progress: 0, startTurn: this.turn };
  }

  private adoptUnlocks(): void {
    // policies listed by the spec: adopt when unlocked and slots remain
    for (const id of this.spec.policies) {
      if (this.policies.has(id)) continue;
      if (this.policies.size >= this.maxPolicySlots) break;
      if (this.parentsDone(nodeKey("policy", id))) this.policies.add(id);
    }
    if (this.spec.government && !this.government) {
      const key = nodeKey("government", this.spec.government);
      if (this.parentsDone(key)) this.government = this.spec.government;
    }
  }

  private boosterGain(node: PaceNode, city: SimCity): number {
    const a = this.baseline.assumptions;
    const floors = a.districtFloor[this.graph.assurance];
    let gain = 0;
    const weights: Record<string, number> = {};
    for (const dim of this.spec.bottlenecks) weights[dim] = (weights[dim] ?? 0) + 1;
    if (node.kind === "district") {
      const floor = floors[node.id] ?? floors[this.graph.civ.uniqueToBase.get(node.id) ?? ""] ?? {};
      for (const [dim, value] of Object.entries(floor)) gain += (Number(value) || 0) * (weights[dim] ?? 0.5);
    }
    const effects = this.graph.effectsByOwner.get(`${node.kind}:${node.id}`) ?? [];
    for (const e of effects) {
      if (e.op === "percent") {
        gain += (weights[e.dimension] ?? 0.5) * 1.5;
        continue;
      }
      const copies = e.per === "pop" ? city.pop : 1;
      gain += e.value * copies * (weights[e.dimension] ?? 0.5);
    }
    return gain;
  }

  private chooseProduction(city: SimCity): BuildItem | null {
    // 1. terminal chain (spaceport then projects, in one designated city)
    const terminal = this.spec.terminal;
    if (terminal.kind === "space-race") {
      const spaceport = resolveId(this.graph, terminal.spaceport);
      const maxSpaceports = Math.max(1, terminal.spaceports ?? 1);
      const holders = this.cities.filter((c) => c.districts.has(spaceport));
      const spaceportKey = nodeKey("district", spaceport);
      const spaceportNode = this.graph.nodes.get(spaceportKey);
      if (
        holders.length < maxSpaceports &&
        spaceportNode?.costs.production &&
        this.parentsDone(spaceportKey)
      ) {
        const top = this.topProductionCities(maxSpaceports);
        if (top.some((c) => c.id === city.id)) return this.itemFromNode(spaceportNode);
      }
      if (city.districts.has(spaceport)) {
        const done = new Set(this.events.filter((e) => e.kind === "project").map((e) => e.id));
        const active = new Set(
          this.cities.map((c) => (c.item?.kind === "project" ? c.item.id : null)).filter(Boolean) as string[],
        );
        for (const id of terminal.projects) {
          if (done.has(id) || active.has(id)) continue;
          const key = nodeKey("project", id);
          if (!this.parentsDone(key)) continue;
          const node = this.graph.nodes.get(key);
          if (node?.costs.production) return this.itemFromNode(node);
        }
      }
    }
    if (terminal.kind === "units") {
      for (const req of terminal.units) {
        const built = this.units.get(req.id) ?? 0;
        if (built >= req.qty) continue;
        const key = nodeKey("unit", resolveId(this.graph, req.id));
        if (!this.parentsDone(key)) break;
        const node = this.graph.nodes.get(key);
        if (node?.costs.production) return this.itemFromNode(node);
      }
    }

    // 2. expansion
    const target = citiesAt(this.spec, this.turn);
    const settlersInFlight = this.cities.filter((c) => c.item?.kind === "unit" && c.item.id === "UNIT_SETTLER").length;
    if (
      this.cities.length + settlersInFlight < target &&
      city.pop >= this.baseline.assumptions.settlerPopFloor &&
      city.item === null
    ) {
      const settler = this.graph.nodes.get(nodeKey("unit", "UNIT_SETTLER"));
      if (settler?.costs.production) return this.itemFromNode(settler);
    }

    // 3. boosters
    const candidates: Array<{ item: BuildItem; score: number }> = [];
    for (const key of this.boosterNodes) {
      const node = this.graph.nodes.get(key);
      if (!node) continue;
      if (node.kind === "district") {
        if (!this.districtAllowed(city, node.id)) continue;
      } else if (node.kind === "building") {
        if (!this.buildingAllowed(city, node.id)) continue;
      } else {
        continue;
      }
      const cost = node.costs.production;
      if (!cost) continue;
      const gain = this.boosterGain(node, city);
      if (gain <= 0) continue;
      candidates.push({ item: this.itemFromNode(node), score: gain / cost });
    }
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.item.id.localeCompare(b.item.id);
    });
    return candidates.length ? candidates[0].item : null;
  }

  private itemFromNode(node: PaceNode): BuildItem {
    const costs: Partial<Record<Currency, number>> = {};
    for (const [cur, value] of Object.entries(node.costs) as Array<[Currency, number]>) {
      costs[cur] = value * this.graph.speed.costMultiplier;
    }
    return { kind: node.kind as MilestoneKind, id: node.id, labelZh: node.labelZh, costs };
  }

  private topProductionCities(n: number): SimCity[] {
    const scored = this.cities.map((c, i) => ({ c, prod: this.lastPerCity[i]?.production ?? 0 }));
    scored.sort((a, b) => b.prod - a.prod || a.c.id - b.c.id);
    return scored.slice(0, Math.max(1, n)).map((s) => s.c);
  }

  // -- turn loop -----------------------------------------------------------

  private foundCapital(): void {
    const city: SimCity = {
      id: 1,
      founded: this.turn,
      pop: 1,
      foodProgress: 0,
      buildings: new Set([resolveId(this.graph, "BUILDING_PALACE")]),
      districts: new Set(),
      item: null,
      progress: 0,
      startTurn: this.turn,
    };
    this.cities.push(city);
    const settler = this.units.get("UNIT_SETTLER") ?? 0;
    if (settler > 0) this.units.set("UNIT_SETTLER", settler - 1);
    this.events.push({
      turn: this.turn,
      startTurn: this.turn,
      kind: "settle",
      id: "CITY_CAPITAL",
      labelZh: "建立首都",
      cost: 0,
      currency: null,
      role: "enabler",
      city: 1,
    });
  }

  private completeTech(cost: number): void {
    const state = this.techState!;
    this.techs.add(state.id);
    this.events.push({
      turn: this.turn,
      startTurn: state.startTurn,
      kind: "tech",
      id: state.id,
      labelZh: this.graph.nodes.get(nodeKey("tech", state.id))?.labelZh ?? state.id,
      cost,
      currency: "science",
      role: this.required.has(nodeKey("tech", state.id)) ? "terminal" : "enabler",
      city: null,
    });
    this.techState = null;
    this.adoptUnlocks();
  }

  private completeCivic(cost: number): void {
    const state = this.civicState!;
    this.civics.add(state.id);
    this.events.push({
      turn: this.turn,
      startTurn: state.startTurn,
      kind: "civic",
      id: state.id,
      labelZh: this.graph.nodes.get(nodeKey("civic", state.id))?.labelZh ?? state.id,
      cost,
      currency: "culture",
      role: "enabler",
      city: null,
    });
    this.civicState = null;
    this.adoptUnlocks();
  }

  private completeCityItem(city: SimCity): void {
    const item = city.item!;
    const cost = item.costs.production ?? 0;
    const role: Milestone["role"] =
      item.kind === "project" ? "terminal" :
      this.required.has(nodeKey(item.kind, item.id)) ? "terminal" : "booster";
    this.events.push({
      turn: this.turn,
      startTurn: city.startTurn,
      kind: item.kind,
      id: item.id,
      labelZh: item.labelZh,
      cost,
      currency: "production",
      role,
      city: city.id,
    });
    if (item.kind === "district") city.districts.add(item.id);
    else if (item.kind === "building") city.buildings.add(item.id);
    else if (item.kind === "unit") {
      this.units.set(item.id, (this.units.get(item.id) ?? 0) + 1);
      if (item.id === "UNIT_SETTLER") {
        city.pop = Math.max(1, city.pop - 1);
        const newCity: SimCity = {
          id: this.cities.length + 1,
          founded: this.turn,
          pop: 1,
          foodProgress: 0,
          buildings: new Set(),
          districts: new Set(),
          item: null,
          progress: 0,
          startTurn: this.turn,
        };
        this.cities.push(newCity);
      }
    }
    city.item = null;
    city.progress = 0;
    city.startTurn = this.turn;
  }

  private growCities(): void {
    const growth = this.baseline.assumptions.growth;
    for (let i = 0; i < this.cities.length; i++) {
      const city = this.cities[i];
      const rates = this.lastPerCity[i];
      if (!rates) continue;
      if (rates.food <= 0) continue;
      const housingLeft = rates.housing - city.pop;
      const mult = housingLeft >= 2 ? 1 : housingLeft === 1 ? 0.5 : housingLeft === 0 ? 0.25 : 0;
      if (mult <= 0) continue;
      city.foodProgress += rates.food * mult;
      const threshold = growth.threshold + growth.multiplier * Math.pow(Math.max(0, city.pop - 1), growth.exponent);
      if (city.foodProgress >= threshold) {
        city.pop += 1;
        city.foodProgress -= threshold;
      }
    }
  }

  private terminalProgress(): boolean {
    const terminal = this.spec.terminal;
    if (terminal.kind === "space-race") {
      const done = terminal.projects.filter((id) => this.events.some((e) => e.kind === "project" && e.id === id));
      if (done.length === terminal.projects.length) {
        this.terminalBurstTurn = this.turn;
        const flightBase = terminal.flight.scaleWithSpeed === false
          ? terminal.flight.baseTurns
          : Math.round(terminal.flight.baseTurns * this.graph.speed.turnScale);
        const flight = Math.max(
          0,
          flightBase - terminal.flight.perLaser * (terminal.flight.maxLasers ?? 0),
        );
        this.terminalSelfTurn = this.turn;
        this.winTurn = this.turn + flight;
        return true;
      }
      return false;
    }
    if (terminal.kind === "units") {
      const ready = terminal.units.every((u) => (this.units.get(resolveId(this.graph, u.id)) ?? 0) >= u.qty);
      if (ready) {
        this.terminalSelfTurn = this.turn;
        this.terminalBurstTurn = this.turn;
        this.winTurn = Math.max(this.turn, this.referenceTurn);
        return true;
      }
      return false;
    }
    if (terminal.kind === "yield-target") {
      const value = this.cumulative[terminal.metric] ?? 0;
      if (value >= terminal.target.value) {
        this.terminalSelfTurn = this.turn;
        this.terminalBurstTurn = this.turn;
        this.winTurn = Math.max(this.turn, this.referenceTurn);
        return true;
      }
      return false;
    }
    if (terminal.kind === "congress") {
      const first = terminal.firstCongressTurn;
      const count = this.turn >= first ? Math.floor((this.turn - first) / terminal.everyTurns) + 1 : 0;
      const points = count * terminal.pointsPerCongress;
      if (points >= terminal.pointsRequired) {
        this.terminalSelfTurn = this.turn;
        this.terminalBurstTurn = this.turn;
        this.winTurn = Math.max(this.turn, this.referenceTurn);
        return true;
      }
      return false;
    }
    return false;
  }

  run(): void {
    for (const u of this.graph.startingUnits) {
      const resolved = resolveId(this.graph, u.id);
      this.units.set(resolved, (this.units.get(resolved) ?? 0) + u.qty);
    }
    while (this.turn <= this.maxTurns) {
      if (this.turn === 1) this.foundCapital();
      const computed = this.computeRatesNow();
      const rates = computed.empire;

      for (const key of ["science", "culture", "gold", "production", "food", "faith", "tourism"] as const) {
        this.cumulative[`${key}_per_turn`] = (this.cumulative[`${key}_per_turn`] ?? 0) + rates[key];
      }

      const cum = {
        science: this.cumulative.science_per_turn,
        culture: this.cumulative.culture_per_turn,
        gold: this.cumulative.gold_per_turn,
        production: this.cumulative.production_per_turn,
        food: this.cumulative.food_per_turn,
        faith: this.cumulative.faith_per_turn,
        tourism: this.cumulative.tourism_per_turn,
      };
      this.series.push({
        turn: this.turn,
        rates: {
          science: rates.science,
          culture: rates.culture,
          gold: rates.gold,
          production: rates.production,
          food: rates.food,
          faith: rates.faith,
          tourism: rates.tourism,
        },
        cum,
        cities: this.cities.length,
        population: this.cities.reduce((n, c) => n + c.pop, 0),
      });

      if (!this.techState) this.chooseTech();
      if (this.techState) {
        const node = this.graph.nodes.get(nodeKey("tech", this.techState.id));
        const worldEra = worldEraAt(this.graph, this.turn);
        const cost = node ? this.techCost(node, worldEra) : 0;
        this.techState.progress += rates.science;
        if (cost > 0 && this.techState.progress >= cost) {
          const overflow = this.techState.progress - cost;
          this.completeTech(cost);
          this.chooseTech();
          const next: TechState | null = this.techState;
          if (next) next.progress += overflow;
        }
      }

      if (!this.civicState) this.chooseCivic();
      if (this.civicState) {
        const node = this.graph.nodes.get(nodeKey("civic", this.civicState.id));
        const worldEra = worldEraAt(this.graph, this.turn);
        const cost = node ? this.civicCost(node, worldEra) : 0;
        this.civicState.progress += rates.culture;
        if (cost > 0 && this.civicState.progress >= cost) {
          const overflow = this.civicState.progress - cost;
          this.completeCivic(cost);
          this.chooseCivic();
          const next: TechState | null = this.civicState;
          if (next) next.progress += overflow;
        }
      }

      for (let i = 0; i < this.cities.length; i++) {
        const city = this.cities[i];
        if (!city.item) {
          const next = this.chooseProduction(city);
          if (next) {
            city.item = next;
            city.progress = 0;
            city.startTurn = this.turn;
          }
        }
        if (!city.item) continue;
        const cost = city.item.costs.production ?? 0;
        const prod = computed.perCity[i]?.production ?? 0;
        city.progress += prod;
        if (cost > 0 && city.progress >= cost) {
          const overflow = city.progress - cost;
          this.completeCityItem(city);
          const next = this.chooseProduction(city);
          if (next) {
            city.item = next;
            city.progress = overflow;
            city.startTurn = this.turn;
          } else {
            city.progress = 0;
          }
        }
      }

      this.growCities();

      if (this.terminalProgress()) break;
      this.turn += 1;
    }
    if (this.targetTurn !== null && this.terminalBurstTurn !== null && this.terminalBurstTurn > this.targetTurn) {
      this.blockers.push({
        kind: "target",
        message: `目标回合 T${this.targetTurn} 不可行：构造得到 T${this.terminalBurstTurn}`,
      });
    }
    if (!this.terminalBurstTurn) {
      this.blockers.push({
        kind: "terminal",
        message: `在 ${this.maxTurns} 回合内未达成终局条件`,
        detail: this.describeShortfall(),
      });
    }
    const negative = this.series.filter((p) => p.cum.gold < 0);
    if (negative.length) {
      this.blockers.push({ kind: "economy", message: "金币累计为负（基准不应依赖借债）" });
    }
  }

  private techCost(node: PaceNode, worldEra: number): number {
    const base = (node.costs.science ?? 0) * this.graph.speed.costMultiplier;
    if (!node.eraIndex) return base;
    const before = this.graph.params.TECH_COST_PERCENT_CHANGE_BEFORE_GAME_ERA ?? 0;
    const after = this.graph.params.TECH_COST_PERCENT_CHANGE_AFTER_GAME_ERA ?? 0;
    const factor = node.eraIndex < worldEra ? 1 + before / 100 : node.eraIndex > worldEra ? 1 + after / 100 : 1;
    return base * factor;
  }

  private civicCost(node: PaceNode, worldEra: number): number {
    const base = (node.costs.culture ?? 0) * this.graph.speed.costMultiplier;
    if (!node.eraIndex) return base;
    const before = this.graph.params.CIVIC_COST_PERCENT_CHANGE_BEFORE_GAME_ERA ?? 0;
    const after = this.graph.params.CIVIC_COST_PERCENT_CHANGE_AFTER_GAME_ERA ?? 0;
    const factor = node.eraIndex < worldEra ? 1 + before / 100 : node.eraIndex > worldEra ? 1 + after / 100 : 1;
    return base * factor;
  }

  private describeShortfall(): string {
    const terminal = this.spec.terminal;
    if (terminal.kind === "space-race") {
      const done = terminal.projects.filter((id) => this.events.some((e) => e.kind === "project" && e.id === id));
      return `航天项目 ${done.length}/${terminal.projects.length}；科研 ${Math.round(this.lastRates?.science ?? 0)}/回合，产能 ${Math.round(this.lastRates?.production ?? 0)}/回合`;
    }
    if (terminal.kind === "units") {
      const missing = terminal.units
        .filter((u) => (this.units.get(resolveId(this.graph, u.id)) ?? 0) < u.qty)
        .map((u) => `${u.id} ${this.units.get(resolveId(this.graph, u.id)) ?? 0}/${u.qty}`);
      return `军力未就位：${missing.join("，")}`;
    }
    if (terminal.kind === "yield-target") {
      return `累计 ${terminal.metric} ${Math.round(this.cumulative[terminal.metric] ?? 0)} / ${terminal.target.value}`;
    }
    return "议会点数未达阈值";
  }

  // -- backward pass -------------------------------------------------------

  computeDeadlines(): Map<string, number> {
    const end = this.targetTurn ?? this.terminalBurstTurn ?? this.maxTurns;
    const deadlines = new Map<string, number>();
    const lastRates = this.lastRates;
    const durations = new Map<string, number>();
    const prodRate = Math.max(1, lastRates?.production ?? 1);
    for (const key of this.required) {
      const node = this.graph.nodes.get(key);
      if (!node) continue;
      if (node.kind === "tech") {
        const rate = Math.max(1, lastRates?.science ?? 1);
        durations.set(key, Math.max(1, Math.ceil(((node.costs.science ?? 0) * this.graph.speed.costMultiplier) / rate)));
      } else if (node.kind === "civic") {
        const rate = Math.max(1, lastRates?.culture ?? 1);
        durations.set(key, Math.max(1, Math.ceil(((node.costs.culture ?? 0) * this.graph.speed.costMultiplier) / rate)));
      } else {
        durations.set(key, Math.max(1, Math.ceil(((node.costs.production ?? 0) * this.graph.speed.costMultiplier) / prodRate)));
      }
    }
    const depth = new Map<string, number>();
    const queue: Array<{ key: string; d: number }> = [];
    for (const key of this.required) {
      if (!this.required.has(key)) continue;
      if (!(this.graph.children.get(key) ?? []).some((c) => this.required.has(c))) queue.push({ key, d: 0 });
    }
    if (!queue.length) {
      for (const key of this.required) queue.push({ key, d: 0 });
    }
    while (queue.length) {
      const { key, d } = queue.shift()!;
      if ((depth.get(key) ?? -1) >= d) continue;
      depth.set(key, d);
      for (const parent of this.graph.parents.get(key) ?? []) {
        if (this.required.has(parent)) queue.push({ key: parent, d: d + 1 });
      }
    }
    const ordered = [...this.required].sort((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0));
    for (const key of ordered) {
      const d = durations.get(key) ?? 1;
      const children = (this.graph.children.get(key) ?? []).filter((c) => this.required.has(c));
      let lf = end;
      if (children.length) {
        lf = Math.min(...children.map((c) => deadlines.get(c) ?? end));
      }
      deadlines.set(key, lf - d);
    }
    return deadlines;
  }

  // -- output --------------------------------------------------------------

  buildResult(specs: PacingSpecs, builtAt: string | null, rawBuiltAt: string | null): PacingResult {
    const feasible =
      this.terminalBurstTurn !== null &&
      this.blockers.every((b) => b.kind !== "terminal" && b.kind !== "target");
    const milestones = this.buildMilestones();
    const series = this.series;
    const checks = this.buildChecks(feasible, milestones, series);
    return {
      schema: "civi6.pacing/v1",
      input: {
        source: this.graph.source,
        civId: this.graph.civ.civId,
        leaderId: this.graph.civ.leaderId,
        victoryId: this.spec.victoryId,
        speed: this.graph.speed.speed,
        assurance: this.graph.assurance,
        targetTurn: this.targetTurn,
      },
      basis: {
        speed: this.graph.speed.speed,
        labelZh: this.graph.speed.labelZh,
        totalTurns: this.graph.speed.totalTurns,
        costMultiplier: this.graph.speed.costMultiplier,
        turnScale: this.graph.speed.turnScale,
        source: this.graph.speed.source,
      },
      civ: {
        civId: this.graph.civ.civId,
        leaderId: this.graph.civ.leaderId,
        labelZh: this.graph.civ.labelZh,
        nameEn: this.graph.civ.nameEn,
        traits: this.graph.civ.traits,
        uniqueDistricts: this.graph.civ.uniqueDistricts,
        uniqueBuildings: this.graph.civ.uniqueBuildings,
        uniqueUnits: this.graph.civ.uniqueUnits,
        replacements: [...this.graph.civ.replacements.entries()].map(([baseId, uniqueId]) => ({ baseId, uniqueId })),
      },
      baseline: {
        feasible,
        guarantee: this.spec.guarantee,
        turn: this.winTurn,
        selfTurn: this.terminalSelfTurn,
        burstTurn: this.terminalBurstTurn,
        referenceTurn: this.referenceTurn,
        window: this.terminalWindow(),
        blockers: this.blockers,
      },
      milestones,
      actions: this.buildActions(milestones),
      state: this.buildState(series),
      series,
      checks,
      assumptions: {
        difficulty: this.baseline.assumptions.difficulty,
        mapProfile: this.baseline.assumptions.mapProfile,
        opponents: this.baseline.assumptions.opponents,
        assurance: this.graph.assurance,
        tileFloor: this.baseline.assumptions.tileFloor[this.graph.assurance],
        districtFloor: this.baseline.assumptions.districtFloor[this.graph.assurance],
        population: this.baseline.assumptions.population,
        noRandomGains: true,
        noPurchases: true,
        worldEraPace: "kb_era_window（AI 参考节奏，玩家自身研究不推进世界时代）",
        policies: [...this.policies],
        government: this.government,
      },
      provenance: {
        ruleset: this.graph.source,
        kbBuiltAt: builtAt,
        rawBuiltAt,
        specVersion: specs.baseline.version,
        generatedAt: new Date().toISOString(),
        excludedEffects: this.graph.excluded.effects,
        excludedByReason: this.graph.excluded.byReason,
      },
    };
  }

  private terminalWindow(): number {
    if (this.terminalBurstTurn === null) return 0;
    const starts = this.events
      .filter((e) => e.kind === "project" || (e.kind === "district" && e.role === "terminal"))
      .map((e) => e.startTurn);
    if (!starts.length) return this.terminalBurstTurn;
    return Math.max(1, this.terminalBurstTurn - Math.min(...starts) + 1);
  }

  private buildMilestones(): Milestone[] {
    const out: Milestone[] = [];
    const deadlines = this.deadlines;
    for (const event of this.events) {
      if (event.kind === "settle") continue;
      const key = nodeKey(event.kind, event.id);
      const latest = deadlines.get(key) ?? null;
      out.push({
        turn: event.turn,
        kind: event.kind,
        id: event.id,
        labelZh: event.labelZh,
        cost: Math.round(event.cost * 100) / 100,
        currency: event.currency,
        role: event.role,
        latestTurn: latest !== null ? Math.max(0, Math.round(latest)) : null,
        slack: latest !== null ? Math.max(0, Math.round(latest)) - event.turn : null,
        why: event.role === "terminal" ? "终局链" : event.role === "booster" ? "瓶颈产出" : "前置/解锁",
        deps: (this.graph.parents.get(key) ?? [])
          .map((p) => splitKey(p))
          .filter((p) => ["tech", "civic", "building", "district"].includes(p.kind))
          .map((p) => nodeKey(p.kind, resolveId(this.graph, p.id)))
          .filter((p) => p !== nodeKey(event.kind, event.id)),
        city: event.city,
      });
    }
    out.sort((a, b) => a.turn - b.turn || kindRank(a.kind) - kindRank(b.kind) || a.id.localeCompare(b.id));
    return out;
  }

  private buildActions(_milestones: Milestone[]): ActionInterval[] {
    // Collapse repeats of the same action (same node id) into one interval with
    // a count; per-city timing remains in `milestones` (which carry `city`).
    const byNode = new Map<string, ActionInterval>();
    for (const event of this.events) {
      if (event.kind === "settle") {
        const key = `settle\u0000${event.id}`;
        const prev = byNode.get(key);
        if (prev) {
          prev.to = Math.max(prev.to, event.turn);
          prev.count += 1;
        } else {
          byNode.set(key, {
            from: event.turn,
            to: event.turn,
            kind: "settle",
            id: event.id,
            label: event.labelZh,
            count: 1,
          });
        }
        continue;
      }
      const kind: ActionInterval["kind"] =
        event.kind === "tech" ? "research" :
        event.kind === "civic" ? "civic" :
        event.kind === "district" ? "district" :
        event.kind === "project" ? "project" :
        event.kind === "unit" ? "unit" : "build";
      const key = `${kind}\u0000${event.id}`;
      const prev = byNode.get(key);
      if (prev) {
        prev.from = Math.min(prev.from, event.startTurn);
        prev.to = Math.max(prev.to, event.turn);
        prev.count += 1;
      } else {
        byNode.set(key, {
          from: event.startTurn,
          to: event.turn,
          kind,
          id: event.id,
          label: event.labelZh,
          count: 1,
        });
      }
    }
    return [...byNode.values()].sort(
      (a, b) => a.from - b.from || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
    );
  }

  private buildState(series: RatePoint[]): PacingResult["state"] {
    const defs: Array<{ key: string; label: string; unit: string }> = [
      { key: "science", label: "科技", unit: "瓶/回合" },
      { key: "culture", label: "文化", unit: "琴/回合" },
      { key: "gold", label: "金币", unit: "金/回合" },
      { key: "production", label: "产能", unit: "锤/回合" },
      { key: "food", label: "食物", unit: "粮/回合" },
      { key: "faith", label: "信仰", unit: "鸽/回合" },
      { key: "tourism", label: "旅游", unit: "旅游/回合" },
    ];
    const out: PacingResult["state"] = {};
    for (const def of defs) {
      const segments: Array<{ from: number; to: number; rate: number; cumFrom: number; cumTo: number }> = [];
      for (const point of series) {
        const rate = point.rates[def.key as keyof RatePoint["rates"]];
        const cum = point.cum[def.key as keyof RatePoint["cum"]];
        const prev = segments[segments.length - 1];
        if (prev && Math.abs(prev.rate - rate) < 1e-9) {
          prev.to = point.turn;
          prev.cumTo = cum;
        } else {
          segments.push({ from: point.turn, to: point.turn, rate, cumFrom: cum - rate, cumTo: cum });
        }
      }
      const term = (from: number) => (from <= 1 ? "t" : `(t−${from - 1})`);
      const exprParts = segments
        .slice(0, 8)
        .map((s) => `${round2(s.rate)}·${term(s.from)} [T${s.from}-${s.to}]`);
      const expression = segments.length
        ? `${def.label}: Y(t) = ${exprParts.join(" + ")}${segments.length > 8 ? ` + …（共 ${segments.length} 段）` : ""}`
        : `${def.label}: Y(t) = 0`;
      out[def.key] = {
        unit: `${def.unit}；累计为同币种`,
        segments,
        expression,
        final: segments.length ? segments[segments.length - 1].cumTo : 0,
      };
    }
    return out;
  }

  private buildChecks(feasible: boolean, milestones: Milestone[], series: RatePoint[]): PacingChecks {
    const details: string[] = [];
    let closedLoop = true;
    const byCurrency = new Map<string, number>();
    for (const m of milestones) {
      if (!m.currency || m.currency === "production") continue;
      byCurrency.set(m.currency, (byCurrency.get(m.currency) ?? 0) + m.cost);
    }
    // cumulative production at each turn must cover cumulative spend by that turn
    for (const [currency, total] of byCurrency) {
      const key = `${currency}` as keyof RatePoint["cum"];
      const endCum = series.length ? series[series.length - 1].cum[key] : 0;
      if (total > endCum + 1e-6) {
        closedLoop = false;
        details.push(`${currency}: 支出 ${round2(total)} > 累计产出 ${round2(endCum)}`);
      }
    }
    let prereqOrder = true;
    const doneAt = new Map<string, number[]>();
    const cityDoneAt = new Map<string, number>();
    for (const m of milestones) {
      const key = nodeKey(m.kind, m.id);
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
        const { kind } = splitKey(dep);
        if (!["tech", "civic", "building", "district"].includes(kind)) continue;
        let ok: boolean;
        if (m.city !== null && (kind === "building" || kind === "district")) {
          const t = cityDoneAt.get(`${dep}\u0000${m.city}`);
          ok = t !== undefined && t < m.turn;
        } else {
          const list = doneAt.get(dep) ?? [];
          ok = list.some((t) => t < m.turn);
        }
        if (!ok) {
          prereqOrder = false;
          details.push(`${m.kind}:${m.id}（T${m.turn}）缺少前置 ${dep}`);
        }
      }
    }
    let monotone = true;
    for (const def of ["science", "culture", "gold", "production", "food", "faith", "tourism"] as const) {
      let prev = -Infinity;
      for (const p of series) {
        if (p.cum[def] + 1e-6 < prev) monotone = false;
        prev = p.cum[def];
      }
    }
    const slackConsistent = milestones.every(
      (m) => m.latestTurn === null || m.slack === null || m.slack >= 0,
    );
    return {
      closedLoop,
      prereqOrder,
      sourceSound: true,
      terminal: feasible,
      deterministic: true,
      monotone,
      slackConsistent,
      details,
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Run the bounded forward/backward iteration and return one baseline. */
export function buildPacing(kb: KnowledgeDb, opts: PacingOptions): PacingResult {
  const root = opts.root ?? process.cwd();
  const specs = loadPacingSpecs(root);
  const specErrors = validatePacingSpecs(specs);
  if (specErrors.length) throw new Error(`Pacing 规格校验失败：\n- ${specErrors.join("\n- ")}`);
  const victory = specs.victories.get(opts.victoryId);
  if (!victory) throw new Error(`未收录胜利规格：${opts.victoryId}`);
  const assurance = opts.assurance ?? "standard";

  let best: PacingSimulation | null = null;
  let deadlines = new Map<string, number>();
  const maxPasses = Math.max(1, specs.baseline.tick.maxPasses);
  for (let pass = 0; pass < maxPasses; pass++) {
    const graph = loadPaceGraph(kb, {
      source: opts.source,
      speed: opts.speed,
      assurance,
      civId: opts.civId,
      leaderId: opts.leaderId ?? null,
      victoryId: opts.victoryId,
      baseline: specs.baseline,
      specs,
    });
    const sim = new PacingSimulation(graph, victory, specs.baseline, opts.targetTurn ?? null);
    sim.deadlines = deadlines;
    sim.run();
    if (!sim.terminalBurstTurn) {
      best = best ?? sim;
      break;
    }
    if (!best || (best.terminalBurstTurn ?? Infinity) > (sim.terminalBurstTurn ?? Infinity)) best = sim;
    const next = sim.computeDeadlines();
    if (sameDeadlines(deadlines, next)) break;
    deadlines = next;
  }
  if (!best) throw new Error("Pacing 未产生任何模拟结果");
  const build = kb.get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'build';`);
  const raw = kb.get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'kb.build';`);
  let kbBuiltAt: string | null = null;
  try {
    const parsed = JSON.parse(raw?.value ?? "{}");
    kbBuiltAt = parsed.builtAt ?? null;
  } catch {
    kbBuiltAt = null;
  }
  let rawBuiltAt: string | null = null;
  try {
    const parsed = JSON.parse(build?.value ?? "{}");
    rawBuiltAt = parsed.builtAt ?? null;
  } catch {
    rawBuiltAt = null;
  }
  return best.buildResult(specs, kbBuiltAt, rawBuiltAt);
}

function sameDeadlines(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}
