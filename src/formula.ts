import type { KnowledgeDb } from "./db.js";

/**
 * Build-time formula layer: one description, one executable formula.
 *
 * The effect layer (`effect_cards`) answers "what does the player-facing text
 * say". This layer answers "what does it do, exactly" — every modifier that
 * carries arithmetic is reduced to a row with
 *
 *   scope + dimension + op + value (+ per + condition)
 *
 * plus a `desc` rendered from the *same* binding, so description and formula
 * can never drift. Rows whose semantics cannot be bound are counted as
 * `unparsed` (never guessed, never silently dropped).
 *
 * The runtime evaluates these rows; it must not do arithmetic from prose.
 */

export const FORMULA_SCHEMA_VERSION = 1;

export interface FormulaStats {
  modifiers: number;
  formulas: number;
  tableFormulas: number;
  owners: number;
  byTemplate: Record<string, number>;
  unparsed: number;
  unparsedTypes: { type: string; rows: number }[];
  requirementSets: number;
  requirementLeaves: number;
  unsupportedLeaves: number;
}

export type FormulaScope =
  | "player"
  | "city"
  | "district"
  | "unit"
  | "plot"
  | "greatwork"
  | "project"
  | "diplomacy"
  | "other";

export type FormulaOp = "add" | "percent" | "multiply" | "grant" | "attach" | "set" | "max";

export interface FormulaRow {
  fx_id: string;
  modifier_id: string;
  modifier_type: string;
  template: string;
  scope: FormulaScope;
  dimension: string | null;
  op: FormulaOp;
  value: number | null;
  per: string | null;
  condition_set_id: string | null;
  desc: string;
  condition_json: string | null;
  src_table: string;
  confidence: number;
}

interface Args {
  [key: string]: string;
}

const YIELD_DIMENSION: Record<string, string> = {
  YIELD_SCIENCE: "science_per_turn",
  YIELD_CULTURE: "culture_per_turn",
  YIELD_FAITH: "faith_per_turn",
  YIELD_GOLD: "gold_per_turn",
  YIELD_PRODUCTION: "production_per_turn",
  YIELD_FOOD: "food_per_turn",
  YIELD_TOURISM: "tourism_per_turn",
  YIELD_DIPLOMATIC_FAVOR: "favor_per_turn",
  YIELD_GREAT_PERSON_POINTS: "great_person_points",
  YIELD_HOUSING: "housing",
  YIELD_AMENITIES: "amenities",
};

const DIMENSION_UNIT: Record<string, string> = {
  science_per_turn: "科技",
  culture_per_turn: "文化",
  faith_per_turn: "信仰",
  gold_per_turn: "金币",
  production_per_turn: "产能",
  food_per_turn: "食物",
  tourism_per_turn: "旅游",
  favor_per_turn: "外交资本",
  great_person_points: "伟人点",
  housing: "住房",
  amenities: "宜居",
  combat_strength: "战斗力",
  religious_strength: "宗教战斗力",
  movement: "移动力",
  sight: "视野",
  great_work_slots: "巨作槽",
  identity_per_turn: "宗教认同",
  experience: "经验",
  influence_points: "影响力",
  trade_routes: "商路",
  diplomatic_opinion: "外交好感",
  diplomatic_victory_points: "外交胜利点",
  purchase_cost: "购买成本",
  spy_chance: "间谍成功率",
  rock_band_level: "乐队等级",
  power: "电力",
  heal_per_turn: "回血",
  governor_points: "总督点",
  religious_building: "宗教建筑",
  all_yields: "全产出",
};

