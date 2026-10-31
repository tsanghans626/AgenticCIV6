import type { KnowledgeDb } from "./db.js";
import type { DataSource } from "./config.js";
import { SPECS, type EntitySpec } from "./entities.js";

/**
 * Build-time effect layer.
 *
 * The raw mirror answers "what is the column value". This module answers
 * "what does the player-facing effect say", by combining three authorities:
 *
 *   1. the entity's official localized description (row.Description);
 *   2. direct table effects (yields, GPP, great-work slots, adjacency, ...);
 *   3. ModifierStrings + ModifierArguments (localized and formatted).
 *
 * Anything that cannot be resolved is kept in `unresolved` with its raw
 * modifier data. The runtime never invents text for those gaps.
 */

export const EFFECT_SCHEMA_VERSION = 1;

export interface EffectSource {
  table: string;
  pk: string;
  col?: string | null;
  modifierId?: string | null;
}

export interface EffectLine {
  kind: string;
  text_zh: string | null;
  text_en: string | null;
  value: number | null;
  unit: string | null;
  condition_zh: string | null;
  condition_en: string | null;
  source: EffectSource;
  authority: "official" | "table" | "modifier_summary";
  resolved: boolean;
  languageFallback: boolean;
  raw_text: string | null;
}

export interface AttributeLine {
  key: string;
  label_zh: string;
  label_en: string;
  value: string | number;
  unit: string | null;
  source: EffectSource;
}

export interface UnresolvedEffect {
  modifierId: string;
  modifierType: string;
  arguments: Record<string, string>;
  requirementSetId: string | null;
  reason: string;
}

export interface EffectCoverage {
  effects: number;
  unresolved: number;
  hasOfficialDescription: boolean;
  hasTableEffects: boolean;
  hasModifierEffects: boolean;
  primaryResolved: boolean;
}

export interface EffectCard {
  card_id: string;
  owner_kind: string;
  owner_id: string;
  description_zh: string | null;
  description_en: string | null;
  attributes: AttributeLine[];
  effects: EffectLine[];
  unresolved: UnresolvedEffect[];
  coverage: EffectCoverage;
  ruleset_id: string;
  built_at: string;
}

export interface EffectStats {
  cards: number;
  effects: number;
  resolved: number;
  unresolved: number;
  modifierTexts: number;
  requirementTexts: number;
}

interface TextResult {
  text: string | null;
  raw: string | null;
  resolved: boolean;
  fallback: boolean;
}

/** Memoized LocalizedText lookup with an English fallback for zh_Hans_CN. */
class TextIndex {
  private readonly cache = new Map<string, { text: string | undefined; fallback: boolean }>();
  private readonly stmt: any;
  private readonly kb: KnowledgeDb;
  private readonly lang: string;
  private readonly fallbackLang: string | null;

  constructor(kb: KnowledgeDb, lang: string, fallbackLang: string | null = null) {
    this.kb = kb;
    this.lang = lang;
    this.fallbackLang = fallbackLang;
    this.stmt = this.kb.db.prepare(
      `SELECT Text FROM LocalizedText WHERE Tag = ? AND Language = ? LIMIT 1;`,
    );
  }

  get(tag: string | null | undefined): { text: string; fallback: boolean } | undefined {
    if (typeof tag !== "string" || !tag) return undefined;
    const cached = this.cache.get(tag);
    if (cached) return cached.text ? { text: cached.text, fallback: cached.fallback } : undefined;

    const row = this.stmt.get(tag, this.lang) as { Text?: string } | undefined;
    if (row?.Text) {
      this.cache.set(tag, { text: row.Text, fallback: false });
      return { text: row.Text, fallback: false };
    }
    if (this.fallbackLang) {
      const fb = this.stmt.get(tag, this.fallbackLang) as { Text?: string } | undefined;
      if (fb?.Text) {
        this.cache.set(tag, { text: fb.Text, fallback: true });
        return { text: fb.Text, fallback: true };
      }
    }
    this.cache.set(tag, { text: undefined, fallback: false });
    return undefined;
  }
}

const YIELD_UNITS: Record<string, string> = {
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

const STAT_LABELS: Record<string, { zh: string; en: string; unit?: string }> = {
  Cost: { zh: "生产力成本", en: "Production cost" },
  Maintenance: { zh: "维护费", en: "Maintenance" },
  Housing: { zh: "住房", en: "Housing" },
  Entertainment: { zh: "宜居度", en: "Amenities" },
  CitizenSlots: { zh: "市民槽", en: "Citizen slots" },
  PrereqTech: { zh: "前置科技", en: "Prerequisite tech" },
  PrereqCivic: { zh: "前置市政", en: "Prerequisite civic" },
  PrereqDistrict: { zh: "前置区域", en: "Prerequisite district" },
  RegionalRange: { zh: "区域范围", en: "Regional range" },
  OuterDefenseStrength: { zh: "外围防御力", en: "Outer defense strength" },
  DefenseModifier: { zh: "防御修正", en: "Defense modifier" },
  IsWonder: { zh: "奇观", en: "Wonder" },
  PurchaseYield: { zh: "购买资源", en: "Purchase yield" },
  RequiresPopulation: { zh: "需要人口", en: "Requires population" },
  OnePerCity: { zh: "每城一座", en: "One per city" },
  Aqueduct: { zh: "水渠", en: "Aqueduct" },
  InternalOnly: { zh: "仅内部", en: "Internal only" },
  ZOC: { zh: "控制区", en: "Zone of control" },
  AirSlots: { zh: "空中槽位", en: "Air slots" },
  MovementCost: { zh: "移动消耗", en: "Movement cost" },
  Appeal: { zh: "魅力", en: "Appeal" },
  Mountain: { zh: "山地", en: "Mountain" },
  Hills: { zh: "丘陵", en: "Hills" },
  Water: { zh: "水域", en: "Water" },
  Impassable: { zh: "不可通行", en: "Impassable" },
  NaturalWonder: { zh: "自然奇观", en: "Natural wonder" },
  Removable: { zh: "可移除", en: "Removable" },
  Forest: { zh: "森林", en: "Forest" },
  ResourceClassType: { zh: "资源类别", en: "Resource class" },
  Happiness: { zh: "幸福度", en: "Happiness" },
  Frequency: { zh: "频率", en: "Frequency" },
  GreatPersonClassType: { zh: "伟人类型", en: "Great person class" },
  EraType: { zh: "时代", en: "Era" },
  ActionCharges: { zh: "行动次数", en: "Action charges" },
  BeliefClassType: { zh: "教条类别", en: "Belief class" },
  Combat: { zh: "战斗力", en: "Combat strength" },
  RangedCombat: { zh: "远程战斗力", en: "Ranged strength" },
  BaseMoves: { zh: "移动力", en: "Movement" },
  BaseSightRange: { zh: "视野", en: "Sight" },
  Domain: { zh: "领域", en: "Domain" },
  FormationClass: { zh: "编队", en: "Formation class" },
  PromotionClass: { zh: "晋升类别", en: "Promotion class" },
  StrategicResource: { zh: "战略资源", en: "Strategic resource" },
  Range: { zh: "射程", en: "Range" },
  Bombard: { zh: "轰炸", en: "Bombard" },
  AntiAirCombat: { zh: "防空战斗力", en: "Anti-air strength" },
  ReligiousStrength: { zh: "宗教战斗力", en: "Religious strength" },
  SpreadCharges: { zh: "传播次数", en: "Spread charges" },
  BuildCharges: { zh: "建造次数", en: "Build charges" },
  Tier: { zh: "层级", en: "Tier" },
  OtherGovernmentIntolerance: { zh: "政体容忍度", en: "Government intolerance" },
  InfluencePointsPerTurn: { zh: "每回合影响力", en: "Influence per turn" },
  GovernmentSlotType: { zh: "政体槽位", en: "Government slot" },
  RequiresGovernmentUnlock: { zh: "需要政体解锁", en: "Requires government unlock" },
  Buildable: { zh: "可建造", en: "Buildable" },
  UITreeRow: { zh: "科技树行", en: "Tree row" },
  Critical: { zh: "关键科技", en: "Critical" },
};

const FLAG_COLUMNS = new Set([
  "IsWonder",
  "RequiresPopulation",
  "OnePerCity",
  "Aqueduct",
  "InternalOnly",
  "ZOC",
  "Mountain",
  "Hills",
  "Water",
  "Impassable",
  "NaturalWonder",
  "Removable",
  "Forest",
  "Buildable",
  "RequiresGovernmentUnlock",
  "Critical",
]);

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

function selectIn(
  kb: KnowledgeDb,
  sql: (ph: string) => string,
  values: string[],
  leading: (string | number)[] = [],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < values.length; i += 400) {
    const chunk = values.slice(i, i + 400);
    if (!chunk.length) continue;
    out.push(
      ...kb.all<Record<string, unknown>>(
        sql(chunk.map(() => "?").join(",")),
        ...leading,
        ...chunk,
      ),
    );
  }
  return out;
}

