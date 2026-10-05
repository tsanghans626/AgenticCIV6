import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";

const OP_TAGS = ["Row", "Replace", "Update", "Delete", "Insert"] as const;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: true,
  trimValues: true,
  parseTagValue: false,
  processEntities: true,
  isArray: (name: string) => (OP_TAGS as readonly string[]).includes(name),
});

export interface ParsedXml {
  /** root element name, e.g. "GameInfo" or "GameData" */
  root: string;
  /** the root element's child object */
  body: Record<string, unknown>;
}

/** Parse a Civ6 XML file. Returns the root element name and its children. */
export function parseXmlFile(filePath: string): ParsedXml {
  const content = readFileSync(filePath, "utf8");
  // Strip a possible UTF-8 BOM.
  const cleaned = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const parsed = parser.parse(cleaned) as Record<string, unknown>;
  const root = Object.keys(parsed).find((k) => !k.startsWith("?xml") && !k.startsWith("!DOCTYPE"));
  if (!root) return { root: "", body: {} };
  const body = (parsed[root] ?? {}) as Record<string, unknown>;
  return { root, body };
}

/** Flatten a <Row>/<Replace>/... node into a column->value record. */
export function rowToRecord(node: unknown): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  if (!node || typeof node !== "object") return rec;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k.startsWith("@_")) {
      rec[k.slice(2)] = v;
    } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      rec[k] = v;
    } else if (v && typeof v === "object") {
      const t = (v as Record<string, unknown>)["#text"];
      if (typeof t === "string" || typeof t === "number") rec[k] = t;
    }
  }
  return rec;
}

/** Coerce a single element (possibly absent) into an array. */
export function asArray(v: unknown): unknown[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export interface RowOp {
  kind: "row" | "replace" | "insert" | "update" | "delete";
  /** for row/replace/insert: the record */
  record?: Record<string, unknown>;
  /** for update/delete: WHERE column->value */
  where?: Record<string, unknown>;
  /** for update: SET column->value */
  set?: Record<string, unknown>;
}

/** Convert a table element (e.g. <Units>...</Units>) into a list of ops. */
export function tableOps(tableEl: unknown): RowOp[] {
  const ops: RowOp[] = [];
  if (!tableEl || typeof tableEl !== "object") return ops;
  const obj = tableEl as Record<string, unknown>;

  for (const t of asArray(obj.Row)) ops.push({ kind: "row", record: rowToRecord(t) });
  for (const t of asArray(obj.Replace)) ops.push({ kind: "replace", record: rowToRecord(t) });
  for (const t of asArray(obj.Insert)) ops.push({ kind: "insert", record: rowToRecord(t) });

  for (const u of asArray(obj.Update)) {
    const uobj = u as Record<string, unknown>;
    const where = uobj.Where ? rowToRecord(uobj.Where) : {};
    // <Set Col="v"/> (attributes) or <Set><Col>text</Col></Set> (child text)
    const setRaw = uobj.Set;
    let set: Record<string, unknown> = {};
    if (setRaw && typeof setRaw === "object") {
      set = rowToRecord(setRaw);
    }
    ops.push({ kind: "update", where, set });
  }

  for (const d of asArray(obj.Delete)) {
    const dobj = d as Record<string, unknown>;
    const where = dobj.Where ? rowToRecord(dobj.Where) : rowToRecord(dobj);
    ops.push({ kind: "delete", where });
  }
  return ops;
}