/** Modifier tables that attach a modifier to an owner, and the owner kind. */
const OWNER_TABLES: Array<[table: string, fk: string, kind: string]> = [
  ["BuildingModifiers", "BuildingType", "building"],
  ["DistrictModifiers", "DistrictType", "district"],
  ["PolicyModifiers", "PolicyType", "policy"],
  ["BeliefModifiers", "BeliefType", "belief"],
  ["ImprovementModifiers", "ImprovementType", "improvement"],
  ["TraitModifiers", "TraitType", "trait"],
  ["CivicModifiers", "CivicType", "civic"],
  ["TechnologyModifiers", "TechnologyType", "technology"],
  ["GovernmentModifiers", "GovernmentType", "government"],
  ["GovernorModifiers", "GovernorType", "governor"],
  ["GovernorPromotionModifiers", "GovernorPromotionType", "governor_promotion"],
  ["UnitAbilityModifiers", "UnitAbilityType", "unit"],
  ["UnitPromotionModifiers", "UnitPromotionType", "promotion"],
  ["ProjectCompletionModifiers", "ProjectType", "project"],
  ["GreatPersonIndividualBirthModifiers", "GreatPersonIndividualType", "greatperson"],
  ["GreatPersonIndividualActionModifiers", "GreatPersonIndividualType", "greatperson"],
];

