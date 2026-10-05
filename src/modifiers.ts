import type { KnowledgeDb } from "./db.js";

/** Substitute `{ArgName}` placeholders in a localized string with argument values. */
function substitute(text: string, args: Record<string, unknown>[]): string {
  let out = text;
  for (const a of args) {
    if (typeof a.Name === "string" && a.Value != null) {
      out = out.replaceAll(`{${a.Name}}`, String(a.Value));
    }
  }
  return out;
}

function describeModifier(kb: KnowledgeDb, modifierId: string, modifierType: string, args: Record<string, unknown>[]): string | undefined {
  if (kb.hasTable("ModifierStrings")) {
    const row =
      kb.get<{ Text: string }>(
        `SELECT Text FROM ModifierStrings WHERE ModifierId = ? AND Context = 'Summary' LIMIT 1;`,
        modifierId,
      ) ??
      kb.get<{ Text: string }>(`SELECT Text FROM ModifierStrings WHERE ModifierId = ? LIMIT 1;`, modifierId);
    if (row?.Text) return substitute(row.Text, args);
  }
  // Fallback: structural summary with localized argument values.
  const parts = args
    .filter((a) => typeof a.Name === "string" && a.Value != null)
    .map((a) => `${a.Name}=${prettyValue(kb, a.Value)}`);
  return parts.length ? `${modifierType} (${parts.join(", ")})` : modifierType;
}

/** Localize a modifier argument value where it is a known reference. */
function prettyValue(kb: KnowledgeDb, v: unknown): string {
  const s = String(v);
  if (s.startsWith("YIELD_")) {
    const name = kb.get<{ Text: string }>(
      `SELECT Text FROM LocalizedText WHERE Tag = ? AND Language = 'zh_Hans_CN' LIMIT 1;`,
      `LOC_${s}_NAME`,
    );
    if (name?.Text) return `${name.Text}(${s})`;
  }
  if (s.startsWith("LOC_")) {
    const name = kb.get<{ Text: string }>(
      `SELECT Text FROM LocalizedText WHERE Tag = ? AND Language = 'zh_Hans_CN' LIMIT 1;`,
      s,
    );
    if (name?.Text) return name.Text;
  }
  return s;
}

function describeRequirement(
  kb: KnowledgeDb,
  requirementId: string,
  args: Record<string, unknown>[],
): string | undefined {
  if (!kb.hasTable("RequirementStrings")) return undefined;
  const row =
    kb.get<{ Text: string }>(
      `SELECT Text FROM RequirementStrings WHERE RequirementId = ? AND Context = 'Summary' LIMIT 1;`,
      requirementId,
    ) ??
    kb.get<{ Text: string }>(`SELECT Text FROM RequirementStrings WHERE RequirementId = ? LIMIT 1;`, requirementId);
  return row?.Text ? substitute(row.Text, args) : undefined;
}

function resolveRequirementSet(kb: KnowledgeDb, setId: string) {
  if (!kb.hasTable("RequirementSets")) return null;
  const set = kb.get<{ RequirementSetType: string }>(
    `SELECT * FROM RequirementSets WHERE RequirementSetId = ?;`,
    setId,
  );
  if (!set) return null;

  const reqs = kb.hasTable("RequirementSetRequirements")
    ? kb.all<{ RequirementId: string }>(
        `SELECT RequirementId FROM RequirementSetRequirements WHERE RequirementSetId = ?;`,
        setId,
      )
    : [];
  const requirements = reqs.map((r) => {
    const req = kb.get<{ RequirementType: string }>(
      `SELECT * FROM Requirements WHERE RequirementId = ?;`,
      r.RequirementId,
    );
    const args = kb.hasTable("RequirementArguments")
      ? kb.all<Record<string, unknown>>(
          `SELECT * FROM RequirementArguments WHERE RequirementId = ?;`,
          r.RequirementId,
        )
      : [];
    return {
      requirementId: r.RequirementId,
      requirementType: req?.RequirementType ?? null,
      description: describeRequirement(kb, r.RequirementId, args) ?? null,
      arguments: args,
    };
  });
  return { requirementSetId: setId, requirementSetType: set.RequirementSetType, requirements };
}

export interface ResolvedModifier {
  modifierId: string;
  modifierType: string;
  description: string | null;
  runOnce: unknown;
  permanent: unknown;
  ownerRequirementSetId: string | null;
  subjectRequirementSetId: string | null;
  ownerRequirement: unknown;
  subjectRequirement: unknown;
  arguments: Record<string, unknown>[];
}

/** Resolve a list of ModifierIds into full effect chains (modifier + requirements). */
export function resolveModifiers(
  kb: KnowledgeDb,
  modifierIds: string[],
  _lang = "zh_Hans_CN",
): ResolvedModifier[] {
  const out: ResolvedModifier[] = [];
  const seen = new Set<string>();
  if (!kb.hasTable("Modifiers")) return out;

  for (const mid of modifierIds) {
    if (!mid || seen.has(mid)) continue;
    seen.add(mid);
    const mod = kb.get<Record<string, unknown>>(`SELECT * FROM Modifiers WHERE ModifierId = ?;`, mid);
    if (!mod) continue;
    const args = kb.hasTable("ModifierArguments")
      ? kb.all<Record<string, unknown>>(`SELECT * FROM ModifierArguments WHERE ModifierId = ?;`, mid)
      : [];
    const ownerId = typeof mod.OwnerRequirementSetId === "string" ? mod.OwnerRequirementSetId : null;
    const subjectId = typeof mod.SubjectRequirementSetId === "string" ? mod.SubjectRequirementSetId : null;
    out.push({
      modifierId: mid,
      modifierType: String(mod.ModifierType ?? ""),
      description: describeModifier(kb, mid, String(mod.ModifierType ?? ""), args) ?? null,
      runOnce: mod.RunOnce ?? null,
      permanent: mod.Permanent ?? null,
      ownerRequirementSetId: ownerId,
      subjectRequirementSetId: subjectId,
      ownerRequirement: ownerId ? resolveRequirementSet(kb, ownerId) : null,
      subjectRequirement: subjectId ? resolveRequirementSet(kb, subjectId) : null,
      arguments: args,
    });
  }
  return out;
}
