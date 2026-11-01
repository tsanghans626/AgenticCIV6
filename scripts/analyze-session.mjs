/**
 * Trajectory metrics for one or more DSH sessions.
 *
 * The point is to keep "it feels slow" measurable: tool latency, model steps,
 * output tokens, silently dropped batch ids, repeated fetches and SQL detours.
 * Session logs are multi-frame zstd JSONL; node:zlib decodes one frame at a
 * time, so the frames are split on the zstd magic and each is validated.
 *
 * usage:
 *   node scripts/analyze-session.mjs                 # 5 most recent sessions
 *   node scripts/analyze-session.mjs <dir-or-file>   # one session (dir or .zstd)
 *   node scripts/analyze-session.mjs --json <dir...> # machine-readable summary
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function frameOffsets(buf) {
  const offsets = [];
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      offsets.push(i);
    }
  }
  return offsets.length ? offsets : [0];
}

/** Decode every zstd frame; a false-positive magic byte is skipped by retrying. */
function decodeSessionFile(file) {
  const buf = readFileSync(file);
  const offsets = frameOffsets(buf);
  const chunks = [];
  let i = 0;
  while (i < offsets.length) {
    let j = i + 1;
    let decoded = false;
    while (j <= offsets.length && !decoded) {
      const end = j < offsets.length ? offsets[j] : buf.length;
      try {
        chunks.push(zstdDecompressSync(buf.subarray(offsets[i], end)));
        decoded = true;
      } catch {
        j += 1;
      }
    }
    if (!decoded) break;
    i = j;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function findSessionFiles(target) {
  const out = [];
  const walk = (p, depth) => {
    if (depth > 3) return;
    let stat;
    try {
      stat = statSync(p);
    } catch {
      return;
    }
    if (stat.isFile()) {
      if (p.endsWith(".zstd")) out.push(p);
      return;
    }
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      walk(join(p, entry.name), depth + 1);
    }
  };
  walk(target, 0);
  return out;
}

function recentSessionFiles(limit = 5) {
  const root = join(homedir(), ".dsh", "sessions");
  const files = findSessionFiles(root);
  return files
    .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((x) => x.file);
}

function textOf(message) {
  return (message?.content ?? []).map((part) => part.text ?? "").join("");
}

function analyze(events, file) {
  const session = events.find((e) => e.type === "session") ?? {};
  const calls = new Map();
  const steps = new Map();
  const startedAt = session.createdAt ?? events[0]?.time ?? 0;

  for (const event of events) {
    if (event.type === "tool/call") {
      calls.set(event.data.callId, event.data);
      if (!steps.has(event.data.step)) steps.set(event.data.step, { start: null, calls: 0, resultChars: 0 });
      steps.get(event.data.step).calls += 1;
    }
    if (event.type === "step/start" && !steps.has(event.data.step)) {
      steps.set(event.data.step, { start: null, calls: 0, resultChars: 0 });
    }
    if (event.type === "step/start") steps.get(event.data.step).start = event.time;
    if (event.type === "step/end") steps.get(event.data.step).end = event.time;
  }

  const tools = {};
  const errors = {};
  const truncated = [];
  const droppedIds = [];
  const seenEntityIds = new Map();

  for (const event of events) {
    if (event.type !== "tool/result") continue;
    const call = calls.get(event.data.message?.toolCallId);
    const name = call?.name ?? "unknown";
    const text = textOf(event.data.message);
    tools[name] = (tools[name] ?? 0) + 1;
    if (event.data.message?.isError || /^Error:\s/.test(text)) errors[name] = (errors[name] ?? 0) + 1;
    if (text.includes('"truncated":true')) truncated.push({ step: event.data.step, tool: name, chars: text.length });
    if (call?.step && steps.has(call.step)) steps.get(call.step).resultChars += text.length;

    if (name === "civi6_entity" && call) {
      let args = {};
      try {
        args = JSON.parse(call.arguments ?? "{}");
      } catch {
        args = {};
      }
      const ids = (args.ids ?? (args.id ? [args.id] : [])).map(String);
      for (const id of ids) {
        const key = `${args.type}:${id}`;
        seenEntityIds.set(key, (seenEntityIds.get(key) ?? 0) + 1);
        if (!text.includes(id)) droppedIds.push({ step: call.step, id });
      }
    }
  }

  const assistant = events.filter((e) => e.type === "assistant/message");
  const usage = assistant.reduce(
    (acc, m) => {
      const u = m.data.usage ?? {};
      acc.input += u.inputTokens ?? 0;
      acc.output += u.outputTokens ?? 0;
      acc.cacheRead += u.cacheReadTokens ?? 0;
      const content = m.data.message?.content ?? [];
      acc.reasoningChars += content.filter((c) => c.type === "reasoning").map((c) => c.text ?? "").join("").length;
      acc.textChars += content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("").length;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, reasoningChars: 0, textChars: 0 },
  );

  const stepRows = [...steps.entries()]
    .map(([step, s]) => {
      const message = assistant.find((m) => m.data.step === step);
      return {
        step,
        wall: s.start ? Math.round(((s.end ?? events.at(-1).time ?? s.start) - s.start) / 100) / 10 : null,
        calls: s.calls,
        output: message?.data.usage?.outputTokens ?? 0,
        resultChars: s.resultChars,
      };
    })
    .sort((a, b) => a.step - b.step);
  const end = events.at(-1)?.time ?? startedAt;
  const duplicates = [...seenEntityIds.entries()].filter(([, n]) => n > 1);

  return {
    file,
    sessionId: session.id ?? dirname(file).split(/[\\/]/).pop(),
    wallSeconds: Math.round(((end - startedAt) / 1000) * 10) / 10,
    steps: stepRows.length,
    calls: [...calls.values()].length,
    callsPerStep: stepRows.length ? Math.round(([...calls.values()].length / stepRows.length) * 10) / 10 : 0,
    tools,
    errors,
    truncated: truncated.length,
    droppedIds: droppedIds.length,
    duplicateIds: duplicates.length,
    usage,
    slowestSteps: [...stepRows].sort((a, b) => (b.wall ?? 0) - (a.wall ?? 0)).slice(0, 5),
    stepRows,
  };
}

function printOne(m) {
  const wall = m.wallSeconds >= 60 ? `${(m.wallSeconds / 60).toFixed(1)}m` : `${m.wallSeconds}s`;
  console.log(`\n=== ${m.sessionId} (${m.file})`);
  console.log(
    `wall ${wall} | steps ${m.steps} | calls ${m.calls} (${m.callsPerStep}/step) | ` +
      `out ${m.usage.output} tok | think ${m.usage.reasoningChars}c / text ${m.usage.textChars}c | ` +
      `cache-read ${m.usage.cacheRead}`,
  );
  if (m.steps > 0) {
    const tokPerSec = m.wallSeconds > 0 ? Math.round((m.usage.output / m.wallSeconds) * 10) / 10 : 0;
    console.log(`rate   ${tokPerSec} output tok/s (wall)`);
  }
  const toolLine = Object.entries(m.tools)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name.replace("civi6_", "")}:${n}${m.errors[name] ? `(err ${m.errors[name]})` : ""}`)
    .join("  ");
  console.log(`tools  ${toolLine}`);
  console.log(`drops  truncated ${m.truncated} | droppedIds ${m.droppedIds} | duplicateEntityIds ${m.duplicateIds}`);
  console.log(
    `slow   ${m.slowestSteps.map((s) => `S${s.step}:${s.wall}s/${s.output}tok`).join("  ")}`,
  );
}

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const targets = argv.filter((arg) => arg !== "--json");
const files = targets.length
  ? targets.flatMap((target) => findSessionFiles(resolve(target)))
  : recentSessionFiles();

if (!files.length) {
  console.error("no session.v4.jsonl.zstd found");
  process.exit(1);
}

const summaries = files.map((file) => analyze(decodeSessionFile(file), file));
if (asJson) {
  console.log(JSON.stringify(summaries, null, 2));
} else {
  for (const summary of summaries) printOne(summary);
  console.log("\nread it as: wall ≈ steps × (TTFT + output tokens / decode rate);");
  console.log("watch steps, output tokens, truncated payloads, droppedIds and duplicateEntityIds.");
}
