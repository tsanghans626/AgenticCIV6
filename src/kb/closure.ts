import type { KnowledgeDb } from "../db.js";

/**
 * L1b: transitive prerequisite closure.
 *
 * `kb_unlock` is a child -> parent edge table. This pass materialises, for each
 * root entity, every prerequisite reachable within `MAX_DEPTH`. The runtime can
 * then fetch a full tech/civic closure with one indexed lookup instead of
 * recursively joining the raw prerequisite tables.
 */
const MAX_DEPTH = 20;
const SKIP_RELATIONS = new Set(["replaces"]);

const ROOT_KINDS = [
  "tech", "civic", "district", "building", "project", "policy",
  "government", "unit", "improvement",
] as const;

interface Node {
  kind: string;
  id: string;
}

function nodeKey(n: Node): string {
  return `${n.kind}\u0000${n.id}`;
}

export function buildClosure(kb: KnowledgeDb): number {
  kb.exec(`DELETE FROM kb_closure;`);

  const edges = kb.all<{ child_kind: string; child_id: string; parent_kind: string; parent_id: string; relation: string }>(
    `SELECT child_kind, child_id, parent_kind, parent_id, relation FROM kb_unlock;`,
  );
  const parents = new Map<string, Node[]>();
  for (const e of edges) {
    if (SKIP_RELATIONS.has(e.relation)) continue;
    const key = `${e.child_kind}\u0000${e.child_id}`;
    const list = parents.get(key);
    const node = { kind: e.parent_kind, id: e.parent_id };
    if (list) list.push(node);
    else parents.set(key, [node]);
  }

  const roots: Node[] = [];
  for (const kind of ROOT_KINDS) {
    const table =
      kind === "tech" ? "Technologies" :
      kind === "civic" ? "Civics" :
      kind === "district" ? "Districts" :
      kind === "building" ? "Buildings" :
      kind === "project" ? "Projects" :
      kind === "policy" ? "Policies" :
      kind === "government" ? "Governments" :
      kind === "unit" ? "Units" : "Improvements";
    const pk =
      kind === "tech" ? "TechnologyType" :
      kind === "civic" ? "CivicType" :
      kind === "district" ? "DistrictType" :
      kind === "building" ? "BuildingType" :
      kind === "project" ? "ProjectType" :
      kind === "policy" ? "PolicyType" :
      kind === "government" ? "GovernmentType" :
      kind === "unit" ? "UnitType" : "ImprovementType";
    if (!kb.hasTable(table)) continue;
    for (const r of kb.all<Record<string, unknown>>(`SELECT "${pk}" AS id FROM "${table}";`)) {
      if (r.id) roots.push({ kind, id: String(r.id) });
    }
  }

  const stmt = kb.db.prepare(
    `INSERT OR IGNORE INTO kb_closure (root_kind, root_id, node_kind, node_id, depth) VALUES (?,?,?,?,?);`,
  );
  let count = 0;
  kb.begin();
  try {
    for (const root of roots) {
      const rootKey = nodeKey(root);
      const visited = new Map<string, number>([[rootKey, 0]]);
      const queue: Array<{ node: Node; depth: number }> = [{ node: root, depth: 0 }];
      stmt.run(root.kind, root.id, root.kind, root.id, 0);
      count++;
      for (let i = 0; i < queue.length; i++) {
        const { node, depth } = queue[i];
        if (depth >= MAX_DEPTH) continue;
        for (const parent of parents.get(nodeKey(node)) ?? []) {
          const key = nodeKey(parent);
          if (visited.has(key)) continue;
          visited.set(key, depth + 1);
          stmt.run(root.kind, root.id, parent.kind, parent.id, depth + 1);
          count++;
          queue.push({ node: parent, depth: depth + 1 });
        }
      }
    }
  } finally {
    kb.commit();
  }
  return count;
}

/** Fetch one root's closure ordered by depth, used by the engine/validator. */
export function closureOf(kb: KnowledgeDb, kind: string, id: string): Array<{ kind: string; id: string; depth: number }> {
  const rows = kb.all<{ node_kind: string; node_id: string; depth: number }>(
    `SELECT node_kind, node_id, depth FROM kb_closure
      WHERE root_kind = ? AND root_id = ? ORDER BY depth, node_kind, node_id;`,
    kind,
    id,
  );
  return rows.map((r) => ({ kind: r.node_kind, id: r.node_id, depth: r.depth }));
}
