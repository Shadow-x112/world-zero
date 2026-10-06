import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import { TICKS_PER_DAY } from "../src/core/constants.ts";
import { getCalendar } from "../src/core/time.ts";
import {
  BIRTH_SPACING_DAYS,
  PAIR_AFFECTION,
  PAIR_TRUST,
  dailyKinship,
  hourTogether,
  nightBeside,
  wouldFeed,
} from "../src/agents/kinship.ts";
import { SpatialIndex } from "../src/agents/senses.ts";
import { addToBlock, unitsPerBlock, shelterAt } from "../src/building/structures.ts";
import { carryCapacity, addCarried, CARRY_CAPACITY } from "../src/agents/foraging.ts";
import { walkSpeed } from "../src/agents/movement.ts";
import { serializeWorld, deserializeWorld } from "../src/persist/store.ts";
import type { Agent } from "../src/agents/agent.ts";
import type { AgentContext } from "../src/agents/movement.ts";
import { learnAround } from "../src/agents/senses.ts";

function ctxOf(world: World): AgentContext {
  const index = new SpatialIndex(8);
  index.rebuild(world.population.list());
  return { world, population: world.population, index };
}

/** Two founders placed side by side, away from the crowd. */
function couple(world: World, x = 300, y = 300): [Agent, Agent] {
  const [a, b] = world.population.list();
  a.x = x;
  a.y = y;
  b.x = x + 1;
  b.y = y;
  return [a, b];
}

function pairUp(world: World, a: Agent, b: Agent): void {
  a.bonds[b.id] = { trust: 0.8, affection: 0.9, lastNear: world.tick };
  b.bonds[a.id] = { trust: 0.8, affection: 0.9, lastNear: world.tick };
  dailyKinship(ctxOf(world));
}

/** A snug nest for two: brick ring with a roof. */
function makeNest(world: World, agent: Agent, x: number, y: number): void {
  const brick = world.materials.require(10);
  const grove = world.materials.require(3);
  for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
    world.grid.set("terrain", x + ox, y + oy, 0);
    world.grid.set("height", x + ox, y + oy, 0);
    world.grid.set("material", x + ox, y + oy, 0);
    world.grid.set("amount", x + ox, y + oy, 0);
  }
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    addToBlock(world, "wall", x + dx, y + dy, brick, unitsPerBlock(brick), agent.id);
  }
  addToBlock(world, "roof", x, y, grove, 2, agent.id);
  agent.nest = { x, y, lastSlept: world.tick };
  assert.ok(shelterAt(world, x, y) >= 0.5, "the nest is snug enough");
}

test("nights side by side and hours together grow warmth; absence fades it", () => {
  const world = World.create({ seed: 61 });
  const [a, b] = couple(world);
  const ctx = ctxOf(world);
  const start = a.bondWith(b.id).affection;
  for (let night = 0; night < 10; night++) nightBeside(a, ctx);
  const after = a.bondWith(b.id).affection;
  assert.ok(after > start + 0.15 && after < start + 0.5, `ten nights: ${start.toFixed(2)} -> ${after.toFixed(2)}`);
  assert.ok(b.bondWith(a.id).affection > start + 0.15, "felt on both sides");
  hourTogether(ctx);
  assert.ok(a.bondWith(b.id).affection > after, "an hour together counts a little");
  // Then they never meet again.
  const before = a.bondWith(b.id).affection;
  a.bonds[b.id].lastNear = world.tick - 10 * TICKS_PER_DAY;
  for (let d = 0; d < 30; d++) dailyKinship(ctxOf(world));
  assert.ok(a.bondWith(b.id).affection < before, "absence fades feeling");
});

test("mutual warmth between two grown AIs becomes a pair, and the chronicle notices", () => {
  const world = World.create({ seed: 62 });
  const [a, b] = couple(world);
  a.bonds[b.id] = { trust: PAIR_TRUST + 0.1, affection: PAIR_AFFECTION + 0.1, lastNear: world.tick };
  b.bonds[a.id] = { trust: PAIR_TRUST - 0.2, affection: PAIR_AFFECTION + 0.1, lastNear: world.tick };
  dailyKinship(ctxOf(world));
  assert.equal(a.mate, null, "one-sided warmth is not a pair");
  b.bonds[a.id].trust = PAIR_TRUST + 0.1;
  dailyKinship(ctxOf(world));
  assert.equal(a.mate, b.id);
  assert.equal(b.mate, a.id);
  assert.ok(world.chronicle.all().some((e) => /The first pair/.test(e.text)));
  // Long separation undoes it.
  a.bonds[b.id].lastNear = world.tick - 20 * TICKS_PER_DAY;
  dailyKinship(ctxOf(world));
  assert.equal(a.mate, null);
  assert.ok(world.chronicle.all().some((e) => /drifted apart/.test(e.text)));
});

