import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vanillaFile = process.env.CIVI6_DB_PATH?.trim() || join(root, "data", "civi6.sqlite");
const bbgFile = process.env.CIVI6_BBG_DB_PATH?.trim() || join(root, "data", "civi6-bbg.sqlite");
const requireBbg = process.argv.includes("--require-bbg");
const KB_TABLES = [
  "kb_dimension", "kb_victory", "kb_era_window", "kb_plan", "kb_target",
  "kb_budget", "kb_check", "kb_effect", "kb_cost", "kb_unlock", "kb_closure",
  "kb_civ_profile", "kb_civ_entity_map", "kb_civ_delta", "kb_derivation", "kb_card",
  "kb_speed_profile", "kb_node", "kb_objective", "kb_constraint", "kb_constraint_lever",
  "kb_path", "kb_path_node", "kb_era_focus", "kb_civ_capability",
  "kb_supply_source", "kb_ledger", "kb_cut", "kb_scenario", "kb_robustness",
];
const KB_VIEWS = ["v_kb_burst", "v_kb_ladder", "v_kb_civ_board", "v_kb_objective", "v_kb_path", "v_kb_focus", "v_kb_ledger"];
const ENTITY_TABLES = {
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

function open(file) {
  return new DatabaseSync(file, { readOnly: true });
}

function scalar(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    console.log(`  ✗ ${label}`);
    throw error;
  }
}

