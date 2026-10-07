import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import { TICKS_PER_DAY } from "../src/core/constants.ts";
import {
  SPOOKED_FEAR,
  blankEmotions,
  feel,
  feelingWords,
  grieveFor,
  shareFeelings,
  tickEmotions,
} from "../src/agents/emotions.ts";
import { updateBody } from "../src/agents/needs.ts";
import { scoreActions, act } from "../src/agents/brain.ts";
import { dailyKinship, hourTogether } from "../src/agents/kinship.ts";
import { SpatialIndex } from "../src/agents/senses.ts";
import { igniteAt } from "../src/world/fire.ts";
import { serializeWorld, deserializeWorld } from "../src/persist/store.ts";
import type { Agent } from "../src/agents/agent.ts";
import type { AgentContext } from "../src/agents/movement.ts";

const TICKS_PER_HOUR = 3600;

function ctxOf(world: World): AgentContext {
  const index = new SpatialIndex(8);
  index.rebuild(world.population.list());
  return { world, population: world.population, index };
}

/** Makes a founder a young adult (the band is mixed-age; some tests need grown hands). */
function adult(agent: Agent, world: World): Agent {
  agent.bornTick = world.tick - Math.round(agent.lifespanTicks * 0.3);
  return agent;
}

function hoursOfQuiet(agent: Agent, hours: number, company = false): void {
  for (let i = 0; i < hours * TICKS_PER_HOUR; i++) tickEmotions(agent, company, 0, false);
}

test("feelings rise with events and fade over hours; grief is the one that stays", () => {
  const world = World.create({ seed: 71 });
  const [a] = world.population.list();
  feel(a, "joy", 0.8);
  feel(a, "sadness", 0.8);
  hoursOfQuiet(a, 6);
  assert.ok(a.emotions.joy < 0.25, `joy passes in an afternoon (${a.emotions.joy.toFixed(2)})`);
  assert.ok(a.emotions.sadness > 0.6, `grief barely moves in six hours (${a.emotions.sadness.toFixed(2)})`);
  hoursOfQuiet(a, 24 * 4);
  assert.ok(a.emotions.sadness < 0.1, "but even grief softens after days");
});

test("sorrow fades faster in company, and loneliness gathers only when alone", () => {
  const world = World.create({ seed: 72 });
  const [a, b] = world.population.list();
  feel(a, "sadness", 0.8);
  feel(b, "sadness", 0.8);
  hoursOfQuiet(a, 24, true);
  hoursOfQuiet(b, 24, false);
  assert.ok(a.emotions.sadness < b.emotions.sadness * 0.75, "shared sorrow softens sooner");
  assert.equal(a.emotions.loneliness, 0, "no loneliness in company");
  assert.ok(b.emotions.loneliness > 0.15, `a day alone is felt (${b.emotions.loneliness.toFixed(2)})`);
  hoursOfQuiet(b, 2, true);
  assert.ok(b.emotions.loneliness < 0.05, "company dissolves it quickly");
});

test("a death lands hardest on the mate, then family, then friends; strangers are untouched", () => {
  const world = World.create({ seed: 73 });
  const [dead, mate, friend, stranger] = world.population.list();
  mate.mate = dead.id;
  dead.mate = mate.id;
  mate.bonds[dead.id] = { trust: 0.8, affection: 0.7, lastNear: world.tick };
  friend.bonds[dead.id] = { trust: 0.5, affection: 0.5, lastNear: world.tick };
  delete stranger.bonds[dead.id];
  world.population.remove(dead.id);
  grieveFor(world, dead);
  assert.ok(mate.emotions.sadness >= 0.9, "the mate is devastated");
  assert.ok(friend.emotions.sadness > 0.2 && friend.emotions.sadness < mate.emotions.sadness, "a friend grieves less");
  assert.equal(stranger.emotions.sadness, 0, "no bond, no grief");
  assert.ok(mate.emotions.fear > 0, "loss unsettles");
  assert.ok(world.chronicle.all().some((e) => /the first grief/.test(e.text)));
});

test("flames burn fear into whoever stands near them", () => {
  const world = World.create({ seed: 74 });
  const [a] = world.population.list();
  assert.equal(a.emotions.fear, 0);
  for (let i = 0; i < TICKS_PER_HOUR / 2; i++) {
    updateBody(a, world, { hasCompany: false, shelter: 0, warmth: 0, fire: "beside" });
  }
  assert.ok(a.emotions.fear > 0.2, `half an hour beside flames is felt (${a.emotions.fear.toFixed(2)})`);
});