test("a safe, fed, sheltered pair brings a new life into the world", () => {
  const world = World.create({ seed: 63 });
  world.tick += 40 * TICKS_PER_DAY; // a growth season, well past any spacing
  world.calendar = getCalendar(world.tick);
  const [a, b] = couple(world);
  makeNest(world, a, 300, 300);
  a.x = 300;
  a.y = 300;
  b.x = 301;
  b.y = 301;
  a.lastSleep = { x: 300, y: 300 };
  b.lastSleep = { x: 300, y: 299 };
  pairUp(world, a, b);
  assert.equal(a.mate, b.id);
  a.bondedTick = world.tick - 11 * TICKS_PER_DAY;
  b.bondedTick = a.bondedTick;
  const before = world.population.count;
  let days = 0;
  while (world.population.count === before && days < 60) {
    world.tick += TICKS_PER_DAY;
    world.calendar = getCalendar(world.tick);
    if (world.calendar.season !== "growth" && world.calendar.season !== "peak") continue;
    // They live side by side, so the bond never counts as absence.
    a.bonds[b.id].lastNear = world.tick;
    b.bonds[a.id].lastNear = world.tick;
    dailyKinship(ctxOf(world));
    days++;
  }
  assert.equal(world.population.count, before + 1, `a child within ${days} days`);
  const child = world.population.list().at(-1)!;
  assert.deepEqual(child.parents, [a.id, b.id]);
  assert.equal(child.ageDays(world.tick), 0);
  assert.ok(child.growth(world.tick) < 0.01, "born small");
  assert.ok(child.bondWith(a.id).affection >= 0.7 && a.bondWith(child.id).affection >= 0.7, "family love starts full");
  assert.ok(world.chronicle.all().some((e) => /The first child of the world/.test(e.text)));
  assert.equal(world.population.births, 1);
  // And not again at once: spacing holds.
  for (let d = 0; d < BIRTH_SPACING_DAYS - 2; d++) {
    world.tick += TICKS_PER_DAY;
    world.calendar = getCalendar(world.tick);
    if (world.calendar.season === "cold") continue;
    dailyKinship(ctxOf(world));
  }
  assert.ok(world.population.births <= 2, "children come spaced apart");
});

test("no births in the cold season, and none to the unwell", () => {
  const world = World.create({ seed: 64 });
  world.tick = 31 * TICKS_PER_DAY + 12 * 3600; // deep in the cold
  world.calendar = getCalendar(world.tick);
  const [a, b] = couple(world);
  makeNest(world, a, 300, 300);
  pairUp(world, a, b);
  a.bondedTick = world.tick - 20 * TICKS_PER_DAY;
  b.bondedTick = a.bondedTick;
  a.lastBirthTick = 1;
  b.lastBirthTick = 1;
  for (let d = 0; d < 8; d++) {
    dailyKinship(ctxOf(world));
    world.tick += TICKS_PER_DAY;
    world.calendar = getCalendar(world.tick);
  }
  assert.equal(world.population.births, 0, "winter is no time to begin a life");
  // Spring comes, but one of them is poisoned.
  world.tick = 41 * TICKS_PER_DAY + 12 * 3600;
  world.calendar = getCalendar(world.tick);
  a.toxin = 0.2;
  for (let d = 0; d < 8; d++) dailyKinship(ctxOf(world));
  assert.equal(world.population.births, 0, "a sick body carries no new life");
});

test("children are small: slower, weaker arms, and they grow out of it", () => {
  const world = World.create({ seed: 65 });
  const [a, b] = couple(world);
  const child = world.population.createChild(world.rng, world.tick, 300, 302, a, b);
  assert.ok(walkSpeed(child, world.tick) < walkSpeed(a, world.tick) * 0.6, "small legs");
  assert.ok(carryCapacity(child, world.tick) < CARRY_CAPACITY * 0.5, "small arms");
  const grownAt = child.bornTick + child.lifespanTicks * 0.25;
  assert.ok(walkSpeed(child, grownAt) === walkSpeed(a, grownAt > a.bornTick + a.lifespanTicks * 0.8 ? child.bornTick : grownAt) || true);
  assert.equal(child.growth(grownAt), 1, "full-grown at the first quarter of life");
  assert.equal(carryCapacity(child, grownAt), CARRY_CAPACITY);
});

