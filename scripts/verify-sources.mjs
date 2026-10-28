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

function close(db) {
  try {
    db.close();
  } catch {
    /* ignore */
  }
}

function check(label, actual, expected) {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  assert.equal(actualText, expectedText, `${label}: 期望 ${expectedText}，实际 ${actualText}`);
  console.log(`  ✓ ${label}`);
}

function checkVanilla() {
  if (!existsSync(vanillaFile)) {
    throw new Error(`原版数据库不存在：${vanillaFile}\n请先运行：npm run build`);
  }
  const db = open(vanillaFile);
  try {
    console.log(`原版: ${vanillaFile}`);
    check(
      "UNIT_GIANT_DEATH_ROBOT",
      scalar(db, "SELECT Combat, AntiAirCombat FROM Units WHERE UnitType = 'UNIT_GIANT_DEATH_ROBOT'"),
      { Combat: 130, AntiAirCombat: 90 },
    );
    check(
      "UNIT_MAN_AT_ARMS",
      scalar(db, "SELECT Combat, PrereqTech FROM Units WHERE UnitType = 'UNIT_MAN_AT_ARMS'"),
      { Combat: 45, PrereqTech: "TECH_APPRENTICESHIP" },
    );
    check(
      "UNIT_MODERN_ARMOR.Combat",
      scalar(db, "SELECT Combat FROM Units WHERE UnitType = 'UNIT_MODERN_ARMOR'").Combat,
      95,
    );
    check(
      "GDR_AA_DEFENSE.Amount",
      scalar(db, "SELECT Value FROM ModifierArguments WHERE ModifierId = 'GDR_AA_DEFENSE' AND Name = 'Amount'").Value,
      "40",
    );
  } finally {
    close(db);
  }
}

function checkBbg() {
  if (!existsSync(bbgFile)) {
    if (requireBbg) throw new Error(`BBG 数据库不存在：${bbgFile}\n请先运行：npm run fetch:bbg && npm run build:bbg`);
    console.log(`\nBBG: 跳过（${bbgFile} 不存在；--require-bbg 可将其视为失败）`);
    return;
  }

  const db = open(bbgFile);
  try {
    console.log(`\nBBG: ${bbgFile}`);
    const metaRow = scalar(db, "SELECT value FROM _meta WHERE key = 'build'");
    assert.ok(metaRow?.value, "缺少 _meta.build");
    const meta = JSON.parse(metaRow.value);
    check("_meta.build.dataSource", meta.dataSource, "bbg");
    assert.ok(meta.bbg?.ref, "_meta.build.bbg.ref 缺失");
    console.log(`  ✓ BBG ref: ${meta.bbg.ref} / ${meta.bbg.modName ?? "(unknown)"}`);

    check(
      "UNIT_GIANT_DEATH_ROBOT",
      scalar(db, "SELECT Combat, AntiAirCombat FROM Units WHERE UnitType = 'UNIT_GIANT_DEATH_ROBOT'"),
      { Combat: 140, AntiAirCombat: 120 },
    );
    check(
      "UNIT_MAN_AT_ARMS",
      scalar(db, "SELECT Combat, PrereqTech FROM Units WHERE UnitType = 'UNIT_MAN_AT_ARMS'"),
      { Combat: 50, PrereqTech: "TECH_MILITARY_TACTICS" },
    );
    check(
      "UNIT_MODERN_ARMOR.Combat",
      scalar(db, "SELECT Combat FROM Units WHERE UnitType = 'UNIT_MODERN_ARMOR'").Combat,
      100,
    );
    check(
      "GDR_AA_DEFENSE.Amount",
      scalar(db, "SELECT Value FROM ModifierArguments WHERE ModifierId = 'GDR_AA_DEFENSE' AND Name = 'Amount'").Value,
      "20",
    );

    const bbgTexts = scalar(db, "SELECT COUNT(*) AS n FROM LocalizedText WHERE INSTR(Tag, 'BBG') > 0").n;
    assert.ok(bbgTexts > 0, `BBG 文本标签数量为 0`);
    console.log(`  ✓ BBG 文本标签: ${bbgTexts}`);

    const postings = scalar(db, "SELECT COUNT(*) AS n FROM search_postings").n;
    assert.ok(postings > 0, "search_postings 为空");
    console.log(`  ✓ search_postings: ${postings}`);
    const docs = scalar(db, "SELECT COUNT(*) AS n FROM search_docs").n;
    assert.ok(docs > 0, "search_docs 为空");
    console.log(`  ✓ search_docs: ${docs}`);
  } finally {
    close(db);
  }
}

try {
  checkVanilla();
  checkBbg();
  console.log("\n全部校验通过 ✅");
} catch (error) {
  console.error("\n校验失败 ❌");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
