import type { KnowledgeDb } from "../db.js";

/**
 * Decision-knowledge layer (`kb_*`) schema.
 *
 * The layer is built offline from the raw game mirror and curated JSON specs,
 * then read by the plugin at runtime. Horizontal slices (a victory's burst
 * point) and vertical slices (the era ladder leading to it) share one table,
 * `kb_target`; the difference is only `slice_kind` plus constraint semantics.
 */
export const KB_SCHEMA_VERSION = 3;

export const KB_TABLES = [
  "kb_dimension",
  "kb_victory",
  "kb_era_window",
  "kb_plan",
  "kb_target",
  "kb_budget",
  "kb_check",
  "kb_effect",
  "kb_cost",
  "kb_unlock",
  "kb_closure",
  "kb_civ_profile",
  "kb_civ_entity_map",
  "kb_civ_delta",
  "kb_derivation",
  "kb_card",
  // v2: objective / constraint / path / focus / capability layers
  "kb_speed_profile",
  "kb_node",
  "kb_objective",
  "kb_constraint",
  "kb_constraint_lever",
  "kb_path",
  "kb_path_node",
  "kb_era_focus",
  "kb_civ_capability",
  // v3: supply ledger / cuts / scenarios / robustness
  "kb_supply_source",
  "kb_ledger",
  "kb_cut",
  "kb_scenario",
  "kb_robustness",
] as const;

export const KB_VIEWS = [
  "v_kb_burst",
  "v_kb_ladder",
  "v_kb_civ_board",
  "v_kb_objective",
  "v_kb_path",
  "v_kb_focus",
  "v_kb_ledger",
] as const;

