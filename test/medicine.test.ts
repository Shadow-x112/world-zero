import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import { getCalendar } from "../src/core/time.ts";
import { HERB_ID, absorbPerUnit, harmPerUnit } from "../src/materials/registry.ts";
import { placeTile, MATERIAL_VERSION } from "../src/materials/placement.ts";
import { sampleTile, FLAT_RADIUS } from "../src/world/generator.ts";
import { SICK_TOXIN, updateBody } from "../src/agents/needs.ts";
import { addCarried, consumeEffect, taste, tasteFor } from "../src/agents/foraging.ts";
import { igniteAt } from "../src/world/fire.ts";
import { serializeWorld, deserializeWorld } from "../src/persist/store.ts";

const GLOW = 7;
const EARTH = 6;

const ctx = { hasCompany: true, shelter: 1, warmth: 0, fire: null } as const;

function freshAgent(seed = 51) {
  const world = World.create({ seed });
  world.tick = 2 * 86400; // a warm season day, no exposure in play
  world.calendar = getCalendar(world.tick);
  const agent = world.population.list()[0];
  return { world, agent };
}

test("the herb exists, bites a well body, and binds poison hard for its weight", () => {
  const world = World.create({ seed: 1 });
  const herb = world.materials.require(HERB_ID);
  assert.ok(harmPerUnit(herb) > 0, "bitter: not free to eat");
  assert.ok(absorbPerUnit(herb) > 0, "but it binds");
  const earth = world.materials.require(EARTH);
  assert.ok(absorbPerUnit(earth) > 0, "the wet earth binds too (clay)");
  assert.ok(
    absorbPerUnit(herb) / herb.props.mass > 5 * (absorbPerUnit(earth) / earth.props.mass),
    "for its weight the herb is the far better medicine",
  );
});

test("herbs grow on ground placed from version 2 on; old ground regenerates without them", () => {
  let found = 0;
  let total = 0;
  for (let y = -FLAT_RADIUS; y <= FLAT_RADIUS; y += 2) {
    for (let x = -FLAT_RADIUS; x <= FLAT_RADIUS; x += 2) {
      total++;
      const t = sampleTile(6, x, y);
      if (placeTile(6, x, y, t.terrain, 2)?.material === HERB_ID) found++;
      assert.notEqual(placeTile(6, x, y, t.terrain, 1)?.material, HERB_ID, "version 1 never grew herbs");
    }
  }
  assert.equal(MATERIAL_VERSION, 2);
  const share = found / total;
  assert.ok(share > 0.001 && share < 0.02, `uncommon but findable (${(share * 100).toFixed(2)}%)`);
});

test("poison lingers: a bad mouthful means hours of sickness, not an instant blow", () => {
  const { world, agent } = freshAgent();
  const glow = world.materials.require(GLOW);
  const before = agent.health;
  const dose = 4;
  for (let i = 0; i < dose; i++) consumeEffect(agent, world, glow);
  const atOnce = before - agent.health;
  assert.ok(atOnce < harmPerUnit(glow) * dose * 0.3, "only a sting at first");
  assert.ok(agent.toxin > SICK_TOXIN, "the poison is in the body");
  let hours = 0;
  while (agent.toxin > 0 && hours < 24) {
    for (let i = 0; i < 3600; i++) updateBody(agent, world, ctx);
    hours++;
  }
  assert.ok(hours >= 2 && hours <= 9, `it worked through over ${hours} hours`);
  assert.ok(before - agent.health > harmPerUnit(glow) * dose * 0.5, "and did most of its damage on the way");
});

