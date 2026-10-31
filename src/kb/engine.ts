import type { KnowledgeDb } from "../db.js";
import type { DataSource } from "../config.js";
import type { Labeler } from "./labels.js";
import {
  type DimensionSpec,
  type EntityReq,
  type KbSpecs,
  type MetricReq,
  type ObjectiveSpec,
  type PlanSpec,
  type Role,
  type SourceFlag,
  type TargetOp,
} from "./spec.js";
import { closureOf } from "./closure.js";
import { loadNodeMeta, buildPathForObjective } from "./path.js";
import { buildConstraints } from "./constraints.js";
import { buildEraFocus } from "./focus.js";
import {
  buildScenarioLedger,
  burstEraIndex,
  expandSupply,
  scenarioList,
  type ScenarioLedger,
} from "./ledger.js";
import { buildCuts } from "./cut.js";
import { classifyRobustness, type DecisionRef } from "./scenario.js";

export interface EngineOptions {
  source: DataSource;
  rawBuiltAt: string | null;
  builtAt: string;
  labeler: Labeler;
  specs: KbSpecs;
}

export interface EngineStats {
  plans: number;
  targets: number;
  budgets: number;
  checks: number;
  derivations: number;
}

interface TargetRow {
  planId: string;
  stage: "opening" | "mid" | "final";
  sliceKind: "burst" | "era";
  eraId: string | null;
  turnLo: number | null;
  turnHi: number | null;
  category: string;
  entityId: string | null;
  dimensionId: string | null;
  op: TargetOp;
  valueNum: number | null;
  valueLo: number | null;
  valueHi: number | null;
  valueText: string | null;
  unit: string | null;
  role: Role;
  priority: number;
  labelZh: string | null;
  labelEn: string | null;
  rationale: string | null;
  formula: string | null;
  checkHint: string | null;
  remedy: string | null;
  sourceFlag: SourceFlag;
  confidence: number;
  provenance: string | null;
}

interface BudgetRow {
  planId: string;
  sliceKind: "burst" | "era";
  eraId: string | null;
  currency: string;
  income: number;
  expense: number;
  net: number;
  drivers: string | null;
  sourceFlag: SourceFlag;
  confidence: number;
}

interface CheckRow {
  planId: string;
  eraId: string | null;
  turnLo: number | null;
  turnHi: number | null;
  dimensionId: string;
  op: TargetOp;
  valueLo: number | null;
  valueHi: number | null;
  message: string;
  remedy: string | null;
  severity: "critical" | "warning" | "info";
  priority: number;
}

interface DerivationRow {
  planId: string;
  sliceKind: "burst" | "era";
  eraId: string | null;
  outputDimensionId: string;
  expression: string;
  inputs: string | null;
  value: number;
  unit: string | null;
  sourceFlag: SourceFlag;
  confidence: number;
}

const ENTITY_CATEGORIES = new Set([
  "tech", "civic", "policy", "government", "building", "district",
  "unit", "project", "greatperson", "improvement", "resource",
]);

function ceil(n: number): number {
  return Math.ceil(n - 1e-9);
}