function checkKb(file, source) {
  if (!existsSync(file)) throw new Error(`数据库不存在：${file}\n请先运行 npm run build`);
  const db = open(file);
  try {
    console.log(`KB: ${file}`);
    for (const table of KB_TABLES) {
      check(`表存在 ${table}`, () => {
        assert.ok(
          scalar(db, "SELECT name FROM sqlite_master WHERE type='table' AND name = ?", table),
          `缺少 ${table}`,
        );
      });
    }
    for (const view of KB_VIEWS) {
      check(`视图存在 ${view}`, () => {
        assert.ok(
          scalar(db, "SELECT name FROM sqlite_master WHERE type='view' AND name = ?", view),
          `缺少 ${view}`,
        );
      });
    }
    check("总督归属视图存在", () => {
      assert.ok(
        scalar(db, "SELECT name FROM sqlite_master WHERE type='view' AND name = 'v_governor_promotion'"),
        "缺少 v_governor_promotion",
      );
    });
    check("总督归属视图覆盖全部晋升（含零归属）", () => {
      if (!scalar(db, "SELECT name FROM sqlite_master WHERE type='table' AND name = 'GovernorPromotions'")) return;
      const total = scalar(db, "SELECT COUNT(*) AS n FROM GovernorPromotions").n;
      const covered = scalar(db, "SELECT COUNT(DISTINCT promotion_id) AS n FROM v_governor_promotion").n;
      assert.equal(covered, total, `view=${covered} promotions=${total}`);
      // A promotion may legitimately have no set row (BBG deletes some). The
      // view must keep it with a NULL owner; the entity layer reports [] and
      // the answer must say "数据层未解析" instead of inferring from the id.
      const missing = db
        .prepare(
          `SELECT p.GovernorPromotionType AS id FROM GovernorPromotions p
             LEFT JOIN v_governor_promotion v ON v.promotion_id = p.GovernorPromotionType
            WHERE v.promotion_id IS NULL LIMIT 5;`,
        )
        .all();
      assert.equal(missing.length, 0, JSON.stringify(missing));
    });
    if (source === "bbg") {
      // BBG keeps vanilla promotion ids but reassigns ownership; this is the
      // regression that ID prefixes cannot answer.
      check("BBG 重分配：鉴赏家归 CARDINAL", () => {
        const rows = db
          .prepare(
            `SELECT governor_id FROM v_governor_promotion
              WHERE promotion_id = 'GOVERNOR_PROMOTION_EDUCATOR_CONNOISSEUR';`,
          )
          .all();
        assert.ok(rows.length >= 1, "鉴赏家没有归属行");
        assert.ok(
          rows.some((r) => r.governor_id === "GOVERNOR_THE_CARDINAL"),
          JSON.stringify(rows),
        );
        assert.ok(
          !rows.some((r) => r.governor_id === "GOVERNOR_THE_EDUCATOR"),
          JSON.stringify(rows),
        );
      });
      check("BBG 重分配：策展人归 CARDINAL", () => {
        const rows = db
          .prepare(
            `SELECT governor_id FROM v_governor_promotion
              WHERE promotion_id = 'GOVERNOR_PROMOTION_MERCHANT_CURATOR';`,
          )
          .all();
        assert.ok(
          rows.some((r) => r.governor_id === "GOVERNOR_THE_CARDINAL"),
          JSON.stringify(rows),
        );
      });
    }

    const validationRow = scalar(db, "SELECT value FROM _meta WHERE key = 'kb.validation'");
    assert.ok(validationRow?.value, "缺少 _meta.kb.validation");
    const validation = JSON.parse(validationRow.value);
    check("kb.validation.ok", () => assert.equal(validation.ok, true, JSON.stringify(validation.issues)));
    console.log(`  ✓ 校验: ${validation.ok ? "ok" : "fail"} / ${validation.errors} 错误 / ${validation.warnings} 警告`);

    const stats = {
      plans: scalar(db, "SELECT COUNT(*) AS n FROM kb_plan").n,
      targets: scalar(db, "SELECT COUNT(*) AS n FROM kb_target").n,
      budgets: scalar(db, "SELECT COUNT(*) AS n FROM kb_budget").n,
      checks: scalar(db, "SELECT COUNT(*) AS n FROM kb_check").n,
      cards: scalar(db, "SELECT COUNT(*) AS n FROM kb_card").n,
      effects: scalar(db, "SELECT COUNT(*) AS n FROM kb_effect").n,
      costs: scalar(db, "SELECT COUNT(*) AS n FROM kb_cost").n,
      unlocks: scalar(db, "SELECT COUNT(*) AS n FROM kb_unlock").n,
      closure: scalar(db, "SELECT COUNT(*) AS n FROM kb_closure").n,
      civs: scalar(db, "SELECT COUNT(*) AS n FROM kb_civ_profile").n,
      nodes: scalar(db, "SELECT COUNT(*) AS n FROM kb_node").n,
      objectives: scalar(db, "SELECT COUNT(*) AS n FROM kb_objective").n,
      focus: scalar(db, "SELECT COUNT(*) AS n FROM kb_era_focus").n,
      capabilities: scalar(db, "SELECT COUNT(*) AS n FROM kb_civ_capability").n,
      supplies: scalar(db, "SELECT COUNT(*) AS n FROM kb_supply_source").n,
      ledger: scalar(db, "SELECT COUNT(*) AS n FROM kb_ledger").n,
      cuts: scalar(db, "SELECT COUNT(*) AS n FROM kb_cut").n,
      scenarios: scalar(db, "SELECT COUNT(*) AS n FROM kb_scenario").n,
    };
    check("计划数量 >= 5", () => assert.ok(stats.plans >= 5, `plans=${stats.plans}`));
    check("目标数量 >= 300", () => assert.ok(stats.targets >= 300, `targets=${stats.targets}`));
    check("卡片数量 >= 50", () => assert.ok(stats.cards >= 50, `cards=${stats.cards}`));
    check("原子层非空", () => {
      assert.ok(stats.effects >= 300, `effects=${stats.effects}`);
      assert.ok(stats.costs >= 150, `costs=${stats.costs}`);
      assert.ok(stats.unlocks >= 300, `unlocks=${stats.unlocks}`);
      assert.ok(stats.closure >= 3000, `closure=${stats.closure}`);
      assert.ok(stats.nodes >= 100, `nodes=${stats.nodes}`);
    });

    // ---- v2 reasoning shape ------------------------------------------------
    if (stats.objectives > 0) {
      const objectives = db.prepare("SELECT objective_id, burst_era FROM kb_objective").all();
      for (const o of objectives) {
        const constraints = db
          .prepare("SELECT constraint_key, required, supply_rate, window, tightness, binding_rank, waived_by FROM kb_constraint WHERE objective_id = ?")
          .all(o.objective_id);
        check(`${o.objective_id}: 有约束`, () => assert.ok(constraints.length > 0, "无约束"));
        const onPath = scalar(
          db,
          "SELECT COUNT(*) AS n FROM kb_path_node WHERE objective_id = ? AND role = 'on_path'",
          o.objective_id,
        ).n;
        check(`${o.objective_id}: 有在路径节点`, () => assert.ok(onPath > 0, `on_path=${onPath}`));
        const focus = scalar(
          db,
          "SELECT COUNT(*) AS n FROM kb_era_focus WHERE objective_id = ?",
          o.objective_id,
        ).n;
        check(`${o.objective_id}: 有时代焦点`, () => assert.ok(focus > 0, `focus=${focus}`));
        check(`${o.objective_id}: 紧张度与公式一致`, () => {
          for (const c of constraints) {
            if (!(c.supply_rate > 0)) continue;
            const expect = c.required / (c.supply_rate * Math.max(1, c.window));
            assert.ok(Math.abs(expect - c.tightness) <= 0.02, `${c.constraint_key}: ${c.tightness} vs ${expect.toFixed(2)}`);
          }
        });
        check(`${o.objective_id}: 绑定排名按紧张度`, () => {
          const ranked = constraints.filter((c) => !c.waived_by && c.supply_rate > 0).sort((a, b) => b.tightness - a.tightness);
          ranked.forEach((c, i) => assert.equal(c.binding_rank, i + 1, `${c.constraint_key} rank=${c.binding_rank} expect=${i + 1}`));
        });
        check(`${o.objective_id}: 死路有原因且不进焦点`, () => {
          const dead = db
            .prepare("SELECT id, why FROM kb_path_node WHERE objective_id = ? AND role = 'dead'")
            .all(o.objective_id);
          const focusRefs = new Set(
            db.prepare("SELECT ref_id FROM kb_era_focus WHERE objective_id = ?").all(o.objective_id).map((r) => r.ref_id),
          );
          for (const d of dead) {
            assert.ok(d.why, `${d.id} 缺少 why`);
            assert.ok(!focusRefs.has(d.id), `${d.id} 出现在焦点里`);
          }
        });

        // ---- v3 ledger / cuts / scenarios -------------------------------
        const ledger = db
          .prepare("SELECT scenario_id, era_id, era_index, metric, required_cum, supply_cum, gap, verdict, window_turns FROM kb_ledger WHERE objective_id = ?")
          .all(o.objective_id);
        check(`${o.objective_id}: 账本自洽`, () => {
          assert.ok(ledger.length > 0, "没有账本行");
          for (const r of ledger) {
            assert.ok(Math.abs(r.gap - (r.required_cum - r.supply_cum)) <= 0.05, `${r.scenario_id}/${r.era_id}/${r.metric}: gap`);
            assert.equal(r.verdict, r.gap <= 0 ? "ok" : "short", `${r.metric}: verdict`);
            assert.ok(r.window_turns > 0, `${r.metric}: window`);
          }
        });
        check(`${o.objective_id}: 账本单调`, () => {
          const groups = new Map();
          for (const r of ledger) {
            const key = `${r.scenario_id}|${r.metric}`;
            const list = groups.get(key) ?? [];
            list.push(r);
            groups.set(key, list);
          }
          for (const [key, list] of groups) {
            const sorted = [...list].sort((a, b) => a.era_index - b.era_index);
            for (let i = 1; i < sorted.length; i++) {
              assert.ok(sorted[i].required_cum + 1e-6 >= sorted[i - 1].required_cum, `${key}: required 倒退`);
              assert.ok(sorted[i].supply_cum + 1e-6 >= sorted[i - 1].supply_cum, `${key}: supply 倒退`);
            }
          }
        });
        check(`${o.objective_id}: 情景含 base`, () => {
          const scenarios = db.prepare("SELECT scenario_id FROM kb_scenario WHERE objective_id = ?").all(o.objective_id);
          assert.ok(scenarios.length > 0, "没有情景");
          assert.ok(scenarios.some((s) => s.scenario_id === "base"), "缺 base");
        });
        check(`${o.objective_id}: 砍单可定位`, () => {
          const onPath = new Set(
            db.prepare("SELECT id FROM kb_path_node WHERE objective_id = ? AND role = 'on_path'").all(o.objective_id).map((r) => r.id),
          );
          const pathRow = scalar(db, "SELECT detour_cost FROM kb_path WHERE objective_id = ?", o.objective_id);
          const groups = pathRow?.detour_cost ? JSON.parse(pathRow.detour_cost) : {};
          for (const c of db.prepare("SELECT cut_kind, ref_id, group_id FROM kb_cut WHERE objective_id = ?").all(o.objective_id)) {
            if (c.cut_kind === "defer") assert.ok(onPath.has(c.ref_id), `defer ${c.ref_id} 不在 on_path`);
            if (c.cut_kind === "drop") assert.ok(c.group_id in groups, `drop ${c.group_id} 无价格`);
          }
        });
        check(`${o.objective_id}: 焦点带缺口`, () => {
          const n = scalar(db, "SELECT COUNT(*) AS n FROM kb_era_focus WHERE objective_id = ? AND ledger_gap IS NULL", o.objective_id).n;
          assert.equal(n, 0, `${n} 行缺少 ledger_gap`);
        });
      }
      check("焦点约束引用完整", () => {
        const bad = db
          .prepare(
            `SELECT f.objective_id, f.constraint_key FROM kb_era_focus f
              LEFT JOIN kb_constraint c ON c.constraint_key = f.constraint_key
             WHERE f.constraint_key IS NOT NULL AND c.constraint_key IS NULL LIMIT 5;`,
          )
          .all();
        assert.equal(bad.length, 0, JSON.stringify(bad));
      });
      check("供给来源可定位", () => {
        const tables = {
          building: ["Buildings", "BuildingType"],
          district: ["Districts", "DistrictType"],
          resource: ["Resources", "ResourceType"],
          policy: ["Policies", "PolicyType"],
          improvement: ["Improvements", "ImprovementType"],
          belief: ["Beliefs", "BeliefType"],
          governor: ["GovernorPromotions", "GovernorPromotionType"],
        };
        const cache = new Map();
        const has = (kind, id) => {
          const t = tables[kind];
          if (!t) return true;
          if (!cache.has(kind)) {
            cache.set(kind, new Set(db.prepare(`SELECT "${t[1]}" AS id FROM "${t[0]}"`).all().map((r) => String(r.id))));
          }
          return cache.get(kind).has(id);
        };
        for (const s of db.prepare("SELECT source_id, kind, ref_id FROM kb_supply_source").all()) {
          assert.ok(has(s.kind, s.ref_id), `${s.source_id}: ${s.kind}/${s.ref_id} 不在原始表`);
        }
      });
      check("kind=governor 的供给 ref 有归属", () => {
        if (!scalar(db, "SELECT name FROM sqlite_master WHERE type='table' AND name = 'GovernorPromotionSets'")) return;
        const orphans = db
          .prepare(
            `SELECT s.source_id, s.ref_id FROM kb_supply_source s
               LEFT JOIN GovernorPromotionSets gps ON gps.GovernorPromotion = s.ref_id
              WHERE s.kind = 'governor' AND gps.GovernorType IS NULL LIMIT 5;`,
          )
          .all();
        assert.equal(orphans.length, 0, JSON.stringify(orphans));
      });
    } else {
      console.log("  ! 没有目标层（kb/objectives 为空）");
    }

    // Every entity reference must exist in the raw mirror.
    const idSets = new Map();
    for (const [category, [table, pk]] of Object.entries(ENTITY_TABLES)) {
      const set = new Set();
      for (const r of db.prepare(`SELECT "${pk}" AS id FROM "${table}"`).all()) {
        if (r.id) set.add(String(r.id));
      }
      idSets.set(category, set);
    }
    const badRefs = db
      .prepare(
        `SELECT plan_id, category, entity_id FROM kb_target
          WHERE entity_id IS NOT NULL AND category IN (${Object.keys(ENTITY_TABLES).map(() => "?").join(",")});`,
      )
      .all(...Object.keys(ENTITY_TABLES))
      .filter((r) => !(idSets.get(r.category)?.has(r.entity_id) ?? true));
    check("target 实体引用完整", () => assert.equal(badRefs.length, 0, JSON.stringify(badRefs.slice(0, 5))));

    // Each plan has a burst slice and at least four era slices.
    const plans = db.prepare("SELECT plan_id, burst_turn FROM kb_plan").all();
    check("每个计划都有 burst", () => {
      for (const p of plans) {
        const n = scalar(db, "SELECT COUNT(*) AS n FROM kb_target WHERE plan_id = ? AND slice_kind = 'burst'", p.plan_id).n;
        assert.ok(n > 0, `${p.plan_id} 缺少 burst`);
      }
    });
    check("每个计划至少 4 个时代", () => {
      for (const p of plans) {
        const n = scalar(
          db,
          "SELECT COUNT(DISTINCT era_id) AS n FROM kb_target WHERE plan_id = ? AND slice_kind = 'era'",
          p.plan_id,
        ).n;
        assert.ok(n >= 4, `${p.plan_id} 只有 ${n} 个时代`);
      }
    });

    // Budget identity.
    check("预算恒等式", () => {
      const rows = db.prepare("SELECT plan_id, income, expense, net FROM kb_budget").all();
      for (const r of rows) {
        assert.ok(Math.abs(r.income - r.expense - r.net) <= 0.05, `${r.plan_id} 预算不平`);
      }
    });

    // The full space-race chain (DB-authoritative: 900 + 1500 + 4*1800 + 2100).
    const projectTotal = scalar(
      db,
      `SELECT SUM(Cost) AS n FROM Projects
        WHERE SpaceRace = 1 AND ProjectType NOT LIKE '%LASER%'
          AND ProjectType NOT IN ('PROJECT_TRAIN_ASTRONAUTS')`,
    ).n;
    check("航天项目合计 11700", () => assert.equal(projectTotal, 11700, `projectTotal=${projectTotal}`));

    // Known BBG/vanilla fingerprints used by verify-sources.mjs style checks.
    const param = scalar(db, "SELECT CostProgressionParam1 AS n FROM Districts WHERE DistrictType='DISTRICT_CAMPUS'").n;
    const workshop = scalar(db, "SELECT Cost AS n FROM Buildings WHERE BuildingType='BUILDING_WORKSHOP'").n;
    const techEra = scalar(
      db,
      "SELECT Value AS v FROM GlobalParameters WHERE Name='TECH_COST_PERCENT_CHANGE_AFTER_GAME_ERA'",
    ).v;
    console.log(`  · 指纹: campus progression=${param} / workshop=${workshop} / tech-era=${techEra}`);

    console.log(
      `  · 统计: ${stats.plans} 计划 / ${stats.targets} 目标 / ${stats.budgets} 预算 / ${stats.checks} 检查 / ${stats.cards} 卡片 / ${stats.civs} 文明`,
    );
    return stats;
  } finally {
    db.close();
  }
}

