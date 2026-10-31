import type { KnowledgeDb } from "../db.js";
import type { DataSource } from "../config.js";
import type { KbSpecs } from "./spec.js";

export interface ValidationIssue {
  level: "error" | "warning";
  check: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: number;
  warnings: number;
  issues: ValidationIssue[];
  stats: {
    plans: number;
    targets: number;
    budgets: number;
    checks: number;
    cards: number;
    effects: number;
    costs: number;
    unlocks: number;
    closure: number;
    civs: number;
    nodes: number;
    objectives: number;
    constraints: number;
    focus: number;
    capabilities: number;
    supplies: number;
    ledger: number;
    cuts: number;
    scenarios: number;
  };
}

const ENTITY_TABLES: Record<string, [string, string]> = {
  tech: ["Technologies", "TechnologyType"],
  civic: ["Civics", "CivicType"],
  policy: ["Policies", "PolicyType"],
  government: ["Governments", "GovernmentType"],
  building: ["Buildings", "BuildingType"],
  district: ["Districts", "DistrictType"],
  unit: ["Units", "UnitType"],
  project: ["Projects", "ProjectType"],
  greatperson: ["GreatPersonIndividuals", "GreatPersonIndividualType"],
  improvement: ["Improvements", "ImprovementType"],
  resource: ["Resources", "ResourceType"],
};

function count(kb: KnowledgeDb, table: string): number {
  if (!kb.hasTable(table)) return 0;
  return kb.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}";`)?.n ?? 0;
}