function groupBy(rows: Record<string, unknown>[], key: string): Map<string, Record<string, unknown>[]> {
  const out = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const k = String(row[key] ?? "");
    if (!k) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(row);
  }
  return out;
}

function yieldUnit(yieldType: string): string {
  return YIELD_UNITS[yieldType] ?? `yield_${yieldType.toLowerCase().replace(/^yield_/, "")}`;
}

function yieldName(yieldType: string, zh: TextIndex, en: TextIndex): { zh: string; en: string } {
  const tag = `LOC_${yieldType}_NAME`;
  return {
    zh: zh.get(tag)?.text ?? yieldType,
    en: en.get(tag)?.text ?? yieldType,
  };
}

function refName(value: string, zh: TextIndex, en: TextIndex): { zh: string; en: string } {
  if (!value || /^\d+$/.test(value)) return { zh: value, en: value };
  const candidates = [`LOC_${value}_NAME`, `LOC_${value}`];
  for (const tag of candidates) {
    const z = zh.get(tag);
    const e = en.get(tag);
    if (z || e) return { zh: z?.text ?? e?.text ?? value, en: e?.text ?? z?.text ?? value };
  }
  return { zh: value, en: value };
}

function localizeArg(value: string, argName: string, zh: TextIndex, en: TextIndex): { zh: string; en: string } {
  if (!value) return { zh: value, en: value };
  if (/^\d+(\.\d+)?$/.test(value)) return { zh: value, en: value };
  if (value.startsWith("LOC_")) {
    const z = zh.get(value);
    const e = en.get(value);
    return { zh: z?.text ?? value, en: e?.text ?? value };
  }
  if (value.startsWith("YIELD_")) return yieldName(value, zh, en);
  const prefixes: Record<string, string[]> = {
    UnitType: ["UNIT_"],
    BuildingType: ["BUILDING_"],
    DistrictType: ["DISTRICT_"],
    ImprovementType: ["IMPROVEMENT_"],
    ResourceType: ["RESOURCE_"],
    FeatureType: ["FEATURE_"],
    TerrainType: ["TERRAIN_"],
    TechType: ["TECH_"],
    CivicType: ["CIVIC_"],
    PolicyType: ["POLICY_"],
    GovernmentType: ["GOVERNMENT_"],
    ProjectType: ["PROJECT_"],
    BeliefType: ["BELIEF_"],
    GreatPersonClassType: ["GREAT_PERSON_CLASS_"],
    UnitPromotionClass: ["PROMOTION_CLASS_"],
    EraType: ["ERA_"],
    GreatWorkObjectType: ["GREATWORKOBJECT_"],
    GreatWorkSlotType: ["GREATWORKSLOT_"],
  };
  const prefixesForArg = prefixes[argName] ?? [];
  for (const prefix of prefixesForArg) {
    if (value.startsWith(prefix)) {
      const suffix = value.slice(prefix.length);
      const tags = [`LOC_${prefix}${suffix}_NAME`, `LOC_${value}_NAME`, `LOC_${value}`];
      for (const tag of tags) {
        const z = zh.get(tag);
        const e = en.get(tag);
        if (z || e) return { zh: z?.text ?? e?.text ?? value, en: e?.text ?? z?.text ?? value };
      }
    }
  }
  return refName(value, zh, en);
}

function cleanText(text: string): string {
  return text
    .replace(/\[NEWLINE\]/gi, "\n")
    .replace(/\[(?:ICON|COLOR|ENDCOLOR)[^\]]*\]/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ +([，。；：、！？])/g, "$1")
    .trim();
}

/**
 * Resolve a LocalizedText tag/value, substitute ModifierArguments placeholders
 * (including Civ6's `{Amount : plural 1?x; other?y;}` form), and strip markup.
 */
export function formatGameText(
  raw: string | null | undefined,
  args: Record<string, string>,
  zh: TextIndex,
  en: TextIndex,
  pick: "zh" | "en" = "zh",
): TextResult {
  if (typeof raw !== "string" || !raw) return { text: null, raw: null, resolved: false, fallback: false };
  let text = raw;
  let fallback = false;
  if (text.startsWith("LOC_")) {
    const z = zh.get(text);
    const e = en.get(text);
    if (!z && !e) return { text: null, raw, resolved: false, fallback: false };
    text = z?.text ?? e?.text ?? text;
    fallback = !z?.text && !!e?.text;
  }
  const original = text;

  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    text = text.replace(/\{([A-Za-z0-9_]+)\s*:\s*([^{}]*)\}/g, (match, name: string, spec: string) => {
      const value = args[name];
      if (value === undefined) return match;
      const n = Number(value);
      const branches = spec
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      const branch =
        branches.find((s) => /^1\?/.test(s) && n === 1) ??
        branches.find((s) => /^other\?/.test(s)) ??
        branches[0];
      if (!branch) return match;
      changed = true;
      const q = branch.indexOf("?");
      return q >= 0 ? branch.slice(q + 1) : branch;
    });
    text = text.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
      const value = args[name];
      if (value === undefined) return match;
      changed = true;
      return localizeArg(value, name, zh, en)[pick];
    });
    if (!changed) break;
  }

  const unresolved = /\{[^{}]*\}/.test(text);
  return {
    text: unresolved ? null : cleanText(text),
    raw: cleanText(original),
    resolved: !unresolved,
    fallback,
  };
}

