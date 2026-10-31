import type { KnowledgeDb } from "../db.js";
import type { DataSource } from "../config.js";

export interface CardStats {
  cards: number;
}

interface PlanRow {
  plan_id: string;
  victory_id: string;
  source: string;
  burst_turn: number;
  burst_era: string;
  summary: string | null;
  difficulty: string;
  speed: string;
}

interface TargetRow {
  category: string;
  entity_id: string | null;
  dimension_id: string | null;
  op: string;
  value_num: number | null;
  value_lo: number | null;
  value_hi: number | null;
  unit: string | null;
  role: string;
  label_zh: string | null;
  rationale: string | null;
  formula: string | null;
  check_hint: string | null;
  remedy: string | null;
}

interface BudgetRow {
  currency: string;
  income: number;
  expense: number;
  net: number;
}

interface CheckRow {
  turn_lo: number | null;
  turn_hi: number | null;
  dimension_id: string;
  value_lo: number | null;
  value_hi: number | null;
  message: string;
  remedy: string | null;
  severity: string;
}

interface CivRow {
  civ_id: string;
  leader_id: string;
  name_zh: string | null;
  name_en: string | null;
  unique_unit: string | null;
  unique_building: string | null;
  unique_district: string | null;
  unique_improvement: string | null;
  playstyle_tags: string | null;
  supported_victories: string | null;
  summary: string | null;
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

function parseJsonSafe(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function band(lo: number | null, hi: number | null): string {
  if (lo === null && hi === null) return "—";
  if (lo !== null && hi !== null) return lo === hi ? fmt(lo) : `${fmt(lo)}-${fmt(hi)}`;
  return fmt(lo ?? hi);
}

function valueText(t: TargetRow): string {
  if (t.op === "between") return band(t.value_lo, t.value_hi);
  return `${t.op === ">=" ? "≥" : t.op === "<=" ? "≤" : "="}${fmt(t.value_num)}${t.unit ? " " + t.unit : ""}`;
}

function groupTargets(rows: TargetRow[]): Map<string, TargetRow[]> {
  const out = new Map<string, TargetRow[]>();
  for (const r of rows) {
    const list = out.get(r.category);
    if (list) list.push(r);
    else out.set(r.category, [r]);
  }
  return out;
}

function targetLine(t: TargetRow): string {
  return `${t.label_zh ?? t.entity_id ?? t.dimension_id} ${valueText(t)}`;
}

export function buildCards(kb: KnowledgeDb, source: DataSource, builtAt: string): CardStats {
  kb.exec(`DELETE FROM kb_card; DELETE FROM search_docs WHERE type = 'card';`);

  const plans = kb.all<PlanRow>(
    `SELECT plan_id, victory_id, source, burst_turn, burst_era, summary, difficulty, speed
       FROM kb_plan WHERE source = ? ORDER BY victory_id;`,
    source,
  );
  const victoryNames = new Map(
    kb.all<{ victory_id: string; name_zh: string }>(`SELECT victory_id, name_zh FROM kb_victory;`)
      .map((r) => [r.victory_id, r.name_zh]),
  );
  const eraNames = new Map(
    kb.all<{ era_id: string; era_name_zh: string }>(
      `SELECT era_id, era_name_zh FROM kb_era_window WHERE source = ?;`,
      source,
    ).map((r) => [r.era_id, r.era_name_zh]),
  );
  const cards: Array<{
    cardId: string; planId: string | null; kind: string; victoryId: string | null;
    eraId: string | null; civId: string | null; title: string; body: string;
    refs: string[]; sourceFlag: string; confidence: number;
  }> = [];

  for (const plan of plans) {
    const burstTargets = kb.all<TargetRow>(
      `SELECT category, entity_id, dimension_id, op, value_num, value_lo, value_hi, unit, role,
              label_zh, rationale, formula, check_hint, remedy
         FROM kb_target WHERE plan_id = ? AND slice_kind = 'burst'
        ORDER BY CASE role WHEN 'blocking' THEN 0 WHEN 'enabling' THEN 1 ELSE 2 END, category, priority;`,
      plan.plan_id,
    );
    const budgets = kb.all<BudgetRow>(
      `SELECT currency, income, expense, net FROM kb_budget
        WHERE plan_id = ? AND slice_kind = 'burst' ORDER BY currency;`,
      plan.plan_id,
    );
    const checks = kb.all<CheckRow>(
      `SELECT turn_lo, turn_hi, dimension_id, value_lo, value_hi, message, remedy, severity
         FROM kb_check WHERE plan_id = ? ORDER BY priority, turn_lo LIMIT 8;`,
      plan.plan_id,
    );
    // The prerequisite closure is materialised as targets too, but a decision
    // card should list the *named* gates; the full closure is available through
    // civi6_plan(detail='full').
    const closureTargets = burstTargets.filter(
      (t) => typeof t.rationale === "string" && t.rationale.includes("前置闭包"),
    );
    const visibleTargets = burstTargets.filter(
      (t) => !(typeof t.rationale === "string" && t.rationale.includes("前置闭包")),
    );
    const grouped = groupTargets(visibleTargets);
    const blocking = (grouped.get("tech") ?? []).length
      + (grouped.get("civic") ?? []).length
      + (grouped.get("project") ?? []).length
      + (grouped.get("district") ?? []).length;
    const refs = visibleTargets.map((t) => t.entity_id).filter((x): x is string => !!x);

    const bodyParts: string[] = [];
    bodyParts.push(plan.summary ?? `${plan.victory_id} 爆发点 T${plan.burst_turn}`);
    bodyParts.push("", "【硬门】");
    for (const cat of ["tech", "civic", "project", "district", "building", "policy", "government", "unit"]) {
      const list = grouped.get(cat);
      if (!list?.length) continue;
      bodyParts.push(`${cat}: ${list.slice(0, 12).map(targetLine).join("；")}${list.length > 12 ? " …" : ""}`);
    }
    const metrics = grouped.get("metric") ?? [];
    if (metrics.length) {
      bodyParts.push("", "【指标】");
      bodyParts.push(metrics.slice(0, 12).map(targetLine).join("；"));
    }
    if (budgets.length) {
      bodyParts.push("", "【预算】");
      bodyParts.push(budgets.map((b) => `${b.currency} 收入${fmt(b.income)}/支出${fmt(b.expense)}/净${fmt(b.net)}`).join("；"));
    }
    if (checks.length) {
      bodyParts.push("", "【检查点】");
      bodyParts.push(checks.slice(0, 5).map((c) => c.message + (c.remedy ? ` → ${c.remedy}` : "")).join("；"));
    }
    if (closureTargets.length) {
      const closureTech = closureTargets.filter((t) => t.category === "tech").length;
      const closureCivic = closureTargets.filter((t) => t.category === "civic").length;
      bodyParts.push("", `前置闭包：科技 ${closureTech} 项 / 市政 ${closureCivic} 项（detail=full 展开）`);
    }
    bodyParts.push("", `硬门 ${blocking} 项；来源 ${source}；T${plan.burst_turn}；${plan.speed}/${plan.difficulty}`);

    const vName = victoryNames.get(plan.victory_id) ?? plan.victory_id;
    cards.push({
      cardId: `card:${plan.plan_id}:burst`,
      planId: plan.plan_id,
      kind: "burst",
      victoryId: plan.victory_id,
      eraId: plan.burst_era,
      civId: null,
      title: `${vName} 爆发点 T${plan.burst_turn}`,
      body: bodyParts.join("\n"),
      refs,
      sourceFlag: "derived",
      confidence: 0.7,
    });

    for (const era of kb.all<{ era_id: string; turn_lo: number; turn_hi: number }>(
      `SELECT DISTINCT era_id, turn_lo, turn_hi FROM kb_target
        WHERE plan_id = ? AND slice_kind = 'era' ORDER BY turn_lo;`,
      plan.plan_id,
    )) {
      const rows = kb.all<TargetRow>(
        `SELECT category, entity_id, dimension_id, op, value_num, value_lo, value_hi, unit, role,
                label_zh, rationale, formula, check_hint, remedy
           FROM kb_target WHERE plan_id = ? AND slice_kind = 'era' AND era_id = ?
          ORDER BY category, priority;`,
        plan.plan_id,
        era.era_id,
      );
      const g = groupTargets(rows);
      const eName = eraNames.get(era.era_id) ?? era.era_id;
      const parts: string[] = [`${vName} / ${eName} / T${era.turn_lo}-${era.turn_hi}`];
      const m = g.get("metric") ?? [];
      if (m.length) parts.push("指标: " + m.map(targetLine).join("；"));
      for (const cat of ["tech", "civic", "policy", "district", "building"]) {
        const list = g.get(cat);
        if (list?.length) parts.push(`${cat}: ${list.map(targetLine).join("；")}`);
      }
      cards.push({
        cardId: `card:${plan.plan_id}:era:${era.era_id}`,
        planId: plan.plan_id,
        kind: "era",
        victoryId: plan.victory_id,
        eraId: era.era_id,
        civId: null,
        title: `${vName} ${eName} 阶段目标`,
        body: parts.join("\n"),
        refs: rows.map((t) => t.entity_id).filter((x): x is string => !!x),
        sourceFlag: "empirical",
        confidence: 0.5,
      });
    }

    const allChecks = kb.all<CheckRow>(
      `SELECT turn_lo, turn_hi, dimension_id, value_lo, value_hi, message, remedy, severity
         FROM kb_check WHERE plan_id = ? ORDER BY priority, turn_lo;`,
      plan.plan_id,
    );
    if (allChecks.length) {
      cards.push({
        cardId: `card:${plan.plan_id}:check`,
        planId: plan.plan_id,
        kind: "check",
        victoryId: plan.victory_id,
        eraId: null,
        civId: null,
        title: `${vName} 检查清单`,
        body: allChecks.map((c) => `- ${c.message}${c.remedy ? ` → ${c.remedy}` : ""}`).join("\n"),
        refs: [],
        sourceFlag: "derived",
        confidence: 0.6,
      });
    }
  }

  // Objective cards: the reasoning skeleton (constraints -> path -> era focus).
  if (kb.hasTable("kb_objective")) {
    for (const o of kb.all<{
      objective_id: string; victory_id: string; civ_id: string | null; leader_id: string | null;
      speed: string; burst_turn: number; burst_era: string; title: string | null;
    }>(
      `SELECT objective_id, victory_id, civ_id, leader_id, speed, burst_turn, burst_era, title
         FROM kb_objective ORDER BY objective_id;`,
    )) {
      const parts: string[] = [];
      parts.push(o.title ?? o.objective_id);
      parts.push(`目标：T${o.burst_turn} / ${o.speed}`);
      const constraints = kb.all<{
        metric: string; required: number; supply_rate: number; tightness: number;
        binding_rank: number | null; waived_by: string | null;
      }>(
        `SELECT metric, required, supply_rate, tightness, binding_rank, waived_by
           FROM kb_constraint WHERE objective_id = ? ORDER BY COALESCE(binding_rank, 99);`,
        o.objective_id,
      );
      if (constraints.length) {
        parts.push("", "【约束方程】");
        for (const c of constraints.slice(0, 6)) {
          parts.push(
            `${c.metric}: 需求 ${fmt(c.required)} / 供给 ${fmt(c.supply_rate)}/回合 → 紧张度 ${fmt(c.tightness)}` +
              (c.binding_rank ? `（绑定 #${c.binding_rank}）` : "") +
              (c.waived_by ? "（已由文明能力取消）" : ""),
          );
        }
      }
      const onPath = kb.all<{ kind: string; id: string; label_zh: string | null }>(
        `SELECT n.kind, n.id, k.label_zh FROM kb_path_node n
           LEFT JOIN kb_node k ON k.kind = n.kind AND k.id = n.id
          WHERE n.objective_id = ? AND n.role = 'on_path'
            AND n.kind IN ('tech','civic','unit','district','building','policy','government')
          ORDER BY n.era_due, n.depth DESC LIMIT 10;`,
        o.objective_id,
      );
      if (onPath.length) parts.push("", "【在路径】", onPath.map((n) => n.label_zh ?? n.id).join(" → "));
      const dead = kb.all<{ id: string; why: string | null }>(
        `SELECT id, why FROM kb_path_node WHERE objective_id = ? AND role = 'dead' LIMIT 6;`,
        o.objective_id,
      );
      if (dead.length) parts.push("", "【死路】", dead.map((d) => `${d.id}（${d.why ?? ""}）`).join("；"));
      const detour = kb.all<{ group_id: string | null }>(
        `SELECT DISTINCT group_id FROM kb_path_node WHERE objective_id = ? AND role = 'detour';`,
        o.objective_id,
      );
      if (detour.length) {
        const priced = parseJsonSafe(
          kb.get<{ detour_cost: string | null }>(
            `SELECT detour_cost FROM kb_path WHERE objective_id = ?;`,
            o.objective_id,
          )?.detour_cost,
        );
        parts.push(
          "",
          "【绕路】",
          detour
            .map((d) => `${d.group_id ?? "misc"}（${JSON.stringify(priced[d.group_id ?? "misc"] ?? {})}）`)
            .join("；"),
        );
      }
      const focus = kb.all<{
        era_id: string; rank: number; ref_label: string | null; why: string | null; abandon_if: string | null;
      }>(
        `SELECT era_id, rank, ref_label, why, abandon_if FROM kb_era_focus
          WHERE objective_id = ? ORDER BY era_index, rank;`,
        o.objective_id,
      );
      if (focus.length) {
        parts.push("", "【时代焦点】");
        for (const f of focus.slice(0, 9)) {
          parts.push(`${f.era_id} #${f.rank} ${f.ref_label ?? ""}：${f.why ?? ""}${f.abandon_if ? `（放弃：${f.abandon_if}）` : ""}`);
        }
      }
      cards.push({
        cardId: `card:${o.objective_id}:why`,
        planId: `${o.victory_id}:${source}`,
        kind: "why",
        victoryId: o.victory_id,
        eraId: o.burst_era,
        civId: o.civ_id,
        title: `${o.title ?? o.objective_id} · 推理切面`,
        body: parts.join("\n").slice(0, 1800),
        refs: onPath.slice(0, 12).map((n) => n.id),
        sourceFlag: "derived",
        confidence: 0.6,
      });
    }
  }

  const civs = kb.all<CivRow>(
    `SELECT civ_id, leader_id, name_zh, name_en, unique_unit, unique_building, unique_district,
            unique_improvement, playstyle_tags, supported_victories, summary
       FROM kb_civ_profile WHERE source = ? ORDER BY civ_id, leader_id;`,
    source,
  );
  for (const civ of civs) {
    const deltas = kb.all<{ target_ref: string; op: string; value_num: number | null; value_text: string | null; reason: string | null }>(
      `SELECT target_ref, op, value_num, value_text, reason FROM kb_civ_delta
        WHERE source = ? AND civ_id = ? AND (leader_id = ? OR leader_id = '') ORDER BY delta_id;`,
      source,
      civ.civ_id,
      civ.leader_id,
    );
    const parse = (raw: string | null): string[] => {
      if (!raw) return [];
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.map(String) : [];
      } catch {
        return [];
      }
    };
    const parts: string[] = [];
    parts.push(civ.summary ?? `${civ.name_zh ?? civ.civ_id} 基本盘`);
    const uniques = [
      ...parse(civ.unique_unit).map((x) => `特色单位 ${x}`),
      ...parse(civ.unique_building).map((x) => `特色建筑 ${x}`),
      ...parse(civ.unique_district).map((x) => `特色区域 ${x}`),
      ...parse(civ.unique_improvement).map((x) => `特色改良 ${x}`),
    ];
    if (uniques.length) parts.push(uniques.slice(0, 6).join("；"));
    const supported = parse(civ.supported_victories);
    if (supported.length) parts.push(`推荐胜利线：${supported.join("/")}`);
    if (deltas.length) {
      parts.push("计划修正：" + deltas.map((d) => `${d.reason ?? d.target_ref} (${d.op}${d.value_num !== null ? " " + fmt(d.value_num) : ""})`).join("；"));
    }
    cards.push({
      cardId: `card:civ:${civ.civ_id}:${civ.leader_id || "any"}`,
      planId: null,
      kind: "civ",
      victoryId: null,
      eraId: null,
      civId: civ.civ_id,
      title: `${civ.name_zh ?? civ.civ_id} 基本盘`,
      body: parts.join("\n"),
      refs: [...parse(civ.unique_unit), ...parse(civ.unique_building), ...parse(civ.unique_district)],
      sourceFlag: deltas.length ? "empirical" : "derived",
      confidence: deltas.length ? 0.7 : 0.5,
    });
  }

  const cardStmt = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_card (card_id, plan_id, kind, victory_id, era_id, civ_id, title, body, refs, source_flag, confidence, built_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?);`,
  );
  const docStmt = kb.db.prepare(
    `INSERT OR REPLACE INTO search_docs (id, type, name, name_zh, doc, meta) VALUES (?,?,?,?,?,?);`,
  );
  kb.begin();
  try {
    for (const c of cards) {
      cardStmt.run(c.cardId, c.planId, c.kind, c.victoryId, c.eraId, c.civId, c.title, c.body,
        JSON.stringify(c.refs), c.sourceFlag, c.confidence, builtAt);
      docStmt.run(c.cardId, "card", c.title, c.title, `${c.title}\n${c.body}`,
        JSON.stringify({ kind: c.kind, victoryId: c.victoryId, eraId: c.eraId, civId: c.civId }));
    }
  } finally {
    kb.commit();
  }
  return { cards: cards.length };
}