const DDL = `
CREATE TABLE IF NOT EXISTS kb_dimension (
  dimension_id TEXT PRIMARY KEY,
  name_zh TEXT NOT NULL,
  name_en TEXT,
  unit TEXT,
  value_type TEXT NOT NULL CHECK (value_type IN ('int','real','bool')),
  aggregation TEXT NOT NULL CHECK (aggregation IN ('sum','count','max','min','mean','last')),
  direction TEXT NOT NULL CHECK (direction IN ('higher','lower','band')),
  observation TEXT,
  notes TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS kb_victory (
  victory_id TEXT PRIMARY KEY,
  name_zh TEXT NOT NULL,
  name_en TEXT,
  raw_victory_type TEXT,
  win_check TEXT NOT NULL,
  critical_percentage REAL,
  burst_definition TEXT,
  default_burst_turn INTEGER,
  source_flag TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS kb_era_window (
  source TEXT NOT NULL,
  era_id TEXT NOT NULL,
  era_index INTEGER NOT NULL,
  era_name_zh TEXT,
  era_name_en TEXT,
  turn_lo INTEGER,
  turn_hi INTEGER,
  db_min_turns INTEGER,
  db_max_turns INTEGER,
  assumed_window INTEGER,
  source_flag TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  PRIMARY KEY (source, era_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS kb_plan (
  plan_id TEXT PRIMARY KEY,
  victory_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('vanilla','bbg')),
  speed TEXT NOT NULL DEFAULT 'standard',
  difficulty TEXT NOT NULL DEFAULT 'deity',
  map_profile TEXT NOT NULL DEFAULT 'standard_continents',
  burst_turn INTEGER NOT NULL,
  burst_era TEXT NOT NULL,
  summary TEXT,
  assumptions TEXT,
  model_version TEXT NOT NULL,
  raw_built_at TEXT,
  built_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS kb_target (
  target_id INTEGER PRIMARY KEY,
  target_key TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'final' CHECK (stage IN ('opening','mid','final')),
  slice_kind TEXT NOT NULL CHECK (slice_kind IN ('burst','era')),
  era_id TEXT,
  turn_lo INTEGER,
  turn_hi INTEGER,
  category TEXT NOT NULL CHECK (category IN
    ('tech','civic','policy','government','building','district','unit',
     'project','greatperson','improvement','resource','metric','gate')),
  entity_id TEXT,
  dimension_id TEXT,
  op TEXT NOT NULL CHECK (op IN ('=','>=','<=','between','contains','ratio')),
  value_num REAL,
  value_lo REAL,
  value_hi REAL,
  value_text TEXT,
  unit TEXT,
  role TEXT NOT NULL CHECK (role IN ('blocking','enabling','support','optional')),
  priority INTEGER NOT NULL DEFAULT 3,
  label_zh TEXT,
  label_en TEXT,
  rationale TEXT,
  formula TEXT,
  check_hint TEXT,
  remedy TEXT,
  source_flag TEXT NOT NULL CHECK (source_flag IN ('db','rule','derived','empirical')),
  confidence REAL NOT NULL DEFAULT 0.5,
  provenance TEXT
);

CREATE INDEX IF NOT EXISTS idx_kb_target_plan_slice ON kb_target(plan_id, slice_kind, era_id);
CREATE INDEX IF NOT EXISTS idx_kb_target_entity ON kb_target(category, entity_id);
CREATE INDEX IF NOT EXISTS idx_kb_target_dim ON kb_target(dimension_id);
CREATE INDEX IF NOT EXISTS idx_kb_target_era ON kb_target(era_id, priority DESC);

CREATE TABLE IF NOT EXISTS kb_budget (
  budget_id INTEGER PRIMARY KEY,
  plan_id TEXT NOT NULL,
  slice_kind TEXT NOT NULL,
  era_id TEXT,
  currency TEXT NOT NULL,
  income REAL NOT NULL DEFAULT 0,
  expense REAL NOT NULL DEFAULT 0,
  net REAL NOT NULL DEFAULT 0,
  drivers TEXT,
  source_flag TEXT NOT NULL DEFAULT 'derived',
  confidence REAL NOT NULL DEFAULT 0.5
);
CREATE INDEX IF NOT EXISTS idx_kb_budget_plan ON kb_budget(plan_id, slice_kind, era_id, currency);

CREATE TABLE IF NOT EXISTS kb_check (
  check_id INTEGER PRIMARY KEY,
  plan_id TEXT NOT NULL,
  era_id TEXT,
  turn_lo INTEGER,
  turn_hi INTEGER,
  dimension_id TEXT NOT NULL,
  op TEXT NOT NULL,
  value_lo REAL,
  value_hi REAL,
  message TEXT NOT NULL,
  remedy TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
  priority INTEGER NOT NULL DEFAULT 3
);
CREATE INDEX IF NOT EXISTS idx_kb_check_plan ON kb_check(plan_id, turn_lo);

CREATE TABLE IF NOT EXISTS kb_effect (
  effect_id INTEGER PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  dimension_id TEXT NOT NULL,
  effect_kind TEXT NOT NULL,
  value REAL NOT NULL,
  value2 REAL,
  condition TEXT,
  requirement_set_id TEXT,
  source_table TEXT,
  source_pk TEXT,
  source_col TEXT,
  confidence REAL NOT NULL DEFAULT 1.0
);
CREATE INDEX IF NOT EXISTS idx_kb_effect_owner ON kb_effect(owner_kind, owner_id);
CREATE INDEX IF NOT EXISTS idx_kb_effect_dim ON kb_effect(dimension_id);

CREATE TABLE IF NOT EXISTS kb_cost (
  cost_id INTEGER PRIMARY KEY,
  ref_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount REAL NOT NULL,
  basis TEXT NOT NULL DEFAULT 'flat',
  progression_model TEXT,
  progression_param REAL,
  purchase_multiplier REAL,
  era_id TEXT,
  is_per_turn INTEGER NOT NULL DEFAULT 0,
  source_table TEXT,
  source_col TEXT,
  confidence REAL NOT NULL DEFAULT 1.0
);
CREATE INDEX IF NOT EXISTS idx_kb_cost_ref ON kb_cost(ref_kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_kb_cost_currency ON kb_cost(currency, is_per_turn);

CREATE TABLE IF NOT EXISTS kb_unlock (
  edge_id INTEGER PRIMARY KEY,
  child_kind TEXT NOT NULL,
  child_id TEXT NOT NULL,
  parent_kind TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  source_table TEXT
);
CREATE INDEX IF NOT EXISTS idx_kb_unlock_child ON kb_unlock(child_kind, child_id);
CREATE INDEX IF NOT EXISTS idx_kb_unlock_parent ON kb_unlock(parent_kind, parent_id);

CREATE TABLE IF NOT EXISTS kb_closure (
  root_kind TEXT NOT NULL,
  root_id TEXT NOT NULL,
  node_kind TEXT NOT NULL,
  node_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  PRIMARY KEY (root_kind, root_id, node_kind, node_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS kb_civ_profile (
  source TEXT NOT NULL,
  civ_id TEXT NOT NULL,
  leader_id TEXT,
  name_zh TEXT,
  name_en TEXT,
  unique_unit TEXT,
  unique_building TEXT,
  unique_district TEXT,
  unique_improvement TEXT,
  trait_ids TEXT,
  start_bias TEXT,
  playstyle_tags TEXT,
  supported_victories TEXT,
  summary TEXT,
  source_flag TEXT NOT NULL DEFAULT 'derived',
  confidence REAL NOT NULL DEFAULT 0.5,
  PRIMARY KEY (source, civ_id, leader_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS kb_civ_entity_map (
  source TEXT NOT NULL,
  civ_id TEXT NOT NULL,
  leader_id TEXT,
  slot_kind TEXT NOT NULL,
  base_id TEXT NOT NULL,
  unique_id TEXT NOT NULL,
  replaces_id TEXT,
  PRIMARY KEY (source, civ_id, leader_id, slot_kind, base_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS kb_civ_delta (
  delta_id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  civ_id TEXT NOT NULL,
  leader_id TEXT,
  victory_id TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('replace','add','multiply','remove','note')),
  value_num REAL,
  value_lo REAL,
  value_hi REAL,
  value_text TEXT,
  era_id TEXT,
  reason TEXT,
  source_flag TEXT NOT NULL DEFAULT 'empirical',
  confidence REAL NOT NULL DEFAULT 0.5
);
CREATE INDEX IF NOT EXISTS idx_kb_civ_delta ON kb_civ_delta(source, civ_id, victory_id);

CREATE TABLE IF NOT EXISTS kb_derivation (
  derivation_id INTEGER PRIMARY KEY,
  plan_id TEXT NOT NULL,
  slice_kind TEXT NOT NULL,
  era_id TEXT,
  output_dimension_id TEXT NOT NULL,
  expression TEXT NOT NULL,
  inputs TEXT,
  value REAL NOT NULL,
  unit TEXT,
  source_flag TEXT NOT NULL DEFAULT 'derived',
  confidence REAL NOT NULL DEFAULT 0.5
);
CREATE INDEX IF NOT EXISTS idx_kb_derivation_plan ON kb_derivation(plan_id, slice_kind, era_id);

CREATE TABLE IF NOT EXISTS kb_card (
  card_id TEXT PRIMARY KEY,
  plan_id TEXT,
  kind TEXT NOT NULL,
  victory_id TEXT,
  era_id TEXT,
  civ_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  refs TEXT,
  source_flag TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  built_at TEXT
) WITHOUT ROWID;

CREATE VIEW IF NOT EXISTS v_kb_burst AS
SELECT t.*, p.victory_id, p.source, p.burst_turn, p.difficulty, p.speed
FROM kb_target t JOIN kb_plan p ON p.plan_id = t.plan_id
WHERE t.slice_kind = 'burst';

CREATE VIEW IF NOT EXISTS v_kb_ladder AS
SELECT t.*, p.victory_id, p.source, p.burst_turn, w.era_index
FROM kb_target t
JOIN kb_plan p ON p.plan_id = t.plan_id
LEFT JOIN kb_era_window w ON w.source = p.source AND w.era_id = t.era_id
WHERE t.slice_kind = 'era';

CREATE VIEW IF NOT EXISTS v_kb_civ_board AS
SELECT cp.source, cp.civ_id, cp.leader_id, cp.name_zh, cp.name_en,
       cp.unique_unit, cp.unique_building, cp.unique_district, cp.unique_improvement,
       cp.playstyle_tags, cp.supported_victories,
       cem.slot_kind, cem.base_id, cem.unique_id, cem.replaces_id
FROM kb_civ_profile cp
LEFT JOIN kb_civ_entity_map cem
  ON cem.source = cp.source AND cem.civ_id = cp.civ_id
 AND (cem.leader_id = cp.leader_id OR cp.leader_id IS NULL);

-- ---------------------------------------------------------------------------
-- v2 layers: speed profile -> node -> objective -> path -> constraint ->
-- era focus -> civ capability. Every downstream row is derived from the
-- objective; the only authored inputs are kb/speeds.json, kb/objectives/*.json
-- and the capabilities in kb/civs/*.json.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kb_speed_profile (
  speed TEXT PRIMARY KEY,
  label_zh TEXT,
  total_turns INTEGER NOT NULL,
  cost_multiplier REAL NOT NULL,
  source_table TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS kb_node (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  label_zh TEXT,
  label_en TEXT,
  era_id TEXT,
  era_index INTEGER,
  cost_production REAL,
  cost_science REAL,
  cost_culture REAL,
  cost_gold REAL,
  cost_faith REAL,
  cost_basis TEXT,
  boost_percent REAL,
  boost_trigger_zh TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  PRIMARY KEY (kind, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_kb_node_era ON kb_node(era_id, era_index);

CREATE TABLE IF NOT EXISTS kb_objective (
  objective_id TEXT PRIMARY KEY,
  victory_id TEXT NOT NULL,
  civ_id TEXT,
  leader_id TEXT,
  speed TEXT NOT NULL DEFAULT 'standard',
  burst_turn INTEGER NOT NULL,
  burst_era TEXT NOT NULL,
  title TEXT,
  win_capsule TEXT,
  assumptions TEXT,
  source_flag TEXT NOT NULL DEFAULT 'rule',
  confidence REAL NOT NULL DEFAULT 0.6,
  built_at TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_kb_objective_civ ON kb_objective(victory_id, civ_id, leader_id, speed);

CREATE TABLE IF NOT EXISTS kb_constraint (
  constraint_key TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  unit TEXT,
  required REAL NOT NULL DEFAULT 0,
  required_source TEXT,
  supply_rate REAL NOT NULL DEFAULT 0,
  supply_source TEXT,
  window INTEGER NOT NULL,
  tightness REAL NOT NULL DEFAULT 0,
  slack REAL NOT NULL DEFAULT 0,
  binding_rank INTEGER,
  waived_by TEXT,
  notes TEXT,
  confidence REAL NOT NULL DEFAULT 0.5
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_kb_constraint_obj ON kb_constraint(objective_id, binding_rank);

CREATE TABLE IF NOT EXISTS kb_constraint_lever (
  lever_id INTEGER PRIMARY KEY,
  constraint_key TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  delta_per_unit REAL,
  cost_production REAL,
  cost_gold REAL,
  requires TEXT,
  why TEXT,
  source_flag TEXT NOT NULL DEFAULT 'rule'
);
CREATE INDEX IF NOT EXISTS idx_kb_lever_constraint ON kb_constraint_lever(constraint_key);

CREATE TABLE IF NOT EXISTS kb_path (
  objective_id TEXT PRIMARY KEY,
  node_count INTEGER NOT NULL,
  on_path_count INTEGER NOT NULL,
  detour_count INTEGER NOT NULL,
  dead_count INTEGER NOT NULL,
  total_cost TEXT,
  detour_cost TEXT,
  dead_nodes TEXT,
  built_from TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS kb_path_node (
  node_key TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('on_path','detour','dead')),
  group_id TEXT,
  depth INTEGER,
  era_due INTEGER,
  cost TEXT,
  enables TEXT,
  why TEXT,
  source_flag TEXT NOT NULL DEFAULT 'derived'
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_kb_path_node_obj ON kb_path_node(objective_id, role, era_due, depth);

CREATE TABLE IF NOT EXISTS kb_era_focus (
  focus_id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL,
  era_id TEXT NOT NULL,
  era_index INTEGER,
  turn_lo INTEGER,
  turn_hi INTEGER,
  rank INTEGER NOT NULL,
  constraint_key TEXT,
  action_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  ref_label TEXT,
  why TEXT,
  cost TEXT,
  alternative TEXT,
  abandon_if TEXT,
  checkpoint TEXT,
  ledger_gap REAL,
  supply_delta REAL,
  source_flag TEXT NOT NULL DEFAULT 'derived',
  confidence REAL NOT NULL DEFAULT 0.5
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_kb_focus_obj ON kb_era_focus(objective_id, era_index, rank);

CREATE TABLE IF NOT EXISTS kb_civ_capability (
  cap_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  civ_id TEXT NOT NULL,
  leader_id TEXT,
  trait_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('waive','convert','retarget','amplify','precondition')),
  target_ref TEXT,
  add_nodes TEXT,
  remove_nodes TEXT,
  value REAL,
  requires TEXT,
  effect_text_zh TEXT,
  why TEXT,
  confidence REAL NOT NULL DEFAULT 0.5
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_kb_cap_civ ON kb_civ_capability(source, civ_id, leader_id);

-- ---------------------------------------------------------------------------
-- v3: supply ledger -> per-era budget gate -> cut order -> scenario band.
-- Every currency an objective consumes is traced to named sources; the ledger
-- integrates them over turns and compares with the cumulative path cost, so
-- "can this era actually be finished?" is arithmetic, not narrative.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kb_supply_source (
  objective_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  per_unit REAL NOT NULL,
  copies REAL NOT NULL DEFAULT 1,
  copies_lo REAL,
  copies_hi REAL,
  from_turn INTEGER NOT NULL DEFAULT 1,
  per_pop INTEGER NOT NULL DEFAULT 0,
  requires TEXT,
  data_ref TEXT,
  source_flag TEXT NOT NULL DEFAULT 'empirical',
  confidence REAL NOT NULL DEFAULT 0.5,
  note TEXT,
  PRIMARY KEY (objective_id, source_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_kb_supply_obj ON kb_supply_source(objective_id, metric);

CREATE TABLE IF NOT EXISTS kb_ledger (
  objective_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  era_id TEXT NOT NULL,
  era_index INTEGER NOT NULL,
  metric TEXT NOT NULL,
  required_cum REAL NOT NULL,
  required_gross REAL NOT NULL,
  boost_credit REAL NOT NULL DEFAULT 0,
  supply_cum REAL NOT NULL,
  gap REAL NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('ok','short')),
  required_per_turn REAL NOT NULL,
  supply_per_turn REAL NOT NULL,
  window_turns INTEGER NOT NULL,
  binding_rank INTEGER,
  PRIMARY KEY (objective_id, scenario_id, era_id, metric)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_kb_ledger_obj ON kb_ledger(objective_id, scenario_id, era_index);

CREATE TABLE IF NOT EXISTS kb_cut (
  objective_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  cut_kind TEXT NOT NULL CHECK (cut_kind IN ('defer','drop')),
  ref_id TEXT,
  group_id TEXT,
  saves_json TEXT NOT NULL,
  lose TEXT NOT NULL,
  trigger TEXT,
  slip_turns INTEGER,
  PRIMARY KEY (objective_id, scenario_id, rank)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS kb_scenario (
  objective_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  label TEXT NOT NULL,
  assumptions TEXT,
  feasible INTEGER NOT NULL,
  first_gap_era TEXT,
  first_gap_amount REAL,
  burst_gap REAL,
  note TEXT,
  PRIMARY KEY (objective_id, scenario_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS kb_robustness (
  objective_id TEXT NOT NULL,
  decision_ref TEXT NOT NULL,
  decision_kind TEXT NOT NULL,
  invariant INTEGER NOT NULL,
  flips_in TEXT,
  trigger TEXT,
  PRIMARY KEY (objective_id, decision_ref)
) WITHOUT ROWID;

CREATE VIEW IF NOT EXISTS v_kb_ledger AS
SELECT l.*, o.burst_turn, o.burst_era, o.speed
FROM kb_ledger l JOIN kb_objective o ON o.objective_id = l.objective_id;


CREATE VIEW IF NOT EXISTS v_kb_objective AS
SELECT o.*, p.plan_id, p.summary AS plan_summary
FROM kb_objective o
LEFT JOIN kb_plan p ON p.victory_id = o.victory_id;

CREATE VIEW IF NOT EXISTS v_kb_path AS
SELECT n.*, p.total_cost AS path_total_cost, p.detour_cost AS path_detour_cost
FROM kb_path_node n JOIN kb_path p ON p.objective_id = n.objective_id;

CREATE VIEW IF NOT EXISTS v_kb_focus AS
SELECT f.*, c.metric AS constraint_metric, c.tightness AS constraint_tightness,
       c.binding_rank AS constraint_rank, c.waived_by AS constraint_waived_by
FROM kb_era_focus f
LEFT JOIN kb_constraint c ON c.constraint_key = f.constraint_key;
`;

/** Create the decision layer tables and views if they do not exist. */
export function ensureKbSchema(kb: KnowledgeDb): void {
  kb.exec(DDL);
}

/** Remove every derived KB object, views first. */
export function dropKbObjects(kb: KnowledgeDb): void {
  for (const view of KB_VIEWS) kb.exec(`DROP VIEW IF EXISTS "${view}";`);
  for (const table of KB_TABLES) kb.exec(`DROP TABLE IF EXISTS "${table}";`);
}

export function hasKbSchema(kb: KnowledgeDb): boolean {
  return (
    kb.hasTable("kb_plan") &&
    kb.hasTable("kb_target") &&
    kb.hasTable("kb_dimension") &&
    kb.hasTable("kb_card")
  );
}