function round(n: number, digits = 1): number {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

const DIMENSION_HELP: Record<string, { hint: string; remedy: string }> = {
  cities: { hint: "城市列表数量", remedy: "补移民：临河优先，配合马格努斯/砍树；先纪念碑再粮仓" },
  population: { hint: "帝国总览人口", remedy: "补水磨/粮仓/农场，确保住房与宜居不为负" },
  science_per_turn: { hint: "科技面板顶部产出", remedy: "每城补学院/图书馆/大学，挂自然哲学/理性主义/五年计划" },
  culture_per_turn: { hint: "文化面板顶部产出", remedy: "补剧院广场/古罗马剧场/博物馆，挂美学/大歌剧" },
  faith_per_turn: { hint: "宗教面板信仰/回合", remedy: "补圣地/神社/寺庙，选职业道德/合唱圣乐" },
  gold_per_turn: { hint: "国库净收入", remedy: "补商业中心/市场/港口/灯塔，增加商路；削减低价值单位" },
  production_per_turn: { hint: "城市生产面板合计", remedy: "补工业区/工作坊/工厂，确保通电；必要时砍树" },
  amenities_surplus: { hint: "城市宜居度条", remedy: "补娱乐中心/斗兽场/奢侈品，避免动乱" },
  housing_surplus: { hint: "城市住房条", remedy: "补水渠/粮仓/社区/下水道" },
  trade_routes: { hint: "贸易面板容量", remedy: "补商业中心/港口与市场/灯塔，政体选商人共和国" },
  tourism_per_turn: { hint: "文化胜利面板旅游/回合", remedy: "补伟人作品/奇观/国家公园，开边与商路" },
  great_person_points: { hint: "伟人面板点数/回合", remedy: "补对应区域与建筑，挂伟人点政策" },
  powered_cities: { hint: "电力面板", remedy: "补工业区发电厂/水电站，覆盖关键城" },
  diplomatic_points: { hint: "世界议会外交点", remedy: "争城邦宗主、议会决议、竞赛与奇观" },
};

function helpFor(dimensionId: string): { hint: string; remedy: string } {
  return DIMENSION_HELP[dimensionId] ?? { hint: "对应面板", remedy: "按优先级补短板" };
}

function defaultRole(category: string): Role {
  if (["tech", "civic", "project", "district"].includes(category)) return "blocking";
  if (["policy", "government", "building", "unit"].includes(category)) return "enabling";
  return "support";
}

function targetKey(
  planId: string, sliceKind: string, eraId: string | null, category: string,
  entityId: string | null, dimensionId: string | null, op: string,
): string {
  return [planId, sliceKind, eraId ?? "", category, entityId ?? "", dimensionId ?? "", op].join("|");
}

export function planIdFor(spec: PlanSpec, source: DataSource): string {
  return `${spec.victoryId}:${source}`;
}

function mergePlan(spec: PlanSpec, source: DataSource): PlanSpec {
  const override = source === "bbg" ? spec.overrides?.bbg : spec.overrides?.vanilla;
  if (!override) return spec;
  return {
    ...spec,
    ...override,
    victoryId: spec.victoryId,
    burst: { ...spec.burst, ...(override.burst ?? {}) },
    eras: override.eras ?? spec.eras,
    assumptions: { ...(spec.assumptions ?? {}), ...(override.assumptions ?? {}) },
  };
}

export function buildPlans(kb: KnowledgeDb, opts: EngineOptions): EngineStats {
  kb.exec(`DELETE FROM kb_plan; DELETE FROM kb_target; DELETE FROM kb_budget; DELETE FROM kb_check; DELETE FROM kb_derivation;`);

  const dims = new Map<string, DimensionSpec>(opts.specs.dimensions.map((d) => [d.dimensionId, d]));
  const eraOrder = new Map(opts.specs.eras.map((e) => [e.eraId, e.eraIndex]));
  const eraLabel = new Map(opts.specs.eras.map((e) => [e.eraId, opts.labeler.pair("era", e.eraId)]));
  const productionCost = new Map<string, number>();
  for (const r of kb.all<{ ref_kind: string; ref_id: string; amount: number }>(
    `SELECT ref_kind, ref_id, amount FROM kb_cost WHERE currency='production' AND is_per_turn=0;`,
  )) productionCost.set(`${r.ref_kind}\u0000${r.ref_id}`, Number(r.amount));
  const upkeepCost = new Map<string, number>();
  for (const r of kb.all<{ ref_kind: string; ref_id: string; amount: number }>(
    `SELECT ref_kind, ref_id, amount FROM kb_cost WHERE currency='gold' AND is_per_turn=1;`,
  )) upkeepCost.set(`${r.ref_kind}\u0000${r.ref_id}`, Number(r.amount));
  const effectFlat = new Map<string, number>();
  for (const r of kb.all<{ owner_kind: string; owner_id: string; dimension_id: string; value: number }>(
    `SELECT owner_kind, owner_id, dimension_id, value FROM kb_effect WHERE effect_kind='flat';`,
  )) {
    const key = `${r.owner_kind}\u0000${r.owner_id}\u0000${r.dimension_id}`;
    effectFlat.set(key, (effectFlat.get(key) ?? 0) + Number(r.value));
  }
  const techCost = new Map<string, number>();
  for (const r of kb.all<{ TechnologyType: string; Cost: number }>(`SELECT TechnologyType, Cost FROM Technologies;`)) {
    techCost.set(r.TechnologyType, Number(r.Cost) || 0);
  }
  const civicCost = new Map<string, number>();
  for (const r of kb.all<{ CivicType: string; Cost: number }>(`SELECT CivicType, Cost FROM Civics;`)) {
    civicCost.set(r.CivicType, Number(r.Cost) || 0);
  }

  const targetRows: TargetRow[] = [];
  const budgetRows: BudgetRow[] = [];
  const checkRows: CheckRow[] = [];
  const derivationRows: DerivationRow[] = [];
  const seen = new Set<string>();
  let plans = 0;

  for (const rawSpec of opts.specs.plans) {
    const spec = mergePlan(rawSpec, opts.source);
    const planId = planIdFor(spec, opts.source);
    const burst = spec.burst;
    const infra = burst.infrastructure ?? {};
    const planDimensions = new Set<string>();

    function labelFor(category: string, id: string): { zh: string; en: string } {
      if (category === "metric" || category === "gate") {
        const d = dims.get(id);
        return { zh: d?.nameZh ?? id, en: d?.nameEn ?? id };
      }
      return opts.labeler.pair(category, id);
    }

    function addTarget(t: Omit<TargetRow, "labelZh" | "labelEn" | "provenance"> & {
      provenance?: string | null;
    }): void {
      const key = targetKey(t.planId, t.sliceKind, t.eraId, t.category, t.entityId, t.dimensionId, t.op);
      if (seen.has(key)) return;
      seen.add(key);
      const label = t.category === "metric" || t.category === "gate"
        ? labelFor("metric", t.dimensionId ?? "")
        : labelFor(t.category, t.entityId ?? "");
      targetRows.push({
        ...t,
        labelZh: label.zh,
        labelEn: label.en,
        provenance: t.provenance ?? JSON.stringify({
          ruleset: opts.source,
          rawBuiltAt: opts.rawBuiltAt,
          planId,
        }),
      });
      if (t.dimensionId) planDimensions.add(t.dimensionId);
    }

    function addEntity(
      category: string,
      id: string,
      qty: number,
      role: Role,
      rationale: string | null,
      sourceFlag: SourceFlag,
      confidence: number,
      sliceKind: "burst" | "era",
      eraId: string,
      turnLo: number,
      turnHi: number,
      stage: "opening" | "mid" | "final",
    ): void {
      if (!id) return;
      const isMetric = category === "metric";
      addTarget({
        planId,
        stage,
        sliceKind,
        eraId,
        turnLo,
        turnHi,
        category,
        entityId: isMetric ? null : id,
        dimensionId: isMetric ? id : null,
        op: ">=",
        valueNum: qty,
        valueLo: null,
        valueHi: null,
        valueText: null,
        unit: null,
        role,
        priority: role === "blocking" ? 1 : role === "enabling" ? 2 : 3,
        rationale,
        formula: null,
        checkHint: null,
        remedy: null,
        sourceFlag,
        confidence,
        provenance: JSON.stringify({
          ruleset: opts.source,
          rawBuiltAt: opts.rawBuiltAt,
          table: category === "metric" ? null : category,
          id,
        }),
      });
    }

    function addMetric(
      m: MetricReq,
      sliceKind: "burst" | "era",
      eraId: string,
      turnLo: number,
      turnHi: number,
      stage: "opening" | "mid" | "final",
      defaultRole: Role = "enabling",
    ): void {
      const dim = dims.get(m.dimension);
      const help = helpFor(m.dimension);
      const op: TargetOp = m.op ?? (m.lo !== undefined || m.hi !== undefined ? "between" : ">=");
      addTarget({
        planId,
        stage,
        sliceKind,
        eraId,
        turnLo,
        turnHi,
        category: "metric",
        entityId: null,
        dimensionId: m.dimension,
        op,
        valueNum: m.value ?? null,
        valueLo: m.lo ?? null,
        valueHi: m.hi ?? null,
        valueText: null,
        unit: dim?.unit ?? null,
        role: m.role ?? defaultRole,
        priority: m.role === "blocking" ? 1 : m.role === "support" ? 3 : 2,
        rationale: m.rationale ?? null,
        formula: m.formula ?? null,
        checkHint: m.checkHint ?? help.hint,
        remedy: m.remedy ?? help.remedy,
        sourceFlag: m.sourceFlag ?? "empirical",
        confidence: m.confidence ?? 0.5,
      });
    }

    function addBudget(
      currency: string,
      income: number,
      expense: number,
      sliceKind: "burst" | "era",
      eraId: string,
      drivers: unknown,
      sourceFlag: SourceFlag,
      confidence: number,
    ): void {
      const net = round(income - expense, 2);
      budgetRows.push({
        planId, sliceKind, eraId, currency,
        income: round(income, 2), expense: round(expense, 2), net,
        drivers: JSON.stringify(drivers),
        sourceFlag, confidence,
      });
    }

    function addCheck(
      eraId: string | null, turnLo: number | null, turnHi: number | null,
      dimensionId: string, lo: number, hi: number,
      message: string, severity: "critical" | "warning" | "info",
    ): void {
      checkRows.push({
        planId, eraId, turnLo, turnHi, dimensionId, op: "between",
        valueLo: round(lo, 2), valueHi: round(hi, 2),
        message, remedy: helpFor(dimensionId).remedy, severity,
        priority: severity === "critical" ? 1 : severity === "warning" ? 2 : 3,
      });
    }

    function addDerivation(
      sliceKind: "burst" | "era", eraId: string, output: string,
      expression: string, inputs: unknown, value: number,
      unit: string | null, sourceFlag: SourceFlag = "derived", confidence = 0.75,
    ): void {
      derivationRows.push({
        planId, sliceKind, eraId, outputDimensionId: output,
        expression, inputs: JSON.stringify(inputs), value: round(value, 2),
        unit, sourceFlag, confidence,
      });
    }

    // ---- burst entity requirements -------------------------------------
    const entityLists: Array<[string, EntityReq[] | undefined]> = [
      ["project", burst.projects],
      ["tech", burst.techs],
      ["civic", burst.civics],
      ["policy", burst.policies],
      ["government", burst.governments],
      ["district", burst.districts],
      ["building", burst.buildings],
      ["unit", burst.units],
      ["greatperson", burst.greatPeople],
    ];
    for (const [category, list] of entityLists) {
      for (const req of list ?? []) {
        addEntity(
          category, req.id, req.qty ?? 1, req.role ?? defaultRole(category),
          req.rationale ?? null, "db", 0.9, "burst", burst.eraId, burst.turn, burst.turn, "final",
        );
      }
    }

    // Add prerequisite closure for the named techs/civics. The spec only names
    // the key nodes; the KB materialises the full closure as blocking targets.
    if (burst.includeTechClosure !== false) {
      for (const req of burst.techs ?? []) {
        for (const node of closureOf(kb, "tech", req.id)) {
          if (node.kind === "tech") {
            addEntity("tech", node.id, 1, "blocking", `科技前置闭包（${req.id}）`, "db", 0.9,
              "burst", burst.eraId, burst.turn, burst.turn, "final");
          }
        }
      }
    }
    if (burst.includeCivicClosure !== false) {
      for (const req of burst.civics ?? []) {
        for (const node of closureOf(kb, "civic", req.id)) {
          if (node.kind === "civic") {
            addEntity("civic", node.id, 1, "blocking", `市政前置闭包（${req.id}）`, "db", 0.9,
              "burst", burst.eraId, burst.turn, burst.turn, "final");
          }
        }
      }
    }

    // ---- reverse derivation -------------------------------------------
    const projectCost = (burst.projects ?? []).reduce(
      (sum, req) => sum + (productionCost.get(`project\u0000${req.id}`) ?? 0) * (req.qty ?? 1), 0,
    );
    const hasSpaceport = (burst.districts ?? []).some((d) => d.id === "DISTRICT_SPACEPORT")
      || (infra.empire?.["DISTRICT_SPACEPORT"] ?? 0) > 0;
    const spaceportCost = hasSpaceport ? (productionCost.get("district\u0000DISTRICT_SPACEPORT") ?? 0) : 0;
    const finalCost = projectCost + spaceportCost;
    const window = burst.window;
    const margin = burst.margin ?? 0.1;
    const prodDemand = finalCost > 0 ? ceil((finalCost / window) * (1 + margin)) : 0;

    const metricOverrides = new Map((burst.metrics ?? []).map((m) => [m.dimension, m]));
    const perCityProd = infra.perCityProd ?? 30;
    const computedCities = prodDemand > 0 && perCityProd > 0 ? ceil(prodDemand / perCityProd) : 0;
    const cities = Math.max(infra.cities ?? 0, computedCities, 1);
    const popPerCity = infra.popPerCity ?? 8;
    const population = cities * popPerCity;

    const counts = new Map<string, { kind: string; id: string; count: number }>();
    const bump = (kind: string, id: string, n: number) => {
      if (!id || n <= 0) return;
      const key = `${kind}\u0000${id}`;
      const cur = counts.get(key);
      if (cur) cur.count += n;
      else counts.set(key, { kind, id, count: n });
    };
    for (const [id, n] of Object.entries(infra.perCity ?? {})) bump("building", id, cities * Number(n));
    for (const [id, n] of Object.entries(infra.empire ?? {})) {
      const kind = id.startsWith("DISTRICT_") ? "district" : id.startsWith("BUILDING_") ? "building" : "improvement";
      bump(kind, id, Number(n));
    }
    for (const [id, n] of Object.entries(infra.units ?? {})) bump("unit", id, Number(n));

    let upkeep = 0;
    const upkeepDrivers: Array<{ ref: string; kind: string; count: number; each: number }> = [];
    for (const c of counts.values()) {
      const each = upkeepCost.get(`${c.kind}\u0000${c.id}`) ?? 0;
      if (each <= 0) continue;
      upkeep += each * c.count;
      upkeepDrivers.push({ ref: c.id, kind: c.kind, count: c.count, each });
    }

    const tradeRoutes = infra.tradeRoutes ?? Math.min(cities, 8);
    const goldPerRoute = infra.goldPerRoute ?? 3;
    let buildingGold = 0;
    for (const c of counts.values()) {
      if (c.kind !== "building") continue;
      buildingGold += (effectFlat.get(`building\u0000${c.id}\u0000gold_per_turn`) ?? 0) * c.count;
    }
    const goldIncome = population * (infra.perPopGold ?? 0.5) + tradeRoutes * goldPerRoute + buildingGold;
    const goldNet = goldIncome - upkeep;

    const amenityDemand = cities * Math.max(0, Math.ceil((popPerCity - 2) / 2));
    const amenitySupply = (infra.luxuries ?? 6) * 4 + (infra.entertainmentAmenities ?? 0);
    const amenitySurplus = amenitySupply - amenityDemand;
    const housingPerCity = infra.housingPerCity ?? 5;
    const housingSurplus = housingPerCity - popPerCity;

    // Science/culture demand: average over the full closure. The spec can
    // override this with a better late-game empirical band.
    const techIds = new Set<string>();
    for (const req of burst.techs ?? []) {
      for (const node of closureOf(kb, "tech", req.id)) {
        if (node.kind === "tech") techIds.add(node.id);
      }
    }
    let techTotal = 0;
    for (const id of techIds) techTotal += techCost.get(id) ?? 0;
    const civicIds = new Set<string>();
    for (const req of burst.civics ?? []) {
      for (const node of closureOf(kb, "civic", req.id)) {
        if (node.kind === "civic") civicIds.add(node.id);
      }
    }
    let civicTotal = 0;
    for (const id of civicIds) civicTotal += civicCost.get(id) ?? 0;
    const scienceDemand = techTotal > 0 ? (techTotal * 0.8) / window : 0;
    const cultureDemand = civicTotal > 0 ? (civicTotal * 0.8) / window : 0;

    // Emit derived metrics unless the spec overrides the dimension.
    const derivedMetrics: Array<[string, number, string, unknown, string]> = [];
    if (prodDemand > 0) {
      derivedMetrics.push([
        "production_per_turn", prodDemand,
        `ceil(${finalCost} / ${window} × (1 + ${margin}))`,
        { finalCost, window, margin }, "锤/回合",
      ]);
    }
    derivedMetrics.push(["cities", cities, `max(spec, ceil(${prodDemand} / ${perCityProd}))`, { prodDemand, perCityProd }, "座"]);
    derivedMetrics.push(["population", population, `${cities} × ${popPerCity}`, { cities, popPerCity }, "人口"]);
    derivedMetrics.push(["gold_per_turn", goldNet, `${round(goldIncome, 1)} - ${round(upkeep, 1)}`, {
      income: goldIncome, upkeep, tradeRoutes, goldPerRoute, buildingGold, population,
    }, "金/回合"]);
    derivedMetrics.push(["amenities_surplus", amenitySurplus, `${amenitySupply} - ${amenityDemand}`, {
      supply: amenitySupply, demand: amenityDemand,
    }, "宜居"]);
    derivedMetrics.push(["housing_surplus", housingSurplus, `${housingPerCity} - ${popPerCity}`, {
      housingPerCity, popPerCity,
    }, "住房"]);
    if (scienceDemand > 0) {
      derivedMetrics.push(["science_per_turn", scienceDemand, `${round(techTotal)} × 0.8 / ${window}`, {
        techTotal, window, eta: 0.5,
      }, "瓶/回合"]);
    }
    if (cultureDemand > 0) {
      derivedMetrics.push(["culture_per_turn", cultureDemand, `${round(civicTotal)} × 0.8 / ${window}`, {
        civicTotal, window, eta: 0.5,
      }, "琴/回合"]);
    }

    for (const [dimension, value, formula, inputs, unit] of derivedMetrics) {
      if (metricOverrides.has(dimension)) continue;
      const isConstraint = dimension === "gold_per_turn"
        || dimension === "amenities_surplus"
        || dimension === "housing_surplus";
      const role: Role = isConstraint ? "support" : "enabling";
      addMetric({
        dimension,
        op: ">=",
        // Balance metrics are gates (must be >= 0); their actual computed value
        // is preserved in kb_budget / kb_derivation so a deficit is visible
        // without pretending the target itself is negative.
        value: isConstraint ? 0 : round(value, 1),
        role,
        formula,
        sourceFlag: "derived",
        confidence: 0.75,
        rationale: isConstraint
          ? `反推实际值 ${round(value, 1)}；目标为不为负`
          : "由终局成本与基础设施反推",
      }, "burst", burst.eraId, burst.turn, burst.turn, "final", role);
      addDerivation("burst", burst.eraId, dimension, formula, inputs, value, unit);
    }

    // Explicit metrics from the spec override/augment the derivation.
    for (const m of burst.metrics ?? []) {
      addMetric(m, "burst", burst.eraId, burst.turn, burst.turn, "final");
    }

    // Budgets (production/gold/amenities/housing). Non-project victories do
    // not have a meaningful production budget at the burst point.
    if (finalCost > 0) {
      addBudget("production", prodDemand, ceil(finalCost / Math.max(window, 1)), "burst", burst.eraId, {
        finalCost, window, projectCost, spaceportCost,
      }, "derived", 0.75);
    }
    addBudget("gold", goldIncome, upkeep, "burst", burst.eraId, {
      upkeepDrivers, tradeRoutes, goldPerRoute, population, buildingGold,
    }, "derived", 0.75);
    addBudget("amenities", amenitySupply, amenityDemand, "burst", burst.eraId, {
      luxuries: infra.luxuries ?? 6, entertainment: infra.entertainmentAmenities ?? 0,
    }, "derived", 0.5);
    addBudget("housing", housingPerCity * cities, population, "burst", burst.eraId, {
      housingPerCity, cities, popPerCity,
    }, "derived", 0.5);

    // Burst checks: critical gates + support warnings.
    if (prodDemand > 0) {
      addCheck(burst.eraId, burst.turn, burst.turn, "production_per_turn", prodDemand, prodDemand,
        `爆发点需要至少 ${prodDemand} 锤/回合（终局 ${finalCost} 锤 / ${window} 回合）`, "critical");
    }
    addCheck(burst.eraId, burst.turn, burst.turn, "cities", cities, cities,
      `爆发点至少 ${cities} 城（按每城 ${perCityProd} 锤估算）`, "critical");
    if (goldNet < 0) {
      addCheck(burst.eraId, burst.turn, burst.turn, "gold_per_turn", 0, Number.POSITIVE_INFINITY,
        `爆发点回合金为负（${round(goldNet, 1)}），需削减维护或增加商路`, "critical");
    }
    if (amenitySurplus < 0) {
      addCheck(burst.eraId, burst.turn, burst.turn, "amenities_surplus", 0, Number.POSITIVE_INFINITY,
        `宜居缺口 ${-amenitySurplus}，需补娱乐区/奢侈品或降人口`, "critical");
    }
    if (housingSurplus < 0) {
      addCheck(burst.eraId, burst.turn, burst.turn, "housing_surplus", 0, Number.POSITIVE_INFINITY,
        `住房缺口 ${-housingSurplus}，需补水渠/粮仓/社区或降人口`, "critical");
    }

    // ---- vertical era ladder ------------------------------------------
    for (const era of spec.eras) {
      const eLabel = eraLabel.get(era.eraId);
      const eName = eLabel?.zh ?? era.eraId;
      const metrics: Array<[string, { lo: number; hi: number } | undefined]> = [
        ["cities", era.cities],
        ["population", era.population],
        ["science_per_turn", era.science],
        ["culture_per_turn", era.culture],
        ["production_per_turn", era.production],
        ["gold_per_turn", era.goldNet],
        ["faith_per_turn", era.faith],
      ];
      for (const [dimension, band] of metrics) {
        if (!band) continue;
        addMetric({
          dimension,
          op: "between",
          lo: band.lo,
          hi: band.hi,
          role: dimension === "gold_per_turn" ? "support" : "enabling",
          sourceFlag: "empirical",
          confidence: 0.5,
          rationale: `${eName}阶段性目标带`,
        }, "era", era.eraId, era.turnLo, era.turnHi, "mid");
        addCheck(era.eraId, era.turnLo, era.turnHi, dimension, band.lo, band.hi,
          `${eName}（T${era.turnLo}-${era.turnHi}）：${dimension} 应在 ${band.lo}-${band.hi}`,
          "warning");
      }
      for (const m of era.metrics ?? []) {
        addMetric(m, "era", era.eraId, era.turnLo, era.turnHi, "mid");
      }
      for (const id of era.techs ?? []) {
        addEntity("tech", id, 1, "enabling", `${eName}应完成`, "db", 0.8,
          "era", era.eraId, era.turnLo, era.turnHi, "mid");
      }
      for (const id of era.civics ?? []) {
        addEntity("civic", id, 1, "enabling", `${eName}应完成`, "db", 0.8,
          "era", era.eraId, era.turnLo, era.turnHi, "mid");
      }
      for (const id of era.policies ?? []) {
        addEntity("policy", id, 1, "enabling", `${eName}应挂载`, "db", 0.7,
          "era", era.eraId, era.turnLo, era.turnHi, "mid");
      }
      for (const id of era.districts ?? []) {
        addEntity("district", id, 1, "enabling", `${eName}应开始铺`, "db", 0.7,
          "era", era.eraId, era.turnLo, era.turnHi, "mid");
      }
      for (const id of era.buildings ?? []) {
        addEntity("building", id, 1, "enabling", `${eName}应开始建`, "db", 0.7,
          "era", era.eraId, era.turnLo, era.turnHi, "mid");
      }
      if (era.goldNet) {
        const mid = round((era.goldNet.lo + era.goldNet.hi) / 2, 1);
        addBudget("gold", mid, 0, "era", era.eraId, { anchor: era.goldNet }, "empirical", 0.5);
      }
    }

    // ---- plan header ---------------------------------------------------
    const summary = spec.nameZh
      ? `${spec.nameZh}：T${burst.turn} 爆发，约 ${cities} 城 / ${population} 人口` +
        (prodDemand > 0 ? ` / ${prodDemand} 锤/回合` : "（非项目型，按资源/改宗/军力验收）")
      : `${spec.victoryId}：T${burst.turn} 爆发`;
    const assumptions = {
      speed: "standard",
      difficulty: "deity",
      mapProfile: "standard_continents",
      opponents: 7,
      ...(spec.assumptions ?? {}),
    };
    kb.db.prepare(
      `INSERT OR REPLACE INTO kb_plan (plan_id, victory_id, source, speed, difficulty, map_profile,
         burst_turn, burst_era, summary, assumptions, model_version, raw_built_at, built_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?);`,
    ).run(
      planId, spec.victoryId, opts.source, "standard", "deity", "standard_continents",
      burst.turn, burst.eraId, summary, JSON.stringify(assumptions),
      "kb-v1", opts.rawBuiltAt, opts.builtAt,
    );
    plans++;
  }

  insertTargets(kb, targetRows);
  insertBudgets(kb, budgetRows);
  insertChecks(kb, checkRows);
  insertDerivations(kb, derivationRows);
  return {
    plans,
    targets: targetRows.length,
    budgets: budgetRows.length,
    checks: checkRows.length,
    derivations: derivationRows.length,
  };
}

function insertTargets(kb: KnowledgeDb, rows: TargetRow[]): void {
  if (!rows.length) return;
  const cols = [
    "target_key", "plan_id", "stage", "slice_kind", "era_id", "turn_lo", "turn_hi", "category",
    "entity_id", "dimension_id", "op", "value_num", "value_lo", "value_hi", "value_text", "unit",
    "role", "priority", "label_zh", "label_en", "rationale", "formula", "check_hint", "remedy",
    "source_flag", "confidence", "provenance",
  ];
  const stmt = kb.db.prepare(
    `INSERT OR IGNORE INTO kb_target (${cols.map((c) => `"${c}"`).join(", ")})
     VALUES (${cols.map(() => "?").join(", ")});`,
  );
  kb.begin();
  try {
    for (const r of rows) {
      stmt.run(
        targetKey(r.planId, r.sliceKind, r.eraId, r.category, r.entityId, r.dimensionId, r.op),
        r.planId, r.stage, r.sliceKind, r.eraId, r.turnLo, r.turnHi, r.category,
        r.entityId, r.dimensionId, r.op, r.valueNum, r.valueLo, r.valueHi, r.valueText, r.unit,
        r.role, r.priority, r.labelZh, r.labelEn, r.rationale, r.formula, r.checkHint, r.remedy,
        r.sourceFlag, r.confidence, r.provenance,
      );
    }
  } finally {
    kb.commit();
  }
}

function insertBudgets(kb: KnowledgeDb, rows: BudgetRow[]): void {
  if (!rows.length) return;
  const stmt = kb.db.prepare(
    `INSERT INTO kb_budget (plan_id, slice_kind, era_id, currency, income, expense, net, drivers, source_flag, confidence)
     VALUES (?,?,?,?,?,?,?,?,?,?);`,
  );
  kb.begin();
  try {
    for (const r of rows) {
      stmt.run(r.planId, r.sliceKind, r.eraId, r.currency, r.income, r.expense, r.net, r.drivers, r.sourceFlag, r.confidence);
    }
  } finally {
    kb.commit();
  }
}

function insertChecks(kb: KnowledgeDb, rows: CheckRow[]): void {
  if (!rows.length) return;
  const stmt = kb.db.prepare(
    `INSERT INTO kb_check (plan_id, era_id, turn_lo, turn_hi, dimension_id, op, value_lo, value_hi, message, remedy, severity, priority)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?);`,
  );
  kb.begin();
  try {
    for (const r of rows) {
      stmt.run(r.planId, r.eraId, r.turnLo, r.turnHi, r.dimensionId, r.op, r.valueLo, r.valueHi,
        r.message, r.remedy, r.severity, r.priority);
    }
  } finally {
    kb.commit();
  }
}

function insertDerivations(kb: KnowledgeDb, rows: DerivationRow[]): void {
  if (!rows.length) return;
  const stmt = kb.db.prepare(
    `INSERT INTO kb_derivation (plan_id, slice_kind, era_id, output_dimension_id, expression, inputs, value, unit, source_flag, confidence)
     VALUES (?,?,?,?,?,?,?,?,?,?);`,
  );
  kb.begin();
  try {
    for (const r of rows) {
      stmt.run(r.planId, r.sliceKind, r.eraId, r.outputDimensionId, r.expression, r.inputs, r.value, r.unit, r.sourceFlag, r.confidence);
    }
  } finally {
    kb.commit();
  }
}

// ---------------------------------------------------------------------------
// v2 objective layer: objective -> path -> constraint -> era focus
// ---------------------------------------------------------------------------

export interface ObjectiveStats {
  objectives: number;
  paths: number;
  pathNodes: number;
  constraints: number;
  focus: number;
  supplies: number;
  ledger: number;
  cuts: number;
  scenarios: number;
  robustness: number;
}

/** Tune a legacy era band so it can never fall below the constraint demand. */
function tuneEraBand(kb: KnowledgeDb, planId: string, eraId: string, dimension: string, lo: number): void {
  kb.db.prepare(
    `UPDATE kb_target
        SET value_lo = MAX(COALESCE(value_lo, 0), ?),
            value_hi = MAX(COALESCE(value_hi, 0), ?)
      WHERE plan_id = ? AND slice_kind = 'era' AND era_id = ? AND dimension_id = ?;`,
  ).run(Math.ceil(lo), Math.ceil(lo), planId, eraId, dimension);
}

/**
 * Build the v2 reasoning tables. Every row is derived from an authored
 * objective (kb/objectives/*.json); the only authored strategy text is the
 * era-focus override, which is marked `source_flag='rule'`.
 */
export function buildObjectives(kb: KnowledgeDb, opts: EngineOptions): ObjectiveStats {
  const stats: ObjectiveStats = {
    objectives: 0, paths: 0, pathNodes: 0, constraints: 0, focus: 0,
    supplies: 0, ledger: 0, cuts: 0, scenarios: 0, robustness: 0,
  };
  if (!kb.hasTable("kb_objective") || !opts.specs.objectives.length) return stats;
  kb.exec(
    `DELETE FROM kb_objective; DELETE FROM kb_constraint; DELETE FROM kb_constraint_lever;
     DELETE FROM kb_path; DELETE FROM kb_path_node; DELETE FROM kb_era_focus;
     DELETE FROM kb_supply_source; DELETE FROM kb_ledger; DELETE FROM kb_cut;
     DELETE FROM kb_scenario; DELETE FROM kb_robustness;`,
  );
  const nodes = loadNodeMeta(kb);
  const nodeBoosts = new Map<string, number>();
  if (kb.hasTable("kb_node")) {
    for (const r of kb.all<{ kind: string; id: string; boost_percent: number | null }>(
      `SELECT kind, id, boost_percent FROM kb_node WHERE boost_percent IS NOT NULL;`,
    )) {
      nodeBoosts.set(`${r.kind}\u0000${r.id}`, Number(r.boost_percent));
    }
  }
  const speeds = opts.specs.speeds.length
    ? opts.specs.speeds
    : [{ speed: "standard" as const, totalTurns: 500, costMultiplier: 100 }];
  const baseTurns = speeds.find((s) => s.costMultiplier === 100)?.totalTurns ?? Math.max(...speeds.map((s) => s.totalTurns));

  const insertObj = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_objective (objective_id, victory_id, civ_id, leader_id, speed,
       burst_turn, burst_era, title, win_capsule, assumptions, source_flag, confidence, built_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?);`,
  );
  const insertPath = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_path (objective_id, node_count, on_path_count, detour_count,
       dead_count, total_cost, detour_cost, dead_nodes, built_from)
     VALUES (?,?,?,?,?,?,?,?,?);`,
  );
  const insertNode = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_path_node (node_key, objective_id, kind, id, role, group_id,
       depth, era_due, cost, enables, why, source_flag)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?);`,
  );
  const insertConstraint = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_constraint (constraint_key, objective_id, metric, unit, required,
       required_source, supply_rate, supply_source, window, tightness, slack, binding_rank,
       waived_by, notes, confidence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);`,
  );
  const insertLever = kb.db.prepare(
    `INSERT INTO kb_constraint_lever (constraint_key, action_kind, ref_id, delta_per_unit,
       cost_production, cost_gold, requires, why, source_flag)
     VALUES (?,?,?,?,?,?,?,?,?);`,
  );
  const insertFocus = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_era_focus (focus_id, objective_id, era_id, era_index, turn_lo,
       turn_hi, rank, constraint_key, action_kind, ref_id, ref_label, why, cost, alternative,
       abandon_if, checkpoint, ledger_gap, supply_delta, source_flag, confidence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);`,
  );
  const insertSupply = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_supply_source (objective_id, source_id, metric, kind, ref_id,
       per_unit, copies, copies_lo, copies_hi, from_turn, per_pop, requires, data_ref,
       source_flag, confidence, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);`,
  );
  const insertLedger = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_ledger (objective_id, scenario_id, era_id, era_index, metric,
       required_cum, required_gross, boost_credit, supply_cum, gap, verdict, required_per_turn,
       supply_per_turn, window_turns, binding_rank)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);`,
  );
  const insertCut = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_cut (objective_id, scenario_id, rank, cut_kind, ref_id, group_id,
       saves_json, lose, trigger, slip_turns)
     VALUES (?,?,?,?,?,?,?,?,?,?);`,
  );
  const insertScenario = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_scenario (objective_id, scenario_id, label, assumptions, feasible,
       first_gap_era, first_gap_amount, burst_gap, note)
     VALUES (?,?,?,?,?,?,?,?,?);`,
  );
  const insertRobust = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_robustness (objective_id, decision_ref, decision_kind, invariant,
       flips_in, trigger)
     VALUES (?,?,?,?,?,?);`,
  );

  kb.begin();
  try {
    for (const objective of opts.specs.objectives) {
      const civSpec = opts.specs.civs.find(
        (c) => c.civId === objective.civId && (!objective.leaderId || c.leaderId === objective.leaderId),
      );
      const capabilities = civSpec?.capabilities ?? [];
      const plan = opts.specs.plans.find((p) => p.victoryId === objective.victoryId);
      const planId = plan ? planIdFor(plan, opts.source) : `${objective.victoryId}:${opts.source}`;

      for (const speed of speeds) {
        const objectiveId = `${objective.objectiveId}:${speed.speed}`;
        const turnScale = speed.totalTurns / baseTurns;
        const burstTurn = Math.max(1, Math.round(objective.burstTurn * turnScale));
        const path = buildPathForObjective(
          kb, objective, objectiveId, nodes, capabilities, speed.costMultiplier / 100,
        );
        const scenarios = scenarioList(objective);
        const ledgers = scenarios.map((sc) =>
          buildScenarioLedger(kb, {
            objective, path, speed, eras: opts.specs.eras, turnScale, burstTurn, nodeBoosts, objectiveId,
          }, sc),
        );
        const baseLedger = ledgers.find((l) => l.scenario.id === "base") ?? ledgers[0];
        const baseSupplies = expandSupply(objective, baseLedger.scenario, turnScale);
        const constraints = buildConstraints(kb, objective, objectiveId, path, baseLedger, baseSupplies);
        const focus = buildEraFocus(
          kb, opts.labeler, objective, objectiveId, path, constraints.rows, constraints.levers,
          speed, opts.specs.eras, plan, turnScale, baseLedger,
        );

        // Feasibility gate: the base scenario must close at the burst era. An
        // objective that cannot pay for its own burst is a data bug, not advice.
        if (!baseLedger.feasible && objective.feasibility !== "report") {
          const missing = baseLedger.rows
            .filter((r) => r.eraIndex === burstEraIndex(opts.specs.eras, objective.burstEra) && r.gap > 0)
            .map((r) => `${r.metric} 缺 ${r.gap}（需 ${r.requiredPerTurn}/回合，可得 ${r.supplyPerTurn}/回合）`)
            .join("；");
          throw new Error(
            `${objectiveId}: 基准情景在 ${objective.burstEra} 前无法闭合 —— ${missing}。` +
            ` 请调整 burstTurn、补充 supply 来源，或显式设置 feasibility='report'。`,
          );
        }

        const onPath = path.nodes.filter((n) => n.role === "on_path").length;
        const detour = path.nodes.filter((n) => n.role === "detour").length;
        insertObj.run(
          objectiveId, objective.victoryId, objective.civId ?? null, objective.leaderId ?? null,
          speed.speed, burstTurn, objective.burstEra, objective.title ?? null,
          JSON.stringify({ gates: objective.gates, deadEnds: objective.deadEnds ?? [], detours: objective.detours ?? [] }),
          JSON.stringify(objective.assumptions ?? {}), "rule", 0.65, opts.builtAt,
        );
        insertPath.run(
          objectiveId, path.nodes.length, onPath, detour, path.dead.length,
          JSON.stringify(path.totalCost), JSON.stringify(path.detourCost), JSON.stringify(path.dead),
          JSON.stringify({ objective: objective.objectiveId, speed: speed.speed, capabilities: capabilities.length }),
        );
        stats.objectives++;
        stats.paths++;
        for (const node of path.nodes) {
          insertNode.run(
            `${objectiveId}|${node.kind}|${node.id}`, objectiveId, node.kind, node.id, node.role,
            node.groupId, node.depth, node.eraDue, JSON.stringify(node.cost),
            JSON.stringify(node.enables), node.why ?? null, "derived",
          );
          stats.pathNodes++;
        }
        // Dead ends are first-class rows: the "do not research this" advice is
        // as important as the path itself.
        for (const dead of path.dead) {
          const meta = nodes.get(`${dead.kind}\u0000${dead.id}`);
          insertNode.run(
            `${objectiveId}|${dead.kind}|${dead.id}`, objectiveId, dead.kind, dead.id, "dead",
            null, null, null, JSON.stringify(meta?.cost ?? {}),
            JSON.stringify([]), dead.why, "rule",
          );
          stats.pathNodes++;
        }
        for (const row of constraints.rows) {
          insertConstraint.run(
            row.key, objectiveId, row.metric, row.unit, row.required, row.requiredSource,
            row.supplyRate, row.supplySource, row.window, row.tightness, row.slack,
            row.bindingRank, row.waivedBy, row.notes, row.confidence,
          );
          stats.constraints++;
        }
        for (const lever of constraints.levers) {
          insertLever.run(
            lever.constraintKey, lever.actionKind, lever.refId, lever.deltaPerUnit,
            lever.costProduction, lever.costGold, lever.requires, lever.why, "rule",
          );
        }
        for (const row of focus) {
          insertFocus.run(
            row.focusId, objectiveId, row.eraId, row.eraIndex, row.turnLo, row.turnHi, row.rank,
            row.constraintKey, row.actionKind, row.refId, row.refLabel, row.why, row.cost,
            row.alternative, row.abandonIf, row.checkpoint, row.ledgerGap, row.supplyDelta,
            row.sourceFlag, row.confidence,
          );
          stats.focus++;
        }

        for (const s of baseSupplies) {
          const spec = objective.supply?.find((x) => x.sourceId === s.sourceId);
          insertSupply.run(
            objectiveId, s.sourceId, s.metric, s.kind, s.refId, s.perUnit, s.copies,
            spec?.copiesLo ?? null, spec?.copiesHi ?? null, s.fromTurn, s.perPop ? 1 : 0,
            s.requires, s.dataRef, s.sourceFlag, s.confidence, s.note,
          );
          stats.supplies++;
        }

        for (const ledger of ledgers) {
          insertScenario.run(
            objectiveId, ledger.scenario.id, ledger.scenario.label,
            JSON.stringify(ledger.scenario.assumptions ?? {}),
            ledger.feasible ? 1 : 0,
            ledger.firstGap?.eraId ?? null,
            ledger.firstGap?.gap ?? null,
            ledger.burstGap,
            ledger.scenario.note ?? null,
          );
          stats.scenarios++;
          for (const cell of ledger.rows) {
            insertLedger.run(
              objectiveId, ledger.scenario.id, cell.eraId, cell.eraIndex, cell.metric,
              cell.requiredCum, cell.requiredGross, cell.boostCredit, cell.supplyCum, cell.gap,
              cell.verdict, cell.requiredPerTurn, cell.supplyPerTurn, cell.windowTurns,
              cell.bindingRank,
            );
            stats.ledger++;
          }
          const cuts = buildCuts(objective, path, ledger);
          for (const cut of cuts.rows) {
            insertCut.run(
              objectiveId, ledger.scenario.id, cut.rank, cut.cutKind, cut.refId, cut.groupId,
              JSON.stringify(cut.saves), cut.lose, cut.trigger, cut.slipTurns,
            );
            stats.cuts++;
          }
        }

        const decisions: DecisionRef[] = focus
          .map((row) => {
            const constraint = constraints.rows.find((c) => c.key === row.constraintKey);
            return constraint
              ? { refId: row.refId, kind: row.actionKind, eraId: row.eraId, metric: constraint.metric }
              : null;
          })
          .filter((d): d is DecisionRef => d !== null);
        for (const r of classifyRobustness(ledgers, decisions)) {
          insertRobust.run(
            objectiveId, r.decisionRef, r.decisionKind, r.invariant ? 1 : 0,
            JSON.stringify(r.flipsIn), r.trigger,
          );
          stats.robustness++;
        }

        // Legacy projection: era bands may not sit below the constraint demand,
        // and the binding focus row becomes an observable checkpoint.
        if (speed.speed === "standard") {
          for (const row of constraints.rows) {
            if (!row.bindingRank) continue;
            tuneEraBand(kb, planId, objective.burstEra, row.metric, row.required / Math.max(1, row.window));
          }
          for (const row of focus.filter((f) => f.rank === 1 && f.actionKind === "node")) {
            const constraint = constraints.rows.find((c) => c.key === row.constraintKey);
            if (!constraint) continue;
            kb.db.prepare(
              `INSERT INTO kb_check (plan_id, era_id, turn_lo, turn_hi, dimension_id, op, value_lo,
                 value_hi, message, remedy, severity, priority)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?);`,
            ).run(
              planId, row.eraId, row.turnLo, row.turnHi, constraint.metric, ">=",
              Math.ceil(constraint.required / Math.max(1, constraint.window)), 999999,
              `[焦点] ${row.refLabel}：${row.why}`,
              row.abandonIf ?? null,
              constraint.bindingRank === 1 ? "critical" : "warning",
              constraint.bindingRank === 1 ? 1 : 2,
            );
          }
        }
      }
    }
  } catch (error) {
    try {
      kb.db.exec("ROLLBACK;");
    } catch {
      /* no active transaction */
    }
    throw error;
  }
  kb.commit();
  return stats;
}
