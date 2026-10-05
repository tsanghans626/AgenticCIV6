import type { KnowledgeDb } from "./db.js";
import type { Config } from "./config.js";

export interface SearchDoc {
  id: string;
  type: string;
  name: string;
  name_zh: string;
  doc: string;
  embedding: Float32Array | null;
}

/** Tokenize text: ASCII words + CJK unigrams/bigrams (lowercased). */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) tokens.push(m[0]);

  for (const m of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i]);
      if (i + 1 < run.length) tokens.push(run[i] + run[i + 1]);
    }
  }
  return tokens;
}

export function loadSearchDocs(kb: KnowledgeDb): SearchDoc[] {
  const rows = kb.all<Record<string, unknown>>(
    `SELECT id, type, name, name_zh, doc, embedding FROM search_docs;`,
  );
  return rows.map((r) => {
    let embedding: Float32Array | null = null;
    if (r.embedding instanceof Uint8Array && r.embedding.byteLength >= 4) {
      embedding = new Float32Array(r.embedding.buffer.slice(0));
    }
    return {
      id: String(r.id),
      type: String(r.type),
      name: String(r.name ?? ""),
      name_zh: String(r.name_zh ?? ""),
      doc: String(r.doc ?? ""),
      embedding,
    };
  });
}

interface Bm25Doc {
  doc: SearchDoc;
  tokens: Map<string, number>;
  len: number;
}

export interface Bm25Index {
  docs: Bm25Doc[];
  df: Map<string, number>;
  avgdl: number;
  N: number;
}

export function buildBm25(docs: SearchDoc[]): Bm25Index {
  const df = new Map<string, number>();
  const bmDocs: Bm25Doc[] = docs.map((doc) => {
    const tokens = tokenize(doc.doc);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return { doc, tokens: tf, len: tokens.length };
  });
  const avgdl = bmDocs.length ? bmDocs.reduce((s, d) => s + d.len, 0) / bmDocs.length : 1;
  return { docs: bmDocs, df, avgdl, N: bmDocs.length };
}

const K1 = 1.5;
const B = 0.75;

export function rankBm25(index: Bm25Index, query: string, limit: number): { doc: SearchDoc; score: number }[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const scored: { doc: SearchDoc; score: number }[] = [];
  for (const d of index.docs) {
    let score = 0;
    for (const t of new Set(qTokens)) {
      const df = index.df.get(t);
      if (df === undefined) continue;
      const tf = d.tokens.get(t) ?? 0;
      if (tf === 0) continue;
      const idf = Math.log(1 + (index.N - df + 0.5) / (df + 0.5));
      const denom = tf + K1 * (1 - B + (B * d.len) / index.avgdl);
      score += idf * ((tf * (K1 + 1)) / denom);
    }
    if (score > 0) scored.push({ doc: d.doc, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function rankVector(docs: SearchDoc[], queryVec: Float32Array, limit: number) {
  const scored = docs
    .filter((d) => d.embedding)
    .map((doc) => ({ doc, score: (cosine(doc.embedding!, queryVec) + 1) / 2 }))
    .filter((r) => r.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

interface SearchResult {
  id: string;
  type: string;
  name: string;
  name_zh: string;
  score: number;
  snippet: string;
}

function combine(
  docs: SearchDoc[],
  query: string,
  limit: number,
  vecScores?: Map<string, number>,
): { results: SearchResult[]; embedding: boolean } {
  const index = buildBm25(docs);
  const bm25 = rankBm25(index, query, Math.max(limit * 3, 50));
  const byId = new Map(docs.map((d) => [d.id, d]));
  const useVec = !!vecScores && vecScores.size > 0;

  if (!useVec) {
    return {
      results: bm25.map((r) => ({
        id: r.doc.id,
        type: r.doc.type,
        name: r.doc.name,
        name_zh: r.doc.name_zh,
        score: r.score,
        snippet: r.doc.doc.slice(0, 240),
      })),
      embedding: false,
    };
  }

  const bmMax = bm25.length ? bm25[0].score : 1;
  const merged = new Map<string, number>();
  for (const r of bm25) merged.set(r.doc.id, (r.score / bmMax) * 0.5);
  for (const [id, s] of vecScores) merged.set(id, (merged.get(id) ?? 0) + s * 0.5);

  const results = [...merged.entries()]
    .map(([id, score]) => {
      const d = byId.get(id)!;
      return { id: d.id, type: d.type, name: d.name, name_zh: d.name_zh, score, snippet: d.doc.slice(0, 240) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { results, embedding: true };
}

/** BM25-only search (offline, used by the CLI). */
export function hybridSearchSync(
  kb: KnowledgeDb,
  query: string,
  opts: { limit?: number; type?: string } = {},
) {
  const limit = Math.min(opts.limit ?? 20, 100);
  let docs = loadSearchDocs(kb);
  if (opts.type) docs = docs.filter((d) => d.type === opts.type);
  const { results, embedding } = combine(docs, query, limit);
  return { query, embedding, count: results.length, results };
}

/** Hybrid search over the entity index (BM25 always; vectors when available). */
export async function hybridSearch(
  kb: KnowledgeDb,
  config: Config,
  query: string,
  opts: { limit?: number; type?: string } = {},
) {
  const limit = Math.min(opts.limit ?? 20, 100);
  let docs = loadSearchDocs(kb);
  if (opts.type) docs = docs.filter((d) => d.type === opts.type);

  let vecScores: Map<string, number> | undefined;
  const hasVectors = docs.some((d) => d.embedding);
  if (hasVectors && config.openaiApiKey) {
    const qv = await embedQuery(config, query);
    if (qv) {
      const vec = rankVector(docs, qv, Math.max(limit * 3, 50));
      vecScores = new Map(vec.map((r) => [r.doc.id, r.score]));
    }
  }
  const { results, embedding } = combine(docs, query, limit, vecScores);
  return { query, embedding, count: results.length, results };
}

async function embedBatch(config: Config, texts: string[]): Promise<Float32Array[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({ model: config.openaiEmbeddingModel, input: texts, encoding_format: "float" }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI embeddings failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => new Float32Array(d.embedding));
}

/** Embed all search docs and store vectors. Returns count (0 when no key). */
export async function buildEmbeddings(kb: KnowledgeDb, config: Config): Promise<number> {
  if (!config.openaiApiKey) return 0;
  const docs = loadSearchDocs(kb);
  if (docs.length === 0) return 0;
  const update = kb.db.prepare(`UPDATE search_docs SET embedding = ? WHERE id = ?;`);

  const batchSize = 100;
  let count = 0;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    const vecs = await embedBatch(config, batch.map((d) => d.doc));
    kb.begin();
    try {
      batch.forEach((d, j) => {
        const bytes = new Uint8Array(vecs[j].buffer);
        update.run(bytes, d.id);
        count++;
      });
    } finally {
      kb.commit();
    }
  }
  return count;
}

/** Async query-time embedding for the server's hybrid search path. */
export async function embedQuery(config: Config, text: string): Promise<Float32Array | null> {
  if (!config.openaiApiKey) return null;
  try {
    const [v] = await embedBatch(config, [text]);
    return v;
  } catch {
    return null;
  }
}