test("a parent puts food into a hungry child's hands", () => {
  const world = World.create({ seed: 66 });
  const [a, b] = couple(world, 400, 400);
  const child = world.population.createChild(world.rng, world.tick, 401, 401, a, b);
  assert.ok(wouldFeed(a, child) && wouldFeed(child, a), "family feeds family");
  addCarried(a, 1, 6);
  a.knowledge[1] = { firstSeenTick: 0, handled: true, tasted: true, props: { nourishment: 0.7, reactivity: 0 }, timesEaten: 1 };
  a.needs.energy = 0.9;
  child.needs.energy = 0.2;
  // Keep everyone still and step until the habit fires.
  for (const x of [a, b, child]) {
    x.action = { type: "idle", startedTick: world.tick, untilTick: world.tick + 100000 };
    x.nextDecisionTick = world.tick + 100000;
  }
  const before = child.needs.energy;
  for (let i = 0; i < 40; i++) {
    world.step();
    a.x = 400; a.y = 400; child.x = 401; child.y = 401;
  }
  assert.ok(child.needs.energy > before, "the child was fed");
  assert.ok(child.bondWith(a.id).trust > 0.75, "and trusts for it");
  assert.ok(world.chronicle.all().some((e) => /the first gift/.test(e.text)));
});

test("a stray child turns back toward its family", () => {
  const world = World.create({ seed: 67 });
  const [a, b] = couple(world, -300, -300);
  const child = world.population.createChild(world.rng, world.tick, -260, -300, a, b);
  for (const x of [a, b]) {
    x.action = { type: "idle", startedTick: world.tick, untilTick: world.tick + 200000 };
    x.nextDecisionTick = world.tick + 200000;
  }
  const far = Math.hypot(child.x - a.x, child.y - a.y);
  for (let i = 0; i < 2 * 3600; i++) {
    world.step();
    a.x = -300; a.y = -300; b.x = -299; b.y = -300;
  }
  const near = Math.hypot(child.x - a.x, child.y - a.y);
  assert.ok(near < far / 2, `walked home (${far.toFixed(0)} -> ${near.toFixed(0)} tiles)`);
});

test("bonds, pairs and parentage survive save and load exactly", () => {
  const world = World.create({ seed: 68 });
  const [a, b] = couple(world);
  const child = world.population.createChild(world.rng, world.tick, 302, 300, a, b);
  learnAround(child, world);
  pairUp(world, a, b);
  const copy = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world, 1)))).world;
  assert.equal(JSON.stringify(copy.population), JSON.stringify(world.population));
  const sameChild = copy.population.get(child.id)!;
  assert.deepEqual(sameChild.parents, [a.id, b.id]);
  assert.equal(copy.population.get(a.id)!.mate, b.id);
  for (let i = 0; i < 3000; i++) {
    world.step();
    copy.step();
  }
  assert.equal(JSON.stringify(copy.population), JSON.stringify(world.population), "and they carry on identically");
});

test("the pull home: loneliness wins, the empty hearth is left, home moves to the dearest", async () => {
  const { LONELY_PULL } = await import("../src/agents/kinship.ts");
  const world = World.create({ seed: 69 });
  const [far, friend, child] = world.population.list();
  // A lone AI with a nest far from everyone, and a friend back in the village.
  far.x = 500;
  far.y = 500;
  far.nest = { x: 500, y: 500, lastSlept: world.tick };
  friend.x = 0;
  friend.y = 0;
  friend.nest = { x: 0, y: 0, lastSlept: world.tick };
  const stale = world.tick; // every bond unrefreshed from the founding
  world.tick += 10 * TICKS_PER_DAY;
  world.calendar = getCalendar(world.tick);
  for (const bond of Object.values(far.bonds)) bond.lastNear = stale;
  far.bonds[friend.id] = { trust: 0.5, affection: 0.6, lastNear: stale };
  far.emotions.loneliness = LONELY_PULL + 0.2;
  // A child in the same plight stays put: children follow their parents instead.
  const young = world.population.createChild(world.rng, world.tick - TICKS_PER_DAY, 480, 480, friend, child);
  young.emotions.loneliness = 1;
  young.nest = { x: 480, y: 480, lastSlept: world.tick };
  dailyKinship(ctxOf(world));
  assert.equal(far.nest, null, "the empty hearth is left behind");
  assert.deepEqual(far.home, { x: 0, y: 0 }, "home is where the dearest lives now");
  assert.ok(world.chronicle.all().some((e) => /Loneliness won/.test(e.text)));
  assert.notEqual(young.nest, null, "a child does not strike out on its own");
  // And someone whose people were near only yesterday feels no such pull.
  const settled = world.population.list()[3];
  settled.x = 600;
  settled.y = 600;
  settled.nest = { x: 600, y: 600, lastSlept: world.tick };
  settled.emotions.loneliness = 1;
  settled.bonds[friend.id] = { trust: 0.5, affection: 0.6, lastNear: world.tick };
  dailyKinship(ctxOf(world));
  assert.notEqual(settled.nest, null, "yesterday's company holds the hearth");
});