function formatTagBoth(
  raw: string | null | undefined,
  args: Record<string, string>,
  zh: TextIndex,
  en: TextIndex,
): { zh: TextResult; en: TextResult; raw: string | null } {
  const zhResult = formatGameText(raw, args, zh, en, "zh");
  const enResult = formatGameText(raw, args, en, zh, "en");
  return {
    zh: zhResult,
    en: enResult,
    raw: zhResult.raw ?? enResult.raw,
  };
}

function attrLabel(key: string): { zh: string; en: string; unit?: string } {
  return STAT_LABELS[key] ?? { zh: key, en: key };
}

function attrValue(
  key: string,
  value: unknown,
  zh: TextIndex,
  en: TextIndex,
): { zh: string; en: string } {
  if (value === null || value === undefined || value === "") return { zh: "", en: "" };
  if (typeof value === "boolean") return { zh: value ? "是" : "否", en: value ? "Yes" : "No" };
  const s = String(value);
  if (FLAG_COLUMNS.has(key) && (s === "0" || s === "1")) {
    return { zh: s === "1" ? "是" : "否", en: s === "1" ? "Yes" : "No" };
  }
  if (
    key.startsWith("Prereq") ||
    key === "EraType" ||
    key === "GreatPersonClassType" ||
    key === "BeliefClassType" ||
    key === "StrategicResource" ||
    key === "Domain" ||
    key === "FormationClass" ||
    key === "PromotionClass" ||
    key === "GovernmentSlotType" ||
    key === "PurchaseYield"
  ) {
    return refName(s, zh, en);
  }
  return { zh: s, en: s };
}

function addAttribute(
  card: EffectCard,
  key: string,
  value: unknown,
  table: string,
  pk: string,
  zh: TextIndex,
  en: TextIndex,
): void {
  if (value === null || value === undefined || value === "") return;
  const label = attrLabel(key);
  const display = attrValue(key, value, zh, en);
  if (!display.zh && !display.en) return;
  card.attributes.push({
    key,
    label_zh: label.zh,
    label_en: label.en,
    value: display.zh || display.en,
    unit: label.unit ?? null,
    source: { table, pk, col: key },
  });
}

function addEffect(
  card: EffectCard,
  effect: Omit<EffectLine, "languageFallback" | "raw_text"> & {
    languageFallback?: boolean;
    raw_text?: string | null;
  },
): void {
  if (!effect.text_zh && !effect.text_en) return;
  const key = `${effect.kind}|${effect.text_zh ?? ""}|${effect.text_en ?? ""}|${effect.source.table}|${effect.source.pk}|${effect.source.col ?? ""}|${effect.source.modifierId ?? ""}`;
  if ((card as any)._seen?.has(key)) return;
  (card as any)._seen ??= new Set<string>();
  (card as any)._seen.add(key);
  card.effects.push({
    ...effect,
    languageFallback: effect.languageFallback ?? false,
    raw_text: effect.raw_text ?? null,
  });
}

function addTagEffect(
  card: EffectCard,
  kind: string,
  tag: string | null | undefined,
  args: Record<string, string>,
  source: EffectSource,
  authority: EffectLine["authority"],
  zh: TextIndex,
  en: TextIndex,
  value: number | null = null,
  unit: string | null = null,
  conditionZh: string | null = null,
  conditionEn: string | null = null,
): void {
  if (!tag) return;
  const f = formatTagBoth(tag, args, zh, en);
  const textZh = f.zh.resolved ? f.zh.text : null;
  const textEn = f.en.resolved ? f.en.text : null;
  if (!textZh && !textEn) {
    card.unresolved.push({
      modifierId: source.modifierId ?? "",
      modifierType: "TEXT",
      arguments: args,
      requirementSetId: null,
      reason: `文本未能解析：${tag}`,
    });
    return;
  }
  addEffect(card, {
    kind,
    text_zh: textZh,
    text_en: textEn,
    value,
    unit,
    condition_zh: conditionZh,
    condition_en: conditionEn,
    source,
    authority,
    resolved: true,
    languageFallback: f.zh.fallback,
    raw_text: f.raw,
  });
}

function addSimpleEffect(
  card: EffectCard,
  kind: string,
  textZh: string,
  textEn: string,
  source: EffectSource,
  authority: EffectLine["authority"] = "table",
  value: number | null = null,
  unit: string | null = null,
  conditionZh: string | null = null,
  conditionEn: string | null = null,
): void {
  addEffect(card, {
    kind,
    text_zh: textZh,
    text_en: textEn,
    value,
    unit,
    condition_zh: conditionZh,
    condition_en: conditionEn,
    source,
    authority,
    resolved: true,
    languageFallback: false,
    raw_text: null,
  });
}

function addDescription(
  card: EffectCard,
  spec: EntitySpec,
  row: Record<string, unknown>,
  zh: TextIndex,
  en: TextIndex,
): void {
  const id = String(row[spec.pk]);
  const tag = str(row.Description);
  if (!tag) return;
  const f = formatTagBoth(tag, {}, zh, en);
  // Some official descriptions embed another lookup tag, e.g.
  // "{LOC_GOVERNOR_THE_CARDINAL_NAME} 是...". formatGameText leaves those as
  // unresolved placeholders because they are not ModifierArguments; resolve
  // them here so the canonical text never leaks LOC_ tokens.
  const resolveRefs = (text: string | null, primary: TextIndex, secondary: TextIndex): string | null => {
    if (!text) return null;
    let out = text;
    for (let pass = 0; pass < 4; pass++) {
      const next = out.replace(/\{(LOC_[A-Za-z0-9_]+)\}/g, (match, ref: string) => {
        return primary.get(ref)?.text ?? secondary.get(ref)?.text ?? match;
      });
      if (next === out) break;
      out = next;
    }
    return out;
  };
  const rawZh = f.zh.resolved ? f.zh.text : f.zh.raw;
  const rawEn = f.en.resolved ? f.en.text : f.en.raw;
  const descZh = resolveRefs(rawZh, zh, en);
  const descEn = resolveRefs(rawEn, en, zh);
  const fullyResolved = (text: string | null): text is string => !!text && !/\{[^{}]*\}/.test(text);
  card.description_zh = descZh;
  card.description_en = descEn;
  const textZh = fullyResolved(descZh) ? descZh : null;
  const textEn = fullyResolved(descEn) ? descEn : null;
  if (!textZh && !textEn) {
    card.unresolved.push({
      modifierId: "",
      modifierType: "DESCRIPTION",
      arguments: {},
      requirementSetId: null,
      reason: `描述未能解析：${tag}`,
    });
    return;
  }
  addEffect(card, {
    kind: "description",
    text_zh: textZh,
    text_en: textEn,
    value: null,
    unit: null,
    condition_zh: null,
    condition_en: null,
    source: { table: spec.table, pk: id, col: "Description" },
    authority: "official",
    resolved: true,
    languageFallback: f.zh.fallback,
    raw_text: f.raw,
  });
}

