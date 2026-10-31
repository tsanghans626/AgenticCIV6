import type { KnowledgeDb } from "../db.js";
import type { DataSource } from "../config.js";
import { loadKbSpecs, validateSpecs, type KbSpecs } from "./spec.js";
import { createLabeler } from "./labels.js";
import { dropKbObjects, ensureKbSchema, KB_SCHEMA_VERSION } from "./schema.js";
import { seedDimensions, seedEraWindows, seedSpeedProfiles, seedVictories, ensureEffectDimensions } from "./seed.js";
import { buildAtoms } from "./atoms.js";
import { buildClosure } from "./closure.js";
import { buildNodes } from "./node.js";
import { buildPlans, buildObjectives } from "./engine.js";
import { buildCivs } from "./civs.js";
import { buildCards } from "./cards.js";
import { validateKb, type ValidationReport } from "./validate.js";

export interface KbBuildResult {
  source: DataSource;
  version: number;
  builtAt: string;
  specs: Pick<KbSpecs, "dimensions" | "victories" | "eras" | "plans" | "civs">;
  atoms: { effects: number; costs: number; unlocks: number };
  closure: number;
  nodes: number;
  plans: number;
  targets: number;
  budgets: number;
  checks: number;
  derivations: number;
  objectives: { objectives: number; paths: number; pathNodes: number; constraints: number; focus: number };
  civs: number;
  cards: number;
  validation: ValidationReport;
}

function readRawBuiltAt(kb: KnowledgeDb): string | null {
  try {
    const row = kb.get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'build';`);
    if (!row?.value) return null;
    return JSON.parse(row.value).builtAt ?? null;
  } catch {
    return null;
  }
}

function writeMeta(kb: KnowledgeDb, key: string, value: unknown): void {
  kb.exec(`CREATE TABLE IF NOT EXISTS "_meta" ("key" TEXT PRIMARY KEY, "value" TEXT);`);
  kb.db.prepare(`INSERT OR REPLACE INTO "_meta" ("key","value") VALUES (?,?);`).run(key, JSON.stringify(value));
}

/**
 * Rebuild the whole decision layer from the current raw mirror plus curated
 * JSON specs. Safe to run on an existing DB: all `kb_*` objects are recreated
 * inside a build transaction, so the raw mirror is never modified.
 */
export function buildKb(
  kb: KnowledgeDb,
  source: DataSource,
  opts: { rawBuiltAt?: string | null; builtAt?: string; root?: string; quiet?: boolean } = {},
): KbBuildResult {
  const builtAt = opts.builtAt ?? new Date().toISOString();
  const rawBuiltAt = opts.rawBuiltAt ?? readRawBuiltAt(kb);
  const specs = loadKbSpecs(opts.root);
  const specErrors = validateSpecs(specs);
  if (specErrors.length) {
    throw new Error(`KB 策划 JSON 校验失败：\n- ${specErrors.join("\n- ")}`);
  }
  if (!kb.hasTable("search_docs")) {
    throw new Error("search_docs 不存在；请先运行完整构建（kb 层依赖实体索引）");
  }

  // Recreate the schema so changed DDL is picked up for existing databases.
  dropKbObjects(kb);
  ensureKbSchema(kb);
  // A forced rebuild may have dropped `_meta` (the table is part of the raw
  // build) before `build()` writes the new build record. Create it now so the
  // validator can run inside this pass.
  kb.exec(`CREATE TABLE IF NOT EXISTS "_meta" ("key" TEXT PRIMARY KEY, "value" TEXT);`);

  const labeler = createLabeler(kb);
  seedDimensions(kb, specs.dimensions);
  seedVictories(kb, specs.victories);
  seedEraWindows(kb, source, specs.eras, labeler);
  seedSpeedProfiles(kb, specs.speeds);
  const atoms = buildAtoms(kb, source);
  ensureEffectDimensions(kb);
  const closure = buildClosure(kb);
  const nodeStats = buildNodes(kb, labeler);
  const engine = buildPlans(kb, { source, rawBuiltAt, builtAt, labeler, specs });
  const objectiveStats = buildObjectives(kb, { source, rawBuiltAt, builtAt, labeler, specs });
  const civStats = buildCivs(kb, source, specs, labeler);
  const cards = buildCards(kb, source, builtAt);
  const validation = validateKb(kb, source, specs);

  const result: KbBuildResult = {
    source,
    version: KB_SCHEMA_VERSION,
    builtAt,
    specs: {
      dimensions: specs.dimensions,
      victories: specs.victories,
      eras: specs.eras,
      plans: specs.plans,
      civs: specs.civs,
    },
    atoms,
    closure,
    nodes: nodeStats.nodes,
    plans: engine.plans,
    targets: engine.targets,
    budgets: engine.budgets,
    checks: engine.checks,
    derivations: engine.derivations,
    objectives: objectiveStats,
    civs: civStats.profiles,
    cards: cards.cards,
    validation,
  };

  writeMeta(kb, "kb.version", { schemaVersion: KB_SCHEMA_VERSION, builtAt, source });
  writeMeta(kb, "kb.build", {
    schemaVersion: KB_SCHEMA_VERSION,
    builtAt,
    rawBuiltAt,
    source,
    plans: engine.plans,
    targets: engine.targets,
    budgets: engine.budgets,
    checks: engine.checks,
    derivations: engine.derivations,
    objectives: objectiveStats,
    nodes: nodeStats.nodes,
    civs: civStats.profiles,
    civEntityMaps: civStats.entityMaps,
    civDeltas: civStats.deltas,
    cards: cards.cards,
    atoms,
    closure,
  });
  writeMeta(kb, "kb.validation", {
    ok: validation.ok,
    errors: validation.errors,
    warnings: validation.warnings,
    issues: validation.issues.slice(0, 100),
    stats: validation.stats,
    builtAt,
  });

  if (!opts.quiet) {
    console.log(
      `  KB 决策层   : ${engine.plans} 计划 / ${engine.targets} 目标 / ${engine.budgets} 预算 / ` +
        `${cards.cards} 卡片（${source}）`,
    );
    console.log(
      `  KB 推理层   : ${objectiveStats.objectives} 目标切面 / ${objectiveStats.pathNodes} 路径节点 / ` +
        `${objectiveStats.constraints} 约束 / ${objectiveStats.focus} 焦点行`,
    );
    console.log(
      `  原子层      : ${atoms.effects} 效果 / ${atoms.costs} 成本 / ${atoms.unlocks} 解锁 / ` +
        `${closure} 闭包 / ${nodeStats.nodes} 节点（灵感 ${nodeStats.boosted}）`,
    );
    if (validation.errors) console.log(`  KB 校验     : ${validation.errors} 错误 / ${validation.warnings} 警告`);
    else console.log(`  KB 校验     : 通过（${validation.warnings} 警告）`);
  }
  return result;
}

/** Check whether a database already carries the decision layer. */
export function hasKb(kb: KnowledgeDb): boolean {
  return kb.hasTable("kb_plan") && kb.hasTable("kb_target") && kb.hasTable("kb_card");
}
