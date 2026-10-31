import type { KnowledgeDb } from "../db.js";
import type { DataSource } from "../config.js";
import type { CivSpec, KbSpecs } from "./spec.js";
import type { Labeler } from "./labels.js";

export interface CivStats {
  profiles: number;
  entityMaps: number;
  deltas: number;
  capabilities: number;
}

interface Profile {
  civId: string;
  leaderId: string;
  traits: string[];
  unique: { unit: string[]; building: string[]; district: string[]; improvement: string[] };
}

function jsonList(values: string[]): string {
  return JSON.stringify([...new Set(values)].sort());
}

/** Derive every civ/leader's base-board profile and unique-entity replacements. */
export function buildCivs(
  kb: KnowledgeDb,
  source: DataSource,
  specs: KbSpecs,
  labeler: Labeler,
): CivStats {
  kb.exec(`DELETE FROM kb_civ_profile; DELETE FROM kb_civ_entity_map; DELETE FROM kb_civ_delta;`);

  const civTraits = new Map<string, string[]>();
  if (kb.hasTable("CivilizationTraits")) {
    for (const r of kb.all<{ CivilizationType: string; TraitType: string }>(
      `SELECT CivilizationType, TraitType FROM CivilizationTraits;`,
    )) {
      const list = civTraits.get(r.CivilizationType) ?? [];
      list.push(r.TraitType);
      civTraits.set(r.CivilizationType, list);
    }
  }
  const leaderTraits = new Map<string, string[]>();
  if (kb.hasTable("LeaderTraits")) {
    for (const r of kb.all<{ LeaderType: string; TraitType: string }>(
      `SELECT LeaderType, TraitType FROM LeaderTraits;`,
    )) {
      const list = leaderTraits.get(r.LeaderType) ?? [];
      list.push(r.TraitType);
      leaderTraits.set(r.LeaderType, list);
    }
  }

  const civLeaderPairs: Array<{ civId: string; leaderId: string }> = [];
  if (kb.hasTable("CivilizationLeaders")) {
    for (const r of kb.all<{ CivilizationType: string; LeaderType: string }>(
      `SELECT CivilizationType, LeaderType FROM CivilizationLeaders;`,
    )) civLeaderPairs.push({ civId: r.CivilizationType, leaderId: r.LeaderType });
  }
  const civs = kb.hasTable("Civilizations")
    ? kb.all<{ CivilizationType: string }>(`SELECT CivilizationType FROM Civilizations;`)
    : [];
  for (const c of civs) {
    if (!civLeaderPairs.some((p) => p.civId === c.CivilizationType)) {
      civLeaderPairs.push({ civId: c.CivilizationType, leaderId: "" });
    }
  }

  // Trait -> unique entities.
  const unitByTrait = new Map<string, string>();
  const buildingByTrait = new Map<string, string>();
  const districtByTrait = new Map<string, string>();
  const improvementByTrait = new Map<string, string>();
  const collect = (table: string, pk: string, target: Map<string, string>) => {
    if (!kb.hasTable(table)) return;
    for (const r of kb.all<Record<string, unknown>>(
      `SELECT "${pk}" AS id, TraitType FROM "${table}" WHERE TraitType IS NOT NULL AND TraitType <> '';`,
    )) {
      const trait = String(r.TraitType);
      if (!target.has(trait)) target.set(trait, String(r.id));
    }
  };
  collect("Units", "UnitType", unitByTrait);
  collect("Buildings", "BuildingType", buildingByTrait);
  collect("Districts", "DistrictType", districtByTrait);
  collect("Improvements", "ImprovementType", improvementByTrait);

  const unitReplaces = new Map<string, string>();
  if (kb.hasTable("UnitReplaces")) {
    for (const r of kb.all<{ CivUniqueUnitType: string; ReplacesUnitType: string }>(
      `SELECT CivUniqueUnitType, ReplacesUnitType FROM UnitReplaces;`,
    )) unitReplaces.set(r.CivUniqueUnitType, r.ReplacesUnitType);
  }
  const buildingReplaces = new Map<string, string>();
  if (kb.hasTable("BuildingReplaces")) {
    for (const r of kb.all<{ CivUniqueBuildingType: string; ReplacesBuildingType: string }>(
      `SELECT CivUniqueBuildingType, ReplacesBuildingType FROM BuildingReplaces;`,
    )) buildingReplaces.set(r.CivUniqueBuildingType, r.ReplacesBuildingType);
  }
  const districtReplaces = new Map<string, string>();
  if (kb.hasTable("DistrictReplaces")) {
    for (const r of kb.all<{ CivUniqueDistrictType: string; ReplacesDistrictType: string }>(
      `SELECT CivUniqueDistrictType, ReplacesDistrictType FROM DistrictReplaces;`,
    )) districtReplaces.set(r.CivUniqueDistrictType, r.ReplacesDistrictType);
  }

  const profiles: Profile[] = [];
  const mapRows: unknown[][] = [];
  for (const pair of civLeaderPairs) {
    const traits = [...(civTraits.get(pair.civId) ?? []), ...(leaderTraits.get(pair.leaderId) ?? [])];
    const unique = { unit: [] as string[], building: [] as string[], district: [] as string[], improvement: [] as string[] };
    for (const t of traits) {
      const u = unitByTrait.get(t);
      if (u) unique.unit.push(u);
      const b = buildingByTrait.get(t);
      if (b) unique.building.push(b);
      const d = districtByTrait.get(t);
      if (d) unique.district.push(d);
      const i = improvementByTrait.get(t);
      if (i) unique.improvement.push(i);
    }
    profiles.push({ civId: pair.civId, leaderId: pair.leaderId, traits, unique });

    const addMap = (slotKind: string, uniqueId: string, replaces?: string) => {
      if (!replaces) return;
      mapRows.push([source, pair.civId, pair.leaderId, slotKind, replaces, uniqueId, replaces]);
    };
    for (const u of unique.unit) addMap("unit", u, unitReplaces.get(u));
    for (const b of unique.building) addMap("building", b, buildingReplaces.get(b));
    for (const d of unique.district) addMap("district", d, districtReplaces.get(d));
  }

  const specByKey = new Map<string, CivSpec>();
  for (const s of specs.civs) specByKey.set(`${s.civId}\u0000${s.leaderId ?? ""}`, s);

  const profileStmt = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_civ_profile (source, civ_id, leader_id, name_zh, name_en,
       unique_unit, unique_building, unique_district, unique_improvement, trait_ids,
       start_bias, playstyle_tags, supported_victories, summary, source_flag, confidence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);`,
  );
  const mapStmt = kb.db.prepare(
    `INSERT OR REPLACE INTO kb_civ_entity_map (source, civ_id, leader_id, slot_kind, base_id, unique_id, replaces_id)
     VALUES (?,?,?,?,?,?,?);`,
  );
  const deltaStmt = kb.db.prepare(
    `INSERT INTO kb_civ_delta (source, civ_id, leader_id, victory_id, target_ref, op, value_num, value_lo, value_hi,
       value_text, era_id, reason, source_flag, confidence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?);`,
  );
  const capStmt = kb.hasTable("kb_civ_capability")
    ? kb.db.prepare(
        `INSERT OR REPLACE INTO kb_civ_capability (cap_id, source, civ_id, leader_id, trait_id, op,
           target_ref, add_nodes, remove_nodes, value, requires, effect_text_zh, why, confidence)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?);`,
      )
    : null;
  let deltaCount = 0;
  let capCount = 0;
  kb.begin();
  try {
    for (const p of profiles) {
      const cs = specByKey.get(`${p.civId}\u0000${p.leaderId}`) ?? specByKey.get(`${p.civId}\u0000`);
      const civLabel = labeler.pair("civilization", p.civId);
      const leaderLabel = p.leaderId ? labeler.pair("leader", p.leaderId) : null;
      const nameZh = leaderLabel ? `${civLabel.zh} / ${leaderLabel.zh}` : civLabel.zh;
      const nameEn = leaderLabel ? `${civLabel.en} / ${leaderLabel.en}` : civLabel.en;
      profileStmt.run(
        source, p.civId, p.leaderId, nameZh, nameEn,
        jsonList(p.unique.unit), jsonList(p.unique.building), jsonList(p.unique.district), jsonList(p.unique.improvement),
        jsonList(p.traits), null,
        cs?.playstyleTags ? JSON.stringify(cs.playstyleTags) : null,
        cs?.supportedVictories ? JSON.stringify(cs.supportedVictories) : null,
        cs?.summary ?? null,
        cs ? "empirical" : "derived",
        cs ? 0.7 : 0.5,
      );
      for (const d of cs?.deltas ?? []) {
        deltaStmt.run(
          source, p.civId, p.leaderId, d.victoryId, JSON.stringify(d.targetRef), d.op,
          d.valueNum ?? null, d.valueLo ?? null, d.valueHi ?? null, d.valueText ?? null,
          d.eraId ?? null, d.reason ?? null, d.sourceFlag ?? "empirical", d.confidence ?? 0.5,
        );
        deltaCount++;
      }
      for (const [index, cap] of (cs?.capabilities ?? []).entries()) {
        capStmt?.run(
          `${source}:${p.civId}:${p.leaderId || "any"}:${index}:${cap.op}`,
          source, p.civId, p.leaderId, cap.traitId, cap.op,
          JSON.stringify(cap.targetRef ?? {}),
          JSON.stringify(cap.add ?? []),
          JSON.stringify(cap.remove ?? []),
          cap.value ?? null,
          JSON.stringify(cap.requires ?? {}),
          cap.effectTextZh ?? null,
          cap.why ?? null,
          cap.confidence ?? 0.6,
        );
        capCount++;
      }
    }
    for (const row of mapRows) mapStmt.run(...row as never[]);
  } finally {
    kb.commit();
  }

  return { profiles: profiles.length, entityMaps: mapRows.length, deltas: deltaCount, capabilities: capCount };
}