test("no healing while sick; eating the herb binds the toxin and teaches the cure", () => {
  const { world, agent } = freshAgent(52);
  agent.health = 0.6;
  agent.toxin = 0.2;
  for (let i = 0; i < 3600; i++) updateBody(agent, world, ctx);
  assert.ok(agent.health < 0.6, "a sick body cannot heal");
  const herb = world.materials.require(HERB_ID);
  const sickBefore = agent.toxin;
  const result = consumeEffect(agent, world, herb);
  assert.equal(result, "bound");
  assert.ok(agent.toxin < sickBefore - 0.05, "the toxin loosened");
  assert.equal(agent.knowledge[HERB_ID].curative, true, "and the lesson stuck");
  assert.ok(world.chronicle.all().some((e) => /the first cure/.test(e.text)));
  // The same mouthful on a well day is just a bitter mistake.
  const { world: w2, agent: healthy } = freshAgent(53);
  assert.equal(consumeEffect(healthy, w2, w2.materials.require(HERB_ID)), "poisoned");
  // And no poison ever cures itself: more of what sickened you only deepens it.
  const { world: w3, agent: doubled } = freshAgent(58);
  const deposit = w3.materials.require(8);
  consumeEffect(doubled, w3, deposit);
  doubled.toxin = 0.2; // deep in it
  const worse = consumeEffect(doubled, w3, deposit);
  assert.equal(worse, "poisoned");
  assert.ok(doubled.toxin > 0.2);
});

test("a sick AI that knows the cure treats itself back to health", () => {
  const { world, agent } = freshAgent(54);
  agent.toxin = 0.25;
  agent.knowledge[HERB_ID] = { firstSeenTick: 0, handled: true, tasted: true, props: {}, timesEaten: 0, curative: true };
  addCarried(agent, HERB_ID, 8);
  for (let i = 0; i < 4 * 3600 && agent.toxin >= SICK_TOXIN; i++) world.step();
  assert.ok(agent.toxin < SICK_TOXIN, `treated itself (toxin ${agent.toxin.toFixed(3)})`);
  assert.ok(agent.health > 0.75, `and lived well (${agent.health.toFixed(2)})`);
});

test("a desperate sick AI puts known-bitter things back in its mouth, and finds the cure", () => {
  const { world, agent } = freshAgent(55);
  // It has tasted the herb once (bitter, 'not food') and there is a patch nearby.
  taste(agent, world, world.materials.require(HERB_ID));
  agent.toxin = 0.3; // poisoned by something else entirely
  agent.toxinFrom = GLOW;
  agent.health = 0.9;
  world.grid.set("material", agent.tileX + 3, agent.tileY, HERB_ID);
  world.grid.set("amount", agent.tileX + 3, agent.tileY, 4);
  for (let i = 0; i < 6 * 3600 && !agent.knowledge[HERB_ID].curative; i++) world.step();
  assert.equal(agent.knowledge[HERB_ID].curative, true, "desperation taught it the cure");
});

test("cooking by the fire feeds better, chars sometimes, and shapes personal tastes", () => {
  const { world, agent } = freshAgent(56);
  igniteAt(world, agent.tileX + 1, agent.tileY + 1, 600);
  const m1 = world.materials.require(1);
  agent.knowledge[1] = { firstSeenTick: 0, handled: true, tasted: true, props: { nourishment: 0.7, reactivity: 0 }, timesEaten: 0 };
  // Many meals at the hearth: on average they feed better than raw, and fondness grows.
  let fedAtFire = 0;
  const meals = 40;
  for (let i = 0; i < meals; i++) {
    agent.needs.energy = 0.3;
    addCarried(agent, 1, 1);
    const before = agent.needs.energy;
    // eat directly through the action step
    agent.action = { type: "eat", startedTick: world.tick, untilTick: world.tick };
    world.step();
    fedAtFire += agent.needs.energy - before;
    agent.action = null;
  }
  assert.ok(agent.stats.cooked >= meals * 0.8, `meals by the fire count as cooked (${agent.stats.cooked})`);
  assert.ok(fedAtFire / meals > m1.props.nourishment * 0.1 * 1.1, "warm food feeds better on average");
  assert.ok(tasteFor(agent, 1) > 0.3, `it has come to like this food (${tasteFor(agent, 1).toFixed(2)})`);
  assert.ok(world.firsts.has("cookedMeal"));
});

test("toxin and tastes survive save and load", () => {
  const { world, agent } = freshAgent(57);
  agent.toxin = 0.11;
  agent.tastes[1] = 0.4;
  agent.knowledge[HERB_ID] = { firstSeenTick: 1, handled: true, tasted: true, props: {}, timesEaten: 0, curative: true };
  const copy = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world, 1)))).world;
  const same = copy.population.get(agent.id)!;
  assert.equal(same.toxin, 0.11);
  assert.equal(same.tastes[1], 0.4);
  assert.equal(same.knowledge[HERB_ID].curative, true);
});