export function validateKb(kb: KnowledgeDb, source: DataSource, _specs: KbSpecs): ValidationReport {
  const issues: ValidationIssue[] = [];
  const error = (check: string, message: string) => issues.push({ level: "error", check, message });
  const warn = (check: string, message: string) => issues.push({ level: "warning", check, message });

  const stats = {
    plans: count(kb, "kb_plan"),
    targets: count(kb, "kb_target"),
    budgets: count(kb, "kb_budget"),
    checks: count(kb, "kb_check"),
    cards: count(kb, "kb_card"),
    effects: count(kb, "kb_effect"),
    costs: count(kb, "kb_cost"),
    unlocks: count(kb, "kb_unlock"),
    closure: count(kb, "kb_closure"),
    civs: count(kb, "kb_civ_profile"),
    nodes: count(kb, "kb_node"),
    objectives: count(kb, "kb_objective"),
    constraints: count(kb, "kb_constraint"),
    focus: count(kb, "kb_era_focus"),
    capabilities: count(kb, "kb_civ_capability"),
    supplies: count(kb, "kb_supply_source"),
    ledger: count(kb, "kb_ledger"),
    cuts: count(kb, "kb_cut"),
    scenarios: count(kb, "kb_scenario"),
  };

  if (stats.plans === 0) error("plans", "没有生成任何计划");
  if (stats.targets === 0) error("targets", "没有生成任何切面目标");
  if (stats.effects < 200) warn("effects", `kb_effect 仅 ${stats.effects} 行，可能抽取不完整`);
  if (stats.costs < 100) warn("costs", `kb_cost 仅 ${stats.costs} 行`);
  if (stats.unlocks < 100) warn("unlocks", `kb_unlock 仅 ${stats.unlocks} 行`);
  if (stats.closure < 1000) warn("closure", `kb_closure 仅 ${stats.closure} 行`);
  if (stats.nodes < 100) warn("nodes", `kb_node 仅 ${stats.nodes} 行`);

  // ---- v2 reasoning shape ------------------------------------------------
  // The objective layer only exists once kb/objectives/*.json is authored; when
  // it does, the reasoning shape is hard-checked so the tool can never return
  // an era plan without a constraint or a priced dead end.
  if (stats.objectives > 0) {
    const objectives = kb.all<{ objective_id: string; burst_era: string }>(
      `SELECT objective_id, burst_era FROM kb_objective;`,
    );
    for (const o of objectives) {
      const onPath = kb.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM kb_path_node WHERE objective_id = ? AND role = 'on_path';`,
        o.objective_id,
      )?.n ?? 0;
      if (onPath === 0) error("path", `${o.objective_id}: 路径没有 on_path 节点`);

      const constraints = kb.all<{ constraint_key: string; required: number; supply_rate: number; window: number; tightness: number; binding_rank: number | null; waived_by: string | null }>(
        `SELECT constraint_key, required, supply_rate, window, tightness, binding_rank, waived_by
           FROM kb_constraint WHERE objective_id = ?;`,
        o.objective_id,
      );
      if (!constraints.length) error("constraint", `${o.objective_id}: 没有约束（目标必须翻译成约束方程）`);
      for (const c of constraints) {
        if (c.supply_rate > 0) {
          const expect = c.required / (c.supply_rate * Math.max(1, c.window));
          if (Math.abs(expect - c.tightness) > 0.02) {
            error("constraint", `${o.objective_id}/${c.constraint_key}: tightness=${c.tightness} 与公式 ${expect.toFixed(2)} 不一致`);
          }
        }
      }
      const ranked = constraints.filter((c) => !c.waived_by && c.supply_rate > 0).sort((a, b) => b.tightness - a.tightness);
      ranked.forEach((c, i) => {
        if (c.binding_rank !== i + 1) {
          error("constraint", `${o.objective_id}/${c.constraint_key}: binding_rank=${c.binding_rank}，按紧张度应为 ${i + 1}`);
        }
      });

      const focus = kb.all<{ action_kind: string; ref_id: string; constraint_key: string | null }>(
        `SELECT action_kind, ref_id, constraint_key FROM kb_era_focus WHERE objective_id = ?;`,
        o.objective_id,
      );
      if (!focus.length) error("focus", `${o.objective_id}: 没有时代焦点行`);
      for (const f of focus) {
        if (f.action_kind !== "node") continue;
        if (!kb.get(`SELECT 1 FROM kb_node WHERE id = ? LIMIT 1;`, f.ref_id)) {
          error("focus", `${o.objective_id}: 焦点引用不存在的节点 ${f.ref_id}`);
        }
        if (f.constraint_key && !constraints.some((c) => c.constraint_key === f.constraint_key)) {
          error("focus", `${o.objective_id}: 焦点引用不存在的约束 ${f.constraint_key}`);
        }
      }
      // Dead ends must be explained (and must not leak into the focus list).
      for (const d of kb.all<{ id: string; why: string | null }>(
        `SELECT id, why FROM kb_path_node WHERE objective_id = ? AND role = 'dead';`,
        o.objective_id,
      )) {
        if (!d.why) error("dead", `${o.objective_id}: 死路 ${d.id} 缺少原因`);
        if (focus.some((f) => f.ref_id === d.id)) {
          error("dead", `${o.objective_id}: 死路 ${d.id} 出现在焦点里`);
        }
      }

      // ---- v3 ledger / cuts / scenarios -----------------------------
      const ledger = kb.all<{
        scenario_id: string; era_id: string; era_index: number; metric: string;
        required_cum: number; supply_cum: number; gap: number; verdict: string;
        window_turns: number; binding_rank: number | null;
      }>(
        `SELECT scenario_id, era_id, era_index, metric, required_cum, supply_cum, gap,
                verdict, window_turns, binding_rank
           FROM kb_ledger WHERE objective_id = ?;`,
        o.objective_id,
      );
      if (!ledger.length) error("ledger", `${o.objective_id}: 没有账本行（无法回答逐时代缺口）`);
      const groups = new Map<string, typeof ledger>();
      for (const r of ledger) {
        if (Math.abs(r.gap - (r.required_cum - r.supply_cum)) > 0.05) {
          error("ledger", `${o.objective_id}/${r.scenario_id}/${r.era_id}/${r.metric}: gap != required - supply`);
        }
        if (r.required_cum < 0 || r.supply_cum < 0) {
          error("ledger", `${o.objective_id}/${r.scenario_id}/${r.era_id}/${r.metric}: 负数金额`);
        }
        if (r.window_turns <= 0) {
          error("ledger", `${o.objective_id}/${r.scenario_id}/${r.era_id}: window_turns 必须为正`);
        }
        if ((r.verdict === "ok") !== (r.gap <= 0)) {
          error("ledger", `${o.objective_id}/${r.scenario_id}/${r.era_id}/${r.metric}: verdict 与 gap 矛盾`);
        }
        const key = `${r.scenario_id}\u0000${r.metric}`;
        const list = groups.get(key) ?? [];
        list.push(r);
        groups.set(key, list);
      }
      for (const [key, list] of groups) {
        const sorted = [...list].sort((a, b) => a.era_index - b.era_index);
        let prevReq = -Infinity;
        let prevSup = -Infinity;
        for (const r of sorted) {
          if (r.required_cum + 1e-6 < prevReq) {
            error("ledger", `${o.objective_id}/${key}: required_cum 在 ${r.era_id} 倒退`);
          }
          if (r.supply_cum + 1e-6 < prevSup) {
            error("ledger", `${o.objective_id}/${key}: supply_cum 在 ${r.era_id} 倒退`);
          }
          prevReq = Math.max(prevReq, r.required_cum);
          prevSup = Math.max(prevSup, r.supply_cum);
        }
      }

      const scenarios = kb.all<{ scenario_id: string; feasible: number }>(
        `SELECT scenario_id, feasible FROM kb_scenario WHERE objective_id = ?;`,
        o.objective_id,
      );
      if (!scenarios.length) error("scenario", `${o.objective_id}: 没有情景行`);
      if (scenarios.length && !scenarios.some((s) => s.scenario_id === "base")) {
        error("scenario", `${o.objective_id}: 缺少 base 情景`);
      }
      const base = scenarios.find((s) => s.scenario_id === "base");
      if (base && !base.feasible) {
        warn("scenario", `${o.objective_id}: base 情景在爆发点前存在缺口（feasibility='report'）`);
      }

      const onPathIds = new Set(
        kb.all<{ id: string }>(
          `SELECT id FROM kb_path_node WHERE objective_id = ? AND role = 'on_path';`,
          o.objective_id,
        ).map((r) => r.id),
      );
      const pathRow = kb.get<{ detour_cost: string | null }>(
        `SELECT detour_cost FROM kb_path WHERE objective_id = ?;`,
        o.objective_id,
      );
      const detourGroups = pathRow?.detour_cost
        ? (JSON.parse(pathRow.detour_cost) as Record<string, unknown>)
        : {};
      for (const c of kb.all<{ cut_kind: string; ref_id: string | null; group_id: string | null; lose: string | null }>(
        `SELECT cut_kind, ref_id, group_id, lose FROM kb_cut WHERE objective_id = ?;`,
        o.objective_id,
      )) {
        if (!c.lose) error("cut", `${o.objective_id}: 砍单缺少 lose`);
        if (c.cut_kind === "defer" && (!c.ref_id || !onPathIds.has(c.ref_id))) {
          error("cut", `${o.objective_id}: defer ${c.ref_id} 不在 on_path 上`);
        }
        if (c.cut_kind === "drop" && (!c.group_id || !(c.group_id in detourGroups))) {
          error("cut", `${o.objective_id}: drop 组 ${c.group_id} 没有价格`);
        }
      }

      for (const f of kb.all<{ ref_id: string; ledger_gap: number | null }>(
        `SELECT ref_id, ledger_gap FROM kb_era_focus WHERE objective_id = ?;`,
        o.objective_id,
      )) {
        if (f.ledger_gap === null) {
          error("focus", `${o.objective_id}: 焦点 ${f.ref_id} 没有 ledger_gap`);
        }
      }
    }
  } else {
    warn("objectives", "没有目标层（kb/objectives 为空），时代阶梯退化为通用带");
  }

  // Raw-build staleness.
  const buildRow = kb.hasTable("_meta")
    ? kb.get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'build';`)
    : undefined;
  let rawBuiltAt: string | null = null;
  if (buildRow?.value) {
    try {
      rawBuiltAt = JSON.parse(buildRow.value).builtAt ?? null;
    } catch {
      rawBuiltAt = null;
    }
  }
  for (const p of kb.all<{ plan_id: string; raw_built_at: string | null }>(
    `SELECT plan_id, raw_built_at FROM kb_plan;`,
  )) {
    if (rawBuiltAt && p.raw_built_at && p.raw_built_at !== rawBuiltAt) {
      error("stale", `${p.plan_id}: raw_built_at 与 _meta.build.builtAt 不一致，请重新运行 kb:build`);
    }
  }

  // Entity references and dimension references.
  const idSets = new Map<string, Set<string>>();
  for (const [category, [table, pk]] of Object.entries(ENTITY_TABLES)) {
    if (!kb.hasTable(table)) continue;
    const set = new Set<string>();
    for (const r of kb.all<Record<string, unknown>>(`SELECT "${pk}" AS id FROM "${table}";`)) {
      if (r.id) set.add(String(r.id));
    }
    idSets.set(category, set);
  }
  const dims = new Set(
    kb.all<{ dimension_id: string }>(`SELECT dimension_id FROM kb_dimension;`).map((r) => r.dimension_id),
  );
  for (const t of kb.all<{
    target_id: number; plan_id: string; category: string; entity_id: string | null;
    dimension_id: string | null; confidence: number; role: string; op: string;
    value_num: number | null; value_lo: number | null; value_hi: number | null;
  }>(`SELECT target_id, plan_id, category, entity_id, dimension_id, confidence, role, op,
            value_num, value_lo, value_hi FROM kb_target;`)) {
    if (t.entity_id && ENTITY_TABLES[t.category]) {
      const set = idSets.get(t.category);
      if (set && !set.has(t.entity_id)) {
        error("entity-ref", `${t.plan_id}: ${t.category} 不存在 ${t.entity_id}（target ${t.target_id}）`);
      }
    }
    if (t.dimension_id && !dims.has(t.dimension_id)) {
      error("dimension-ref", `${t.plan_id}: 未登记维度 ${t.dimension_id}`);
    }
    if (!(t.confidence >= 0 && t.confidence <= 1)) {
      error("confidence", `${t.plan_id}: confidence 越界 ${t.confidence}`);
    }
    if (t.op === "between" && t.value_lo !== null && t.value_hi !== null && t.value_lo > t.value_hi) {
      error("range", `${t.plan_id}: between 区间 lo > hi（target ${t.target_id}）`);
    }
    if ((t.op === ">=" || t.op === "<=" || t.op === "=") && t.value_num === null) {
      error("value", `${t.plan_id}: ${t.op} 缺少 value_num（target ${t.target_id}）`);
    }
  }

  // Each plan should have a burst slice plus a reasonable era ladder.
  for (const p of kb.all<{ plan_id: string; victory_id: string; burst_turn: number; burst_era: string }>(
    `SELECT plan_id, victory_id, burst_turn, burst_era FROM kb_plan;`,
  )) {
    const burst = kb.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM kb_target WHERE plan_id = ? AND slice_kind = 'burst';`,
      p.plan_id,
    )?.n ?? 0;
    const eras = kb.get<{ n: number }>(
      `SELECT COUNT(DISTINCT era_id) AS n FROM kb_target WHERE plan_id = ? AND slice_kind = 'era';`,
      p.plan_id,
    )?.n ?? 0;
    if (burst === 0) error("burst", `${p.plan_id}: 缺少 burst 切面`);
    if (eras < 4) warn("eras", `${p.plan_id}: 仅 ${eras} 个时代切面（预期 8）`);
    if (!kb.get(`SELECT 1 FROM kb_check WHERE plan_id = ? LIMIT 1;`, p.plan_id)) {
      warn("checks", `${p.plan_id}: 没有检查点`);
    }
    if (!kb.get(`SELECT 1 FROM kb_budget WHERE plan_id = ? LIMIT 1;`, p.plan_id)) {
      warn("budget", `${p.plan_id}: 没有预算`);
    }
  }

  // Budget identity and non-negativity.
  for (const b of kb.all<{ budget_id: number; plan_id: string; income: number; expense: number; net: number }>(
    `SELECT budget_id, plan_id, income, expense, net FROM kb_budget;`,
  )) {
    if (Math.abs(b.income - b.expense - b.net) > 0.05) {
      error("budget", `${b.plan_id}: income - expense != net（budget ${b.budget_id}）`);
    }
    if (b.income < 0 || b.expense < 0) {
      error("budget", `${b.plan_id}: 预算出现负收入/负支出（budget ${b.budget_id}）`);
    }
  }

  // Monotonicity of the era ladder for core metrics.
  for (const plan of kb.all<{ plan_id: string }>(`SELECT plan_id FROM kb_plan;`)) {
    for (const dim of ["cities", "population", "science_per_turn", "culture_per_turn", "production_per_turn"]) {
      const rows = kb.all<{ era_id: string; lo: number | null; hi: number | null }>(
        `SELECT t.era_id, t.value_lo AS lo, t.value_hi AS hi
           FROM kb_target t JOIN kb_era_window w
             ON w.era_id = t.era_id
            AND w.source = (SELECT source FROM kb_plan p WHERE p.plan_id = t.plan_id)
          WHERE t.plan_id = ? AND t.slice_kind = 'era' AND t.dimension_id = ?
          ORDER BY w.era_index;`,
        plan.plan_id,
        dim,
      );
      let prev = -Infinity;
      for (const r of rows) {
        const mid = ((r.lo ?? 0) + (r.hi ?? 0)) / 2;
        if (mid + 1e-6 < prev) {
          warn("monotonic", `${plan.plan_id}: ${dim} 在 ${r.era_id} 出现倒退（${prev} -> ${mid}）`);
        }
        prev = Math.max(prev, mid);
      }
    }
  }

  // Known invariant from the current DB: the full space-race chain (satellite,
  // moon, four Mars projects, exoplanet) is 11700 production. The older model
  // docs say 9900 because they assumed only three Mars projects; the raw DB is
  // authoritative, so report a warning only if the chain differs.
  if (kb.hasTable("Projects")) {
    const withSatellite = kb.get<{ n: number }>(
      `SELECT SUM(Cost) AS n FROM Projects
        WHERE SpaceRace = 1 AND ProjectType NOT LIKE '%LASER%'
          AND ProjectType NOT IN ('PROJECT_TRAIN_ASTRONAUTS');`,
    )?.n ?? 0;
    if (withSatellite !== 11700) {
      warn("project-total", `航天项目合计为 ${withSatellite}，当前 DB 基准为 11700（规则可能被 BBG 修改）`);
    }
  }

  const errors = issues.filter((i) => i.level === "error").length;
  const warnings = issues.filter((i) => i.level === "warning").length;
  return { ok: errors === 0, errors, warnings, issues, stats };
}
