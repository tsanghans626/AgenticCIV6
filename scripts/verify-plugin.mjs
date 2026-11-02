import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apply, createKnowledgeBase, renderToolPayload } from "../dsh-plugin/index.js";
import { buildPacing, encodePaceHandle, makePacingFunctions, PACE_CALL_FNS } from "../dist/pacing/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbFile = process.env.CIVI6_BBG_DB_PATH?.trim() || join(root, "data", "civi6-bbg.sqlite");

const CLASSES = [
  "core",
  "tech-tree",
  "civic-tree",
  "units",
  "districts",
  "buildings",
  "tiles",
  "multipliers",
  "beliefs",
  "promotions",
  "governors",
];

/**
 * The session that motivated the class rewrite (17b596ad) spent 39 calls on a
 * per-entity drill-down. Every one of those entities must now be answerable from
 * the packet alone; this fixture is the regression gate for that.
 */
const SESSION_FIXTURE = [
  ["civilization", "CIVILIZATION_BYZANTIUM"],
  ["leader", "LEADER_BASIL"],
  ["district", "DISTRICT_HIPPODROME"],
  ["unit", "UNIT_BYZANTINE_TAGMA"],
  ["unit", "UNIT_BYZANTINE_DROMON"],
  ["belief", "BELIEF_JUST_WAR"],
  ["policy", "POLICY_WARS_OF_RELIGION"],
  // This trait has no text of its own: its mechanism is written in the Tagma's
  // description, so coverage is asserted through the owning unit.
  ["trait", "TRAIT_LEADER_UNIT_BYZANTINE_TAGMA", ["unit", "UNIT_BYZANTINE_TAGMA"]],
  ["trait", "TRAIT_CIVILIZATION_BYZANTIUM"],
  ["trait", "TRAIT_LEADER_BASIL"],
  ["building", "BUILDING_ARENA"],
  ["policy", "POLICY_CHIVALRY"],
  ["policy", "POLICY_GRANDE_ARMEE"],
  ["government", "GOVERNMENT_THEOCRACY"],
  ["building", "BUILDING_GOV_FAITH"],
  ["belief", "BELIEF_DIVINE_SPARK"],
  ["belief", "BELIEF_RELIGIOUS_SETTLEMENTS"],
  ["belief", "BELIEF_WORK_ETHIC"],
  ["belief", "BELIEF_CHORAL_MUSIC"],
  ["belief", "BELIEF_TITHE"],
  ["belief", "BELIEF_WORLD_CHURCH"],
  ["belief", "BELIEF_MEETING_HOUSE"],
  ["belief", "BELIEF_HOLY_ORDER"],
  ["policy", "POLICY_RELIGIOUS_ORDERS"],
  ["policy", "POLICY_SCRIPTURE"],
  ["policy", "POLICY_CONSCRIPTION"],
  ["policy", "POLICY_LEVEE_EN_MASSE"],
  ["policy", "POLICY_LOGISTICS"],
  ["government", "GOVERNMENT_OLIGARCHY"],
  ["government", "GOVERNMENT_MONARCHY"],
  ["government", "GOVERNMENT_FASCISM"],
  ["belief", "BELIEF_GOD_OF_WAR"],
  ["belief", "BELIEF_GOD_OF_THE_FORGE"],
  ["belief", "BELIEF_DEFENDER_OF_FAITH"],
  ["belief", "BELIEF_RELIGIOUS_UNITY"],
  ["belief", "BELIEF_ITINERANT_PREACHERS"],
  ["belief", "BELIEF_PAPAL_PRIMACY"],
  ["belief", "BELIEF_CROSS_CULTURAL_DIALOGUE"],
  ["belief", "BELIEF_STEWARDSHIP"],
];

function assertLossless(value) {
  const bad = [];
  const walk = (v, path) => {
    if (v === undefined) {
      bad.push(`${path}: undefined`);
      return;
    }
    if (typeof v === "number" && !Number.isFinite(v)) {
      bad.push(`${path}: ${v}`);
      return;
    }
    if (typeof v === "bigint" || typeof v === "symbol" || typeof v === "function") {
      bad.push(`${path}: ${typeof v}`);
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const key of Object.keys(v)) walk(v[key], `${path}.${key}`);
  };
  walk(value, "value");
  assert.deepEqual(bad, [], `非无损 JSON：${bad.slice(0, 5).join(", ")}`);
}

/** Row helper: read by column name instead of guessing a position. */
function rowOf(section, id) {
  if (!section) return undefined;
  return section.rows.find((row) => row[section.columns.indexOf("id")] === id);
}

function cell(section, row, name) {
  const index = section.columns.indexOf(name);
  return index < 0 ? undefined : row[index];
}

if (!existsSync(dbFile)) {
  console.log(`跳过：BBG 数据库不存在（${dbFile}）`);
  process.exit(0);
}

