import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import {
  CHILD_DRIFT_FACTOR,
  TRAIT_DRIFT_PER_DAY,
  TRAIT_KINDS,
  blankPersonality,
  dailyPersonality,
  daySignals,
  natureWords,
} from "../src/agents/personality.ts";
import { blankEmotions, feel } from "../src/agents/emotions.ts";
import { scoreActions } from "../src/agents/brain.ts";
import { SpatialIndex } from "../src/agents/senses.ts";
import { serializeWorld, deserializeWorld } from "../src/persist/store.ts";
import type { Agent } from "../src/agents/agent.ts";
import type { AgentContext } from "../src/agents/movement.ts";

function ctxOf(world: World): AgentContext {
  const index = new SpatialIndex(8);
  index.rebuild(world.population.list());
  return { world, population: world.population, index };
}

/** One settled day for everyone: these feelings happened, then midnight came. */
function dayOf(world: World, shape: (a: Agent) => void): void {
  for (const a of world.population.list()) shape(a);
  dailyPersonality(ctxOf(world));
}

test("the founders begin all but identical: a whisper of quirk, nothing more", () => {
  const world = World.create({ seed: 91 });
  for (const a of world.population.list()) {
    for (const k of TRAIT_KINDS) assert.ok(Math.abs(a.personality[k]) <= 0.08 + 1e-9, `${k} starts near zero`);
  }
});

test("a life of scares makes a timid soul; a safe life builds a little nerve", () => {
  const world = World.create({ seed: 92 });
  const [scared, safe] = world.population.list();
  scared.personality = blankPersonality();
  safe.personality = blankPersonality();
  for (let d = 0; d < 60; d++) {
    dayOf(world, (a) => {
      if (a === scared) feel(a, "fear", 0.8);
    });
  }
  assert.ok(scared.personality.courage < -0.5, `repeated fright settles (${scared.personality.courage.toFixed(2)})`);
  assert.ok(safe.personality.courage > 0.2, `quiet days build nerve (${safe.personality.courage.toFixed(2)})`);
  assert.ok(natureWords(scared).includes("timid"));
});

test("joy makes the sunny, grief the somber, wonder the seeker", () => {
  const world = World.create({ seed: 93 });
  const [sunny, somber, seeker] = world.population.list();
  for (const a of [sunny, somber, seeker]) a.personality = blankPersonality();
  for (let d = 0; d < 60; d++) {
    dayOf(world, (a) => {
      if (a === sunny) feel(a, "joy", 0.6);
      if (a === somber) feel(a, "sadness", 0.7);
      if (a === seeker) feel(a, "wonder", 0.7);
    });
  }
  assert.ok(sunny.personality.cheer > 0.4, "joy settles into sunniness");
  assert.ok(somber.personality.cheer < -0.4, "grief settles into somberness");
  assert.ok(seeker.personality.wander > 0.4, "wonder settles into seeking");
  assert.ok(natureWords(seeker).includes("a seeker"));
});

test("childhood shapes twice as fast", () => {
  const world = World.create({ seed: 94 });
  const [a, b] = world.population.list();
  const child = world.population.createChild(world.rng, world.tick, a.x + 2, a.y, a, b);
  child.personality = blankPersonality();
  a.personality = blankPersonality();
  for (let d = 0; d < 20; d++) {
    dayOf(world, (x) => {
      if (x === child || x === a) feel(x, "wonder", 0.5);
    });
  }
  assert.ok(
    child.personality.wander > a.personality.wander * 1.5,
    `the child is marked deeper (${child.personality.wander.toFixed(2)} vs ${a.personality.wander.toFixed(2)})`,
  );
});

test("the day's work and company read as signals, and midnight clears the slate", () => {
  const world = World.create({ seed: 95 });
  const [a] = world.population.list();
  a.stats.blocksPlaced = 3;
  a.stats.crafted = 1;
  a.prevWork = 0;
  a.needs.social = 1;
  feel(a, "joy", 0.5);
  const signals = daySignals(a);
  assert.ok(signals.industry > 0.5, "a day of real work");
  assert.ok(signals.warmth > 0.3, "a day among others");
  dailyPersonality(ctxOf(world));
  assert.deepEqual(a.felt, blankEmotions(), "tomorrow accumulates fresh");
  assert.equal(a.prevWork, 4, "and the work is banked");
  assert.ok(daySignals(a).industry < 0, "no new work yet: the signal rests");
});

test("nature tilts the day: seekers roam, the warm seek company, the dreamy sit", () => {
  const world = World.create({ seed: 96 });
  const [a] = world.population.list();
  const ctx = ctxOf(world);
  a.needs.social = 0.5; // missing company a little, so the pull is there to tilt
  a.personality = blankPersonality();
  const plain = scoreActions(a, ctx);
  a.personality = { ...blankPersonality(), wander: 0.8, warmth: 0.8 };
  const roamer = scoreActions(a, ctx);
  assert.ok(roamer.explore > plain.explore * 1.2, "a seeker roams more");
  assert.ok(roamer.socialize > plain.socialize, "the warm seek company");
  a.personality = { ...blankPersonality(), industry: -0.8, cheer: -0.8 };
  const dreamer = scoreActions(a, ctx);
  assert.ok(dreamer.idle > plain.idle, "the dreamy and somber sit longer");
  assert.equal(dreamer.eat, plain.eat, "nature never starves anyone");
  assert.equal(dreamer.sleep, plain.sleep);
});

test("the chronicle marks the world's first of each settled nature", () => {
  const world = World.create({ seed: 97 });
  const [a] = world.population.list();
  a.personality = blankPersonality();
  for (let d = 0; d < 40; d++) {
    dayOf(world, (x) => {
      if (x === a) feel(x, "fear", 0.9);
    });
  }
  const entries = world.chronicle.all().filter((e) => /timid now, the first of them/.test(e.text));
  assert.equal(entries.length, 1, "once, for the whole world");
});

test("personality survives save and load exactly, and old saves grow natures from their quirks", () => {
  const world = World.create({ seed: 98 });
  const [a] = world.population.list();
  a.personality.wander = 0.6;
  feel(a, "joy", 0.3); // felt-so-far must survive too
  const copy = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world, 1)))).world;
  assert.equal(JSON.stringify(copy.population), JSON.stringify(world.population));
  for (let i = 0; i < 3000; i++) {
    world.step();
    copy.step();
  }
  assert.equal(JSON.stringify(copy.population), JSON.stringify(world.population), "and the worlds carry on identically");
  // A format-9 save (before personality) upgrades with quirk-whisper natures.
  const raw = JSON.parse(JSON.stringify(serializeWorld(world, 1)));
  raw.format = 9;
  for (const ag of raw.population.agents) {
    delete ag.personality;
    delete ag.felt;
    delete ag.prevWork;
  }
  const loaded = deserializeWorld(raw).world;
  for (const ag of loaded.population.list()) {
    for (const k of TRAIT_KINDS) assert.ok(Math.abs(ag.personality[k]) <= 0.08 + 1e-9);
    assert.deepEqual(ag.felt, blankEmotions());
  }
});
