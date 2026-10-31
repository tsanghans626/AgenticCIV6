import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKnowledgeBase } from "../dsh-plugin/index.js";

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
  assert.equal(meta.ruleset?.id, "bbg", "ruleset.id 不是 bbg");
  assert.equal(meta.locked, true, "locked 不为 true");
  assert.ok(meta.effectCoverage?.cards > 0, "效果卡为空");
  assert.equal(meta.effectCoverage.stale, false, "效果层过期");
  assertLossless(meta);
  console.log("✓ meta：bbg / locked / effectCoverage");

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

  // v2 reasoning view: constraints ranked by tightness, priced detours, dead ends.
  const focus = kb.plan({
    victory: "domination",
    civ: "CIVILIZATION_BYZANTIUM",
    leader: "LEADER_BASIL",
    speed: "online",
    view: "focus",
  });
  assert.ok(focus.objective, "focus 缺少 objective");
  assert.equal(focus.objective.speed, "online", "focus speed 不是 online");
  assert.ok(focus.objective.constraints.length >= 3, "约束不足");
  assert.equal(focus.objective.constraints[0].metric, "culture_per_turn", "绑定约束不是文化");
  assert.equal(focus.objective.constraints[0].bindingRank, 1, "文化不是 #1 绑定约束");
  assert.ok(focus.path.onPath.length > 0, "缺少在路节点");
  assert.ok(focus.path.detour.length > 0, "缺少绕路节点");
  assert.ok(
    focus.path.dead.some((d) => d.id === "TECH_STIRRUPS"),
    JSON.stringify(focus.path.dead.map((d) => d.id)),
  );
  assert.ok(focus.eras.length >= 2, "时代焦点不足");
  assert.ok(focus.eras.every((e) => e.items.length >= 1), "有时代没有焦点项");
  assert.ok(
    focus.eras.every((e) => e.items.every((i) => i.why && i.abandonIf !== undefined)),
    "焦点缺少 why/放弃条件",
  );
  assertLossless(focus);
  console.log(`✓ plan：focus（拜占庭/联机）${focus.objective.constraints[0].metric} 绑定 / ${focus.eras.length} 时代`);

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

  const governorSupply = focus.supply.find((s) => s.ref === "GOVERNOR_PROMOTION_EDUCATOR_CONNOISSEUR");
  assert.ok(governorSupply, "目标层缺少鉴赏家供给源");
  assert.doesNotMatch(String(governorSupply.id), /pingala|moksha|educator|cardinal/i, String(governorSupply.id));
  console.log(`✓ 目标层：总督供给 id=${governorSupply.id}（不写总督归属）`);

  console.log("\n插件门面校验通过 ✅");
} finally {
  kb.close();
}