const kb = createKnowledgeBase(dbFile, "bbg");
try {
  const meta = kb.meta();
  const metaChars = JSON.stringify(meta).length;
  assert.equal(meta.ruleset?.id, "bbg", "ruleset.id 不是 bbg");
  assert.equal(meta.locked, true, "locked 不为 true");
  assert.ok(meta.effectCoverage?.cards > 0, "效果卡为空");
  assert.equal(meta.effectCoverage.stale, false, "效果层过期");
  assert.ok(metaChars < 6000, `meta 默认载荷 ${metaChars}B 仍过大（verbose 字段没有收进 verbose）`);
  // The entity-type inventory is a verbose-only maintenance view now; the
  // model-facing inventory is core.manifest.classes.
  assert.equal(meta.entityTypes, undefined, "entityTypes 仍在默认载荷里");
  assert.ok(kb.meta({ verbose: true }).entityTypes?.length > 0, "verbose 缺少 entityTypes");
  assertLossless(meta);
  console.log(`✓ meta：bbg / locked / effectCoverage / ${metaChars}B`);

  const workEthic = kb.entityDetail("belief", "BELIEF_WORK_ETHIC");
  assert.match(workEthic.description_zh, /神社和寺庙分别提供\+2和\+4/, workEthic.description_zh);
  assert.doesNotMatch(workEthic.description_zh, /每个信仰此宗教的居民/, workEthic.description_zh);
  assertLossless(workEthic);
  console.log("✓ belief Work Ethic 文本锁定为 BBG");

  const library = kb.entityDetail("building", "BUILDING_LIBRARY");
  const libraryText = (library.effects ?? []).map((e) => e.text).join("\n");
  assert.match(libraryText, /\+2 科技值/, libraryText);
  const libraryCost = (library.attributes ?? []).find((a) => a.key === "Cost")?.value;
  assert.equal(Number(libraryCost), 90, `Library Cost=${libraryCost}`);
  assertLossless(library);
  console.log("✓ 图书馆 +2 科技 / 90 锤");

  const pantheon = kb.listEntities("belief", { beliefClass: "BELIEF_CLASS_PANTHEON", effects: true, effectLimit: 2 });
  assert.equal(pantheon.total, 23, `pantheon total=${pantheon.total}`);
  assert.ok(pantheon.items.every((i) => i.effects?.length), "有万神殿缺少效果");
  assertLossless(pantheon);
  console.log("✓ 万神殿 23 条，均有效果");

  const search = kb.search("职业道德", { scope: "entity", type: "belief" });
  assert.equal(search.results[0]?.id, "belief:BELIEF_WORK_ETHIC", JSON.stringify(search.results[0]));
  assertLossless(search);
  console.log("✓ 检索：职业道德 → BELIEF_WORK_ETHIC");

  const plan = kb.plan({ victory: "science" });
  assert.equal(plan.plan.source, "bbg", "plan source 不是 bbg");
  assert.ok(plan.burst?.blocking?.length > 0, "plan 缺少 blocking");
  assertLossless(plan);
  console.log("✓ plan：science:bbg 切面可读");

  // The authored objective layer is retired: `focus` must now report "no
  // objective layer" instead of serving stale rows.
  const objectiveRows = kb.db.prepare("SELECT COUNT(*) AS n FROM kb_objective").get().n;
  assert.equal(objectiveRows, 0, "kb_objective 应为空（作者目标层已退役）");

  // --- instance: one data class per call, self-describing -------------------
  const baseArgs = { civ: "Russia", leader: "Peter", speed: "online", difficulty: "DIFFICULTY_DEITY" };
  const inst = kb.instance({ ...baseArgs, section: "all" });
  assert.equal(inst.instance.civ, "CIVILIZATION_RUSSIA", `instance.civ=${inst.instance.civ}`);
  assert.equal(inst.instance.speedProfile?.totalTurns, 250, "online 速度档缺失");
  assert.ok(inst.integrity.rows >= 1036, `内容行 ${inst.integrity.rows} 过少`);
  assert.equal(inst.content.technology.rows.length, 77, "科技行数不是 77");
  assert.equal(inst.content.civic.rows.length, 61, "市政行数不是 61");
  assert.equal(inst.meta.packetVersion, 3, `packetVersion=${inst.meta.packetVersion}`);

  // Every class carries `definition` (what it is) and `whenToUse` (when to ask
  // for it) as separate fields, and core.manifest repeats whenToUse verbatim.
  const corePage = kb.instance({ ...baseArgs, section: "core" });
  assert.ok(Array.isArray(corePage.manifest?.classes), "core 缺少 manifest.classes");
  assert.equal(corePage.manifest.classes.length, CLASSES.length, "manifest 类数不对");
  const sectionSizes = {};
  for (const name of CLASSES) {
    const page = kb.instance({ ...baseArgs, section: name });
    const entry = corePage.manifest.classes.find((c) => c.section === name);
    assert.ok(entry, `manifest 缺类 ${name}`);
    assert.ok(page.definition && page.definition.length >= 40 && page.definition.length <= 400, `${name}.definition 不合法`);
    assert.ok(page.whenToUse && page.whenToUse.length >= 20 && page.whenToUse.length <= 300, `${name}.whenToUse 不合法`);
    assert.notEqual(page.definition, page.whenToUse, `${name}: definition 与 whenToUse 混写`);
    assert.equal(entry.whenToUse, page.whenToUse, `${name}: manifest.whenToUse 与类载荷不一致`);
    assert.ok(entry.bytes > 0, `${name}: manifest 缺 bytes`);
    const text = renderToolPayload("instance", page);
    sectionSizes[name] = text.length;
    assert.ok(text.length <= 44000, `类 ${name} ${text.length} > 44000`);
    assert.ok(text.length < 50000, `类 ${name} ${text.length} 超过传输上限`);
    const parsed = JSON.parse(text);
    assert.equal(parsed.section, name, `类 ${name} section=${parsed.section}`);
  }
  assert.throws(
    () => kb.instance({ ...baseArgs, section: "content-a" }),
    /未知数据类/,
    "旧分片名没有报错",
  );
  console.log(
    `✓ instance 数据类：${CLASSES.length} 类 / ${inst.integrity.rows} 行 / 内联边 ${inst.integrity.inlineEdges} / ` +
      `文本 ${inst.integrity.effChars} 字 / 未解析行 ${inst.integrity.unresolvedRows}`,
  );
  console.log(`  体积 ${CLASSES.map((name) => `${name} ${(sectionSizes[name] / 1024).toFixed(1)}KB`).join(" · ")}`);

  // --- tech / civic tree structure ----------------------------------------
  for (const [tree, expected, edgesMin] of [
    ["technology", 77, 100],
    ["civic", 61, 70],
  ]) {
    const section = inst.content[tree];
    for (const column of ["req", "boost", "treeRow", "depth", "children", "unlocks", "eff"]) {
      assert.ok(section.columns.includes(column), `${tree} 缺列 ${column}`);
    }
    const edges = section.rows.reduce(
      (n, row) => n + (Array.isArray(cell(section, row, "children")) ? cell(section, row, "children").length : 0),
      0,
    );
    assert.ok(edges >= edgesMin, `${tree} 后继边 ${edges} 过少`);
    // children must be the exact inverse of req
    const parentEdges = new Set();
    for (const row of section.rows) {
      for (const parent of cell(section, row, "req") ?? []) parentEdges.add(`${parent}->${cell(section, row, "id")}`);
    }
    for (const row of section.rows) {
      for (const child of cell(section, row, "children") ?? []) {
        assert.ok(parentEdges.has(`${cell(section, row, "id")}->${child}`), `${tree} children 与 req 不一致：${child}`);
      }
    }
    const withUnlocks = section.rows.filter((row) => (cell(section, row, "unlocks") ?? []).length > 0).length;
    assert.ok(withUnlocks >= 20, `${tree} 只有 ${withUnlocks} 个节点有 unlocks`);
    assert.ok(section.rows.every((row) => Number.isInteger(cell(section, row, "depth"))), `${tree} depth 不是整数`);
    assert.ok(section.rows.every((row) => Number.isInteger(cell(section, row, "treeRow"))), `${tree} treeRow 不是整数`);
    console.log(
      `✓ ${tree === "technology" ? "科技" : "市政"}树：${section.rows.length} 节点 / 后继边 ${edges} / 有解锁 ${withUnlocks} / ` +
        `深度 ≤ ${Math.max(...section.rows.map((row) => cell(section, row, "depth")))}`,
    );
  }
  const divineRight = rowOf(inst.content.civic, "CIVIC_DIVINE_RIGHT");
  assert.ok(divineRight, "缺少 CIVIC_DIVINE_RIGHT");
  assert.match(String(cell(inst.content.civic, divineRight, "boost")), /寺庙/, "市政鼓舞文本未解析");

  // --- rows carry the authoritative text inline ---------------------------
  const unit = inst.content.unit;
  const tagma = rowOf(unit, "UNIT_BYZANTINE_TAGMA");
  assert.ok(tagma, "缺少 UNIT_BYZANTINE_TAGMA 行");
  assert.equal(cell(unit, tagma, "civic"), "CIVIC_DIVINE_RIGHT", `甲胄解锁市政=${cell(unit, tagma, "civic")}`);
  assert.ok(Number(cell(unit, tagma, "cs")) > 0, `甲胄战斗力=${cell(unit, tagma, "cs")}`);
  assert.match((cell(unit, tagma, "eff") ?? []).join(" "), /替代骑士/, "甲胄描述没有说明替代关系");
  assert.deepEqual(cell(unit, tagma, "replaces"), ["UNIT_KNIGHT"], `甲胄 replaces=${JSON.stringify(cell(unit, tagma, "replaces"))}`);
  const knight = rowOf(unit, "UNIT_KNIGHT");
  assert.ok((cell(unit, knight, "replacedBy") ?? []).includes("UNIT_BYZANTINE_TAGMA"), "骑士 replacedBy 缺甲胄");
  // `Units_XP2.ResourceCost` is a leftover on units that declare no strategic
  // resource; shipping it reads as a requirement, so it must be null.
  assert.equal(cell(unit, tagma, "res"), null, "甲胄不应有战略资源");
  assert.equal(cell(unit, tagma, "resq"), null, `甲胄 resq=${cell(unit, tagma, "resq")}（应为 null）`);
  assert.ok(cell(unit, knight, "resq") > 0, "骑士 resq 应保留");

  const hippodrome = rowOf(inst.content.district, "DISTRICT_HIPPODROME");
  assert.deepEqual(cell(inst.content.district, hippodrome, "replaces"), ["DISTRICT_ENTERTAINMENT_COMPLEX"]);
  const hippoBuildings = cell(inst.content.district, hippodrome, "buildings") ?? [];
  assert.ok(hippoBuildings.length >= 3, `跑马场继承建筑 ${hippoBuildings.length}`);

  const campus = rowOf(inst.content.district, "DISTRICT_CAMPUS");
  const campusText = (cell(inst.content.district, campus, "eff") ?? []).join(" ");
  assert.match(campusText, /相邻山脉/, `学院相邻文本：${campusText.slice(0, 120)}`);
  assert.doesNotMatch(campusText, /LOC_[A-Z0-9_]+/, "学院相邻文本仍有 LOC_ 残留");

  const oligarchy = rowOf(inst.content.government, "GOVERNMENT_OLIGARCHY");
  const govText = (cell(inst.content.government, oligarchy, "eff") ?? []).join(" ");
  assert.match(govText, /固有加成/, "政体缺固有加成文本");
  assert.match(govText, /积累加成/, "政体缺积累加成文本");
  const oligarchyFx = String(cell(inst.content.government, oligarchy, "fx"));
  assert.ok(oligarchyFx.length > 0, "寡头 fx 为空（真实效果被占位行挤掉了）");
  assert.match(oligarchyFx, /经验|移动力/, `寡头 fx 没有解析出真实效果：${oligarchyFx}`);

  const workEthicRow = rowOf(inst.content.belief, "BELIEF_WORK_ETHIC");
  assert.match((cell(inst.content.belief, workEthicRow, "eff") ?? []).join(" "), /神社和寺庙分别提供\+2和\+4/);

  const religionPolicy = rowOf(inst.content.policy, "POLICY_WARS_OF_RELIGION");
  assert.match((cell(inst.content.policy, religionPolicy, "eff") ?? []).join(" "), /\+4 战斗力/);

  // Mechanism-only formula rows must never reach `fx`; they are counted instead.
  for (const [kind, section] of Object.entries(inst.content)) {
    for (const row of section.rows) {
      const fx = cell(section, row, "fx");
      assert.ok(typeof fx === "string", `${kind}: fx 不是字符串`);
      assert.ok(!fx.startsWith("获得"), `${kind}:${cell(section, row, "id")} fx 是机制占位：${fx}`);
      assert.ok(!fx.includes("…"), `${kind}:${cell(section, row, "id")} fx 被截断：${fx}`);
      assert.ok(Number.isInteger(cell(section, row, "unres")), `${kind}: unres 不是整数`);
    }
  }
  console.log("✓ 行内文本：单位替代关系 / 区划相邻加成 / 政体固有+积累 / 信条与政策全文 / fx 无占位");

  // Session 17b596ad regression fixture: every drilled entity answers from the packet.
  const byzArgs = { civ: "Byzantium", leader: "Basil II", speed: "online" };
  const byz = kb.instance({ ...byzArgs, section: "all" });
  const byzCore = kb.instance({ ...byzArgs, section: "core" });
  const kitText = new Map(byzCore.civKit.map((item) => [`${item.kind}:${item.id}`, item.effects ?? []]));
  const missing = [];
  for (const [kind, id, via] of SESSION_FIXTURE) {
    if (via) {
      const target = rowOf(byz.content[via[0]], via[1]);
      if (target && (cell(byz.content[via[0]], target, "eff") ?? []).length > 0) continue;
      missing.push(`${kind}:${id} (via ${via.join(":")})`);
      continue;
    }
    if ((kitText.get(`${kind}:${id}`) ?? []).length > 0) continue;
    const section = byz.content[kind];
    const row = rowOf(section, id);
    const text = row ? cell(section, row, "eff") : undefined;
    const fx = row ? cell(section, row, "fx") : undefined;
    if ((Array.isArray(text) && text.length > 0) || fx) continue;
    missing.push(`${kind}:${id}`);
  }
  assert.deepEqual(missing, [], `会话夹具未覆盖：${missing.join(", ")}`);
  console.log(`✓ 会话夹具：17b596ad 的 ${SESSION_FIXTURE.length} 个实体全部可从包内回答`);

  // --- deterministic scratchpad -------------------------------------------
  const ev = kb.eval({ builds: ["BUILDING_LIBRARY"], cities: 3, popPerCity: 4, victory: "culture", speed: "standard" });
  const science = ev.metrics.find((m) => m.dimension === "science_per_turn");
  assert.equal(science?.supply, 6, `图书馆×3 科技供应=${science?.supply}`);
  assert.equal(science?.composition[0]?.id, "BUILDING_LIBRARY", "构成清单缺少来源");
  assert.ok(ev.demand.length > 0, "缺少计划带需求");
  assert.deepEqual(ev.missingBuilds, [], JSON.stringify(ev.missingBuilds));

  const evalPlan = kb.eval({
    builds: ["BUILDING_LIBRARY", "BUILDING_AMPHITHEATER", "BUILDING_MONUMENT"],
    gates: ["CIVIC_HUMANISM", "BUILDING_MUSEUM_ART"],
    cities: 6,
    popPerCity: 6,
    eraIndex: 3,
    eraId: "ERA_RENAISSANCE",
    victory: "culture",
    speed: "standard",
  });
  assert.ok(evalPlan.path?.closure >= 5, `前置闭包 ${evalPlan.path?.closure}`);
  assert.ok(evalPlan.ledger.length >= 2, `账本行 ${evalPlan.ledger.length}`);
  const cultureRow = evalPlan.ledger.find((r) => r.currency === "culture");
  assert.ok(cultureRow?.required > 0, "缺少文化需求");
  assert.equal(
    cultureRow?.gap,
    Math.round((cultureRow.requiredPerTurn - cultureRow.supplyPerTurn) * 100) / 100,
    "账本 gap 与 required/supply 不一致",
  );
  assert.ok(evalPlan.cut.length > 0 && evalPlan.cut[0].slipTurns !== undefined, "砍单缺少推迟估算");
  assert.equal(evalPlan.scenarios.length, 3, "情景不是 low/base/high 三档");
  assert.ok(evalPlan.deadline.era === "ERA_RENAISSANCE" && evalPlan.deadline.turn > 0, "截止回合缺失");
  assertLossless(evalPlan);
  console.log(
    `✓ eval：${ev.metrics.length} 维度 / 账本 ${evalPlan.ledger.length} 币种 / 砍单 ${evalPlan.cut.length} / 情景 3 / 闭包 ${evalPlan.path.closure}`,
  );

  // --- speed basis: every cost and deadline states its units --------------
  // The regression this pins: the same gate set used to return identical costs
  // and deadlines for standard and online, next to speedProfile.costMultiplier=50,
  // leaving the model to guess whether it still had to halve them.
  const gateSet = ["CIVIC_DIVINE_RIGHT", "CIVIC_REFORMED_CHURCH", "CIVIC_MERCENARIES"];
  const evalArgs = { builds: ["BUILDING_MONUMENT"], gates: gateSet, cities: 6, popPerCity: 8, eraId: "ERA_MEDIEVAL" };
  const evalStd = kb.eval({ ...evalArgs, speed: "standard" });
  const evalOnline = kb.eval({ ...evalArgs, speed: "online" });
  const stdRow = evalStd.ledger.find((r) => r.currency === "culture");
  const onlRow = evalOnline.ledger.find((r) => r.currency === "culture");
  const speedProfiles = kb.meta().speedProfiles;
  const onlineProfile = speedProfiles.find((s) => s.speed === "online");
  const standardProfile = speedProfiles.find((s) => s.speed === "standard");
  assert.ok(stdRow && onlRow, "缺少文化账本行");
  assert.equal(onlRow.required, stdRow.required / 2, `联机需求 ${onlRow.required} != 标准 ${stdRow.required} / 2`);
  assert.equal(
    onlRow.requiredPerTurn,
    stdRow.requiredPerTurn,
    "成本与回合同时折算时 requiredPerTurn 必须不变（双缩放校验）",
  );
  assert.equal(
    evalOnline.deadline.turn,
    Math.round((evalStd.deadline.turn * onlineProfile.totalTurns) / standardProfile.totalTurns),
    `联机截止回合 ${evalOnline.deadline.turn} 未按 totalTurns 比例压缩`,
  );
  assert.equal(evalOnline.path.totalCost.culture, evalStd.path.totalCost.culture / 2, "path.totalCost 未折算");
  assert.equal(evalOnline.cut[0].cost, evalStd.cut[0].cost / 2, "cut.cost 未折算");
  assert.equal(
    evalOnline.cut[0].slipTurns,
    Math.ceil(evalOnline.cut[0].cost / onlRow.supplyPerTurn),
    "slipTurns 必须用已折成本 ÷ 未折供给",
  );
  assert.equal(evalStd.basis.costMultiplier, standardProfile.costMultiplier / 100, "standard basis 倍数不对");
  assert.equal(evalOnline.basis.costMultiplier, onlineProfile.costMultiplier / 100, "online basis 倍数不对");
  assert.equal(evalOnline.basis.turnScale, onlineProfile.totalTurns / standardProfile.totalTurns, "turnScale 不对");
  assert.equal(evalOnline.basis.applied, true, "basis.applied 应为 true");
  assert.equal(evalOnline.assumptions.speed, "online", "assumptions 缺 speed");
  assert.equal(evalOnline.deadline.timeBasis, "online", "deadline 缺 timeBasis");

  // The same numbers must appear in the packet the model reads.
  const stdCivic = kb.instance({ civ: "Byzantium", leader: "Basil II", speed: "standard", section: "civic-tree" });
  const onlCivic = kb.instance({ civ: "Byzantium", leader: "Basil II", speed: "online", section: "civic-tree" });
  const civicCost = (page, id) => {
    const section = page.content.civic;
    return section.rows.find((row) => row[section.columns.indexOf("id")] === id)[section.columns.indexOf("cost")];
  };
  const stdCost = civicCost(stdCivic, "CIVIC_DIVINE_RIGHT");
  const onlCost = civicCost(onlCivic, "CIVIC_DIVINE_RIGHT");
  assert.equal(onlCost, stdCost / 2, `行内 cost 未按速度折算：${stdCost} → ${onlCost}`);
  const onlCore = kb.instance({ civ: "Byzantium", leader: "Basil II", speed: "online", section: "core" });
  assert.equal(onlCore.instance.costBasis.multiplier, onlineProfile.costMultiplier / 100, "core 缺 costBasis");
  assert.equal(onlCore.instance.costBasis.applied, true, "core.costBasis.applied 应为 true");

  // No silent defaults: an era-less deadline used to fall back to ERA_ANCIENT.
  assert.throws(
    () => kb.eval({ builds: ["BUILDING_MONUMENT"], gates: gateSet, speed: "online" }),
    /eraId/,
    "有 gates 但没给 eraId 时没有报错",
  );
  assert.throws(() => kb.eval({ builds: ["BUILDING_MONUMENT"], speed: "epic" }), /speed 未知/, "未知速度没有报错");
  console.log(
    `✓ 速度口径：成本 ×${evalStd.basis.costMultiplier}→×${evalOnline.basis.costMultiplier} / deadline ${evalStd.deadline.turn}→${evalOnline.deadline.turn} / requiredPerTurn 不变 / basis 与 meta 一致`,
  );

  // Governor ownership is a relation, not an id prefix. BBG keeps the vanilla
  // EDUCATOR id while reassigning the promotion to the Cardinal.
  const connoisseur = kb.entityDetail("governor_promotion", "GOVERNOR_PROMOTION_EDUCATOR_CONNOISSEUR");
  assert.ok(Array.isArray(connoisseur.governors), "缺少 governors[]");
  assert.ok(
    connoisseur.governors.some((g) => g.id === "GOVERNOR_THE_CARDINAL"),
    JSON.stringify(connoisseur.governors),
  );
  assert.equal(
    connoisseur.governors.find((g) => g.id === "GOVERNOR_THE_CARDINAL")?.name_zh,
    "莫克夏",
    "总督中文名不匹配",
  );
  assert.ok(
    !connoisseur.governors.some((g) => g.id === "GOVERNOR_THE_EDUCATOR"),
    JSON.stringify(connoisseur.governors),
  );
  assertLossless(connoisseur);
  console.log(`✓ governor_promotion：鉴赏家归属 ${connoisseur.governors.map((g) => g.id).join(",")}`);

  // BBG deletes this promotion's set row. The surface must say "no owner"
  // instead of falling back to the AMBASSADOR id prefix.
  const orphan = kb.entityDetail("governor_promotion", "GOVERNOR_PROMOTION_AMBASSADOR_EMISSARY");
  assert.deepEqual(orphan.governors, [], JSON.stringify(orphan.governors));
  console.log("✓ governor_promotion：零归属晋升返回 []，不按 id 推断");

  const educator = kb.entityDetail("governor", "GOVERNOR_THE_EDUCATOR");
  assert.ok(Array.isArray(educator.promotions), "缺少 promotions[]");
  assert.ok(
    !educator.promotions.some((p) => p.id === "GOVERNOR_PROMOTION_EDUCATOR_CONNOISSEUR"),
    "平伽拉的晋升列表仍含鉴赏家",
  );
  assertLossless(educator);
  console.log(`✓ governor：平伽拉晋升 ${educator.promotions.length} 项，不含鉴赏家`);

  // The packet's `gov` column must agree with the relation table.
  const governorSection = byz.content.governor_promotion;
  const connoisseurRow = rowOf(governorSection, "GOVERNOR_PROMOTION_EDUCATOR_CONNOISSEUR");
  assert.deepEqual(cell(governorSection, connoisseurRow, "gov"), ["GOVERNOR_THE_CARDINAL"]);
  const orphanRow = rowOf(governorSection, "GOVERNOR_PROMOTION_AMBASSADOR_EMISSARY");
  assert.equal(cell(governorSection, orphanRow, "gov"), null);
  console.log("✓ instance.governors：gov 列与 GovernorPromotionSets 一致");

  const promotionList = kb.listEntities("governor_promotion", { q: "CONNOISSEUR", limit: 5 });
  assert.equal(promotionList.items[0]?.id, "GOVERNOR_PROMOTION_EDUCATOR_CONNOISSEUR");
  assert.ok(promotionList.items[0]?.governors?.some((g) => g.id === "GOVERNOR_THE_CARDINAL"));
  assertLossless(promotionList);
  console.log("✓ 内部 entities API：晋升列表带 governors[]");

  const hits = kb.search("鉴赏家", { scope: "entity" }).results;
  const rank = hits.findIndex((r) => r.id === "governor_promotion:GOVERNOR_PROMOTION_EDUCATOR_CONNOISSEUR");
  assert.ok(rank >= 0 && rank < 3, JSON.stringify(hits.slice(0, 5)));
  assert.match(hits[rank].snippet, /莫克夏/, hits[rank].snippet);
  assertLossless(hits[rank]);
  console.log(`✓ 检索：鉴赏家 → ${hits[rank].id}（含归属）`);

  const governorSupplyRows = kb.db
    .prepare(
      `SELECT owner_id FROM kb_formula_owner WHERE owner_id = 'GOVERNOR_PROMOTION_EDUCATOR_CONNOISSEUR' LIMIT 1;`,
    )
    .get();
  assert.ok(governorSupplyRows, "公式层缺少鉴赏家归属行");
  console.log("✓ 公式层：鉴赏家归属按关系表解析（不写总督归属）");

  // --- payload contract: the budget may compact audit fields, never facts ---
  const byzPlan = {
    victory: "domination",
    civ: "CIVILIZATION_BYZANTIUM",
    leader: "LEADER_BASIL",
    speed: "online",
  };
  const checkView = kb.plan({ ...byzPlan, view: "check", detail: "full" });
  assertLossless(checkView);
  assert.ok(checkView.checks.length > 0, "check 视图为空");
  assert.ok(checkView.checks.every((c) => c.remedy !== undefined), "check.remedy 含 undefined");
  console.log(`✓ plan：check 视图 ${checkView.checks.length} 条，可无损序列化`);

  let focusError = null;
  try {
    kb.plan({ ...byzPlan, view: "focus", detail: "full" });
  } catch (error) {
    focusError = error;
  }
  assert.ok(focusError, "没有目标层时 focus 应明确报错");
  assert.match(String(focusError.message), /目标层/, `focus 报错文案：${focusError.message}`);
  console.log("✓ plan：目标层退役后 focus 明确报错，不退化为通用阶梯");

  // Batch fetch must return every requested id even when the payload has to be
  // compacted; this is the internal QA API now, not a model-facing tool.
  const unitIds = ["UNIT_BYZANTINE_TAGMA", "UNIT_BYZANTINE_DROMON", "UNIT_HEAVY_CHARIOT", "UNIT_KNIGHT"];
  const batch = kb.entityMany("unit", unitIds, { effects: "full", modifiers: "summary" });
  assert.deepEqual(batch.items.map((i) => i.id), unitIds, "批量实体被丢弃");
  const batchText = renderToolPayload("entity", batch);
  const batchRendered = JSON.parse(batchText);
  assert.equal(batchRendered.items.length, 4, "渲染后批量实体被丢弃");
  assert.ok(
    batchRendered._budget?.over !== true,
    `批量实体超出预算：${batchText.length}B ${JSON.stringify(batchRendered._budget)}`,
  );
  assert.ok(batchText.length <= 16000, `entity 载荷 ${batchText.length} > 16000`);
  console.log(`✓ 内部 entity API：4 条批量全保留 / ${batchText.length} 字符`);

  const monarchy = kb.listEntities("government", { q: "君主" });
  assert.ok(
    monarchy.items.some((item) => item.id === "GOVERNMENT_MONARCHY"),
    JSON.stringify(monarchy.items.map((i) => i.id)),
  );
  console.log("✓ 内部 entities API：q=君主 命中 GOVERNMENT_MONARCHY");

  const promotionTree = kb.listEntities("promotion", {
    promotionClass: "PROMOTION_CLASS_HEAVY_CAVALRY",
    limit: 50,
  });
  assert.equal(promotionTree.total, 7, `重骑兵晋升 ${promotionTree.total} 条`);
  const charge = kb.entityDetail("promotion", "PROMOTION_CHARGE");
  assert.match(
    `${charge.description_zh ?? ""}\n${(charge.effects ?? []).map((e) => e.text).join("\n")}`,
    /驻扎/,
    charge.description_zh,
  );
  assertLossless(promotionTree);
  console.log(`✓ promotion：重骑兵 ${promotionTree.total} 条，冲锋文本可读`);

  const tagmaDetail = kb.entityDetail("unit", "UNIT_BYZANTINE_TAGMA");
  assert.equal(tagmaDetail.upgrade?.to, "UNIT_TANK", JSON.stringify(tagmaDetail.upgrade));
  assert.ok(tagmaDetail.upgrade?.upgradableFrom?.includes("UNIT_HEAVY_CHARIOT"), JSON.stringify(tagmaDetail.upgrade));
  assert.equal(tagmaDetail.resource?.requiresResource, false, JSON.stringify(tagmaDetail.resource));
  assertLossless(tagmaDetail);
  const hippoDetail = kb.entityDetail("district", "DISTRICT_HIPPODROME");
  const hippoBuildingsDetail = (hippoDetail.buildings ?? []).map((b) => b.id);
  for (const id of ["BUILDING_ARENA", "BUILDING_ZOO", "BUILDING_STADIUM"]) {
    assert.ok(hippoBuildingsDetail.includes(id), `${id} 不在跑马场建筑列表：${hippoBuildingsDetail.join(",")}`);
  }
  assert.ok(!hippoBuildingsDetail.includes("BUILDING_TLACHTLI"), "别国特色建筑混进了基础建筑链");
  console.log(`✓ 内部 entity API：甲胄升级 ${tagmaDetail.upgrade?.to} / 跑马场 ${hippoBuildingsDetail.length} 基础建筑`);

  const metaOnline = kb.meta().speedProfiles?.find((s) => s.speed === "online");
  assert.equal(metaOnline?.totalTurns, 250);
  assert.equal(metaOnline?.costMultiplier, 50);
  console.log("✓ meta：online = 250 回合 / 50% 成本");

  const badSql = kb.sql("SELECT * FROM UnitUpgradeCosts");
  assert.match(badSql.error ?? "", /no such table/);
  assert.ok(badSql.candidates?.tables?.some((t) => /UnitUpgrade/.test(t)), JSON.stringify(badSql.candidates));
  console.log(`✓ kb.sql（内部 QA）：缺表返回候选 ${badSql.candidates.tables.join(",")}`);

  const schema = kb.schema({ q: "UnitPromotion" });
  assert.ok(schema.tables.some((t) => t.name === "UnitPromotions"), JSON.stringify(schema.tables.map((t) => t.name)));
  console.log(`✓ kb.schema（内部 QA）：UnitPromotion* ${schema.tables.length} 张表`);

  // --- host surface: five tools, no drill-down escape hatch ----------------
  const registered = {};
  apply(
    {
      tools: {
        register: (tool) => {
          registered[tool.name] = tool;
        },
        guard: () => () => {},
      },
      systemPrompt: { section: () => () => {} },
      effect: () => () => {},
    },
    { ruleset: "bbg", dbPaths: { bbg: dbFile }, effectCardsRequired: true, strictGrounding: false },
  );
  const expectedTools = ["civi6_instance", "civi6_eval", "civi6_meta", "civi6_pace", "civi6_pace_eval"];
  for (const name of expectedTools) {
    assert.ok(registered[name], `缺少工具 ${name}: ${JSON.stringify(Object.keys(registered))}`);
  }
  for (const gone of [
    "civi6_entity",
    "civi6_plan",
    "civi6_search",
    "civi6_entities",
    "civi6_modifiers",
    "civi6_schema",
    "civi6_sql",
  ]) {
    assert.equal(registered[gone], undefined, `${gone} 仍注册（探索面应为 0）`);
  }
  assert.deepEqual(Object.keys(registered).sort(), [...expectedTools].sort(), "模型面工具数不是 5");

  const hostCore = await registered.civi6_instance.execute({
    civ: "Russia",
    leader: "Peter",
    speed: "online",
    section: "core",
  });
  assert.ok(hostCore.manifest?.classes?.length === CLASSES.length, "host core 缺少 manifest.classes");
  assert.ok(hostCore.definition && hostCore.whenToUse, "host core 缺 definition/whenToUse");
  const hostCoreText = renderToolPayload("instance", hostCore);
  assert.ok(hostCoreText.length <= 44000, `host core ${hostCoreText.length} > 44000`);

  const hostBeliefs = await registered.civi6_instance.execute({
    civ: "Byzantium",
    leader: "Basil II",
    speed: "online",
    section: "beliefs",
  });
  assert.ok(hostBeliefs.content.belief.rows.length > 0, "host beliefs 行为空");

  const hostEval = await registered.civi6_eval.execute({
    builds: ["BUILDING_LIBRARY"],
    gates: ["CIVIC_HUMANISM"],
    cities: 4,
    speed: "online",
    eraId: "ERA_MEDIEVAL",
  });
  assert.ok(hostEval.ledger.length >= 1, "host eval 缺少账本");
  assert.ok(hostEval.path?.closure >= 2, "host eval 缺少前置闭包");
  assert.equal(hostEval.basis?.speed, "online", "host eval 缺 basis.speed");
  assert.equal(hostEval._workBudget, undefined, "旧 _workBudget 不应再出现");
  // The tool schema must force the two inputs that used to be silently defaulted.
  const evalParams = registered.civi6_eval.parameters;
  assert.deepEqual(evalParams.required, ["builds", "speed"], `eval required=${JSON.stringify(evalParams.required)}`);
  assert.ok(evalParams.properties.speed, "eval 缺 speed 参数");
  assert.match(evalParams.properties.eraId.description, /REQUIRED/, "eraId 说明未标注必填于 gates");

  // --- pacing: build the function set once, evaluate by explicit calls ------
  const paceParams = registered.civi6_pace.parameters;
  assert.deepEqual(paceParams.required, ["civ", "speed", "victory"], `pace required=${JSON.stringify(paceParams.required)}`);
  assert.equal(paceParams.properties.source, undefined, "pace 不应暴露 source（规则锁定）");
  assert.equal(paceParams.properties.format, undefined, "pace 不应暴露 format（面向数据）");
  assert.ok(paceParams.properties.formula, "pace 缺 formula 开关");
  assert.deepEqual(
    registered.civi6_pace_eval.parameters.properties.calls.items.properties.fn.enum,
    [...PACE_CALL_FNS],
    "pace_eval 的 fn enum 与求值器不一致",
  );

  const pace = await registered.civi6_pace.execute({
    civ: "CIVILIZATION_KOREA",
    leader: "LEADER_SEONDEOK",
    speed: "online",
    victory: "science",
  });
  assert.equal(pace.schema, "civi6.pacing/tool/v1", "pace schema");
  assert.equal(pace.functionSet?.schema, "civi6.pacing/formula/v1", "pace functionSet schema");
  assert.ok(pace.functionSet.T > 0, `pace T=${pace.functionSet?.T}`);
  assert.ok(pace.handle?.startsWith("pc1."), "pace handle 缺失");
  assert.equal(pace.functionSet.meta.checks.closedLoop, true, "pace 证书 closedLoop 非 true");
  assert.equal(pace.functionSet.meta.baseline.feasible, true, "pace science 应可行");
  const paceText = renderToolPayload("pace", pace);
  assert.ok(paceText.length <= 32000, `pace 载荷 ${paceText.length} > 32000`);

  // The input contract is data, not user text: names and ambiguous leaders fail.
  await assert.rejects(
    () => registered.civi6_pace.execute({ civ: "Korea", speed: "online", victory: "science" }),
    /精确 id/,
    "名字入参没有被拒绝",
  );
  await assert.rejects(
    () => registered.civi6_pace.execute({ civ: "CIVILIZATION_AMERICA", speed: "online", victory: "science" }),
    /多个领袖/,
    "多领袖文明未指定 leader 时没有报错",
  );

  const adapter = {
    hasTable: (table) =>
      !!kb.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
    tableColumns: (table) => kb.db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name),
    all: (sql, ...params) => kb.db.prepare(sql).all(...params),
    get: (sql, ...params) => kb.db.prepare(sql).get(...params),
  };
  const expectedResult = buildPacing(adapter, {
    source: "bbg",
    civId: "CIVILIZATION_KOREA",
    leaderId: "LEADER_SEONDEOK",
    victoryId: "science",
    speed: "online",
    root,
  });
  const expectedFns = makePacingFunctions(expectedResult);

  const paceEval = await registered.civi6_pace_eval.execute({
    handle: pace.handle,
    calls: [
      { fn: "cumulative", key: "science", t: 120 },
      { fn: "state", t: 120 },
      { fn: "nextMilestone", t: 120 },
      { fn: "milestones", from: 1, to: 120, limit: 3 },
      { fn: "baseline" },
    ],
  });
  assert.equal(paceEval.schema, "civi6.pacing/eval/v1", "pace_eval schema");
  assert.equal(paceEval.T, pace.functionSet.T, "pace_eval T 与函数集不一致");
  assert.equal(paceEval.source, "handle", "pace_eval source 不是 handle");
  const scienceAt120 = paceEval.results.find((r) => r.fn === "cumulative" && r.key === "science").value;
  const stateAt120 = paceEval.results.find((r) => r.fn === "state").value;
  assert.ok(
    Math.abs(scienceAt120 - expectedFns.science(120)) <= 1e-6,
    `pace_eval science(120)=${scienceAt120} vs ${expectedFns.science(120)}`,
  );
  assert.ok(
    Math.abs(stateAt120.cumulative.production - expectedFns.production(120)) <= 1e-6,
    `pace_eval production(120)=${stateAt120.cumulative.production} vs ${expectedFns.production(120)}`,
  );
  assert.equal(stateAt120.research?.id, expectedFns.research(120)?.id, "pace_eval research 不一致");
  const milestonePage = paceEval.results.find((r) => r.fn === "milestones").value;
  assert.ok(milestonePage.total > 0 && milestonePage.rows.length === 3, "pace_eval milestones 窗口/limit 不对");
  assert.equal(
    paceEval.results.find((r) => r.fn === "baseline").value.turn,
    expectedResult.baseline.turn,
    "pace_eval baseline.turn 不一致",
  );

  // The literal function set is accepted too (external/offline producers), but
  // the handle remains the cheap path.
  const literalEval = await registered.civi6_pace_eval.execute({
    functionSet: pace.functionSet,
    calls: [{ fn: "cumulative", key: "science", t: 120 }],
  });
  assert.equal(literalEval.source, "functionSet", "字面 functionSet 未被识别");
  assert.equal(literalEval.results[0].value, scienceAt120, "字面 functionSet 求值不一致");

  // Handoffs fail closed when stale/corrupt, and batches stay bounded.
  const drift = encodePaceHandle({
    version: 1,
    source: "bbg",
    civ: "CIVILIZATION_KOREA",
    leader: "LEADER_SEONDEOK",
    speed: "online",
    victory: "science",
    assurance: "standard",
    targetTurn: null,
    rawBuiltAt: "stale",
    kbBuiltAt: "stale",
  });
  await assert.rejects(
    () => registered.civi6_pace_eval.execute({ handle: drift, calls: [{ fn: "baseline" }] }),
    /不一致/,
    "旧构建 handle 没有被拒绝",
  );
  await assert.rejects(
    () => registered.civi6_pace_eval.execute({ handle: "pc1.bad", calls: [{ fn: "baseline" }] }),
    /handle/,
    "损坏 handle 没有被拒绝",
  );
  await assert.rejects(
    () =>
      registered.civi6_pace_eval.execute({
        handle: pace.handle,
        calls: Array.from({ length: 25 }, () => ({ fn: "baseline" })),
      }),
    /最多 24/,
    "calls 上限没有生效",
  );

  // Culture is infeasible under the authored baseline: a result, not an error.
  const culturePace = await registered.civi6_pace.execute({
    civ: "CIVILIZATION_KOREA",
    leader: "LEADER_SEONDEOK",
    speed: "online",
    victory: "culture",
    formula: false,
  });
  assert.equal(culturePace.summary?.baseline?.feasible, false, "culture 应显式不可行");
  assert.ok(culturePace.summary?.baseline?.blockers?.length > 0, "culture 缺少 blockers");

  // Difficulty is a provenance caveat, not a silent re-model.
  const settlerPace = await registered.civi6_pace.execute({
    civ: "CIVILIZATION_KOREA",
    leader: "LEADER_SEONDEOK",
    speed: "online",
    victory: "science",
    difficulty: "DIFFICULTY_SETTLER",
    formula: false,
  });
  assert.equal(settlerPace.warnings?.[0]?.code, "difficulty-modeled", "难度不一致没有 warning");

  // An infeasible target is a structured blocker, never a re-planned baseline.
  const targetPace = await registered.civi6_pace.execute({
    civ: "CIVILIZATION_KOREA",
    leader: "LEADER_SEONDEOK",
    speed: "online",
    victory: "science",
    targetTurn: 20,
    formula: false,
  });
  assert.equal(targetPace.summary?.baseline?.feasible, false, "T20 science 应不可行");
  assert.ok(
    targetPace.summary?.baseline?.blockers?.some((b) => b.kind === "target"),
    "不可行目标缺少 target blocker",
  );
  console.log(
    `✓ pace：T=${pace.functionSet.T} / 载荷 ${paceText.length}B / eval science(120)=${scienceAt120} / ` +
      `milestones ${milestonePage.total} 条（回 ${milestonePage.rows.length}） / culture infeasible`,
  );

  // A packet row can still be resolved by its handle for QA, but the model has
  // no tool that accepts one; the handle index and the resolver must agree on pk
  // order or cross-references silently point at the wrong row.
  const unitPage = await registered.civi6_instance.execute({
    civ: "Russia",
    leader: "Peter",
    speed: "online",
    section: "units",
  });
  const tagmaHandle = unitPage.content.unit.rows.find((row) => row[1] === "UNIT_BYZANTINE_TAGMA")[0];
  assert.equal(kb.entityFromHandle(tagmaHandle), "UNIT_BYZANTINE_TAGMA", `句柄 ${tagmaHandle} 解析错误`);
  const districtPage = await registered.civi6_instance.execute({
    civ: "Russia",
    leader: "Peter",
    speed: "online",
    section: "districts",
  });
  const campusRow = districtPage.content.district.rows.find((row) => row[1] === "DISTRICT_CAMPUS");
  const buildingHandle = (campusRow[districtPage.content.district.columns.indexOf("buildings")] ?? [])[0];
  assert.ok(buildingHandle, "学院没有 building 句柄");
  assert.equal(kb.entityFromHandle(buildingHandle), "BUILDING_LIBRARY", `建筑句柄 ${buildingHandle} 解析错误`);
  console.log(
    `✓ host：工具面 ${Object.keys(registered).length} 个 / core ${hostCore.integrity.rows} 行 / eval 账本 ${hostEval.ledger.length} 币种 / ` +
      `句柄 ${tagmaHandle}→甲胄、${buildingHandle}→图书馆`,
  );

  console.log("\n插件门面校验通过 ✅");
} finally {
  kb.close();
}
