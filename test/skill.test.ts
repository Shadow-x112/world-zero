import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import {
  MASTERY,
  TEACH_CAP,
  WATCH_CAP,
  blankSkills,
  practice,
  skillWords,
  teachNearby,
  watchSuccess,
  workSpeed,
} from "../src/agents/skill.ts";
import { heatChance, shapeChance, HEAT_CHANCE } from "../src/items/crafting.ts";
import { pickupTicks } from "../src/agents/foraging.ts";
import { SpatialIndex } from "../src/agents/senses.ts";
import { serializeWorld, deserializeWorld } from "../src/persist/store.ts";
import type { Agent } from "../src/agents/agent.ts";
import type { AgentContext } from "../src/agents/movement.ts";

function ctxOf(world: World): AgentContext {
  const index = new SpatialIndex(8);
  index.rebuild(world.population.list());
  return { world, population: world.population, index };
}

test("hands learn by doing, successes most, with diminishing returns", () => {
  const world = World.create({ seed: 101 });
  const [a, b] = world.population.list();
  practice(a, "crafting", true, world);
  practice(b, "crafting", false, world);
  assert.ok(a.skills.crafting > b.skills.crafting && b.skills.crafting > 0, "a success teaches more; a failure still teaches");
  const earlyGain = a.skills.crafting;
  for (let i = 0; i < 200; i++) practice(a, "crafting", true, world);
  const s = a.skills.crafting;
  practice(a, "crafting", true, world);
  assert.ok(a.skills.crafting - s < earlyGain / 2, "the two-hundredth rep teaches less than the first");
  assert.ok(a.skills.crafting <= 1);
});

test("skill shows in the work: faster gathering, surer edges, readier flame", () => {
  const world = World.create({ seed: 102 });
  const [green, master] = world.population.list();
  master.skills = { ...blankSkills(), gathering: 1, crafting: 1, firecraft: 1 };
  const type = world.materials.require(1);
  assert.ok(pickupTicks(master, world, type) < pickupTicks(green, world, type) * 0.7, "things come loose faster");
  assert.ok(shapeChance(master) > shapeChance(green) + 0.2, "edges take surer");
  assert.equal(heatChance(green), HEAT_CHANCE, "green hands start where the world started");
  assert.ok(heatChance(master) >= 0.55, "practiced hands raise flame surer");
  assert.ok(workSpeed(1) > workSpeed(0), "work goes quicker");
});

test("the first raised flame is most of the knack", () => {
  const world = World.create({ seed: 103 });
  const [a] = world.population.list();
  practice(a, "firecraft", true, world);
  assert.ok(heatChance(a) > 0.35, `one success carries the knack (${heatChance(a).toFixed(2)})`);
});

test("watching a success teaches a little and plants the recipe, but never mastery", () => {
  const world = World.create({ seed: 104 });
  const [doer, watcher, sleeper, far] = world.population.list();
  doer.skills.firecraft = 1;
  watcher.x = doer.x + 2;
  watcher.y = doer.y;
  sleeper.x = doer.x + 1;
  sleeper.y = doer.y + 1;
  sleeper.asleep = true;
  far.x = doer.x + 200;
  doer.tried["heat:4"] = { n: 3, ok: 1 };
  for (let i = 0; i < 50; i++) watchSuccess(ctxOf(world), doer, "firecraft", "heat:4");
  assert.equal(watcher.skills.firecraft, WATCH_CAP, "watching gets you only so far");
  assert.ok(watcher.tried["heat:4"]?.ok === 1, "the recipe survived outside its maker's skull");
  assert.equal(sleeper.skills.firecraft, 0, "the asleep saw nothing");
  assert.equal(far.skills.firecraft, 0, "the far-off saw nothing");
});

