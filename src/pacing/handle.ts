import type { DataSource } from "../config.js";
import type { VictoryId } from "../kb/spec.js";
import type { Assurance } from "./spec.js";

/**
 * Self-describing handoff token for one built function set.
 *
 * The token is not a cache key: it carries the exact construction inputs plus
 * the two build timestamps, so `civi6_pace_eval` can rebuild the same formula
 * deterministically (or reject a handle from a different KB build). A short
 * token keeps the common path from echoing an 8–22KB formula back through the
 * model; the literal function set is still accepted for external producers.
 */
export interface PaceHandleData {
  version: 1;
  source: DataSource;
  civ: string;
  leader: string | null;
  speed: string;
  victory: VictoryId;
  assurance: Assurance;
  targetTurn: number | null;
  /** `_meta.build.builtAt` — raw game data build. */
  rawBuiltAt: string | null;
  /** `_meta['kb.build'].builtAt` — decision layer build. */
  kbBuiltAt: string | null;
}

export const PACE_HANDLE_PREFIX = "pc1.";

interface WireHandle {
  v: 1;
  s: string;
  c: string;
  l: string | null;
  sp: string;
  vc: string;
  a: string;
  t: number | null;
  b: string | null;
  k: string | null;
}

const VICTORIES = new Set(["science", "culture", "religion", "domination", "diplomatic"]);
const ASSURANCES = new Set(["standard", "strict"]);

function handleFail(message: string): never {
  throw new Error(`civi6_pace_eval: ${message}`);
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") handleFail("handle 字段类型错误。");
  return value;
}

export function encodePaceHandle(data: PaceHandleData): string {
  const wire: WireHandle = {
    v: 1,
    s: data.source,
    c: data.civ,
    l: data.leader,
    sp: data.speed,
    vc: data.victory,
    a: data.assurance,
    t: data.targetTurn,
    b: data.rawBuiltAt,
    k: data.kbBuiltAt,
  };
  return `${PACE_HANDLE_PREFIX}${Buffer.from(JSON.stringify(wire), "utf8").toString("base64url")}`;
}

export function decodePaceHandle(handle: string): PaceHandleData {
  if (typeof handle !== "string" || !handle.startsWith(PACE_HANDLE_PREFIX)) {
    handleFail(`handle 必须以 "${PACE_HANDLE_PREFIX}" 开头。`);
  }
  const payload = handle.slice(PACE_HANDLE_PREFIX.length);
  if (!payload) handleFail("handle 为空。");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    handleFail("handle 无法解码（不是合法 base64url JSON）。请重新调用 civi6_pace。");
  }
  if (!parsed || typeof parsed !== "object") handleFail("handle 载荷不是对象。");
  const wire = parsed as Partial<WireHandle>;
  if (wire.v !== 1) handleFail(`handle 版本不支持（${String(wire.v)}）。`);
  if (wire.s !== "vanilla" && wire.s !== "bbg") handleFail(`handle.source 非法（${String(wire.s)}）。`);
  if (typeof wire.c !== "string" || !wire.c.startsWith("CIVILIZATION_")) {
    handleFail("handle.civ 非法。");
  }
  if (wire.l !== null && wire.l !== undefined && typeof wire.l !== "string") handleFail("handle.leader 非法。");
  if (typeof wire.sp !== "string" || !wire.sp) handleFail("handle.speed 非法。");
  if (typeof wire.vc !== "string" || !VICTORIES.has(wire.vc)) handleFail("handle.victory 非法。");
  if (typeof wire.a !== "string" || !ASSURANCES.has(wire.a)) handleFail("handle.assurance 非法。");
  if (wire.t !== null && wire.t !== undefined && (typeof wire.t !== "number" || !Number.isInteger(wire.t))) {
    handleFail("handle.targetTurn 非法。");
  }
  return {
    version: 1,
    source: wire.s,
    civ: wire.c,
    leader: wire.l ?? null,
    speed: wire.sp,
    victory: wire.vc as VictoryId,
    assurance: wire.a as Assurance,
    targetTurn: wire.t ?? null,
    rawBuiltAt: optionalString(wire.b),
    kbBuiltAt: optionalString(wire.k),
  };
}
