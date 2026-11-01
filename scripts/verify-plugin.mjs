import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apply, createKnowledgeBase, renderToolPayload } from "../dsh-plugin/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbFile = process.env.CIVI6_BBG_DB_PATH?.trim() || join(root, "data", "civi6-bbg.sqlite");

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
  // objective layer" instead of serving stale rows. The answer path is
  // civi6_instance + civi6_eval below.
  const objectiveRows = kb.db.prepare("SELECT COUNT(*) AS n FROM kb_objective").get().n;
  assert.equal(objectiveRows, 0, "kb_objective 应为空（作者目标层已退役）");

  // Objective-free instance packet: hard constraints decide the fetch, never the
  // victory line. It ships as bounded sections because the transport cuts a
  // single tool result at ~50k chars; each page must fit and the four pages must
  // reconstruct the whole packet.
  const baseInstanceArgs = { civ: "Russia", leader: "Peter", speed: "online", difficulty: "DIFFICULTY_DEITY" };
  const inst = kb.instance({ ...baseInstanceArgs, section: "all" });
  assert.equal(inst.instance.civ, "CIVILIZATION_RUSSIA", `instance.civ=${inst.instance.civ}`);
  assert.equal(inst.instance.speedProfile?.totalTurns, 250, "online 速度档缺失");
  assert.ok(inst.integrity.rows >= 900, `内容行 ${inst.integrity.rows} 过少`);
  assert.equal(inst.content.technology.rows.length, 77, "科技行数不是 77");
  assert.equal(inst.content.civic.rows.length, 61, "市政行数不是 61");
  assert.ok(inst.relations.length > 500, `前置关系 ${inst.relations.length} 过少`);
  assert.ok(inst.civKit.some((k) => k.id === "DISTRICT_LAVRA"), "文明套件缺少拉夫拉");
  const libraryRow = inst.content.building.rows.find((r) => r[1] === "BUILDING_LIBRARY");
  assert.ok(libraryRow, "缺少图书馆行");
  assert.match(String(libraryRow[5]), /科技/, `图书馆公式摘要=${libraryRow[5]}`);
  assert.ok((inst.indexes.dimension.culture_per_turn ?? []).length > 0, "缺少产出索引");
  assert.deepEqual(inst.omitted.find((o) => /时代得分/.test(o.what)) ? true : false, true, "omitted 未标注时代得分");

  // The gaps models used to fill with SQL must now be inside the packet.
  assert.ok(inst.params.some(([name]) => String(name).startsWith("RELIGION_SPREAD_")), "缺少宗教压力参数");
  assert.ok(inst.params.some(([name]) => String(name).startsWith("TOURISM_")), "缺少旅游参数");
  assert.equal(inst.greatPersonClasses.length, 10, `伟人职业 ${inst.greatPersonClasses.length}`);
  assert.ok(inst.gppBaseCost.length >= 8, "缺少伟人基础成本");
  const policySection = kb.instance({ ...baseInstanceArgs, section: "content-b" });
  assert.ok(
    Object.values(policySection.content).some((sec) =>
      sec.rows.some((row) => (row[5] && row[5].length) || (row[6] && row[6].length)),
    ),
    "content-b 行既无 fx 也无 d",
  );

  // Every page must fit the transport; oversize is an error, never a cut.
  for (const name of ["core", "content-a", "content-b", "content-c"]) {
    const page = kb.instance({ ...baseInstanceArgs, section: name });
    const text = renderToolPayload("instance", page);
    assert.ok(text.length <= 44000, `分片 ${name} ${text.length} > 44000`);
    assert.ok(text.length < 50000, `分片 ${name} ${text.length} 超过传输上限`);
    const parsed = JSON.parse(text);
    assert.ok(parsed.section === name, `分片 ${name} section=${parsed.section}`);
    if (name === "core") {
      assert.ok(parsed.manifest?.next?.length === 3, "core 缺少 manifest.next");
      assert.ok(parsed.manifest.sections["content-c"] > 0, "manifest 缺少分片体积");
    }
  }
  const allIds = new Set();
  for (const sec of Object.values(inst.content)) for (const row of sec.rows) allIds.add(row[1]);
  assert.equal(allIds.size, 979, `合并后实体 ${allIds.size} ≠ 979`);
  console.log(
    `✓ instance：4 分片重建 ${inst.integrity.rows} 行 / ${inst.integrity.relations} 前置 / 参数 ${inst.params.length} / 标志 ${inst.boosts.length}`,
  );

  // Deterministic scratchpad: composes formulas, never fetches.
  const ev = kb.eval({ builds: ["BUILDING_LIBRARY"], cities: 3, popPerCity: 4, victory: "culture" });
  const science = ev.metrics.find((m) => m.dimension === "science_per_turn");
  assert.equal(science?.supply, 6, `图书馆×3 科技供应=${science?.supply}`);
  assert.equal(science?.composition[0]?.id, "BUILDING_LIBRARY", "构成清单缺少来源");
  assert.ok(ev.demand.length > 0, "缺少计划带需求");
  assert.deepEqual(ev.missingBuilds, [], JSON.stringify(ev.missingBuilds));

  // Required side: gate closure -> ledger -> cut -> scenarios.
  const evalPlan = kb.eval({
    builds: ["BUILDING_LIBRARY", "BUILDING_AMPHITHEATER", "BUILDING_MONUMENT"],
    gates: ["CIVIC_HUMANISM", "BUILDING_MUSEUM_ART"],
    cities: 6,
    popPerCity: 6,
    eraIndex: 3,
    eraId: "ERA_RENAISSANCE",
    victory: "culture",
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

  const promotionList = kb.listEntities("governor_promotion", { q: "CONNOISSEUR", limit: 5 });
  assert.equal(promotionList.items[0]?.id, "GOVERNOR_PROMOTION_EDUCATOR_CONNOISSEUR");
  assert.ok(promotionList.items[0]?.governors?.some((g) => g.id === "GOVERNOR_THE_CARDINAL"));
  assertLossless(promotionList);
  console.log("✓ civi6_entities：晋升列表带 governors[]");

  const hits = kb.search("鉴赏家", { scope: "entity" }).results;
  const rank = hits.findIndex((r) => r.id === "governor_promotion:GOVERNOR_PROMOTION_EDUCATOR_CONNOISSEUR");
  assert.ok(rank >= 0 && rank < 3, JSON.stringify(hits.slice(0, 5)));
  assert.match(hits[rank].snippet, /莫克夏/, hits[rank].snippet);
  assertLossless(hits[rank]);
  console.log(`✓ 检索：鉴赏家 → ${hits[rank].id}（含归属）`);

  // Governor supply ids no longer name an owner: ownership is a relation read
  // from GovernorPromotionSets, covered by the connoisseur checks above.
  const governorSupplyRows = kb.db
    .prepare(
      `SELECT owner_id FROM kb_formula_owner WHERE owner_id = 'GOVERNOR_PROMOTION_EDUCATOR_CONNOISSEUR' LIMIT 1;`,
    )
    .get();
  assert.ok(governorSupplyRows, "公式层缺少鉴赏家归属行");
  console.log("✓ 公式层：鉴赏家归属按关系表解析（不写总督归属）");

  // --- payload contract: the budget may compact audit fields, never facts ---
  const byz = {
    victory: "domination",
    civ: "CIVILIZATION_BYZANTIUM",
    leader: "LEADER_BASIL",
    speed: "online",
  };

  const checkView = kb.plan({ ...byz, view: "check", detail: "full" });
  assertLossless(checkView);
  assert.ok(checkView.checks.length > 0, "check 视图为空");
  assert.ok(checkView.checks.every((c) => c.remedy !== undefined), "check.remedy 含 undefined");
  console.log(`✓ plan：check 视图 ${checkView.checks.length} 条，可无损序列化`);

  // The brief/answer-packet surface was tied to authored objectives and is gone
  // with them; the packet contract now lives in civi6_instance (checked above).
  let focusError = null;
  try {
    kb.plan({ ...byz, view: "focus", detail: "full" });
  } catch (error) {
    focusError = error;
  }
  assert.ok(focusError, "没有目标层时 focus 应明确报错");
  assert.match(String(focusError.message), /目标层/, `focus 报错文案：${focusError.message}`);
  console.log("✓ plan：目标层退役后 focus 明确报错，不退化为通用阶梯");


  // Batch fetch must return every requested id even when the payload has to be
  // compacted; the old budgeter halved `items` and silently dropped 2 of 4.
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
  console.log(`✓ civi6_entity：4 条批量全保留 / ${batchText.length} 字符`);

  // Localized q: the Chinese name must match even when the raw Name is a LOC tag.
  const monarchy = kb.listEntities("government", { q: "君主" });
  assert.ok(
    monarchy.items.some((item) => item.id === "GOVERNMENT_MONARCHY"),
    JSON.stringify(monarchy.items.map((i) => i.id)),
  );
  console.log("✓ civi6_entities：q=君主 命中 GOVERNMENT_MONARCHY");

  // Unit promotion tree as a first-class entity.
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
  const promoSearch = kb.search("冲锋", { type: "promotion" });
  assert.ok(
    promoSearch.results.some((r) => r.id === "promotion:PROMOTION_CHARGE"),
    JSON.stringify(promoSearch.results.slice(0, 3)),
  );
  console.log(`✓ promotion：重骑兵 ${promotionTree.total} 条，冲锋文本与检索可读`);

  // Derived unit/district facts replace SQL archaeology.
  const tagma = kb.entityDetail("unit", "UNIT_BYZANTINE_TAGMA");
  assert.equal(tagma.upgrade?.to, "UNIT_TANK", JSON.stringify(tagma.upgrade));
  assert.ok(tagma.upgrade?.upgradableFrom?.includes("UNIT_HEAVY_CHARIOT"), JSON.stringify(tagma.upgrade));
  assert.ok(tagma.upgrade?.goldEstimate > 0, JSON.stringify(tagma.upgrade));
  assert.equal(tagma.upgrade?.goldEstimateAuthority, "derived");
  assert.equal(tagma.resource?.requiresResource, false, JSON.stringify(tagma.resource));
  assertLossless(tagma);
  const chariot = kb.entityDetail("unit", "UNIT_HEAVY_CHARIOT");
  assert.equal(chariot.upgrade?.to, "UNIT_KNIGHT");
  const tagmaCandidate = (chariot.upgrade?.targetReplacedBy ?? []).find(
    (entry) => entry.id === "UNIT_BYZANTINE_TAGMA",
  );
  assert.ok(tagmaCandidate, JSON.stringify(chariot.upgrade?.targetReplacedBy));
  assert.equal(tagmaCandidate.productionDelta, 90);
  assert.equal(tagmaCandidate.goldEstimate, 100);
  const knight = kb.entityDetail("unit", "UNIT_KNIGHT");
  assert.ok(knight.upgrade?.replacedBy?.includes("UNIT_BYZANTINE_TAGMA"), JSON.stringify(knight.upgrade));
  const hippo = kb.entityDetail("district", "DISTRICT_HIPPODROME");
  const hippoBuildings = (hippo.buildings ?? []).map((b) => b.id);
  for (const id of ["BUILDING_ARENA", "BUILDING_ZOO", "BUILDING_STADIUM"]) {
    assert.ok(hippoBuildings.includes(id), `${id} 不在跑马场建筑列表：${hippoBuildings.join(",")}`);
  }
  assert.ok(!hippoBuildings.includes("BUILDING_TLACHTLI"), "别国特色建筑混进了基础建筑链");
  assert.ok(
    (hippo.uniqueBuildings ?? []).some((b) => b.id === "BUILDING_TLACHTLI" && b.replaces === "BUILDING_ARENA"),
    JSON.stringify(hippo.uniqueBuildings),
  );
  assert.deepEqual(hippo.replaces, ["DISTRICT_ENTERTAINMENT_COMPLEX"]);
  console.log(
    `✓ unit/district：升级链 ${tagma.upgrade?.to} / 跑马场 ${hippoBuildings.length} 基础建筑 + ${hippo.uniqueBuildings.length} 特色`,
  );

  // Speed profile must be visible without SQL.
  const metaOnline = kb.meta().speedProfiles?.find((s) => s.speed === "online");
  assert.equal(metaOnline?.totalTurns, 250);
  assert.equal(metaOnline?.costMultiplier, 50);
  console.log("✓ meta：online = 250 回合 / 50% 成本");

  // Bad SQL is a discovery answer, not a dead end.
  const badSql = kb.sql("SELECT * FROM UnitUpgradeCosts");
  assert.match(badSql.error ?? "", /no such table/);
  assert.ok(badSql.candidates?.tables?.some((t) => /UnitUpgrade/.test(t)), JSON.stringify(badSql.candidates));
  console.log(`✓ civi6_sql：缺表返回候选 ${badSql.candidates.tables.join(",")}`);

  const schema = kb.schema({ q: "UnitPromotion" });
  assert.ok(schema.tables.some((t) => t.name === "UnitPromotions"), JSON.stringify(schema.tables.map((t) => t.name)));
  assert.ok(
    schema.tables.find((t) => t.name === "UnitPromotions")?.columns?.some((c) => c.name === "PromotionClass"),
  );
  console.log(`✓ civi6_schema：UnitPromotion* ${schema.tables.length} 张表`);

  // Column-first lookup: the exact query shape that cost e94 three SQL steps
  // ("where does ResourceCost live?") must be answered in one compact payload.
  const columnSchema = kb.schema({ q: "ResourceCost" });
  assert.ok(
    columnSchema.tables.some((t) => (t.matchedColumns ?? []).some((c) => c.name === "ResourceCost")),
    JSON.stringify(columnSchema.tables.map((t) => t.name)),
  );
  const columnSchemaText = renderToolPayload("schema", columnSchema);
  assert.ok(columnSchemaText.length < 5000, `column schema 载荷 ${columnSchemaText.length} > 5000`);
  console.log(`✓ civi6_schema：列名优先（ResourceCost）${columnSchemaText.length} 字符`);

  // Host path: a complete brief arms the visible work budget on later calls.
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
  const expectedTools = ["civi6_instance", "civi6_eval", "civi6_entity", "civi6_sql", "civi6_meta"];
  for (const name of expectedTools) {
    assert.ok(registered[name], `缺少工具 ${name}: ${JSON.stringify(Object.keys(registered))}`);
  }
  for (const gone of ["civi6_plan", "civi6_search", "civi6_entities", "civi6_modifiers", "civi6_schema"]) {
    assert.equal(registered[gone], undefined, `${gone} 仍注册（探索面应为 0）`);
  }
  const hostInstance = await registered.civi6_instance.execute({
    civ: "Russia",
    leader: "Peter",
    speed: "online",
    section: "core",
  });
  assert.ok(hostInstance.integrity.rows >= 900, `host instance 行 ${hostInstance.integrity.rows}`);
  assert.ok(hostInstance.manifest?.next?.length === 3, "host core 缺少 manifest.next");
  const hostInstanceText = renderToolPayload("instance", hostInstance);
  assert.ok(hostInstanceText.length <= 44000, `host core ${hostInstanceText.length} > 44000`);
  const hostEval = await registered.civi6_eval.execute({
    builds: ["BUILDING_LIBRARY"],
    gates: ["CIVIC_HUMANISM"],
    cities: 4,
  });
  assert.ok(hostEval.ledger.length >= 1, "host eval 缺少账本");
  assert.ok(hostEval.path?.closure >= 2, "host eval 缺少前置闭包");
  const hostEntity = await registered.civi6_entity.execute({
    type: "unit",
    id: "UNIT_BYZANTINE_TAGMA",
    effects: "none",
    modifiers: "none",
  });
  assert.equal(hostEntity._workBudget, undefined, "旧 _workBudget 不应再出现");
  console.log(
    `✓ host：工具面 ${Object.keys(registered).length} 个 / instance ${hostInstance.integrity.rows} 行 / eval 账本 ${hostEval.ledger.length} 币种`,
  );

  console.log("\n插件门面校验通过 ✅");
} finally {
  kb.close();
}