function num(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function scopeOf(type: string): FormulaScope {
  if (type.includes("PLAYER_CITIES") || type.includes("CITY_")) return "city";
  if (type.includes("DISTRICT")) return "district";
  if (type.includes("UNIT")) return "unit";
  if (type.includes("PLOT")) return "plot";
  if (type.includes("GREATWORK")) return "greatwork";
  if (type.includes("PROJECT")) return "project";
  if (type.includes("DIPLOMACY")) return "diplomacy";
  if (type.startsWith("MODIFIER_PLAYER")) return "player";
  return "other";
}

function perOf(type: string): string | null {
  if (type.includes("PER_POP") || type.includes("PER_CITIZEN")) return "pop";
  if (type.includes("PER_ADJACENT") || type.includes("ADJACENCY")) return "adjacent";
  if (type.includes("PER_TRADE_ROUTE")) return "trade_route";
  if (type.includes("PER_ERA")) return "era";
  if (type.includes("PER_RESOURCE")) return "resource";
  if (type.includes("PER_TURN")) return "turn";
  return null;
}

/** `YIELD_X` -> dimension key; anything else falls back to a stable slug. */
function dimensionOf(yieldType: string | undefined): string | null {
  if (!yieldType) return null;
  const raw = yieldType.trim();
  if (!raw) return null;
  if (YIELD_DIMENSION[raw]) return YIELD_DIMENSION[raw];
  if (raw.startsWith("YIELD_")) {
    return `yield_${raw.toLowerCase().replace(/^yield_/, "").replace(/[^a-z0-9_]/g, "_")}`;
  }
  return null;
}

function dimensionLabel(dimension: string | null): string {
  if (!dimension) return "";
  return DIMENSION_UNIT[dimension] ?? dimension.replace(/_per_turn$/, "").replace(/_/g, "");
}

function scopePrefix(scope: FormulaScope): string {
  switch (scope) {
    case "city":
      return "本城";
    case "district":
      return "区域";
    case "unit":
      return "单位";
    case "plot":
      return "地块";
    case "greatwork":
      return "巨作";
    case "project":
      return "项目";
    case "diplomacy":
      return "外交";
    case "player":
      return "全局";
    default:
      return "";
  }
}

function clampDesc(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length <= 24 ? trimmed : `${trimmed.slice(0, 23)}…`;
}

/** Render the short player-facing description from the same binding. */
function renderDesc(row: Omit<FormulaRow, "desc">, targetLabel?: string): string {
  const unit = dimensionLabel(row.dimension);
  const prefix = scopePrefix(row.scope);
  const per = row.per === "pop" ? "/人口" : row.per === "adjacent" ? "/邻接" : row.per === "era" ? "/时代" : "";
  const signed = row.value === null ? "" : row.value >= 0 ? `+${row.value}` : `${row.value}`;
  switch (row.op) {
    case "add":
      return clampDesc(`${prefix}${unit}${signed}${per}`);
    case "percent":
      return clampDesc(`${prefix}${unit}${signed}%${per}`);
    case "multiply":
      return clampDesc(`${prefix}${unit}×${row.value ?? "?"}${per}`);
    case "grant":
      return clampDesc(`获得${targetLabel ?? row.dimension ?? "能力"}`);
    case "attach":
      return clampDesc(`附加 ${targetLabel ?? "修正"}`);
    case "set":
    case "max":
      return clampDesc(`${prefix}${unit} = ${row.value ?? "?"}`);
    default:
      return clampDesc(`${prefix}${unit} ${signed}`);
  }
}

interface Bound {
  template: string;
  scope: FormulaScope;
  dimension: string | null;
  op: FormulaOp;
  value: number | null;
  per: string | null;
  targetLabel?: string;
}

/** Dimension inferred from the modifier type name, for types without YieldType. */
const DIMENSION_HINTS: Array<[RegExp, string]> = [
  [/_PRODUCTION/, "production_per_turn"],
  [/_TOURISM/, "tourism_per_turn"],
  [/_EXPERIENCE/, "experience"],
  [/_INFLUENCE_POINTS/, "influence_points"],
  [/_TRADE_ROUTE_CAPACITY/, "trade_routes"],
  [/_HOUSING/, "housing"],
  [/_AMENIT/, "amenities"],
  [/_DIPLOMATIC_FAVOR|_FAVOR/, "favor_per_turn"],
  [/_DIPLOMATIC_VICTORY_POINTS/, "diplomatic_victory_points"],
  [/_ALL_YIELDS/, "all_yields"],
  [/_GREAT_PERSON_POINT|_HAPPINESS_GREAT_PERSON/, "great_person_points"],
  [/_GOVERNOR_POINTS/, "governor_points"],
  [/_COMBAT|_STRENGTH/, "combat_strength"],
  [/_MOVEMENT/, "movement"],
  [/_SIGHT/, "sight"],
  [/_IDENTITY/, "identity_per_turn"],
  [/_RELIGIOUS_BUILDING/, "religious_building"],
  [/_RELIGIOUS/, "religious_strength"],
  [/_SPY_OPERATION_CHANCE/, "spy_chance"],
  [/_ROCK_BAND_LEVEL/, "rock_band_level"],
  [/_FREE_POWER|_POWER\b/, "power"],
  [/_HEAL/, "heal_per_turn"],
  [/_PURCHASE_COST/, "purchase_cost"],
  [/_CULTURE/, "culture_per_turn"],
  [/_SCIENCE/, "science_per_turn"],
  [/_FAITH/, "faith_per_turn"],
  [/_GOLD/, "gold_per_turn"],
  [/_FOOD/, "food_per_turn"],
];

function dimensionFromType(type: string): string | null {
  for (const [pattern, dimension] of DIMENSION_HINTS) {
    if (pattern.test(type)) return dimension;
  }
  return null;
}

/** The first argument that names an entity the modifier acts on. */
function targetOf(args: Args): string | null {
  const keys = [
    "UnitType",
    "BuildingType",
    "DistrictType",
    "TechnologyType",
    "TechType",
    "CivicType",
    "PolicyType",
    "ResourceType",
    "ImprovementType",
    "GreatWorkObjectType",
    "RelicType",
    "UnitAbilityType",
    "AbilityType",
    "UnitPromotionClass",
    "GreatPersonClassType",
    "ProjectType",
  ];
  for (const key of keys) if (args[key]) return args[key];
  return null;
}

function isPercentType(type: string): boolean {
  return /_MODIFIER$|PERCENT|_PRODUCTION$/.test(type);
}

/**
 * Bind one modifier row to a formula, or return null when the semantics are
 * not understood. Conservative on purpose: an `unparsed` row is a visible gap,
 * a wrong row is a silent error.
 */
export function bindModifier(modifierType: string, args: Args): Bound | null {
  const amount =
    num(args.Amount) ??
    num(args.YieldChange) ??
    num(args.Value) ??
    num(args.Percent) ??
    num(args.Tourism) ??
    num(args.Points) ??
    num(args.Bonus) ??
    num(args.InitialValue);
  const yieldDim = dimensionOf(args.YieldType ?? args.Yield);
  const scope = scopeOf(modifierType);
  const per = perOf(modifierType);

  // --- non-arithmetic structural modifiers -------------------------------
  if (modifierType.includes("ATTACH_MODIFIER")) {
    const ref = args.ModifierId ?? args.ModifierType ?? null;
    if (!ref) return null;
    return { template: "attach_modifier", scope: "other", dimension: null, op: "attach", value: null, per: null, targetLabel: ref };
  }
  if (modifierType.includes("GRANT_ABILITY")) {
    const ref = args.AbilityType ?? args.UnitAbilityType ?? args.Type ?? null;
    if (!ref) return null;
    return { template: "grant_ability", scope, dimension: null, op: "grant", value: null, per: null, targetLabel: ref };
  }

  // --- adjacency (yield on adjacent terrain/feature/improvement) ---------
  if (/ADJACENCY/.test(modifierType)) {
    const dim = yieldDim ?? dimensionFromType(modifierType);
    if (dim && amount !== null) {
      return { template: "adjacency_yield", scope, dimension: dim, op: "add", value: amount, per: "adjacent" };
    }
    return null;
  }

  // --- combat / religious strength ---------------------------------------
  if (/COMBAT_STRENGTH|ADJUST_COMBAT|COMBAT_MODIFIER|GRANT_STRENGTH/.test(modifierType) && amount !== null) {
    const dim = /RELIGIOUS/.test(modifierType) ? "religious_strength" : "combat_strength";
    return { template: "unit_combat", scope, dimension: dim, op: "add", value: amount, per };
  }

  // --- tourism ------------------------------------------------------------
  if (/TOURISM/.test(modifierType) && amount !== null) {
    return { template: "tourism", scope, dimension: "tourism_per_turn", op: isPercentType(modifierType) ? "percent" : "add", value: amount, per };
  }

  // --- great person points ------------------------------------------------
  if (/GREAT_PERSON_POINT|HAPPINESS_GREAT_PERSON/.test(modifierType) && amount !== null) {
    return { template: "gpp", scope, dimension: "great_person_points", op: "add", value: amount, per, targetLabel: args.GreatPersonClassType };
  }

  // --- yields declared by argument ---------------------------------------
  if (yieldDim && amount !== null) {
    return {
      template: isPercentType(modifierType) ? "yield_percent" : "yield_flat",
      scope,
      dimension: yieldDim,
      op: isPercentType(modifierType) ? "percent" : "add",
      value: amount,
      per,
    };
  }

  // --- movement / sight / misc dimensions by type name --------------------
  if (amount !== null) {
    const dim = dimensionFromType(modifierType);
    if (dim) {
      return {
        template: "generic_amount",
        scope,
        dimension: dim,
        op: isPercentType(modifierType) ? "percent" : "add",
        value: amount,
        per,
        targetLabel: targetOf(args) ?? undefined,
      };
    }
  }

  // --- diplomacy ----------------------------------------------------------
  if (/DIPLOMACY_SIMPLE_MODIFIER/.test(modifierType)) {
    const initial = num(args.InitialValue);
    if (initial !== null) {
      return { template: "diplomacy_modifier", scope: "diplomacy", dimension: "diplomatic_opinion", op: "add", value: initial, per };
    }
  }

  // --- grants that carry no arithmetic -----------------------------------
  if (/GRANT|ENABLE|UNLOCK|ALLOW|FREE_|ADD_RELIGIOUS|ADD_CULTURE_BOMB|IGNORE_TERRAIN/.test(modifierType)) {
    return {
      template: "grant_entity",
      scope,
      dimension: null,
      op: "grant",
      value: amount,
      per: null,
      targetLabel: targetOf(args) ?? undefined,
    };
  }

  return null;
}

interface RequirementLeaf {
  requirement_id: string;
  type: string;
  args: Args;
  inverse: boolean;
}

/** Requirement types the runtime can evaluate; everything else is unsupported. */
export const SUPPORTED_REQUIREMENTS = new Set([
  "REQUIREMENT_PLOT_ADJACENT_TO_DISTRICT",
  "REQUIREMENT_PLOT_ADJACENT_TO_OWNER",
  "REQUIREMENT_CITY_HAS_DISTRICT",
  "REQUIREMENT_CITY_HAS_BUILDING",
  "REQUIREMENT_CITY_HAS_IMPROVEMENT",
  "REQUIREMENT_PLAYER_HAS_CIVIC",
  "REQUIREMENT_PLAYER_HAS_TECHNOLOGY",
  "REQUIREMENT_PLAYER_IS_CIVILIZATION",
  "REQUIREMENT_PLAYER_IS_LEADER",
  "REQUIREMENT_CITY_FOLLOWS_RELIGION",
  "REQUIREMENT_PLAYER_FOLLOWS_RELIGION",
  "REQUIREMENT_PLAYER_HAS_GOVERNMENT",
  "REQUIREMENT_PLAYER_HAS_POLICY",
  "REQUIREMENT_CITY_HAS_GOVERNOR",
  "REQUIREMENT_PLAYER_HAS_GOVERNOR",
]);

function readArgs(
  db: KnowledgeDb,
  table: string,
  fk: string,
  ids: string[],
  idCol: string,
): Map<string, Args> {
  const out = new Map<string, Args>();
  if (!ids.length || !db.hasTable(table)) return out;
  const chunk = 400;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const ph = slice.map(() => "?").join(",");
    const rows = db.all<Record<string, unknown>>(
      `SELECT * FROM "${table}" WHERE "${fk}" IN (${ph});`,
      ...slice,
    );
    for (const r of rows) {
      const id = String(r[idCol] ?? "");
      if (!id) continue;
      const name = String(r.Name ?? "");
      if (!name) continue;
      let m = out.get(id);
      if (!m) {
        m = {};
        out.set(id, m);
      }
      m[name] = String(r.Value ?? "");
    }
  }
  return out;
}

