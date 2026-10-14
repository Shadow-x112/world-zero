import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import { TICKS_PER_DAY } from "../src/core/constants.ts";
import { historyFromChronicle } from "../src/core/history.ts";
import { serializeWorld, deserializeWorld } from "../src/persist/store.ts";

function runDays(world: World, days: number): void {
  for (let i = 0; i < days * TICKS_PER_DAY; i++) world.step();
}

test("the world keeps one record of its vital signs per day", () => {
  const world = World.create({ seed: 401 });
  runDays(world, 3);
  assert.equal(world.history.length, 3, "a record at each turn of the day");
  const r = world.history[2];
  assert.equal(r.alive, world.population.count);
  assert.equal(r.partial, undefined, "live records are complete");
  for (const k of ["children", "pairs", "walls", "roofs", "sharedWords", "concepts", "energy", "health", "joy", "fear", "explored"] as const) {
    assert.equal(typeof r[k], "number", k);
  }
  assert.ok(r.energy! >= 0 && r.energy! <= 1);
  assert.equal(r.day, world.history[1].day + 1, "consecutive days");
});

test("history is only watched, never acted on: a recorded world unfolds as it would have", () => {
  const a = World.create({ seed: 402 });
  const b = World.create({ seed: 402 });
  runDays(a, 2);
  runDays(b, 2);
  b.history = []; // forget everything recorded
  runDays(a, 1);
  runDays(b, 1);
  const strip = (w: World) => JSON.stringify({ ...serializeWorld(w, 1), savedAt: "", meta: { ...w.meta, id: "", createdAt: "" }, history: [] });
  assert.ok(strip(a) === strip(b), "what happens does not depend on what was recorded");
});

test("a restart in the middle of a day loses no births or deaths from the record", () => {
  const world = World.create({ seed: 403 });
  runDays(world, 1);
  for (let i = 0; i < TICKS_PER_DAY / 2; i++) world.step();
  const copy = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world, 1)))).world;
  // Pretend someone died this morning, in both (as if before the save).
  world.population.deaths++;
  copy.population.deaths++;
  for (let i = 0; i < TICKS_PER_DAY; i++) {
    world.step();
    copy.step();
  }
  assert.deepEqual(copy.history, world.history, "the resumed world keeps the same history");
  assert.equal(world.history[1].died, 1, "the death is counted on its day");
});

test("older worlds get their past rebuilt from the chronicle, marked partial", () => {
  const world = World.create({ seed: 404 });
  runDays(world, 2);
  const t0 = world.chronicle.all()[0].tick;
  world.chronicle.add(t0 + TICKS_PER_DAY + 10, "birth", "A new one.", { child: 99 });
  world.chronicle.add(t0 + TICKS_PER_DAY + 20, "death", "One died.", { agentId: 3 });
  world.chronicle.add(t0 + TICKS_PER_DAY + 30, "death", "One died.", { agentId: 4 });
  const past = historyFromChronicle(world.chronicle.all(), world.tick);
  assert.ok(past.length >= 2);
  assert.ok(past.every((r) => r.partial));
  assert.equal(past[0].alive, 50, "founders");
  assert.equal(past[1].born, 1);
  assert.equal(past[1].died, 2);
  assert.equal(past[1].alive, 49);

  // And a format-13 save gains it on load.
  const raw = JSON.parse(JSON.stringify(serializeWorld(world, 1)));
  raw.format = 13;
  delete raw.history;
  const loaded = deserializeWorld(raw).world;
  assert.ok(loaded.history.length >= 2 && loaded.history[0].partial);
  assert.equal(loaded.history[loaded.history.length - 1].totalDied, world.population.deaths, "totals line up with the population's own count");
});
