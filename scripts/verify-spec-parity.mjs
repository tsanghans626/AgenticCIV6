import assert from "node:assert/strict";
import { SPECS as buildSpecs } from "../src/entities.ts";
import { SPECS as pluginSpecs } from "../dsh-plugin/index.js";

function shape(spec) {
  return {
    type: spec.type,
    table: spec.table,
    pk: spec.pk,
    loc: spec.loc,
    stats: [...spec.stats],
    related: spec.related.map((r) => ({ table: r.table, fk: r.fk })),
    modifierResolver: spec.modifierResolver,
  };
}

const build = buildSpecs.map(shape);
const plugin = pluginSpecs.map(shape);

assert.equal(
  build.length,
  plugin.length,
  `实体类型数量不一致：build=${build.length} plugin=${plugin.length}`,
);

for (const expected of build) {
  const actual = plugin.find((s) => s.type === expected.type);
  assert.ok(actual, `插件缺少实体类型：${expected.type}`);
  assert.deepEqual(actual, expected, `实体定义漂移：${expected.type}`);
}

console.log(`✓ 实体 SPECS 一致：${build.length} 类（${build.map((s) => s.type).join(", ")}）`);