function ensureFormulaSchema(kb: KnowledgeDb): void {
  kb.exec(`
    DROP TABLE IF EXISTS "kb_formula";
    CREATE TABLE "kb_formula" (
      "fx_id" TEXT PRIMARY KEY,
      "modifier_id" TEXT NOT NULL,
      "modifier_type" TEXT NOT NULL,
      "template" TEXT NOT NULL,
      "scope" TEXT NOT NULL,
      "dimension" TEXT,
      "op" TEXT NOT NULL,
      "value" REAL,
      "per" TEXT,
      "condition_set_id" TEXT,
      "desc" TEXT NOT NULL,
      "condition_json" TEXT,
      "src_table" TEXT NOT NULL,
      "confidence" REAL NOT NULL DEFAULT 0.8
    );
    CREATE INDEX "idx_kb_formula_dim" ON "kb_formula" ("dimension", "op");
    DROP TABLE IF EXISTS "kb_formula_owner";
    CREATE TABLE "kb_formula_owner" (
      "owner_kind" TEXT NOT NULL,
      "owner_id" TEXT NOT NULL,
      "modifier_id" TEXT NOT NULL,
      "src_table" TEXT NOT NULL,
      PRIMARY KEY ("owner_kind", "owner_id", "modifier_id")
    );
    CREATE INDEX "idx_kb_formula_owner_id" ON "kb_formula_owner" ("owner_kind", "owner_id");
    DROP TABLE IF EXISTS "kb_requirement_set";
    CREATE TABLE "kb_requirement_set" (
      "set_id" TEXT PRIMARY KEY,
      "set_type" TEXT,
      "leaves_json" TEXT NOT NULL,
      "supported" INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function collectOwners(kb: KnowledgeDb): Map<string, Array<{ kind: string; id: string; table: string }>> {
  const byModifier = new Map<string, Array<{ kind: string; id: string; table: string }>>();
  for (const [table, fk, kind] of OWNER_TABLES) {
    if (!kb.hasTable(table)) continue;
    let rows: Record<string, unknown>[];
    try {
      rows = kb.all<Record<string, unknown>>(`SELECT "${fk}" AS owner, "ModifierId" AS m FROM "${table}";`);
    } catch {
      continue;
    }
    for (const r of rows) {
      const owner = String(r.owner ?? "");
      const m = String(r.m ?? "");
      if (!owner || !m) continue;
      let list = byModifier.get(m);
      if (!list) {
        list = [];
        byModifier.set(m, list);
      }
      list.push({ kind, id: owner, table });
    }
  }
  return byModifier;
}

function buildRequirementSets(kb: KnowledgeDb): { sets: number; leaves: number; unsupported: number } {
  if (!kb.hasTable("RequirementSets") || !kb.hasTable("Requirements")) {
    return { sets: 0, leaves: 0, unsupported: 0 };
  }
  const sets = kb.all<Record<string, unknown>>(`SELECT * FROM RequirementSets;`);
  const pairRows = kb.hasTable("RequirementSetRequirements")
    ? kb.all<{ RequirementSetId: string; RequirementId: string }>(
        `SELECT RequirementSetId, RequirementId FROM RequirementSetRequirements;`,
      )
    : [];
  const bySet = new Map<string, string[]>();
  const reqIds = new Set<string>();
  for (const p of pairRows) {
    const setId = String(p.RequirementSetId ?? "");
    const reqId = String(p.RequirementId ?? "");
    if (!setId || !reqId) continue;
    reqIds.add(reqId);
    let list = bySet.get(setId);
    if (!list) {
      list = [];
      bySet.set(setId, list);
    }
    list.push(reqId);
  }
  const reqRows = reqIds.size
    ? kb.all<Record<string, unknown>>(
        `SELECT * FROM Requirements WHERE RequirementId IN (${[...reqIds].map(() => "?").join(",")});`,
        ...[...reqIds],
      )
    : [];
  const reqById = new Map(reqRows.map((r) => [String(r.RequirementId), r]));
  const argsById = readArgs(kb, "RequirementArguments", "RequirementId", [...reqIds], "RequirementId");

  const ins = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_requirement_set (set_id, set_type, leaves_json, supported)
     VALUES (?,?,?,?);`,
  );
  let leafCount = 0;
  let unsupported = 0;
  let setCount = 0;
  for (const row of sets) {
    const setId = String(row.RequirementSetId ?? "");
    if (!setId) continue;
    const leaves: RequirementLeaf[] = [];
    let supported = true;
    for (const reqId of bySet.get(setId) ?? []) {
      const req = reqById.get(reqId);
      const type = String(req?.RequirementType ?? "");
      const args = argsById.get(reqId) ?? {};
      const inverse = String(req?.Inverse ?? "0") === "1";
      leaves.push({ requirement_id: reqId, type, args, inverse });
      leafCount++;
      if (!SUPPORTED_REQUIREMENTS.has(type)) {
        supported = false;
        unsupported++;
      }
    }
    ins.run(setId, String(row.RequirementSetType ?? ""), JSON.stringify(leaves), supported && leaves.length > 0 ? 1 : 0);
    setCount++;
  }
  return { sets: setCount, leaves: leafCount, unsupported };
}

