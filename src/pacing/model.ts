import type { PaceEffect, PaceGraph } from "./graph.js";
import type { PacingDimension } from "./spec.js";

/**
 * Yield algebra.
 *
 * The formula layer contains many semantics that are *not* flat empire yields
 * (trade routes, adjacency, specialists, plots, powered buildings). `graph.ts`
 * already filters those out; this module only aggregates what is left, in the
 * order the game applies it:
 *
 *   district pool (adjacency floor + district effects)  × district %
 *   city subtotal (centre + tiles + pop + buildings)    × city %
 *   empire total                                        × player %
 *
 * Conditions are evaluated against state we actually track; any condition the
 * model does not understand was dropped at load time (never guessed true).
 */

export interface CityRates {
  science: number;
  culture: number;
  gold: number;
  production: number;
  food: number;
  faith: number;
  tourism: number;
  housing: number;
  amenities: number;
}

export interface EmpireRates {
  science: number;
  culture: number;
  gold: number;
  production: number;
  food: number;
  faith: number;
  tourism: number;
  housing: number;
  amenities: number;
  maintenance: number;
  goldNet: number;
}

export interface CityView {
  id: number;
  pop: number;
  buildings: ReadonlySet<string>;
  districts: ReadonlySet<string>;
}

export const MODEL_DIMENSIONS: PacingDimension[] = [
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

type Bucket = Record<PacingDimension, number>;

function emptyBucket(): Bucket {
  const out = {} as Bucket;
  for (const d of MODEL_DIMENSIONS) out[d] = 0;
  return out;
}

export interface RateInput {
  graph: PaceGraph;
  assurance: "standard" | "strict";
  worldEra: number;
  cities: CityView[];
  techs: ReadonlySet<string>;
  civics: ReadonlySet<string>;
  policies: ReadonlySet<string>;
  government: string | null;
  units: ReadonlyMap<string, number>;
  districtFloor: Record<string, Partial<Record<PacingDimension, number>>>;
  population: { sciencePerPop: number; culturePerPop: number; goldPerPop: number };
  cityCenter: { food: number; production: number; gold: number };
  tileFloor: { foodPerPop: number; productionPerPop: number; housingPerCity: number };
  housingBase: number;
  foodConsumptionPerPop: number;
  highPopThreshold: number;
  campusHighAdjacencyFloor: number;
}

export function activeEffects(input: RateInput): PaceEffect[] {
  const { graph, techs, civics, policies, government } = input;
  const out: PaceEffect[] = [];
  const add = (ownerKind: string, ownerId: string) => {
    const list = graph.effectsByOwner.get(`${ownerKind}:${ownerId}`);
    if (list?.length) out.push(...list);
  };
  for (const id of policies) add("policy", id);
  if (government) add("government", government);
  for (const id of techs) add("technology", id);
  for (const id of civics) add("civic", id);
  for (const trait of graph.civ.traits) add("trait", trait);
  return out;
}

function resolved(graph: PaceGraph, id: string): string {
  return graph.civ.replacements.get(id) ?? id;
}

function conditionHolds(condition: string | null, city: CityView | null, input: RateInput): boolean {
  if (!condition) return true;
  switch (condition) {
    case "campusHighAdjacency": {
      if (input.assurance !== "standard") return false;
      const campus = resolved(input.graph, "DISTRICT_CAMPUS");
      const floor = input.districtFloor[campus] ?? input.districtFloor[input.graph.civ.uniqueToBase.get(campus) ?? ""];
      return (floor?.science_per_turn ?? 0) >= input.campusHighAdjacencyFloor;
    }
    case "highPop":
      return city ? city.pop >= input.highPopThreshold : false;
    case "hasCampus":
      return city ? city.districts.has(resolved(input.graph, "DISTRICT_CAMPUS")) : false;
    case "hasIndustrialZone":
      return city ? city.districts.has(resolved(input.graph, "DISTRICT_INDUSTRIAL_ZONE")) : false;
    default:
      return false;
  }
}

function copiesOf(effect: PaceEffect, city: CityView | null, input: RateInput): number {
  const per = effect.per ?? "turn";
  if (per === "pop") return city ? city.pop : input.cities.reduce((n, c) => n + c.pop, 0);
  if (per === "city") return city ? 1 : input.cities.length;
  if (per === "era") return input.worldEra;
  return 1;
}

function addBucket(target: Bucket, effects: PaceEffect[], city: CityView | null, input: RateInput): void {
  for (const e of effects) {
    if (e.op === "percent") continue;
    if (!conditionHolds(e.condition, city, input)) continue;
    target[e.dimension] += e.value * copiesOf(e, city, input);
  }
}

function percentFor(
  effects: PaceEffect[],
  city: CityView | null,
  input: RateInput,
  scope: "city" | "player" | "district",
): number {
  let pct = 0;
  for (const e of effects) {
    if (e.scope !== scope || e.op !== "percent") continue;
    if (!conditionHolds(e.condition, city, input)) continue;
    pct += e.value;
  }
  return pct / 100;
}

function toRates(b: Bucket): CityRates {
  return {
    science: b.science_per_turn,
    culture: b.culture_per_turn,
    gold: b.gold_per_turn,
    production: b.production_per_turn,
    food: b.food_per_turn,
    faith: b.faith_per_turn,
    tourism: b.tourism_per_turn,
    housing: b.housing,
    amenities: b.amenities,
  };
}

export interface ComputedRates {
  perCity: CityRates[];
  empire: EmpireRates;
}

export function computeRates(input: RateInput): ComputedRates {
  const { graph, cities } = input;
  const active = activeEffects(input);

  const perCity: CityRates[] = [];
  const sum = emptyBucket();

  for (const city of cities) {
    const cityAdd = emptyBucket();
    const districtPool = emptyBucket();

    cityAdd.food_per_turn += input.cityCenter.food;
    cityAdd.production_per_turn += input.cityCenter.production;
    cityAdd.gold_per_turn += input.cityCenter.gold;
    cityAdd.food_per_turn += input.tileFloor.foodPerPop * city.pop;
    cityAdd.production_per_turn += input.tileFloor.productionPerPop * city.pop;
    cityAdd.science_per_turn += input.population.sciencePerPop * city.pop;
    cityAdd.culture_per_turn += input.population.culturePerPop * city.pop;
    cityAdd.gold_per_turn += input.population.goldPerPop * city.pop;
    cityAdd.food_per_turn -= input.foodConsumptionPerPop * city.pop;
    cityAdd.housing += input.housingBase + input.tileFloor.housingPerCity;

    for (const id of city.buildings) {
      const effects = graph.effectsByOwner.get(`building:${id}`) ?? [];
      for (const e of effects) {
        if (e.scope === "city") addBucket(cityAdd, [e], city, input);
        else if (e.scope === "district") addBucket(districtPool, [e], city, input);
      }
    }
    for (const id of city.districts) {
      const floor = input.districtFloor[id] ?? input.districtFloor[input.graph.civ.uniqueToBase.get(id) ?? ""];
      if (floor) {
        for (const [dim, value] of Object.entries(floor)) {
          districtPool[dim as PacingDimension] += Number(value) || 0;
        }
      }
      const effects = graph.effectsByOwner.get(`district:${id}`) ?? [];
      for (const e of effects) {
        if (e.scope === "city") addBucket(cityAdd, [e], city, input);
        else if (e.scope === "district") addBucket(districtPool, [e], city, input);
      }
    }
    for (const e of active) {
      if (e.scope === "city") addBucket(cityAdd, [e], city, input);
      else if (e.scope === "district") addBucket(districtPool, [e], city, input);
    }

    const districtPct = percentFor(active, city, input, "district");
    for (const dim of MODEL_DIMENSIONS) districtPool[dim] *= 1 + districtPct;

    const total = emptyBucket();
    for (const dim of MODEL_DIMENSIONS) total[dim] = cityAdd[dim] + districtPool[dim];
    const cityPct = percentFor(active, city, input, "city");
    for (const dim of MODEL_DIMENSIONS) total[dim] *= 1 + cityPct;

    const rates = toRates(total);
    perCity.push(rates);
    for (const dim of MODEL_DIMENSIONS) sum[dim] += total[dim];
  }

  for (const e of active) {
    if (e.scope !== "player" || e.op === "percent") continue;
    if (!conditionHolds(e.condition, null, input)) continue;
    sum[e.dimension] += e.value * copiesOf(e, null, input);
  }
  const playerPct = percentFor(active, null, input, "player");
  for (const dim of MODEL_DIMENSIONS) sum[dim] *= 1 + playerPct;

  let maintenance = 0;
  for (const [id, count] of input.units) {
    const meta = graph.unitMeta.get(id);
    if (meta) maintenance += meta.maintenance * count;
  }

  const clamp = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const empire: EmpireRates = {
    science: clamp(sum.science_per_turn),
    culture: clamp(sum.culture_per_turn),
    gold: clamp(sum.gold_per_turn),
    production: clamp(sum.production_per_turn),
    food: sum.food_per_turn,
    faith: clamp(sum.faith_per_turn),
    tourism: clamp(sum.tourism_per_turn),
    housing: clamp(sum.housing),
    amenities: clamp(sum.amenities),
    maintenance,
    goldNet: clamp(sum.gold_per_turn) - maintenance,
  };
  return { perCity, empire };
}
