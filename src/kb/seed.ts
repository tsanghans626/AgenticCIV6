import { normalizeValue, type KnowledgeDb } from "../db.js";
import type { DataSource } from "../config.js";
import type { DimensionSpec, EraWindowSpec, SpeedProfileSpec, VictorySpec } from "./spec.js";
import type { Labeler } from "./labels.js";

function insertRows(kb: KnowledgeDb, table: string, columns: string[], rows: unknown[][]): void {
  if (!rows.length) return;
  const sql = `INSERT OR REPLACE INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns
    .map(() => "?")
    .join(", ")});`;
  const stmt = kb.db.prepare(sql);
  kb.begin();
  try {
    for (const row of rows) stmt.run(...row.map((v) => normalizeValue(v)));
  } finally {
    kb.commit();
  }
}

export function seedDimensions(kb: KnowledgeDb, dimensions: DimensionSpec[]): number {
  kb.exec(`DELETE FROM kb_dimension;`);
  insertRows(
    kb,
    "kb_dimension",
    ["dimension_id", "name_zh", "name_en", "unit", "value_type", "aggregation", "direction", "observation", "notes"],
    dimensions.map((d) => [
      d.dimensionId, d.nameZh, d.nameEn ?? null, d.unit ?? null, d.valueType,
      d.aggregation, d.direction, d.observation ?? null, d.notes ?? null,
    ]),
  );
  return dimensions.length;
}

export function seedVictories(kb: KnowledgeDb, victories: VictorySpec[]): number {
  kb.exec(`DELETE FROM kb_victory;`);
  insertRows(
    kb,
    "kb_victory",
    ["victory_id", "name_zh", "name_en", "raw_victory_type", "win_check", "critical_percentage",
      "burst_definition", "default_burst_turn", "source_flag", "confidence"],
    victories.map((v) => [
      v.victoryId, v.nameZh, v.nameEn, v.rawVictoryType, v.winCheck, v.criticalPercentage ?? null,
      v.burstDefinition, v.defaultBurstTurn, v.sourceFlag, v.confidence,
    ]),
  );
  return victories.length;
}

export function seedEraWindows(
  kb: KnowledgeDb,
  source: DataSource,
  eras: EraWindowSpec[],
  labeler: Labeler,
): number {
  kb.db.prepare(`DELETE FROM kb_era_window WHERE source = ?;`).run(source);
  const rows: unknown[][] = [];
  for (const era of eras) {
    let min: number | null = null;
    let max: number | null = null;
    try {
      const r = kb.get<{ GameEraMinimumTurns: number; GameEraMaximumTurns: number }>(
        `SELECT GameEraMinimumTurns, GameEraMaximumTurns FROM Eras_XP1 WHERE EraType = ? LIMIT 1;`,
        era.eraId,
      );
      min = r?.GameEraMinimumTurns ?? null;
      max = r?.GameEraMaximumTurns ?? null;
    } catch {
      /* Eras_XP1 is absent in some base-only installs */
    }
    const label = labeler.pair("era", era.eraId);
    rows.push([
      source, era.eraId, era.eraIndex, label.zh, label.en,
      era.turnLo, era.turnHi, min, max, era.assumedWindow,
      "empirical", 0.6,
    ]);
  }
  insertRows(
    kb,
    "kb_era_window",
    ["source", "era_id", "era_index", "era_name_zh", "era_name_en", "turn_lo", "turn_hi",
      "db_min_turns", "db_max_turns", "assumed_window", "source_flag", "confidence"],
    rows,
  );
  return rows.length;
}

/** Populate `kb_speed_profile` so runtime views can show the active scaling. */
export function seedSpeedProfiles(kb: KnowledgeDb, speeds: SpeedProfileSpec[]): number {
  if (!kb.hasTable("kb_speed_profile")) return 0;
  kb.exec(`DELETE FROM kb_speed_profile;`);
  insertRows(
    kb,
    "kb_speed_profile",
    ["speed", "label_zh", "total_turns", "cost_multiplier", "source_table"],
    speeds.map((s) => [s.speed, s.labelZh ?? null, s.totalTurns, s.costMultiplier, "Gamespeeds"]),
  );
  return speeds.length;
}

/** Add a fallback dictionary row for any yield dimension discovered in raw tables. */export function ensureEffectDimensions(kb: KnowledgeDb): void {
  const rows = kb.all<{ dimension_id: string }>(
    `SELECT DISTINCT dimension_id FROM kb_effect WHERE dimension_id NOT IN (SELECT dimension_id FROM kb_dimension);`,
  );
  if (!rows.length) return;
  insertRows(
    kb,
    "kb_dimension",
    ["dimension_id", "name_zh", "name_en", "unit", "value_type", "aggregation", "direction", "observation", "notes"],
    rows.map((r) => [
      r.dimension_id,
      r.dimension_id,
      r.dimension_id,
      null,
      "real",
      "sum",
      "higher",
      "原始产出表推导",
      "由 atoms 自动补充",
    ]),
  );
}