/**
 * Formula rows derived from *table* effects (Building_YieldChanges, GPP,
 * citizen/per-era yields, ...). The effect layer already extracted these into
 * `effect_cards.effects_json`; reusing them here keeps a single extraction
 * path and gives every owner a formula next to its description.
 */
export function buildTableFormulas(kb: KnowledgeDb, opts: { inTransaction?: boolean } = {}): number {
  if (!kb.hasTable("effect_cards") || !kb.hasTable("kb_formula")) return 0;
  const ins = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_formula
      (fx_id, modifier_id, modifier_type, template, scope, dimension, op, value, per,
       condition_set_id, desc, condition_json, src_table, confidence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?);`,
  );
  const insOwner = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_formula_owner (owner_kind, owner_id, modifier_id, src_table)
     VALUES (?,?,?,?);`,
  );
  const SCOPE_BY_OWNER: Record<string, FormulaScope> = {
    building: "city",
    district: "city",
    improvement: "plot",
    resource: "plot",
    unit: "unit",
    project: "project",
    greatperson: "unit",
    policy: "player",
    belief: "player",
    government: "player",
    trait: "player",
    civilization: "player",
    leader: "player",
    governor_promotion: "city",
    promotion: "unit",
    technology: "player",
    civic: "player",
  };
  const PER_BY_KIND: Record<string, string | null> = {
    citizen: "pop",
    per_era: "era",
    trade_route: "trade_route",
    powered: null,
    yield: null,
    gpp: null,
  };
  let n = 0;
  if (!opts.inTransaction) kb.begin();
  try {
    const cards = kb.all<{ card_id: string; owner_kind: string; owner_id: string; effects_json: string }>(
      `SELECT card_id, owner_kind, owner_id, effects_json FROM effect_cards;`,
    );
    for (const card of cards) {
      let effects: Array<Record<string, unknown>> = [];
      try {
        effects = JSON.parse(card.effects_json) as Array<Record<string, unknown>>;
      } catch {
        continue;
      }
      const scope = SCOPE_BY_OWNER[card.owner_kind] ?? "other";
      let idx = 0;
      // The same (dimension, value, condition) can appear twice inside one card
      // (base + replacement rows). Counting it twice would inflate supply, so
      // identical bindings are collapsed per owner.
      const seen = new Set<string>();
      for (const effect of effects) {
        const dimension = typeof effect.unit === "string" ? effect.unit : null;
        const value = typeof effect.value === "number" ? effect.value : null;
        if (!dimension || value === null) continue;
        const kind = String(effect.kind ?? "yield");
        const source = (effect.source ?? {}) as { table?: string; pk?: string; col?: string };
        const per = PER_BY_KIND[kind] ?? null;
        const dedupeKey = `${dimension}|${value}|${per ?? ""}|${kind === "powered" ? "powered" : ""}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        idx += 1;
        const draft: Omit<FormulaRow, "desc"> = {
          fx_id: `fx:t:${card.owner_kind}:${card.owner_id}:${idx}`,
          // The owner prefix makes modifier_id unique: two owners can share the
          // same source row (base/replacement districts), and a non-unique id
          // would cross-join them in kb_formula_owner.
          modifier_id: `${card.owner_kind}:${card.owner_id}:${source.table ?? "table"}:${source.pk ?? card.owner_id}:${source.col ?? kind}:${idx}`,
          modifier_type: `TABLE_${String(source.table ?? kind).toUpperCase()}`,
          template: "table_effect",
          scope,
          dimension,
          op: "add",
          value,
          per,
          condition_set_id: null,
          condition_json: kind === "powered" ? JSON.stringify({ powered: true }) : null,
          src_table: source.table ?? "effect_cards",
          confidence: 0.95,
        };
        ins.run(
          draft.fx_id,
          draft.modifier_id,
          draft.modifier_type,
          draft.template,
          draft.scope,
          draft.dimension,
          draft.op,
          draft.value,
          draft.per,
          draft.condition_set_id,
          renderDesc(draft),
          draft.condition_json,
          draft.src_table,
          draft.confidence,
        );
        insOwner.run(card.owner_kind, card.owner_id, draft.modifier_id, draft.src_table);
        n += 1;
      }
    }
    if (!opts.inTransaction) kb.commit();
  } catch (error) {
    if (!opts.inTransaction) {
      try {
        kb.exec("ROLLBACK;");
      } catch {
        /* no active transaction */
      }
    }
    throw error;
  }
  return n;
}

/**
 * Build `kb_formula`, `kb_formula_owner` and `kb_requirement_set`.
 * Every row is bound from `Modifiers` + `ModifierArguments`; unbound rows are
 * reported by type so the gap is visible and countable.
 */
export function buildFormulas(kb: KnowledgeDb, opts: { inTransaction?: boolean } = {}): FormulaStats {
  ensureFormulaSchema(kb);
  if (!kb.hasTable("Modifiers") || !kb.hasTable("ModifierArguments")) {
    return {
      modifiers: 0,
      formulas: 0,
      tableFormulas: 0,
      owners: 0,
      byTemplate: {},
      unparsed: 0,
      unparsedTypes: [],
      requirementSets: 0,
      requirementLeaves: 0,
      unsupportedLeaves: 0,
    };
  }

  const modifiers = kb.all<Record<string, unknown>>(`SELECT * FROM Modifiers;`);
  const modifierIds = modifiers.map((m) => String(m.ModifierId ?? "")).filter(Boolean);
  const argsById = readArgs(kb, "ModifierArguments", "ModifierId", modifierIds, "ModifierId");
  const owners = collectOwners(kb);
  const requirementStats = buildRequirementSets(kb);

  const insFormula = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_formula
      (fx_id, modifier_id, modifier_type, template, scope, dimension, op, value, per,
       condition_set_id, desc, condition_json, src_table, confidence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?);`,
  );
  const insOwner = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_formula_owner (owner_kind, owner_id, modifier_id, src_table)
     VALUES (?,?,?,?);`,
  );

  const byTemplate: Record<string, number> = {};
  const unparsedByType = new Map<string, number>();
  let formulas = 0;
  let ownerRows = 0;
  let unparsed = 0;

  if (!opts.inTransaction) kb.begin();
  try {
    for (const row of modifiers) {
      const modifierId = String(row.ModifierId ?? "");
      if (!modifierId) continue;
      const modifierType = String(row.ModifierType ?? "");
      const args = argsById.get(modifierId) ?? {};
      const bound = bindModifier(modifierType, args);
      if (!bound) {
        unparsed++;
        unparsedByType.set(modifierType, (unparsedByType.get(modifierType) ?? 0) + 1);
        continue;
      }
      const conditionSetId =
        (row.OwnerRequirementSetId as string | null) ?? (row.SubjectRequirementSetId as string | null) ?? null;
      const draft: Omit<FormulaRow, "desc"> = {
        fx_id: `fx:${modifierId}`,
        modifier_id: modifierId,
        modifier_type: modifierType,
        template: bound.template,
        scope: bound.scope,
        dimension: bound.dimension,
        op: bound.op,
        value: bound.value,
        per: bound.per,
        condition_set_id: conditionSetId,
        condition_json: conditionSetId ? JSON.stringify({ set: conditionSetId }) : null,
        src_table: "Modifiers",
        confidence:
          bound.template === "grant_ability" || bound.template === "attach_modifier"
            ? 0.9
            : bound.template === "generic_amount"
              ? 0.5
              : bound.template === "grant_entity"
                ? 0.6
                : 0.75,
      };
      insFormula.run(
        draft.fx_id,
        draft.modifier_id,
        draft.modifier_type,
        draft.template,
        draft.scope,
        draft.dimension,
        draft.op,
        draft.value,
        draft.per,
        draft.condition_set_id,
        renderDesc(draft, bound.targetLabel),
        draft.condition_json,
        draft.src_table,
        draft.confidence,
      );
      formulas++;
      byTemplate[bound.template] = (byTemplate[bound.template] ?? 0) + 1;
      for (const owner of owners.get(modifierId) ?? []) {
        insOwner.run(owner.kind, owner.id, modifierId, owner.table);
        ownerRows++;
      }
    }
    if (!opts.inTransaction) kb.commit();
  } catch (error) {
    if (!opts.inTransaction) {
      try {
        kb.exec("ROLLBACK;");
      } catch {
        /* no active transaction */
      }
    }
    throw error;
  }

  const unparsedTypes = [...unparsedByType.entries()]
    .map(([type, rows]) => ({ type, rows }))
    .sort((a, b) => b.rows - a.rows);

  return {
    modifiers: modifiers.length,
    formulas,
    tableFormulas: 0,
    owners: ownerRows,
    byTemplate,
    unparsed,
    unparsedTypes,
    requirementSets: requirementStats.sets,
    requirementLeaves: requirementStats.leaves,
    unsupportedLeaves: requirementStats.unsupported,
  };
}