test("fresh fear widens the berth: a spooked AI backs away from fire before it hurts", () => {
  const world = World.create({ seed: 75 });
  const [calm, spooked] = world.population.list();
  // Both stand two tiles from a burning tile: close, but not burning distance.
  for (const [agent, x] of [[calm, 300], [spooked, 320]] as [Agent, number][]) {
    agent.x = x;
    agent.y = 300;
    agent.action = { type: "idle", startedTick: world.tick, untilTick: world.tick + 100000 };
    agent.nextDecisionTick = world.tick + 100000;
  }
  igniteAt(world, 302, 300, 100);
  igniteAt(world, 322, 300, 100);
  spooked.emotions.fear = SPOOKED_FEAR + 0.1;
  const ctx = ctxOf(world);
  act(calm, ctx);
  act(spooked, ctx);
  assert.notEqual(calm.action?.type, "flee", "two tiles off and unafraid: no reason to move");
  assert.equal(spooked.action?.type, "flee", "the burned one keeps its distance");
});

test("fear and joy pass between people who spend an hour close together", () => {
  const world = World.create({ seed: 76 });
  const [a, b] = world.population.list();
  b.x = a.x + 1;
  b.y = a.y;
  feel(a, "fear", 0.8);
  feel(b, "joy", 0.6);
  hourTogether(ctxOf(world));
  assert.ok(b.emotions.fear > 0.05, `fear spreads (${b.emotions.fear.toFixed(2)})`);
  assert.ok(a.emotions.joy > 0.04, `joy spreads back (${a.emotions.joy.toFixed(2)})`);
  assert.ok(a.emotions.fear >= 0.8 - 1e-9, "feeling passes without draining the one who feels it");
});

test("grief drains the will for play and wandering, but not for staying alive", () => {
  const world = World.create({ seed: 77 });
  const [a] = world.population.list();
  a.carrying.push({ material: 1, units: 3 });
  const ctx = ctxOf(world);
  const calm = scoreActions(a, ctx);
  a.emotions = { ...blankEmotions(), sadness: 0.9 };
  const grieving = scoreActions(a, ctx);
  assert.ok(grieving.explore < calm.explore * 0.7, "no heart for wandering");
  assert.ok(grieving.idle > calm.idle, "a grieving one sits");
  assert.equal(grieving.eat, calm.eat, "the body still has to live");
  assert.equal(grieving.sleep, calm.sleep);
});

test("feelings have words, and they survive save and load exactly", () => {
  const world = World.create({ seed: 78 });
  const [a, b] = world.population.list();
  feel(a, "sadness", 0.7);
  feel(a, "fear", 0.4);
  feel(b, "wonder", 0.5);
  assert.deepEqual(feelingWords(a), ["grieving", "uneasy"]);
  assert.deepEqual(feelingWords(b), ["full of wonder"]);
  const copy = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world, 1)))).world;
  assert.equal(JSON.stringify(copy.population), JSON.stringify(world.population));
  for (let i = 0; i < 3000; i++) {
    world.step();
    copy.step();
  }
  assert.equal(JSON.stringify(copy.population), JSON.stringify(world.population), "and the worlds carry on identically");
});

test("a save from before feelings existed loads with everyone even-keeled", () => {
  const world = World.create({ seed: 79 });
  const raw = JSON.parse(JSON.stringify(serializeWorld(world, 1)));
  raw.format = 8;
  for (const a of raw.population.agents) delete a.emotions;
  const loaded = deserializeWorld(raw).world;
  for (const a of loaded.population.list()) {
    assert.deepEqual(a.emotions, blankEmotions());
  }
});

test("a pair forming is a joy to both; drifting apart is a sorrow", () => {
  const world = World.create({ seed: 80 });
  const [a, b] = world.population.list();
  adult(a, world);
  adult(b, world);
  b.x = a.x + 1;
  b.y = a.y;
  a.bonds[b.id] = { trust: 0.6, affection: 0.6, lastNear: world.tick };
  b.bonds[a.id] = { trust: 0.6, affection: 0.6, lastNear: world.tick };
  dailyKinship(ctxOf(world));
  assert.equal(a.mate, b.id);
  assert.ok(a.emotions.joy >= 0.5 && b.emotions.joy >= 0.5, "pairing is joy");
  // Long separation undoes it, sadly.
  a.emotions.joy = 0;
  b.emotions.joy = 0;
  a.bonds[b.id].lastNear = world.tick - 20 * TICKS_PER_DAY;
  dailyKinship(ctxOf(world));
  assert.equal(a.mate, null);
  assert.ok(a.emotions.sadness >= 0.4 && b.emotions.sadness >= 0.4, "parting is sorrow");
});
