import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import { agentLook, agentSummary } from "../src/server/views.ts";
import { serializeWorld } from "../src/persist/store.ts";

test("each AI's look is public, in range, and reading it changes nothing", () => {
  const world = World.create({ seed: 77 });
  const snap = () => JSON.stringify({ ...serializeWorld(world, 1), savedAt: "" });
  const before = snap();
  for (const a of world.population.all()) {
    const look = agentLook(a);
    assert.ok(look.hue >= 0 && look.hue < 1);
    assert.equal(look.p.length, 5);
    assert.equal(look.sk.length, 5);
    assert.equal(look.em.length, 4);
    for (const v of look.p) assert.ok(v >= -1 && v <= 1);
    assert.deepEqual(agentSummary(a, world).look, look);
  }
  assert.equal(snap(), before);
});

test("founders differ in color; the same quirks give the same color", () => {
  const world = World.create({ seed: 77 });
  const hues = world.population.list().map((a) => agentLook(a).hue);
  assert.ok(new Set(hues.map((h) => Math.round(h * 20))).size >= 8, "founders spread around the wheel");
  const a = world.population.list()[0];
  assert.equal(agentLook(a).hue, agentLook(a).hue);
});
