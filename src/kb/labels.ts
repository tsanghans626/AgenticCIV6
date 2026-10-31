import type { KnowledgeDb } from "../db.js";

interface EntityLoc {
  table: string;
  pk: string;
  loc: string;
}

/** Raw entity tables used by the decision layer, keyed by KB entity kind. */
export const ENTITY_LOC: Record<string, EntityLoc> = {
  tech: { table: "Technologies", pk: "TechnologyType", loc: "LOC_TECH_" },
  civic: { table: "Civics", pk: "CivicType", loc: "LOC_CIVIC_" },
  policy: { table: "Policies", pk: "PolicyType", loc: "LOC_POLICY_" },
  government: { table: "Governments", pk: "GovernmentType", loc: "LOC_GOVERNMENT_" },
  building: { table: "Buildings", pk: "BuildingType", loc: "LOC_BUILDING_" },
  district: { table: "Districts", pk: "DistrictType", loc: "LOC_DISTRICT_" },
  unit: { table: "Units", pk: "UnitType", loc: "LOC_UNIT_" },
  project: { table: "Projects", pk: "ProjectType", loc: "LOC_PROJECT_" },
  greatperson: {
    table: "GreatPersonIndividuals",
    pk: "GreatPersonIndividualType",
    loc: "LOC_GREAT_PERSON_INDIVIDUAL_",
  },
  improvement: { table: "Improvements", pk: "ImprovementType", loc: "LOC_IMPROVEMENT_" },
  resource: { table: "Resources", pk: "ResourceType", loc: "LOC_RESOURCE_" },
  civilization: { table: "Civilizations", pk: "CivilizationType", loc: "LOC_CIVILIZATION_" },
  leader: { table: "Leaders", pk: "LeaderType", loc: "LOC_LEADER_" },
  trait: { table: "Traits", pk: "TraitType", loc: "LOC_TRAIT_" },
  era: { table: "Eras", pk: "EraType", loc: "LOC_ERA_" },
  terrain: { table: "Terrains", pk: "TerrainType", loc: "LOC_TERRAIN_" },
  feature: { table: "Features", pk: "FeatureType", loc: "LOC_FEATURE_" },
};

export interface Labeler {
  pair(kind: string, id: string): { zh: string; en: string };
  zh(kind: string, id: string): string;
  en(kind: string, id: string): string;
  tag(tag: string, lang: "zh_Hans_CN" | "en_US"): string | undefined;
}

/** Build a memoized label resolver over the KB's own LocalizedText table. */
export function createLabeler(kb: KnowledgeDb, langs: string[] = ["en_US", "zh_Hans_CN"]): Labeler {
  const cache = new Map<string, { zh: string; en: string }>();
  const locCache = new Map<string, string | null>();

  function loc(tag: string, lang: string): string | undefined {
    const key = `${lang}\u0000${tag}`;
    if (locCache.has(key)) return locCache.get(key) ?? undefined;
    const row = kb.get<{ Text: string }>(
      `SELECT Text FROM LocalizedText WHERE Tag = ? AND Language = ? LIMIT 1;`,
      tag,
      lang,
    );
    const text = row?.Text ?? null;
    locCache.set(key, text);
    return text ?? undefined;
  }

  function tag(tagName: string, lang: "zh_Hans_CN" | "en_US"): string | undefined {
    return loc(tagName, lang) ?? (lang !== "en_US" ? loc(tagName, "en_US") : undefined);
  }

  function resolve(kind: string, id: string): { zh: string; en: string } {
    const key = `${kind}\u0000${id}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const spec = ENTITY_LOC[kind];
    if (!spec) {
      const out = { zh: id, en: id };
      cache.set(key, out);
      return out;
    }
    let nameTag: string | undefined;
    try {
      const row = kb.get<Record<string, unknown>>(
        `SELECT "Name" FROM "${spec.table}" WHERE "${spec.pk}" = ? LIMIT 1;`,
        id,
      );
      if (row && typeof row.Name === "string" && row.Name) nameTag = row.Name;
    } catch {
      /* table/column may not exist */
    }
    if (!nameTag) nameTag = `${spec.loc}${id.replace(/^[A-Z]+_/, "")}_NAME`;
    const en = loc(nameTag, "en_US") ?? id;
    const zh = loc(nameTag, "zh_Hans_CN") ?? en;
    const out = { zh, en };
    cache.set(key, out);
    return out;
  }

  return {
    pair: resolve,
    zh: (kind, id) => resolve(kind, id).zh,
    en: (kind, id) => resolve(kind, id).en,
    tag,
  };
}