async function benchmark(file, source) {
  const { createKnowledgeBase } = await import(pathToFileURL(join(root, "dsh-plugin", "index.js")).href);
  const kb = createKnowledgeBase(file, source);
  try {
    for (let i = 0; i < 10; i++) kb.plan({ victory: "science" });
    const durations = [];
    let last = null;
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      last = kb.plan({ victory: "science" });
      durations.push(performance.now() - t0);
    }
    durations.sort((a, b) => a - b);
    const p50 = durations[50];
    const p95 = durations[95];
    const bytes = JSON.stringify(last).length;
    assert.ok(p95 < 50, `${source}: p95=${p95.toFixed(2)}ms > 50ms`);
    assert.ok(bytes < 12000, `${source}: payload=${bytes} > 12000`);
    const search = kb.search("科技胜利 爆发点", { scope: "plan", type: "card", full: true });
    assert.ok(search.count > 0, `${source}: plan search 无结果`);
    // v2 reasoning view: Byzantium + online must fit the 12k payload budget.
    let focusBytes = 0;
    try {
      const focus = kb.plan({
        victory: "domination",
        civ: "CIVILIZATION_BYZANTIUM",
        leader: "LEADER_BASIL",
        speed: "online",
        view: "focus",
      });
      focusBytes = JSON.stringify(focus).length;
      assert.ok(focus.objective, `${source}: focus 视图缺少 objective`);
      assert.ok(focus.objective.constraints?.length >= 3, `${source}: 约束不足`);
      assert.ok(focus.eras?.length >= 2, `${source}: 时代焦点不足`);
      assert.ok(focus.path?.dead?.length >= 1, `${source}: 死路未登记`);
      assert.ok(focus.budget?.length >= 3, `${source}: 账本缺失`);
      assert.ok(
        focus.budget.every((b) => typeof b.required === "number" && typeof b.supply === "number" && typeof b.gap === "number"),
        `${source}: 账本字段不全`,
      );
      assert.ok(focus.supply?.length >= 1, `${source}: 供给来源缺失`);
      assert.ok(focus.scenario?.some((s) => s.id === "base"), `${source}: 情景缺失`);
      assert.ok(Array.isArray(focus.cut), `${source}: 砍单缺失`);
      assert.ok(focusBytes < 12000, `${source}: focus payload=${focusBytes} > 12000`);
    } catch (error) {
      if (String(error.message).includes("目标层")) {
        console.log(`  ! ${source}: 无目标层，跳过 focus 基准`);
      } else {
        throw error;
      }
    }
    console.log(
      `  ✓ 基准 ${source}: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms payload=${bytes}B focus=${focusBytes}B search=${search.count}`,
    );
    return { p50, p95, bytes };
  } finally {
    kb.close();
  }
}