function addAttributes(
  card: EffectCard,
  spec: EntitySpec,
  row: Record<string, unknown>,
  zh: TextIndex,
  en: TextIndex,
): void {
  const id = String(row[spec.pk]);
  for (const col of spec.stats) {
    addAttribute(card, col, row[col], spec.table, id, zh, en);
  }
}

/* ------------------------------------------------------------------------- */
/* Direct table effects                                                      */
/* ------------------------------------------------------------------------- */

function addYieldEffect(
  card: EffectCard,
  kind: string,
  table: string,
  id: string,
  amount: number,
  yieldType: string,
  zh: TextIndex,
  en: TextIndex,
  prefixZh: string,
  prefixEn: string,
  conditionZh: string | null = null,
  conditionEn: string | null = null,
): void {
  if (!Number.isFinite(amount) || amount === 0) return;
  const yn = yieldName(yieldType, zh, en);
  addSimpleEffect(
    card,
    kind,
    `${conditionZh ? conditionZh + "：" : ""}${prefixZh} +${amount} ${yn.zh}`,
    `${conditionEn ? conditionEn + ": " : ""}${prefixEn} +${amount} ${yn.en}`,
    { table, pk: id, col: "YieldChange" },
    "table",
    amount,
    yieldUnit(yieldType),
    conditionZh,
    conditionEn,
  );
}

function addGppEffect(
  card: EffectCard,
  table: string,
  id: string,
  amount: number,
  cls: string,
  zh: TextIndex,
  en: TextIndex,
  prefixZh = "每回合",
  prefixEn = "Per turn",
): void {
  if (!Number.isFinite(amount) || amount === 0) return;
  const name = refName(cls, zh, en);
  addSimpleEffect(
    card,
    "gpp",
    `${prefixZh} +${amount} ${name.zh}点数`,
    `${prefixEn} +${amount} ${name.en} points`,
    { table, pk: id, col: "PointsPerTurn" },
    "table",
    amount,
    "great_person_points",
  );
}