test("a skilled adult shows a dear one its craft: skill, recipe, warmth, history", () => {
  const world = World.create({ seed: 105 });
  const [teacher, learner, stranger] = world.population.list();
  world.tick = Math.ceil(world.tick / 3600) * 3600 + 2520; // the teaching minute, in daylight
  world.calendar = { ...world.calendar, light: 1 };
  teacher.x = 300;
  teacher.y = 300;
  learner.x = 301;
  learner.y = 300;
  stranger.x = 302;
  stranger.y = 300;
  teacher.skills.firecraft = 0.9;
  teacher.tried["heat:4"] = { n: 5, ok: 2 };
  teacher.personality.warmth = 1; // teaches readily
  teacher.bonds[learner.id] = { trust: 0.7, affection: 0.8, lastNear: world.tick };
  delete teacher.bonds[stranger.id];
  teacher.action = { type: "idle", startedTick: world.tick };
  const trustBefore = learner.bondWith(teacher.id).trust;
  let taught = false;
  for (let i = 0; i < 60 && !taught; i++) {
    teachNearby(teacher, ctxOf(world));
    taught = learner.skills.firecraft > 0;
    if (!taught) world.tick += 3600; // another hour, another chance
  }
  assert.ok(taught, "the lesson came");
  assert.ok(learner.skills.firecraft > 0.05 && learner.skills.firecraft <= TEACH_CAP, "shown, not made a master");
  assert.equal(learner.tried["heat:4"]?.ok, 1, "and the recipe passed with it");
  assert.ok(learner.bondWith(teacher.id).trust > trustBefore, "a lesson warms the bond");
  assert.equal(stranger.skills.firecraft, 0, "strangers get no lessons");
  assert.ok(world.chronicle.all().some((e) => /The first lesson/.test(e.text)));
});

test("the cure is the first lesson: herb-lore outlives its discoverer", () => {
  const world = World.create({ seed: 106 });
  const [teacher, child] = world.population.list();
  world.tick = Math.ceil(world.tick / 3600) * 3600 + 2520;
  world.calendar = { ...world.calendar, light: 1 };
  teacher.x = 300;
  teacher.y = 300;
  child.x = 301;
  child.y = 300;
  teacher.personality.warmth = 1;
  teacher.mate = child.id; // dear by definition
  teacher.knowledge[11] = { firstSeenTick: 0, handled: true, tasted: true, props: { nourishment: 0.1, reactivity: 0.6 }, timesEaten: 2, curative: true };
  teacher.action = { type: "idle", startedTick: world.tick };
  let taught = false;
  for (let i = 0; i < 60 && !taught; i++) {
    teachNearby(teacher, ctxOf(world));
    taught = !!child.knowledge[11]?.curative;
    if (!taught) world.tick += 3600;
  }
  assert.ok(taught, "the herb was shown");
  assert.ok(child.knowledge[11].curative && child.knowledge[11].tasted, "the child now knows the cure without ever being poisoned");
});

test("mastery is noticed once per world, and has words", () => {
  const world = World.create({ seed: 107 });
  const [a, b] = world.population.list();
  a.skills.cooking = MASTERY - 0.001;
  b.skills.cooking = MASTERY - 0.001;
  practice(a, "cooking", true, world);
  practice(b, "cooking", true, world);
  const entries = world.chronicle.all().filter((e) => /mastered its craft/.test(e.text));
  assert.equal(entries.length, 1, "the world's first master of a craft, once");
  assert.ok(skillWords(a).some((w) => w.startsWith("cooking")), skillWords(a).join());
});

test("skills survive save and load exactly, and old saves keep the fire knack", () => {
  const world = World.create({ seed: 108 });
  const [a] = world.population.list();
  a.skills.gathering = 0.4;
  a.tried["heat:4"] = { n: 2, ok: 1 };
  const copy = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world, 1)))).world;
  assert.equal(JSON.stringify(copy.population), JSON.stringify(world.population));
  for (let i = 0; i < 3000; i++) {
    world.step();
    copy.step();
  }
  assert.equal(JSON.stringify(copy.population), JSON.stringify(world.population), "and the worlds carry on identically");
  // A format-10 save (before skill): green hands, except the proven firemaker.
  const raw = JSON.parse(JSON.stringify(serializeWorld(world, 1)));
  raw.format = 10;
  for (const ag of raw.population.agents) delete ag.skills;
  const loaded = deserializeWorld(raw).world;
  const was = loaded.population.get(a.id)!;
  assert.equal(was.skills.firecraft, 0.6, "whoever had raised flame keeps the knack");
  assert.equal(was.skills.gathering, 0, "everything else starts green");
});
