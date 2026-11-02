import type { PacingResult } from "./engine.js";
import { renderPacingModule } from "./module.js";

export type PacingFormat = "js" | "json" | "csv" | "md";

export interface RenderOptions {
  format?: PacingFormat;
  sampleStep?: number;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Compact human summary — the JSON is the machine contract. */
export function renderMarkdown(result: PacingResult): string {
  const b = result.baseline;
  const lines: string[] = [];
  lines.push(`# 基准节奏：${result.civ.labelZh} · ${result.input.victoryId} · ${result.basis.speed}`);
  lines.push("");
  lines.push(
    `- 结果：${b.feasible ? "可达" : "不可达"}；保证层级 \`${b.guarantee}\`；胜利回合 **${b.turn ?? "—"}**（我方就位 ${b.selfTurn ?? "—"}，爆发点 ${b.burstTurn ?? "—"}，参考 ${b.referenceTurn}）`,
  );
  lines.push(`- 速度：×${result.basis.costMultiplier} 成本 / 回合压缩 ${round(result.basis.turnScale, 2)}（${result.basis.totalTurns} 回合上限）`);
  lines.push(`- 文明：${result.civ.labelZh}${result.civ.leaderId ? `（${result.civ.leaderId}）` : ""}`);
  const unique = [
    ...result.civ.uniqueDistricts,
    ...result.civ.uniqueBuildings,
    ...result.civ.uniqueUnits,
  ];
  if (unique.length) lines.push(`- 特色替代：${unique.join(" / ")}`);
  if (b.blockers.length) {
    lines.push("");
    lines.push("## 阻断项");
    for (const blocker of b.blockers) lines.push(`- [${blocker.kind}] ${blocker.message}${blocker.detail ? `：${blocker.detail}` : ""}`);
  }
  lines.push("");
  lines.push("## 里程碑（T 之前必须完成）");
  lines.push("");
  lines.push("| 完成 | 最晚 | 松弛 | 类别 | 名称 | 成本 | 币种 | 作用 |");
  lines.push("| ---: | ---: | ---: | --- | --- | ---: | --- | --- |");
  for (const m of result.milestones) {
    lines.push(
      `| ${m.turn} | ${m.latestTurn ?? "—"} | ${m.slack ?? "—"} | ${m.kind} | ${m.labelZh} | ${m.cost} | ${m.currency ?? "—"} | ${m.why} |`,
    );
  }
  lines.push("");
  lines.push("## 状态函数（分段线性；事件处跳变）");
  lines.push("");
  for (const [key, state] of Object.entries(result.state)) {
    const last = state.segments[state.segments.length - 1];
    lines.push(`- \`${key}\`（${state.unit}）：最终 ${round(state.final, 1)}；${state.segments.length} 段，末段 T${last?.from}-${last?.to} @ ${round(last?.rate ?? 0, 1)}`);
  }
  lines.push("");
  lines.push("## 动作函数");
  lines.push("");
  lines.push("| 起 | 止 | 动作 | 数量 |");
  lines.push("| ---: | ---: | --- | ---: |");
  for (const a of result.actions.slice(0, 80)) {
    lines.push(`| ${a.from} | ${a.to} | ${a.kind} · ${a.label} | ${a.count} |`);
  }
  if (result.actions.length > 80) lines.push(`| … | | 其余 ${result.actions.length - 80} 条见 JSON | |`);
  lines.push("");
  lines.push("## 证书");
  lines.push("");
  const c = result.checks;
  lines.push(`- 成本闭环：${c.closedLoop ? "通过" : "失败"}`);
  lines.push(`- 前置顺序：${c.prereqOrder ? "通过" : "失败"}`);
  lines.push(`- 来源合法：${c.sourceSound ? "通过" : "失败"}`);
  lines.push(`- 单调性：${c.monotone ? "通过" : "失败"}`);
  lines.push(`- 松弛自洽：${c.slackConsistent ? "通过" : "失败"}`);
  lines.push(`- 未建模修饰符：${result.provenance.excludedEffects}（${Object.entries(result.provenance.excludedByReason).map(([k, v]) => `${k}=${v}`).join(", ") || "0"}）`);
  lines.push("");
  lines.push("## 函数 API（`--format=js`）");
  lines.push("");
  lines.push("```js");
  lines.push("import pace from \"./korea-domination-online.mjs\";");
  lines.push("pace.science(120);            // 累计科技");
  lines.push("pace.rate(120).production;    // 当回合产能");
  lines.push("pace.state(120).research;     // { id, label } | null");
  lines.push("pace.builds(120);             // 当前在建/在造");
  lines.push("```");
  lines.push("");
  lines.push("## 假设");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(result.assumptions, null, 2));
  lines.push("```");
  return lines.join("\n");
}

export function renderCsv(result: PacingResult): string {
  const rows: string[] = [];
  rows.push("section,turn,key,rate,cum");
  for (const point of result.series) {
    for (const key of Object.keys(point.rates) as Array<keyof typeof point.rates>) {
      rows.push(`state,${point.turn},${key},${round(point.rates[key])},${round(point.cum[key])}`);
    }
  }
  rows.push("section,turn,latest,slack,kind,id,label,cost,currency,role");
  for (const m of result.milestones) {
    rows.push(
      `milestone,${m.turn},${m.latestTurn ?? ""},${m.slack ?? ""},${m.kind},${m.id},"${m.labelZh.replace(/"/g, '""')}",${m.cost},${m.currency ?? ""},${m.role}`,
    );
  }
  return rows.join("\n");
}

export function renderPacing(result: PacingResult, opts: RenderOptions = {}): string {
  const format = opts.format ?? "json";
  if (format === "js" || (format as string) === "mjs" || (format as string) === "module") {
    return renderPacingModule(result);
  }
  if (format === "csv") return renderCsv(result);
  if (format === "md") return renderMarkdown(result);
  return JSON.stringify(result, null, 2);
}