function addBuildingEffects(kb: KnowledgeDb, card: EffectCard, id: string, zh: TextIndex, en: TextIndex): void {
  for (const r of kb.all<Record<string, unknown>>(
    `SELECT YieldType, YieldChange FROM Building_YieldChanges WHERE BuildingType = ?;`,
    id,
  )) {
    addYieldEffect(card, "yield", "Building_YieldChanges", id, Number(r.YieldChange), String(r.YieldType), zh, en, "每回合", "Per turn");
  }
  if (kb.hasTable("Building_YieldChangesBonusWithPower")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT YieldType, YieldChange FROM Building_YieldChangesBonusWithPower WHERE BuildingType = ?;`,
      id,
    )) {
      addYieldEffect(card, "powered", "Building_YieldChangesBonusWithPower", id, Number(r.YieldChange), String(r.YieldType), zh, en, "通电时每回合", "When powered, per turn", "通电时", "When powered");
    }
  }
  if (kb.hasTable("Building_GreatPersonPoints")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT GreatPersonClassType, PointsPerTurn FROM Building_GreatPersonPoints WHERE BuildingType = ?;`,
      id,
    )) {
      addGppEffect(card, "Building_GreatPersonPoints", id, Number(r.PointsPerTurn), String(r.GreatPersonClassType), zh, en);
    }
  }
  if (kb.hasTable("Building_GreatWorks")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT GreatWorkSlotType, NumSlots FROM Building_GreatWorks WHERE BuildingType = ?;`,
      id,
    )) {
      const slotRaw = String(r.GreatWorkSlotType);
      const slotMap: Record<string, { zh: string; en: string }> = {
        GREATWORKSLOT_WRITING: { zh: "著作", en: "Writing" },
        GREATWORKSLOT_ART: { zh: "艺术", en: "Art" },
        GREATWORKSLOT_MUSIC: { zh: "音乐", en: "Music" },
        GREATWORKSLOT_ARTIFACT: { zh: "文物", en: "Artifact" },
        GREATWORKSLOT_RELIC: { zh: "遗物", en: "Relic" },
        GREATWORKSLOT_CATHEDRAL: { zh: "大教堂", en: "Cathedral" },
        GREATWORKSLOT_PALACE: { zh: "宫殿", en: "Palace" },
      };
      const slot = slotMap[slotRaw] ?? refName(slotRaw, zh, en);
      const n = Number(r.NumSlots);
      if (!Number.isFinite(n) || n === 0) continue;
      addSimpleEffect(
        card,
        "greatwork",
        `提供 ${n} 个${slot.zh}槽位`,
        `Provides ${n} ${slot.en} slot(s)`,
        { table: "Building_GreatWorks", pk: id, col: "NumSlots" },
        "table",
        n,
        "great_work_slots",
      );
    }
  }
  if (kb.hasTable("Building_CitizenYieldChanges")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT YieldType, YieldChange FROM Building_CitizenYieldChanges WHERE BuildingType = ?;`,
      id,
    )) {
      addYieldEffect(card, "citizen", "Building_CitizenYieldChanges", id, Number(r.YieldChange), String(r.YieldType), zh, en, "每名公民", "Per citizen");
    }
  }
  if (kb.hasTable("Building_YieldsPerEra")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT YieldType, YieldChange FROM Building_YieldsPerEra WHERE BuildingType = ?;`,
      id,
    )) {
      addYieldEffect(card, "per_era", "Building_YieldsPerEra", id, Number(r.YieldChange), String(r.YieldType), zh, en, "每个时代", "Per era");
    }
  }
  // Building_TourismBombs_XP2 is a one-shot tourism burst used by specific
  // effects, not a per-turn building yield; do not present it as a normal
  // building effect.
}

function addDistrictEffects(kb: KnowledgeDb, card: EffectCard, id: string, zh: TextIndex, en: TextIndex): void {
  for (const r of kb.all<Record<string, unknown>>(
    `SELECT YieldType, YieldChange FROM District_CitizenYieldChanges WHERE DistrictType = ?;`,
    id,
  )) {
    addYieldEffect(card, "citizen", "District_CitizenYieldChanges", id, Number(r.YieldChange), String(r.YieldType), zh, en, "每名公民", "Per citizen");
  }
  if (kb.hasTable("District_GreatPersonPoints")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT GreatPersonClassType, PointsPerTurn FROM District_GreatPersonPoints WHERE DistrictType = ?;`,
      id,
    )) {
      addGppEffect(card, "District_GreatPersonPoints", id, Number(r.PointsPerTurn), String(r.GreatPersonClassType), zh, en);
    }
  }
  if (kb.hasTable("District_CitizenGreatPersonPoints")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT GreatPersonClassType, PointsPerTurn FROM District_CitizenGreatPersonPoints WHERE DistrictType = ?;`,
      id,
    )) {
      addGppEffect(card, "District_CitizenGreatPersonPoints", id, Number(r.PointsPerTurn), String(r.GreatPersonClassType), zh, en, "每名公民", "Per citizen");
    }
  }
  if (kb.hasTable("District_TradeRouteYields")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT YieldType, YieldChangeAsOrigin, YieldChangeAsDomesticDestination,
              YieldChangeAsInternationalDestination
         FROM District_TradeRouteYields WHERE DistrictType = ?;`,
      id,
    )) {
      const variants: [string, string, string, string, number][] = [
        ["origin", "作为商路起点", "As trade route origin", "YieldChangeAsOrigin", Number(r.YieldChangeAsOrigin)],
        ["domestic_destination", "作为国内商路目的地", "As domestic destination", "YieldChangeAsDomesticDestination", Number(r.YieldChangeAsDomesticDestination)],
        ["international_destination", "作为国际商路目的地", "As international destination", "YieldChangeAsInternationalDestination", Number(r.YieldChangeAsInternationalDestination)],
      ];
      for (const [kind, pz, pe, col, amount] of variants) {
        if (!Number.isFinite(amount) || amount === 0) continue;
        addYieldEffect(card, `trade_${kind}`, "District_TradeRouteYields", id, amount, String(r.YieldType), zh, en, pz, pe);
      }
    }
  }
  if (kb.hasTable("District_Adjacencies") && kb.hasTable("Adjacency_YieldChanges")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT a.* FROM District_Adjacencies d
         JOIN Adjacency_YieldChanges a ON a.ID = d.YieldChangeId
        WHERE d.DistrictType = ?;`,
      id,
    )) {
      const yn = yieldName(String(r.YieldType), zh, en);
      const amount = Number(r.YieldChange);
      const desc = str(r.Description);
      if (desc) {
        const f = formatTagBoth(desc, {}, zh, en);
        addSimpleEffect(
          card,
          "adjacency",
          `${f.zh.text ?? desc}：+${amount} ${yn.zh}`,
          `${f.en.text ?? desc}: +${amount} ${yn.en}`,
          { table: "Adjacency_YieldChanges", pk: String(r.ID ?? id), col: "YieldChange" },
          "table",
          amount,
          yieldUnit(String(r.YieldType)),
        );
      } else {
        addSimpleEffect(
          card,
          "adjacency",
          `相邻加成：+${amount} ${yn.zh}`,
          `Adjacency bonus: +${amount} ${yn.en}`,
          { table: "Adjacency_YieldChanges", pk: String(r.ID ?? id), col: "YieldChange" },
          "table",
          amount,
          yieldUnit(String(r.YieldType)),
        );
      }
    }
  }
}

function addImprovementEffects(kb: KnowledgeDb, card: EffectCard, id: string, zh: TextIndex, en: TextIndex): void {
  for (const r of kb.all<Record<string, unknown>>(
    `SELECT YieldType, YieldChange FROM Improvement_YieldChanges WHERE ImprovementType = ?;`,
    id,
  )) {
    addYieldEffect(card, "yield", "Improvement_YieldChanges", id, Number(r.YieldChange), String(r.YieldType), zh, en, "提供", "Provides");
  }
  if (kb.hasTable("Improvement_BonusYieldChanges")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT YieldType, BonusYieldChange FROM Improvement_BonusYieldChanges WHERE ImprovementType = ?;`,
      id,
    )) {
      addYieldEffect(card, "bonus_yield", "Improvement_BonusYieldChanges", id, Number(r.BonusYieldChange), String(r.YieldType), zh, en, "额外提供", "Additional");
    }
  }
  if (kb.hasTable("Improvement_Adjacencies") && kb.hasTable("Adjacency_YieldChanges")) {
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT a.* FROM Improvement_Adjacencies d
         JOIN Adjacency_YieldChanges a ON a.ID = d.YieldChangeId
        WHERE d.ImprovementType = ?;`,
      id,
    )) {
      const yn = yieldName(String(r.YieldType), zh, en);
      const amount = Number(r.YieldChange);
      const desc = str(r.Description);
      const f = desc ? formatTagBoth(desc, {}, zh, en) : null;
      addSimpleEffect(
        card,
        "adjacency",
        `${f?.zh.text ?? desc ?? "相邻加成"}：+${amount} ${yn.zh}`,
        `${f?.en.text ?? desc ?? "Adjacency bonus"}: +${amount} ${yn.en}`,
        { table: "Adjacency_YieldChanges", pk: String(r.ID ?? id), col: "YieldChange" },
        "table",
        amount,
        yieldUnit(String(r.YieldType)),
      );
    }
  }
}

function addTerrainFamilyEffects(
  kb: KnowledgeDb,
  card: EffectCard,
  spec: EntitySpec,
  id: string,
  zh: TextIndex,
  en: TextIndex,
): void {
  const tableByType: Record<string, string> = {
    resource: "Resource_YieldChanges",
    terrain: "Terrain_YieldChanges",
    feature: "Feature_YieldChanges",
  };
  const table = tableByType[spec.type];
  if (!table || !kb.hasTable(table)) return;
  const fk = spec.pk;
  for (const r of kb.all<Record<string, unknown>>(
    `SELECT YieldType, YieldChange FROM "${table}" WHERE "${fk}" = ?;`,
    id,
  )) {
    addYieldEffect(card, "yield", table, id, Number(r.YieldChange), String(r.YieldType), zh, en, "提供", "Provides");
  }
}

/* ------------------------------------------------------------------------- */
/* Modifier / requirement resolution                                         */
/* ------------------------------------------------------------------------- */

const DIRECT_MODIFIER_TABLE: Record<string, { table: string; fk: string; modifierCol: string }> = {
  building: { table: "BuildingModifiers", fk: "BuildingType", modifierCol: "ModifierId" },
  district: { table: "DistrictModifiers", fk: "DistrictType", modifierCol: "ModifierId" },
  trait: { table: "TraitModifiers", fk: "TraitType", modifierCol: "ModifierId" },
  technology: { table: "TechnologyModifiers", fk: "TechnologyType", modifierCol: "ModifierId" },
  civic: { table: "CivicModifiers", fk: "CivicType", modifierCol: "ModifierId" },
  policy: { table: "PolicyModifiers", fk: "PolicyType", modifierCol: "ModifierId" },
  government: { table: "GovernmentModifiers", fk: "GovernmentType", modifierCol: "ModifierId" },
  improvement: { table: "ImprovementModifiers", fk: "ImprovementType", modifierCol: "ModifierId" },
  belief: { table: "BeliefModifiers", fk: "BeliefType", modifierCol: "ModifierID" },
  // Governor promotion text is official, but some effects live only in the
  // modifier chain; keep them auditable in the same card.
  governor_promotion: { table: "GovernorPromotionModifiers", fk: "GovernorPromotionType", modifierCol: "ModifierId" },
};

function directModifierIds(
  kb: KnowledgeDb,
  table: string,
  fk: string,
  modifierCol: string,
  values: string[],
): string[] {
  if (!kb.hasTable(table) || !values.length) return [];
  return selectIn(
    kb,
    (ph) => `SELECT "${modifierCol}" AS id FROM "${table}" WHERE "${fk}" IN (${ph});`,
    values,
  )
    .map((r) => str(r.id))
    .filter((v): v is string => !!v);
}

function collectModifierIds(kb: KnowledgeDb, spec: EntitySpec, id: string): string[] {
  switch (spec.modifierResolver) {
    case "unit": {
      const tags = kb.hasTable("TypeTags")
        ? kb.all<{ Tag: string }>(`SELECT Tag FROM TypeTags WHERE Type = ?;`, id).map((r) => r.Tag)
        : [];
      if (!tags.length) return [];
      const abilities = selectIn(
        kb,
        (ph) =>
          `SELECT Type FROM TypeTags WHERE Tag IN (${ph}) AND Type IN (SELECT UnitAbilityType FROM UnitAbilities);`,
        tags,
      )
        .map((r) => str(r.Type))
        .filter((v): v is string => !!v);
      if (!abilities.length) return [];
      return directModifierIds(kb, "UnitAbilityModifiers", "UnitAbilityType", "ModifierId", abilities);
    }
    case "civilization": {
      const traits = kb.hasTable("CivilizationTraits")
        ? kb.all<{ TraitType: string }>(`SELECT TraitType FROM CivilizationTraits WHERE CivilizationType = ?;`, id).map((r) => r.TraitType)
        : [];
      return directModifierIds(kb, "TraitModifiers", "TraitType", "ModifierId", traits);
    }
    case "leader": {
      const traits = kb.hasTable("LeaderTraits")
        ? kb.all<{ TraitType: string }>(`SELECT TraitType FROM LeaderTraits WHERE LeaderType = ?;`, id).map((r) => r.TraitType)
        : [];
      return directModifierIds(kb, "TraitModifiers", "TraitType", "ModifierId", traits);
    }
    case "greatperson": {
      return [
        ...directModifierIds(kb, "GreatPersonIndividualBirthModifiers", "GreatPersonIndividualType", "ModifierId", [id]),
        ...directModifierIds(kb, "GreatPersonIndividualActionModifiers", "GreatPersonIndividualType", "ModifierId", [id]),
      ];
    }
    case "belief": {
      return directModifierIds(kb, "BeliefModifiers", "BeliefType", "ModifierID", [id]);
    }
    case "none":
      return [];
    case "direct":
    default: {
      const entry = DIRECT_MODIFIER_TABLE[spec.type];
      return entry ? directModifierIds(kb, entry.table, entry.fk, entry.modifierCol, [id]) : [];
    }
  }
}

function requirementTextForSet(
  kb: KnowledgeDb,
  setId: string | null,
  zh: TextIndex,
  en: TextIndex,
): { zh: string | null; en: string | null } {
  if (!setId || !kb.hasTable("RequirementSets")) return { zh: null, en: null };
  const set = kb.get<Record<string, unknown>>(`SELECT * FROM RequirementSets WHERE RequirementSetId = ?;`, setId);
  if (!set) return { zh: null, en: null };
  const reqs = kb.hasTable("RequirementSetRequirements")
    ? kb.all<{ RequirementId: string }>(
        `SELECT RequirementId FROM RequirementSetRequirements WHERE RequirementSetId = ?;`,
        setId,
      )
    : [];
  const partsZh: string[] = [];
  const partsEn: string[] = [];
  for (const r of reqs) {
    const text = kb.hasTable("requirement_text")
      ? kb.get<{ text_zh: string | null; text_en: string | null; resolved: number }>(
          `SELECT text_zh, text_en, resolved FROM requirement_text WHERE requirement_id = ?;`,
          r.RequirementId,
        )
      : undefined;
    if (text?.resolved) {
      if (text.text_zh) partsZh.push(text.text_zh);
      if (text.text_en) partsEn.push(text.text_en);
      continue;
    }
    const req = kb.hasTable("Requirements")
      ? kb.get<Record<string, unknown>>(`SELECT * FROM Requirements WHERE RequirementId = ?;`, r.RequirementId)
      : undefined;
    if (req?.RequirementType) {
      partsZh.push(String(req.RequirementType));
      partsEn.push(String(req.RequirementType));
    }
  }
  return {
    zh: partsZh.length ? partsZh.join(" 且 ") : str(set.RequirementSetType),
    en: partsEn.length ? partsEn.join(" and ") : str(set.RequirementSetType),
  };
}

function addModifierEffects(
  kb: KnowledgeDb,
  card: EffectCard,
  spec: EntitySpec,
  id: string,
  zh: TextIndex,
  en: TextIndex,
): void {
  const ids = [...new Set(collectModifierIds(kb, spec, id))];
  if (!ids.length) return;
  const mods = selectIn(kb, (ph) => `SELECT * FROM Modifiers WHERE ModifierId IN (${ph});`, ids);
  const modById = new Map(mods.map((m) => [String(m.ModifierId), m]));
  const argsByMod = kb.hasTable("ModifierArguments")
    ? groupBy(selectIn(kb, (ph) => `SELECT * FROM ModifierArguments WHERE ModifierId IN (${ph});`, ids), "ModifierId")
    : new Map<string, Record<string, unknown>[]>();
  const texts = kb.hasTable("modifier_text")
    ? selectIn(kb, (ph) => `SELECT * FROM modifier_text WHERE modifier_id IN (${ph});`, ids)
    : [];
  const textById = new Map(texts.map((t) => [String(t.modifier_id), t]));

  for (const mid of ids) {
    const mod = modById.get(mid);
    if (!mod) continue;
    const args = argsByMod.get(mid) ?? [];
    const argMap: Record<string, string> = {};
    for (const a of args) {
      const name = str(a.Name);
      if (name) argMap[name] = String(a.Value ?? "");
    }
    const text = textById.get(mid);
    if (text && Number(text.resolved) === 1 && (text.text_zh || text.text_en)) {
      const ownerSet = str(mod.OwnerRequirementSetId);
      const subjectSet = str(mod.SubjectRequirementSetId);
      const owner = requirementTextForSet(kb, ownerSet, zh, en);
      const subject = requirementTextForSet(kb, subjectSet, zh, en);
      addEffect(card, {
        kind: "modifier",
        text_zh: str(text.text_zh),
        text_en: str(text.text_en),
        value: null,
        unit: null,
        condition_zh: owner.zh ?? subject.zh,
        condition_en: owner.en ?? subject.en,
        source: { table: "Modifiers", pk: mid, modifierId: mid },
        authority: "modifier_summary",
        resolved: true,
        languageFallback: false,
        raw_text: str(text.raw_text),
      });
      continue;
    }
    card.unresolved.push({
      modifierId: mid,
      modifierType: String(mod.ModifierType ?? ""),
      arguments: argMap,
      requirementSetId: str(mod.OwnerRequirementSetId) ?? str(mod.SubjectRequirementSetId),
      reason: text ? "Modifier 文本未完全解析" : "没有 ModifierStrings Summary 文本",
    });
  }
}

/* ------------------------------------------------------------------------- */
/* Trait / unit ability / great-person text                                  */
/* ------------------------------------------------------------------------- */

function addTraitDescriptions(
  kb: KnowledgeDb,
  card: EffectCard,
  traitIds: string[],
  zh: TextIndex,
  en: TextIndex,
): void {
  if (!traitIds.length || !kb.hasTable("Traits")) return;
  for (const r of selectIn(kb, (ph) => `SELECT * FROM Traits WHERE TraitType IN (${ph});`, traitIds)) {
    const id = String(r.TraitType);
    addTagEffect(
      card,
      "trait",
      str(r.Description),
      {},
      { table: "Traits", pk: id, col: "Description" },
      "official",
      zh,
      en,
    );
  }
}

function addUnitAbilityDescriptions(
  kb: KnowledgeDb,
  card: EffectCard,
  id: string,
  zh: TextIndex,
  en: TextIndex,
): void {
  if (!kb.hasTable("TypeTags") || !kb.hasTable("UnitAbilities")) return;
  const tags = kb.all<{ Tag: string }>(`SELECT Tag FROM TypeTags WHERE Type = ?;`, id).map((r) => r.Tag);
  if (!tags.length) return;
  const abilities = selectIn(
    kb,
    (ph) => `SELECT * FROM UnitAbilities WHERE UnitAbilityType IN (SELECT Type FROM TypeTags WHERE Tag IN (${ph}));`,
    tags,
  );
  for (const a of abilities) {
    const abilityId = String(a.UnitAbilityType);
    addTagEffect(
      card,
      "ability",
      str(a.Description),
      {},
      { table: "UnitAbilities", pk: abilityId, col: "Description" },
      "official",
      zh,
      en,
    );
  }
}

function addGreatPersonText(
  kb: KnowledgeDb,
  card: EffectCard,
  row: Record<string, unknown>,
  zh: TextIndex,
  en: TextIndex,
): void {
  const id = String(row.GreatPersonIndividualType ?? "");
  for (const col of ["BirthEffectTextOverride", "ActionEffectTextOverride", "ActionNameTextOverride"]) {
    const tag = str(row[col]);
    if (tag) {
      addTagEffect(
        card,
        "great_person",
        tag,
        {},
        { table: "GreatPersonIndividuals", pk: id, col },
        "official",
        zh,
        en,
      );
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Text tables                                                               */
/* ------------------------------------------------------------------------- */

function setMeta(kb: KnowledgeDb, key: string, value: unknown): void {
  kb.exec(`CREATE TABLE IF NOT EXISTS "_meta" ("key" TEXT PRIMARY KEY, "value" TEXT);`);
  kb.db
    .prepare(`INSERT OR REPLACE INTO "_meta" ("key","value") VALUES (?,?);`)
    .run(key, JSON.stringify(value));
}

function readMeta(kb: KnowledgeDb, key: string): Record<string, unknown> | null {
  if (!kb.hasTable("_meta")) return null;
  const row = kb.get<{ value: string }>(`SELECT value FROM _meta WHERE key = ?;`, key);
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildModifierText(kb: KnowledgeDb, zh: TextIndex, en: TextIndex): number {
  if (!kb.hasTable("ModifierStrings")) return 0;
  const strings = kb.all<Record<string, unknown>>(
    `SELECT ModifierId, Context, Text FROM ModifierStrings;`,
  );
  const byMod = new Map<string, Record<string, unknown>>();
  for (const row of strings) {
    const id = String(row.ModifierId ?? "");
    if (!id) continue;
    const prev = byMod.get(id);
    if (!prev || (row.Context === "Summary" && prev.Context !== "Summary")) byMod.set(id, row);
  }
  const ids = [...byMod.keys()];
  if (!ids.length) return 0;
  const argsByMod = kb.hasTable("ModifierArguments")
    ? groupBy(selectIn(kb, (ph) => `SELECT * FROM ModifierArguments WHERE ModifierId IN (${ph});`, ids), "ModifierId")
    : new Map<string, Record<string, unknown>[]>();
  const ins = kb.db.prepare(
    `INSERT OR REPLACE INTO modifier_text (modifier_id, text_zh, text_en, resolved, raw_text)
     VALUES (?,?,?,?,?);`,
  );
  let n = 0;
  for (const [id, row] of byMod) {
    if (row.Context !== "Summary") continue;
    const argMap: Record<string, string> = {};
    for (const a of argsByMod.get(id) ?? []) {
      const name = str(a.Name);
      if (name) argMap[name] = String(a.Value ?? "");
    }
    const f = formatTagBoth(str(row.Text), argMap, zh, en);
    const textZh = f.zh.resolved ? f.zh.text : null;
    const textEn = f.en.resolved ? f.en.text : null;
    ins.run(id, textZh, textEn, textZh || textEn ? 1 : 0, f.raw);
    n++;
  }
  return n;
}

function buildRequirementText(kb: KnowledgeDb, zh: TextIndex, en: TextIndex): number {
  if (!kb.hasTable("RequirementStrings")) return 0;
  const strings = kb.all<Record<string, unknown>>(
    `SELECT RequirementId, Context, Text FROM RequirementStrings;`,
  );
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of strings) {
    const id = String(row.RequirementId ?? "");
    if (!id) continue;
    const prev = byId.get(id);
    if (!prev || (row.Context === "Summary" && prev.Context !== "Summary")) byId.set(id, row);
  }
  const ids = [...byId.keys()];
  if (!ids.length) return 0;
  const argsById = kb.hasTable("RequirementArguments")
    ? groupBy(selectIn(kb, (ph) => `SELECT * FROM RequirementArguments WHERE RequirementId IN (${ph});`, ids), "RequirementId")
    : new Map<string, Record<string, unknown>[]>();
  const ins = kb.db.prepare(
    `INSERT OR REPLACE INTO requirement_text (requirement_id, text_zh, text_en, resolved, raw_text)
     VALUES (?,?,?,?,?);`,
  );
  let n = 0;
  for (const [id, row] of byId) {
    if (row.Context !== "Summary") continue;
    const argMap: Record<string, string> = {};
    for (const a of argsById.get(id) ?? []) {
      const name = str(a.Name);
      if (name) argMap[name] = String(a.Value ?? "");
    }
    const f = formatTagBoth(str(row.Text), argMap, zh, en);
    const textZh = f.zh.resolved ? f.zh.text : null;
    const textEn = f.en.resolved ? f.en.text : null;
    ins.run(id, textZh, textEn, textZh || textEn ? 1 : 0, f.raw);
    n++;
  }
  return n;
}

/* ------------------------------------------------------------------------- */
/* Public build API                                                          */
/* ------------------------------------------------------------------------- */

function ensureEffectSchema(kb: KnowledgeDb): void {
  kb.exec(`
    DROP TABLE IF EXISTS "effect_cards";
    CREATE TABLE "effect_cards" (
      "card_id" TEXT PRIMARY KEY,
      "owner_kind" TEXT NOT NULL,
      "owner_id" TEXT NOT NULL,
      "description_zh" TEXT,
      "description_en" TEXT,
      "attributes_json" TEXT NOT NULL,
      "effects_json" TEXT NOT NULL,
      "unresolved_json" TEXT NOT NULL,
      "coverage_json" TEXT NOT NULL,
      "ruleset_id" TEXT NOT NULL,
      "built_at" TEXT NOT NULL
    );
    CREATE INDEX "idx_effect_cards_owner" ON "effect_cards" ("owner_kind", "owner_id");
    DROP TABLE IF EXISTS "modifier_text";
    CREATE TABLE "modifier_text" (
      "modifier_id" TEXT PRIMARY KEY,
      "text_zh" TEXT,
      "text_en" TEXT,
      "resolved" INTEGER NOT NULL DEFAULT 0,
      "raw_text" TEXT
    );
    DROP TABLE IF EXISTS "requirement_text";
    CREATE TABLE "requirement_text" (
      "requirement_id" TEXT PRIMARY KEY,
      "text_zh" TEXT,
      "text_en" TEXT,
      "resolved" INTEGER NOT NULL DEFAULT 0,
      "raw_text" TEXT
    );
  `);
}

export function hasEffectCards(kb: KnowledgeDb): boolean {
  if (!kb.hasTable("effect_cards") || !kb.hasTable("modifier_text")) return false;
  const effects = readMeta(kb, "effects");
  const build = readMeta(kb, "build");
  if (!effects || !build) return false;
  return effects.rawBuiltAt === build.builtAt;
}

/**
 * Build `effect_cards`, `modifier_text`, `requirement_text` and `_meta.effects`.
 * Call after all localized text has been ingested/applied.
 */
export function buildEffectCards(
  kb: KnowledgeDb,
  source: DataSource,
  opts: { rawBuiltAt?: string | null; builtAt?: string } = {},
): EffectStats {
  const builtAt = opts.builtAt ?? new Date().toISOString();
  const buildMeta = readMeta(kb, "build");
  const rawBuiltAt =
    opts.rawBuiltAt ?? (typeof buildMeta?.builtAt === "string" ? buildMeta.builtAt : builtAt);

  ensureEffectSchema(kb);
  // The raw build opens with journal_mode=OFF for speed. A large failed
  // transaction cannot roll back without a journal, so use MEMORY for this
  // derived pass; it is still fast and keeps the database recoverable.
  try {
    kb.exec("PRAGMA journal_mode = MEMORY;");
  } catch {
    /* best effort */
  }
  const zh = new TextIndex(kb, "zh_Hans_CN", "en_US");
  const en = new TextIndex(kb, "en_US");
  const stats: EffectStats = {
    cards: 0,
    effects: 0,
    resolved: 0,
    unresolved: 0,
    modifierTexts: 0,
    requirementTexts: 0,
  };

  kb.begin();
  try {
    stats.modifierTexts = buildModifierText(kb, zh, en);
    stats.requirementTexts = buildRequirementText(kb, zh, en);
    const ins = kb.db.prepare(
      `INSERT INTO effect_cards
        (card_id, owner_kind, owner_id, description_zh, description_en, attributes_json,
         effects_json, unresolved_json, coverage_json, ruleset_id, built_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?);`,
    );

    for (const spec of SPECS) {
      if (!kb.hasTable(spec.table)) continue;
      for (const row of kb.all<Record<string, unknown>>(`SELECT * FROM "${spec.table}";`)) {
        const id = str(row[spec.pk]);
        if (!id) continue;
        const card: EffectCard = {
          card_id: `${spec.type}:${id}`,
          owner_kind: spec.type,
          owner_id: id,
          description_zh: null,
          description_en: null,
          attributes: [],
          effects: [],
          unresolved: [],
          coverage: {
            effects: 0,
            unresolved: 0,
            hasOfficialDescription: false,
            hasTableEffects: false,
            hasModifierEffects: false,
            primaryResolved: false,
          },
          ruleset_id: source,
          built_at: builtAt,
        };

        addDescription(card, spec, row, zh, en);
        addAttributes(card, spec, row, zh, en);
        switch (spec.type) {
          case "building":
            addBuildingEffects(kb, card, id, zh, en);
            break;
          case "district":
            addDistrictEffects(kb, card, id, zh, en);
            break;
          case "improvement":
            addImprovementEffects(kb, card, id, zh, en);
            break;
          case "resource":
          case "terrain":
          case "feature":
            addTerrainFamilyEffects(kb, card, spec, id, zh, en);
            break;
          case "unit":
            addUnitAbilityDescriptions(kb, card, id, zh, en);
            break;
          case "civilization": {
            const traits = kb.hasTable("CivilizationTraits")
              ? kb.all<{ TraitType: string }>(`SELECT TraitType FROM CivilizationTraits WHERE CivilizationType = ?;`, id).map((r) => r.TraitType)
              : [];
            addTraitDescriptions(kb, card, traits, zh, en);
            break;
          }
          case "leader": {
            const traits = kb.hasTable("LeaderTraits")
              ? kb.all<{ TraitType: string }>(`SELECT TraitType FROM LeaderTraits WHERE LeaderType = ?;`, id).map((r) => r.TraitType)
              : [];
            addTraitDescriptions(kb, card, traits, zh, en);
            break;
          }
          case "greatperson":
            addGreatPersonText(kb, card, row, zh, en);
            break;
          default:
            break;
        }
        addModifierEffects(kb, card, spec, id, zh, en);

        card.coverage = {
          effects: card.effects.length,
          unresolved: card.unresolved.length,
          hasOfficialDescription: !!card.description_zh,
          hasTableEffects: card.effects.some((e) => e.authority === "table"),
          hasModifierEffects: card.effects.some((e) => e.authority === "modifier_summary"),
          primaryResolved: card.effects.length > 0 && card.effects.every((e) => e.resolved),
        };
        delete (card as any)._seen;

        ins.run(
          card.card_id,
          card.owner_kind,
          card.owner_id,
          card.description_zh,
          card.description_en,
          JSON.stringify(card.attributes),
          JSON.stringify(card.effects),
          JSON.stringify(card.unresolved),
          JSON.stringify(card.coverage),
          card.ruleset_id,
          card.built_at,
        );
        stats.cards++;
        stats.effects += card.effects.length;
        stats.resolved += card.effects.filter((e) => e.resolved).length;
        stats.unresolved += card.unresolved.length;
      }
    }
    kb.commit();
  } catch (error) {
    try {
      kb.exec("ROLLBACK;");
    } catch {
      /* no active transaction */
    }
    throw error;
  }

  setMeta(kb, "effects", {
    schemaVersion: EFFECT_SCHEMA_VERSION,
    builtAt,
    rawBuiltAt,
    rulesetId: source,
    cards: stats.cards,
    effects: stats.effects,
    resolved: stats.resolved,
    unresolved: stats.unresolved,
    modifierTexts: stats.modifierTexts,
    requirementTexts: stats.requirementTexts,
  });
  return stats;
}

/** Rebuild only when missing or anchored to an older raw build. */
export function ensureEffectCards(kb: KnowledgeDb, source: DataSource): EffectStats | null {
  if (hasEffectCards(kb)) return null;
  return buildEffectCards(kb, source);
}
