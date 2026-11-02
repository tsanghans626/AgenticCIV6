import type { DataSource } from "../config.js";
import type { KnowledgeDb } from "../db.js";
import type { VictoryId } from "../kb/spec.js";
import { buildPacing } from "./engine.js";
import { buildPacingFormula, type PacingFormula } from "./formula.js";
import type { Assurance } from "./spec.js";

/**
 * Data-oriented entry point for the pacing baseline.
 *
 * The CLI (`npm run pace`) is the human-facing surface: it accepts names,
 * formats and output files. This request is the opposite contract: the caller
 * must already hold the resolved instance ids, and the only result is the
 * function set (`civi6.pacing/formula/v1`) — no module text, no file output.
 *
 * `civ` / `leader` are intentionally strict. The engine's `loadCiv` silently
 * falls back to the first profile when a leader does not match; that is fine
 * for a CLI convenience but wrong for an agent handoff, where a silent leader
 * swap changes the whole baseline. Here ambiguous or foreign leaders fail
 * closed.
 */
export interface PaceBuildRequest {
  source: DataSource;
  /** Exact `instance.instance.civ` id (`CIVILIZATION_*`). */
  civ: string;
  /** Exact `instance.instance.leader` id (`LEADER_*`); required when the civ has several. */
  leader?: string | null;
  /** Exact `instance.instance.speed` id (e.g. `standard` / `online`). */
  speed: string;
  /** Authored victory line (`kb/pacing/<victory>.json`). */
  victory: VictoryId;
  /** Baseline source policy; default `standard`. */
  assurance?: Assurance;
  /** Optional reverse check; infeasible targets produce blockers, not a new baseline. */
  targetTurn?: number | null;
  /** Repository root that contains `kb/pacing/`; defaults to `process.cwd()`. */
  root?: string;
}

const CIV_PREFIX = "CIVILIZATION_";
const LEADER_PREFIX = "LEADER_";
const MINOR_LEADER_PREFIX = "LEADER_MINOR_CIV_";

function fail(message: string): never {
  throw new Error(`PaceBuildRequest: ${message}`);
}

/**
 * Validate the exact-id contract before touching the engine.
 *
 * Returns the resolved leader id so the caller never re-implements the
 * single-leader / multi-leader policy.
 */
function resolveLeader(kb: KnowledgeDb, request: PaceBuildRequest): string | null {
  if (!request.civ.startsWith(CIV_PREFIX)) {
    fail(
      `civ 必须是 instance.instance.civ 的精确 id（${CIV_PREFIX}*），收到 "${request.civ}"；` +
        "名字/中文名/模糊匹配属于 CLI 便利，工具入参不接受。",
    );
  }
  if (request.leader !== undefined && request.leader !== null && !String(request.leader).startsWith(LEADER_PREFIX)) {
    fail(
      `leader 必须是 instance.instance.leader 的精确 id（${LEADER_PREFIX}*），收到 "${request.leader}"。`,
    );
  }
  const rows = kb.all<{ leader_id: string }>(
    `SELECT leader_id FROM kb_civ_profile WHERE source = ? AND civ_id = ?;`,
    request.source,
    request.civ,
  );
  if (!rows.length) {
    fail(`未知文明 "${request.civ}"（kb_civ_profile 无记录）；请传 instance.instance.civ。`);
  }
  const majors = rows
    .map((row) => String(row.leader_id ?? ""))
    .filter((id) => id && !id.startsWith(MINOR_LEADER_PREFIX));
  if (!majors.length) {
    fail(`${request.civ} 只有城邦/小文明档案，不能作为基准节奏主体。`);
  }
  const wanted = request.leader ? String(request.leader) : null;
  if (wanted) {
    if (!majors.includes(wanted)) {
      fail(`领袖 "${wanted}" 不属于 ${request.civ}；可用：${majors.join(" / ")}。`);
    }
    return wanted;
  }
  if (majors.length > 1) {
    fail(`${request.civ} 有多个领袖，必须传 leader（可用：${majors.join(" / ")}）；不静默取第一条。`);
  }
  return majors[0] ?? null;
}

function resolveTargetTurn(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    fail(`targetTurn 必须是正整数，收到 ${String(value)}。`);
  }
  return value;
}

/**
 * Build the pacing function set for one exact instance × one victory line.
 *
 * Pure read: the database is only read, `kb/pacing/*.json` is only read, and
 * the emitted object is deterministic for the same inputs/build.
 */
export function buildPaceFunctionSet(kb: KnowledgeDb, request: PaceBuildRequest): PacingFormula {
  if (!request || typeof request !== "object") fail("request 缺失。");
  if (typeof request.speed !== "string" || !request.speed) fail("speed 必填。");
  if (typeof request.victory !== "string" || !request.victory) fail("victory 必填。");
  if (request.assurance !== undefined && request.assurance !== "standard" && request.assurance !== "strict") {
    fail(`assurance 只能是 standard / strict，收到 "${String(request.assurance)}"。`);
  }
  const leader = resolveLeader(kb, request);
  const targetTurn = resolveTargetTurn(request.targetTurn);
  const result = buildPacing(kb, {
    source: request.source,
    civId: request.civ,
    leaderId: leader,
    victoryId: request.victory,
    speed: request.speed,
    assurance: request.assurance ?? "standard",
    targetTurn,
    root: request.root,
  });
  return buildPacingFormula(result);
}
