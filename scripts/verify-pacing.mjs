import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KnowledgeDb } from "../src/db.ts";
import { buildPaceFunctionSet } from "../src/pacing/api.ts";
import { buildPacing } from "../src/pacing/engine.ts";
import { evaluatePacingFormula, validatePaceFormula } from "../src/pacing/evaluate.ts";
import { buildPacingFormula } from "../src/pacing/formula.ts";
import { makePacingFunctions } from "../src/pacing/functions.ts";
import { decodePaceHandle, encodePaceHandle } from "../src/pacing/handle.ts";
import { renderPacingModule } from "../src/pacing/module.ts";
import { verifyPacing } from "../src/pacing/verify.ts";

/**
 * Pacing baseline certificate suite.
 *
 * The point of this script is not "the numbers look nice" — it is that every
 * fixture either yields a plan whose certificate passes, or fails with a
 * structured blocker. A run that silently produces a partial plan is a bug.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (process.env.CIVI6_SOURCE ?? "vanilla").trim();
const dbFile =
  process.env.CIVI6_DB_PATH?.trim() ||
  join(root, "data", source === "bbg" ? "civi6-bbg.sqlite" : "civi6.sqlite");
const civs = (process.env.CIVI6_PACE_CIVS ?? "CIVILIZATION_ROME,CIVILIZATION_KOREA")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const victories = ["science", "culture", "religion", "domination", "diplomatic"];
const speeds = ["standard", "online"];

if (!existsSync(dbFile)) {
  console.error(`✗ 知识库不存在：${dbFile}\n  先运行 npm run build`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    pass += 1;
  } catch (error) {
    fail += 1;
    failures.push({ label, message: error.message });
    console.log(`  ✗ ${label}\n      ${error.message}`);
  }
}

function stable(result) {
  const copy = JSON.parse(JSON.stringify(result));
  if (copy.provenance) delete copy.provenance.generatedAt;
  return JSON.stringify(copy);
}

const kb = new KnowledgeDb(dbFile);
try {
  console.log(`Pacing 证书套件（${source} / ${dbFile}）`);
  const results = new Map();

  for (const speed of speeds) {
    for (const civ of civs) {
      for (const victory of victories) {
        const key = `${speed}:${civ}:${victory}`;
        let result;
        try {
          result = buildPacing(kb, { source, civId: civ, victoryId: victory, speed, root });
        } catch (error) {
          check(key, () => {
            throw error;
          });
          continue;
        }
        results.set(key, result);
        check(`${key} 证书`, () => {
          const verification = verifyPacing(result);
          assert.ok(verification.ok, verification.issues.slice(0, 4).join(" | "));
        });
        check(`${key} 结构`, () => {
          assert.ok(result.schema === "civi6.pacing/v1", "schema");
          assert.ok(result.basis.totalTurns > 0, "totalTurns");
          assert.ok(result.milestones.length > 0, "milestones");
          assert.ok(result.actions.length > 0, "actions");
          assert.ok(result.baseline.referenceTurn > 0, "referenceTurn");
          if (result.baseline.feasible) {
            assert.ok(result.baseline.turn !== null, "feasible 但无 turn");
            assert.ok(result.baseline.turn <= result.basis.totalTurns + 5, "turn 超出速度回合上限");
          } else {
            assert.ok(
              result.baseline.blockers.some((b) => b.kind === "terminal" || b.kind === "target"),
              "不可行但没有 terminal/target blocker",
            );
          }
        });
      }
    }
  }

  // Science is the fully-certified line: it must be feasible at both speeds.
  for (const speed of speeds) {
    const key = `${speed}:${civs[0]}:science`;
    check(`${key} 必须可行`, () => {
      const result = results.get(key);
      assert.ok(result, "缺少结果");
      assert.ok(result.baseline.feasible, result.baseline.blockers.map((b) => b.message).join(" | "));
    });
  }

  // Determinism: same input -> byte-identical payload (generatedAt excluded).
  const first = results.get(`standard:${civs[0]}:science`);
  if (first) {
    const second = buildPacing(kb, { source, civId: civs[0], victoryId: "science", speed: "standard", root });
    check("确定性（同输入同输出）", () => assert.equal(stable(second), stable(first)));
  }

  // Speed invariant: costs and turns both scale, so online must be shorter and
  // may not undercut half of the standard burst (growth itself is not scaled).
  for (const civ of civs) {
    const standard = results.get(`standard:${civ}:science`);
    const online = results.get(`online:${civ}:science`);
    if (!standard?.baseline.feasible || !online?.baseline.feasible) continue;
    check(`${civ} 速度恒等式`, () => {
      const s = standard.baseline.burstTurn;
      const o = online.baseline.burstTurn;
      assert.ok(o < s, `online(${o}) 应早于 standard(${s})`);
      assert.ok(o >= Math.floor(s * 0.5) - 5, `online(${o}) 不应早于标准的一半(${Math.floor(s * 0.5)})`);
      assert.ok(Math.abs(online.basis.costMultiplier - 0.5) < 1e-9, "online 成本倍率应为 0.5");
    });
  }

  // Calibration is a watch metric, not a gate: report the delta against the
  // authored plan band so drift is visible instead of silent.
  for (const civ of civs) {
    const result = results.get(`standard:${civ}:science`);
    if (!result?.baseline.feasible) continue;
    check(`${civ} 校准报告`, () => {
      const burst = result.baseline.burstTurn;
      const ref = result.baseline.referenceTurn;
      assert.ok(burst !== null);
      assert.ok(burst >= ref * 0.5, `burst(${burst}) 与参考(${ref}) 偏差过大`);
      console.log(`      · ${civ} 科技 burst=${burst} / 参考=${ref} / Δ=${burst - ref}`);
    });
  }

  // Uncertified lines must say why they cannot be certified.
  const culture = results.get(`standard:${civs[0]}:culture`);
  check("未建模线给出结构化阻断", () => {
    assert.ok(culture, "缺少 culture 结果");
    if (!culture.baseline.feasible) {
      assert.ok(culture.baseline.blockers.some((b) => b.kind === "terminal"), "culture 缺 terminal blocker");
      assert.ok(
        culture.baseline.blockers.some((b) => /tourism|urism|旅游/.test(b.detail ?? "")),
        "culture 阻断应指向旅游来源",
      );
    }
  });

  // Explicit target inversion: an unreachable target must be rejected, not
  // silently re-planned around.
  const target = buildPacing(kb, {
    source,
    civId: civs[0],
    victoryId: "science",
    speed: "standard",
    targetTurn: 120,
    root,
  });
  check("目标回合不可行时显式拒绝", () => {
    assert.equal(target.baseline.feasible, false);
    assert.ok(target.baseline.blockers.some((b) => b.kind === "target"), "缺 target blocker");
  });

  // Strict assurance must not be better than standard.
  const strict = buildPacing(kb, {
    source,
    civId: civs[0],
    victoryId: "science",
    speed: "standard",
    assurance: "strict",
    root,
  });
  check("strict 档不优于 standard 档", () => {
    if (strict.baseline.feasible) {
      assert.ok(
        strict.baseline.turn >= (results.get(`standard:${civs[0]}:science`)?.baseline.turn ?? 0),
        "strict 不应比 standard 更快",
      );
    } else {
      assert.ok(strict.baseline.blockers.length > 0, "strict 不可行但无 blocker");
    }
  });
  // ---- function module: the actual product surface ---------------------
  //
  // The JSON result is an IR; consumers are promised a callable function set.
  // These checks import the generated module and compare it against the
  // in-process evaluator at boundary and sample turns.
  const moduleDir = mkdtempSync(join(tmpdir(), "civi6-pace-"));
  let moduleSeq = 0;
  const CHECK_KEYS = ["science", "culture", "gold", "production", "food", "faith", "tourism", "cities", "population"];
  try {
    for (const [key, result] of results) {
      const sourceCode = renderPacingModule(result);
      check(`${key} 模块自包含`, () => {
        assert.ok(!/^\s*import\s/m.test(sourceCode), "模块含 import");
        assert.ok(!/\brequire\s*\(/.test(sourceCode), "模块含 require");
        assert.ok(sourceCode.includes("export default api"), "模块缺 default export");
      });
      check(`${key} 公式模块体积`, () => {
        assert.ok(sourceCode.length <= 40000, `模块 ${sourceCode.length}B 超过 40KB 预算`);
      });
      check(`${key} 无内嵌轨迹`, () => {
        assert.ok(!/"series"\s*:/.test(sourceCode), "模块仍内嵌 series");
        assert.ok(!/const DATA\s*=/.test(sourceCode), "模块仍内嵌完整结果 DATA");
      });
      check(`${key} 模块确定性`, () => assert.equal(renderPacingModule(result), sourceCode));

      const file = join(moduleDir, `m${moduleSeq++}.mjs`);
      writeFileSync(file, sourceCode, "utf8");
      let mod = null;
      let importError = null;
      try {
        mod = await import(pathToFileURL(file).href);
      } catch (error) {
        importError = error;
      }
      check(`${key} 模块可导入`, () => {
        if (importError) throw importError;
        assert.ok(mod?.default, "缺 default export");
        for (const fn of CHECK_KEYS) assert.equal(typeof mod.default[fn], "function", `缺函数 ${fn}`);
        for (const fn of ["rate", "state", "research", "civic", "builds", "actionsAt", "milestonesUntil", "nextMilestone"]) {
          assert.equal(typeof mod.default[fn], "function", `缺函数 ${fn}`);
        }
        assert.ok(mod.default.formula && mod.default.formula.schema === "civi6.pacing/formula/v1", "缺 formula 基");
        assert.equal(mod.default.data, undefined, "data 应已移除（用 --format=json）");
      });
      if (!mod) continue;

      const lib = makePacingFunctions(result);
      const T = lib.T;
      check(`${key} 全回合 parity（0..T+10）`, () => {
        const dims = ["science", "culture", "gold", "production", "food", "faith", "tourism"];
        let maxCum = 0;
        let maxRate = 0;
        for (let t = 0; t <= T + 10; t++) {
          for (const dim of dims) {
            maxCum = Math.max(maxCum, Math.abs(lib[dim](t) - mod.default[dim](t)));
            maxRate = Math.max(maxRate, Math.abs(lib.rate(t)[dim] - mod.default.rate(t)[dim]));
          }
          assert.equal(mod.default.cities(t), lib.cities(t), `cities(${t})`);
          assert.equal(mod.default.population(t), lib.population(t), `population(${t})`);
        }
        assert.ok(maxCum <= 1e-6, `累计最大误差 ${maxCum}`);
        assert.ok(maxRate <= 1e-6, `速率最大误差 ${maxRate}`);
      });
      check(`${key} 动作/里程碑派生一致`, () => {
        const turns = [1, Math.max(1, Math.floor(T / 2)), T];
        for (const t of turns) {
          assert.equal(mod.default.research(t)?.id ?? null, lib.research(t)?.id ?? null, `research(${t})`);
          assert.equal(mod.default.civic(t)?.id ?? null, lib.civic(t)?.id ?? null, `civic(${t})`);
          assert.equal(mod.default.actionsAt(t).length, lib.actionsAt(t).length, `actions(${t})`);
          assert.equal(mod.default.milestonesUntil(t).length, lib.milestonesUntil(t).length, `milestones(${t})`);
          assert.equal(mod.default.nextMilestone(t)?.id ?? null, lib.nextMilestone(t)?.id ?? null, `next(${t})`);
        }
        const first = lib.milestonesUntil(T)[0];
        const got = mod.default.milestonesUntil(T)[0];
        if (first) {
          assert.equal(got.id, first.id);
          assert.equal(got.cost, first.cost);
          assert.equal(got.role, first.role);
          assert.equal(got.latestTurn, first.latestTurn);
          assert.equal(got.slack, first.slack);
          assert.equal(got.why, first.why);
        }
      });
      check(`${key} 模块边界语义`, () => {
        assert.equal(mod.default.science(0), 0);
        try {
          mod.default.science(Number.NaN);
          assert.fail("NaN 应抛 TypeError");
        } catch (error) {
          assert.ok(error instanceof TypeError, `NaN 应抛 TypeError，得到 ${error}`);
        }
        if (T > 0) {
          assert.ok(Math.abs(mod.default.science(T + 10) - mod.default.science(T)) < 1e-9, "t>T 应取末值");
        }
      });
    }
  } finally {
    rmSync(moduleDir, { recursive: true, force: true });
  }

  // ---- data-oriented function-set API + evaluator ----------------------
  //
  // `buildPaceFunctionSet` is the tool-facing contract: exact ids in, formula
  // out. `evaluatePacingFormula` is the executor surface. Both must agree with
  // the generated module turn by turn, and the request must fail closed on
  // names, ambiguous leaders and city-states.
  const sample = results.get(`online:${civs[0]}:science`) ?? results.get(`standard:${civs[0]}:science`);
  if (!sample) {
    check("pace 函数集样本存在", () => {
      throw new Error("缺少 science 结果，无法验证函数集 API");
    });
  } else {
    const sampleCiv = sample.civ.civId;
    const sampleLeader = sample.civ.leaderId;
    const sampleSpeed = sample.input.speed;
    let functionSet = null;
    check("buildPaceFunctionSet 与 buildPacingFormula 一致", () => {
      functionSet = buildPaceFunctionSet(kb, {
        source,
        civ: sampleCiv,
        leader: sampleLeader,
        speed: sampleSpeed,
        victory: "science",
        root,
      });
      assert.deepEqual(functionSet, buildPacingFormula(sample));
      assert.ok(JSON.stringify(functionSet).length <= 32000, `函数集 ${JSON.stringify(functionSet).length}B 超预算`);
    });

    check("名字/非法 id/非法 targetTurn fail closed", () => {
      assert.throws(
        () =>
          buildPaceFunctionSet(kb, {
            source,
            civ: "Korea",
            speed: sampleSpeed,
            victory: "science",
            root,
          }),
        /精确 id/,
      );
      assert.throws(
        () =>
          buildPaceFunctionSet(kb, {
            source,
            civ: sampleCiv,
            leader: "LEADER_SEONDEOK_FAKE",
            speed: sampleSpeed,
            victory: "science",
            root,
          }),
        /不属于/,
      );
      assert.throws(
        () =>
          buildPaceFunctionSet(kb, {
            source,
            civ: sampleCiv,
            leader: sampleLeader,
            speed: sampleSpeed,
            victory: "science",
            targetTurn: 0,
            root,
          }),
        /正整数/,
      );
    });

    check("多领袖文明必须显式传 leader", () => {
      const row = kb.get(
        `SELECT civ_id, COUNT(*) AS n FROM kb_civ_profile
          WHERE source = ? AND leader_id NOT LIKE 'LEADER_MINOR_CIV_%'
          GROUP BY civ_id HAVING n > 1 ORDER BY civ_id LIMIT 1;`,
        source,
      );
      assert.ok(row, "缺少多领袖文明样本");
      assert.throws(
        () =>
          buildPaceFunctionSet(kb, {
            source,
            civ: String(row.civ_id),
            speed: sampleSpeed,
            victory: "science",
            root,
          }),
        /多个领袖/,
      );
    });

    check("城邦/小文明不能作为基准主体", () => {
      const row = kb.get(
        `SELECT civ_id FROM kb_civ_profile WHERE source = ? AND leader_id LIKE 'LEADER_MINOR_CIV_%' ORDER BY civ_id LIMIT 1;`,
        source,
      );
      assert.ok(row, "缺少城邦样本");
      assert.throws(
        () =>
          buildPaceFunctionSet(kb, {
            source,
            civ: String(row.civ_id),
            speed: sampleSpeed,
            victory: "science",
            root,
          }),
        /城邦/,
      );
    });

    check("handle round-trip + 损坏拒绝", () => {
      const handle = encodePaceHandle({
        version: 1,
        source,
        civ: sampleCiv,
        leader: sampleLeader,
        speed: sampleSpeed,
        victory: "science",
        assurance: "standard",
        targetTurn: null,
        rawBuiltAt: "raw",
        kbBuiltAt: "kb",
      });
      assert.deepEqual(decodePaceHandle(handle), {
        version: 1,
        source,
        civ: sampleCiv,
        leader: sampleLeader,
        speed: sampleSpeed,
        victory: "science",
        assurance: "standard",
        targetTurn: null,
        rawBuiltAt: "raw",
        kbBuiltAt: "kb",
      });
      assert.throws(() => decodePaceHandle("pc1.bad"), /handle/);
      assert.throws(() => decodePaceHandle("nope"), /handle/);
    });

    check("functionSet 形状校验", () => {
      if (!functionSet) throw new Error("函数集未构建");
      validatePaceFormula(functionSet);
      assert.throws(() => validatePaceFormula({ ...functionSet, schema: "x" }), /schema/);
      assert.throws(() => validatePaceFormula(null), /对象/);
    });

    const evalDir = mkdtempSync(join(tmpdir(), "civi6-pace-eval-"));
    try {
      const file = join(evalDir, "fn.mjs");
      writeFileSync(file, renderPacingModule(sample), "utf8");
      let mod = null;
      let importError = null;
      try {
        mod = await import(pathToFileURL(file).href);
      } catch (error) {
        importError = error;
      }
      check("pace 函数集模块可导入", () => {
        if (importError) throw importError;
        assert.ok(mod?.default, "缺 default export");
      });
      if (mod && functionSet) {
        check("evaluator 全回合 parity（0..T+10）", () => {
          const T = functionSet.T;
          const dims = ["science", "culture", "gold", "production", "food", "faith", "tourism"];
          for (let t = 0; t <= T + 10; t++) {
            for (const dim of dims) {
              const cum = evaluatePacingFormula(functionSet, { fn: "cumulative", key: dim, t }).value;
              const rate = evaluatePacingFormula(functionSet, { fn: "rate", key: dim, t }).value;
              assert.ok(Math.abs(cum - mod.default[dim](t)) <= 1e-6, `cum ${dim}@${t}: ${cum} vs ${mod.default[dim](t)}`);
              assert.ok(
                Math.abs(rate - mod.default.rate(t)[dim]) <= 1e-6,
                `rate ${dim}@${t}: ${rate} vs ${mod.default.rate(t)[dim]}`,
              );
            }
            assert.equal(evaluatePacingFormula(functionSet, { fn: "cities", t }).value, mod.default.cities(t));
            assert.equal(evaluatePacingFormula(functionSet, { fn: "population", t }).value, mod.default.population(t));
          }
        });
        check("evaluator state/动作/里程碑 parity", () => {
          const T = functionSet.T;
          for (const t of [0, 1, Math.max(1, Math.floor(T / 2)), T, T + 10]) {
            assert.deepEqual(evaluatePacingFormula(functionSet, { fn: "state", t }).value, mod.default.state(t));
            assert.equal(
              evaluatePacingFormula(functionSet, { fn: "research", t }).value?.id ?? null,
              mod.default.research(t)?.id ?? null,
            );
            assert.equal(
              evaluatePacingFormula(functionSet, { fn: "civic", t }).value?.id ?? null,
              mod.default.civic(t)?.id ?? null,
            );
          }
          const page = evaluatePacingFormula(functionSet, { fn: "milestones", from: 1, to: T, limit: 100 }).value;
          assert.equal(page.total, mod.default.milestonesUntil(T).length, "里程碑总数不一致");
          const first = page.rows[0];
          const expected = mod.default.milestonesUntil(T)[0];
          if (expected) assert.deepEqual(first, expected);
        });
        check("evaluator 边界与调用校验", () => {
          assert.equal(evaluatePacingFormula(functionSet, { fn: "cumulative", key: "science", t: 0 }).value, 0);
          const beyond = evaluatePacingFormula(functionSet, { fn: "cumulative", key: "science", t: functionSet.T + 10 });
          assert.equal(beyond.clamped, true, "t>T 应标 clamped");
          assert.throws(() => evaluatePacingFormula(functionSet, { fn: "state" }), /t/);
          assert.throws(() => evaluatePacingFormula(functionSet, { fn: "nope" }), /未知 fn/);
          assert.throws(() => evaluatePacingFormula(functionSet, { fn: "milestones", limit: 0 }), /limit/);
          assert.throws(() => evaluatePacingFormula(functionSet, { fn: "baseline", t: 1 }), /不接受 t/);
          assert.throws(() => evaluatePacingFormula(functionSet, { fn: "milestone", id: "" }), /id/);
        });
      }
    } finally {
      rmSync(evalDir, { recursive: true, force: true });
    }
  }
} finally {
  kb.close();
}

console.log("");
if (fail) {
  console.log(`✗ ${fail} 项失败 / ${pass} 项通过`);
  for (const f of failures) console.log(`  - ${f.label}: ${f.message}`);
  process.exit(1);
}
console.log(`✓ ${pass} 项通过（0 失败）`);
