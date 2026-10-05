import express, { type Request, type Response, type NextFunction } from "express";
import type { KnowledgeDb } from "./db.js";
import type { Config } from "./config.js";
import { listEntityTypes, listEntities, getEntityDetail, getSpec, collectModifierIds } from "./entities.js";
import { resolveModifiers } from "./modifiers.js";
import { hybridSearch } from "./search.js";

function asyncWrap(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function num(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function createApp(kb: KnowledgeDb, config: Config) {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", source: config.paths.assets, dbFile: config.dbFile });
  });

  app.get("/api/meta", (_req, res) => {
    const metaRow = kb.get<{ value: string }>(`SELECT value FROM _meta WHERE key = 'build';`);
    const tables = kb.listTables();
    const counts: Record<string, number> = {};
    for (const t of tables) counts[t] = kb.countRows(t);
    res.json({
      build: metaRow ? JSON.parse(metaRow.value) : null,
      source: config.paths.assets,
      tableCount: tables.length,
      rowCounts: counts,
      entityTypes: listEntityTypes(),
      languages: config.langs,
      embeddingEnabled: !!config.openaiApiKey,
    });
  });

  app.get("/api/tables", (_req, res) => {
    const tables = kb.listTables().map((name) => ({
      name,
      columns: kb.tableColumns(name),
      rows: kb.countRows(name),
    }));
    res.json({ count: tables.length, tables });
  });

  app.get("/api/tables/:name", (req, res) => {
    const name = req.params.name;
    if (!kb.hasTable(name)) return res.status(404).json({ error: `table not found: ${name}` });
    res.json({ name, columns: kb.tableColumns(name), rows: kb.countRows(name) });
  });

  app.get("/api/tables/:name/rows", (req, res) => {
    const name = req.params.name;
    if (!kb.hasTable(name)) return res.status(404).json({ error: `table not found: ${name}` });
    const columns = kb.tableColumns(name);
    const limit = Math.min(num(req.query.limit, 100), 1000);
    const offset = Math.max(num(req.query.offset, 0), 0);

    const where: string[] = [];
    const params: (string | number)[] = [];
    for (const [k, v] of Object.entries(req.query)) {
      if (k === "limit" || k === "offset") continue;
      if (!columns.includes(k)) continue;
      where.push(`"${k}" = ?`);
      params.push(String(v));
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = kb.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}" ${whereSql};`, ...params)?.n ?? 0;
    const rows = kb.all<Record<string, unknown>>(
      `SELECT * FROM "${name}" ${whereSql} LIMIT ? OFFSET ?;`,
      ...params,
      limit,
      offset,
    );
    res.json({ table: name, total, limit, offset, rows });
  });

  app.get("/api/query", (req, res) => {
    const sql = (req.query.sql as string | undefined)?.trim();
    if (!sql) return res.status(400).json({ error: "missing ?sql=" });
    const upper = sql.toUpperCase();
    if (!/^\s*(SELECT|WITH|EXPLAIN|PRAGMA)\b/.test(upper)) {
      return res.status(400).json({ error: "只读模式：仅允许 SELECT/WITH/EXPLAIN/PRAGMA 查询" });
    }
    try {
      const rows = kb.all<Record<string, unknown>>(sql);
      res.json({ sql, count: rows.length, rows });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.get("/api/entities", (_req, res) => {
    res.json({
      types: listEntityTypes().map((t) => {
        const spec = getSpec(t)!;
        return { type: t, table: spec.table, pk: spec.pk, count: kb.countRows(spec.table) };
      }),
    });
  });

  app.get("/api/entities/:type", (req, res) => {
    const { type } = req.params;
    const result = listEntities(kb, type, {
      limit: num(req.query.limit, 100),
      offset: num(req.query.offset, 0),
      q: (req.query.q as string) || undefined,
      lang: (req.query.lang as string) || "zh_Hans_CN",
    });
    res.json({ type, ...result });
  });

  app.get("/api/entities/:type/:id", (req, res) => {
    const { type, id } = req.params;
    const lang = (req.query.lang as string) || "zh_Hans_CN";
    const detail = getEntityDetail(kb, type, id, lang);
    if (!detail) return res.status(404).json({ error: `entity not found: ${type}/${id}` });
    res.json(detail);
  });

  app.get("/api/modifiers/:type/:id", (req, res) => {
    const { type, id } = req.params;
    const spec = getSpec(type);
    if (!spec) return res.status(404).json({ error: `unknown entity type: ${type}` });
    const modifierIds = collectModifierIds(kb, spec, id);
    const modifiers = resolveModifiers(kb, modifierIds, (req.query.lang as string) || "zh_Hans_CN");
    res.json({ type, id, count: modifiers.length, modifiers });
  });

  app.get(
    "/api/search",
    asyncWrap(async (req, res) => {
      const q = (req.query.q as string)?.trim();
      if (!q) return res.status(400).json({ error: "missing ?q=" });
      const result = await hybridSearch(kb, config, q, {
        limit: num(req.query.limit, 20),
        type: (req.query.type as string) || undefined,
      });
      res.json(result);
    }),
  );

  // 404 handler for API routes
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  return app;
}
