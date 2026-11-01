import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vanillaFile = process.env.CIVI6_DB_PATH?.trim() || join(root, "data", "civi6.sqlite");
const bbgFile = process.env.CIVI6_BBG_DB_PATH?.trim() || join(root, "data", "civi6-bbg.sqlite");
const requireBbg = process.argv.includes("--require-bbg");

function open(file) {
  return new DatabaseSync(file, { readOnly: true });
}

function scalar(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function card(db, id) {
  const row = scalar(db, "SELECT * FROM effect_cards WHERE card_id = ?", id);
  assert.ok(row, `缺少效果卡 ${id}`);
  return {
    ...row,
    attributes: JSON.parse(row.attributes_json),
    effects: JSON.parse(row.effects_json),
    unresolved: JSON.parse(row.unresolved_json),
    coverage: JSON.parse(row.coverage_json),
  };
}

function textOf(entry) {
  return [entry.description_zh ?? "", ...entry.effects.map((e) => e.text_zh ?? "")].join("\n");
}

function attribute(entry, key) {
  return entry.attributes.find((a) => a.key === key)?.value;
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

function checkDb(file, source) {
  if (!existsSync(file)) {
    if (requireBbg) throw new Error(`数据库不存在：${file}`);
    console.log(`\n${source}: 跳过（${file} 不存在）`);
    return null;
  }
  const db = open(file);
  try {
    console.log(`\n${source}: ${file}`);
    check("_meta.effects 存在且与 _meta.build 对齐", () => {
      const effects = scalar(db, "SELECT value FROM _meta WHERE key = 'effects'");
      const build = scalar(db, "SELECT value FROM _meta WHERE key = 'build'");
      assert.ok(effects?.value, "缺少 _meta.effects");
      assert.ok(build?.value, "缺少 _meta.build");
      const e = JSON.parse(effects.value);
      const b = JSON.parse(build.value);
      assert.equal(e.rawBuiltAt, b.builtAt, "effect rawBuiltAt 与 build.builtAt 不一致");
      assert.equal(e.rulesetId, source, "effect rulesetId 不匹配");
      assert.ok(e.cards > 0, "cards=0");
    });

    check("_meta.ruleset 存在且 id 匹配", () => {
      const row = scalar(db, "SELECT value FROM _meta WHERE key = 'ruleset'");
      assert.ok(row?.value, "缺少 _meta.ruleset");
      const meta = JSON.parse(row.value);
      assert.equal(meta.id, source, `ruleset.id=${meta.id}`);
      assert.ok(meta.labelZh, "缺少 labelZh");
    });

    check("effect_cards / modifier_text 非空", () => {
      assert.ok(scalar(db, "SELECT COUNT(*) AS n FROM effect_cards").n > 0, "effect_cards 为空");
      assert.ok(scalar(db, "SELECT COUNT(*) AS n FROM modifier_text").n > 0, "modifier_text 为空");
    });

    // "One description, one formula": arithmetic must be executable, not prose.
    // Coverage is a build-record field, so a regression shows up here instead of
    // silently degrading answers into mental arithmetic.
    check("公式层覆盖 ≥85% 且有表格公式", () => {
      const row = scalar(db, "SELECT value FROM _meta WHERE key = 'effects'");
      const e = JSON.parse(row.value);
      const cov = e.formulaCoverage;
      assert.ok(cov, "缺少 formulaCoverage");
      // The locked runtime ruleset carries the stricter bar; vanilla is kept
      // buildable but is not the answering target.
      const minCoverage = source === "bbg" ? 0.85 : 0.75;
      assert.ok(cov.coverage >= minCoverage, `公式覆盖 ${cov.coverage} < ${minCoverage}（${source}）`);
      assert.ok(cov.unparsed >= 0, "unparsed 未记录");
      assert.ok(cov.tableFormulas > 0, "缺少表格公式");
      const n = scalar(db, "SELECT COUNT(*) AS n FROM kb_formula").n;
      const modifiers = scalar(db, "SELECT COUNT(*) AS n FROM Modifiers").n;
      assert.ok(n >= Math.floor(modifiers * 0.7), `kb_formula ${n} 行 / Modifiers ${modifiers}`);
      const owner = scalar(db, "SELECT COUNT(*) AS n FROM kb_formula_owner").n;
      assert.ok(owner >= Math.floor(n * 0.5), `kb_formula_owner ${owner} 行 / 公式 ${n}`);
    });

    check("图书馆有可执行公式（描述与公式同源）", () => {
      const rows = db
        .prepare(
          `SELECT f.desc AS d, f.dimension AS dim, f.value AS v
             FROM kb_formula f
            WHERE f.fx_id LIKE 'fx:t:building:BUILDING_LIBRARY:%'`,
        )
        .all();
      assert.ok(rows.length >= 2, `图书馆公式 ${rows.length} 条`);
      const science = rows.find((r) => r.dim === "science_per_turn");
      assert.equal(science?.v, 2, `图书馆科技公式 ${science?.v}`);
      assert.match(String(science?.d), /科技/, `图书馆描述 ${science?.d}`);
    });

    check("每个 Beliefs 行都有非空效果卡", () => {
      const rows = db.prepare("SELECT BeliefType FROM Beliefs").all();
      assert.ok(rows.length > 0, "Beliefs 为空");
      for (const r of rows) {
        const c = card(db, `belief:${r.BeliefType}`);
        assert.ok(c.description_zh, `${r.BeliefType} 缺少 description_zh`);
        assert.ok(c.effects.length > 0, `${r.BeliefType} 没有权威效果`);
        assert.equal(c.effects.every((e) => e.resolved), true, `${r.BeliefType} 有未解析效果`);
      }
    });

    check("Work Ethic 版本指纹", () => {
      const text = textOf(card(db, "belief:BELIEF_WORK_ETHIC"));
      if (source === "bbg") {
        assert.match(text, /神社和寺庙分别提供\+2和\+4/, text);
        assert.doesNotMatch(text, /每个信仰此宗教的居民/, text);
      } else {
        assert.match(text, /圣地区域|每个信仰此宗教的居民/, text);
        assert.doesNotMatch(text, /神社和寺庙分别提供\+2和\+4/, text);
      }
    });

    check("极光之舞版本指纹", () => {
      const text = textOf(card(db, "belief:BELIEF_DANCE_OF_THE_AURORA"));
      if (source === "bbg") assert.match(text, /平原冻土/, text);
      else assert.match(text, /相邻冻土/, text);
    });

    check("图书馆 +2 科技 / 90 锤", () => {
      const c = card(db, "building:BUILDING_LIBRARY");
      assert.match(textOf(c), /\+2 科技值/, textOf(c));
      assert.equal(Number(attribute(c, "Cost")), 90, `Cost=${attribute(c, "Cost")}`);
    });

    check("大学 +4 科技 / 250 锤 / 1 住房，且没有误报旅游业绩", () => {
      const c = card(db, "building:BUILDING_UNIVERSITY");
      const text = textOf(c);
      assert.match(text, /\+4 科技值/, text);
      assert.doesNotMatch(text, /旅游业绩/, text);
      assert.equal(Number(attribute(c, "Cost")), 250, `Cost=${attribute(c, "Cost")}`);
      assert.equal(Number(attribute(c, "Housing")), 1, `Housing=${attribute(c, "Housing")}`);
    });

    check("骑士团长礼拜堂 290 锤与版本文本", () => {
      const c = card(db, "building:BUILDING_GOV_FAITH");
      const text = textOf(c);
      assert.equal(Number(attribute(c, "Cost")), 290, `Cost=${attribute(c, "Cost")}`);
      if (source === "bbg") {
        assert.match(text, /在您建立的城市中/, text);
        assert.doesNotMatch(text, /获得用/, text);
      } else {
        assert.match(text, /获得用/, text);
      }
    });

    check("每个政体都有固有/积累加成文本（数据层无 Description 列）", () => {
      const rows = db.prepare("SELECT GovernmentType FROM Governments").all();
      assert.ok(rows.length > 0, "Governments 为空");
      for (const r of rows) {
        const c = card(db, `government:${r.GovernmentType}`);
        const texts = c.effects.filter((e) => e.kind === "description").map((e) => e.text_zh ?? "");
        assert.ok(texts.some((t) => /固有加成/.test(t)), `${r.GovernmentType} 缺固有加成`);
        assert.ok(texts.some((t) => /积累加成/.test(t)), `${r.GovernmentType} 缺积累加成`);
        for (const e of c.effects) {
          assert.equal(e.resolved, true, `${r.GovernmentType} 有未解析效果`);
        }
      }
    });

    check("全部效果文本无 LOC_ / 残留占位符", () => {
      const rows = db
        .prepare("SELECT card_id, owner_kind, description_zh, effects_json FROM effect_cards")
        .all();
      for (const r of rows) {
        const texts = [r.description_zh ?? "", ...JSON.parse(r.effects_json).map((e) => e.text_zh ?? "")];
        for (const text of texts) {
          assert.doesNotMatch(text, /LOC_[A-Z0-9_]+/, `${r.card_id}: ${text}`);
          assert.doesNotMatch(text, /\{[^}]*\}/, `${r.card_id}: ${text}`);
        }
      }
    });

    check("区划相邻加成带条件文本（{1_num} 已替换）", () => {
      const c = card(db, "district:DISTRICT_CAMPUS");
      const adjacency = c.effects.filter((e) => e.kind === "adjacency").map((e) => e.text_zh ?? "");
      assert.ok(adjacency.length > 0, "学院没有相邻加成效果");
      assert.ok(adjacency.some((t) => /相邻山脉/.test(t)), JSON.stringify(adjacency.slice(0, 5)));
      assert.ok(adjacency.every((t) => !/\{/.test(t)), JSON.stringify(adjacency.filter((t) => /\{/.test(t))));
    });

    check("每条效果都有出处，effects 数组全部 resolved", () => {
      for (const r of db.prepare("SELECT card_id, effects_json FROM effect_cards").all()) {
        for (const e of JSON.parse(r.effects_json)) {
          assert.ok(e.source?.table, `${r.card_id}: 缺少 source.table`);
          assert.ok(e.source?.pk, `${r.card_id}: 缺少 source.pk`);
          assert.equal(e.resolved, true, `${r.card_id}: unresolved effect 混入 effects`);
        }
      }
    });

    check("每个总督晋升都有卡", () => {
      const rows = db.prepare("SELECT GovernorPromotionType AS id FROM GovernorPromotions").all();
      assert.ok(rows.length > 0, "GovernorPromotions 为空");
      for (const r of rows) card(db, `governor_promotion:${r.id}`);
    });

    check("鉴赏家晋升卡：官方描述已解析，无 LOC_ 残留", () => {
      const c = card(db, "governor_promotion:GOVERNOR_PROMOTION_EDUCATOR_CONNOISSEUR");
      assert.ok(c.description_zh, "缺少 description_zh");
      assert.ok(c.effects.some((e) => e.authority === "official"), "缺少官方描述效果");
      assert.doesNotMatch(textOf(c), /LOC_[A-Z0-9_]+/, textOf(c));
    });

    const stats = JSON.parse(scalar(db, "SELECT value FROM _meta WHERE key = 'effects'").value);
    console.log(
      `  · ${stats.cards} 卡 / ${stats.effects} 效果 / ${stats.unresolved} 未解析修饰符 / ` +
        `${stats.modifierTexts} 修饰符文本`,
    );
    return stats;
  } finally {
    db.close();
  }
}

try {
  const vanilla = checkDb(vanillaFile, "vanilla");
  const bbg = checkDb(bbgFile, "bbg");
  if (vanilla && bbg) {
    check("BBG 与 vanilla 的 Work Ethic 文本确实不同", () => {
      const v = open(vanillaFile);
      const b = open(bbgFile);
      try {
        const vt = textOf(card(v, "belief:BELIEF_WORK_ETHIC"));
        const bt = textOf(card(b, "belief:BELIEF_WORK_ETHIC"));
        assert.notEqual(vt, bt, "两套库的 Work Ethic 文本相同，版本隔离失效");
      } finally {
        v.close();
        b.close();
      }
    });
  }
  console.log("\n效果事实层校验通过 ✅");
} catch (error) {
  console.error("\n效果事实层校验失败 ❌");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