try {
  const vanilla = checkKb(vanillaFile, "vanilla");
  await benchmark(vanillaFile, "vanilla");

  if (!existsSync(bbgFile)) {
    if (requireBbg) throw new Error(`BBG 数据库不存在：${bbgFile}`);
    console.log(`\nBBG: 跳过（${bbgFile} 不存在；--require-bbg 可将其视为失败）`);
  } else {
    const bbg = checkKb(bbgFile, "bbg");
    await benchmark(bbgFile, "bbg");
    check("BBG 目标数量与 vanilla 同量级", () => {
      assert.ok(Math.abs(bbg.targets - vanilla.targets) <= 100, `${vanilla.targets} vs ${bbg.targets}`);
    });
    // The BBG raw mirror was copied from a vanilla build. If vanilla has been
    // rebuilt since, the BBG overlay should be rebuilt too; the running DSH
    // plugin may hold the file, so report it as a warning rather than a hard
    // failure here.
    const vdb = open(vanillaFile);
    const bdb = open(bbgFile);
    try {
      const vMeta = JSON.parse(scalar(vdb, "SELECT value FROM _meta WHERE key='build'").value);
      const bMeta = JSON.parse(scalar(bdb, "SELECT value FROM _meta WHERE key='build'").value);
      if (bMeta?.bbg?.baseBuiltAt && vMeta?.builtAt && bMeta.bbg.baseBuiltAt !== vMeta.builtAt) {
        console.log(
          `  ! BBG 基座时间戳与当前原版库不一致（base=${bMeta.bbg.baseBuiltAt} / vanilla=${vMeta.builtAt}）；` +
            `建议重启 DSH 后运行 npm run rebuild:bbg`,
        );
      }
    } finally {
      vdb.close();
      bdb.close();
    }
  }
  console.log("\n全部 KB 校验通过 ✅");
} catch (error) {
  console.error("\nKB 校验失败 ❌");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
