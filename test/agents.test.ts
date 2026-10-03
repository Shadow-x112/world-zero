import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import { TICKS_PER_DAY, START_TICK } from "../src/core/constants.ts";
import { getCalendar } from "../src/core/time.ts";
import { Grid } from "../src/world/grid.ts";
import { Terrain } from "../src/world/chunk.ts";
import { findPath, canStep } from "../src/agents/pathfinding.ts";
import { updateBody, healthCeiling, RATES } from "../src/agents/needs.ts";
import { FOUNDER_COUNT, BODY_DAYS } from "../src/agents/population.ts";
import type { Agent } from "../src/agents/agent.ts";

const HOUR = 3600;

/** Runs only an agent's body for some hours (daytime calendar, no behavior). */
function bodyHours(agent: Agent, world: World, hours: number, ctx = { hasCompany: false, shelter: 0, warmth: 0, fire: null }) {
  for (let i = 0; i < hours * HOUR; i++) {
    world.tick++;
    const cause = updateBody(agent, world, ctx);
    if (cause) return cause;
  }
  return null;
}

test("the founders start together, grown, healthy and fed", () => {
  const world = World.create({ seed: 2 });
  const agents = world.population.list();
  assert.equal(agents.length, FOUNDER_COUNT);
  for (const a of agents) {
    assert.deepEqual(a.needs, { energy: 1, rest: 1, social: 1, curiosity: 0.7 });
    assert.equal(a.health, 1);
    assert.ok(Math.hypot(a.x, a.y) <= 8, "near the middle of the plain");
    const life = a.lifeFraction(world.tick);
    assert.ok(life > 0.2 && life < 0.3, "grown up but young");
  }
  const spots = new Set(agents.map((a) => `${a.x},${a.y}`));
  assert.equal(spots.size, FOUNDER_COUNT, "each stands on its own tile");
  const quirks = new Set(agents.map((a) => a.quirk.join()));
  assert.equal(quirks.size, FOUNDER_COUNT, "tiny differences make each one unique");
});

test("needs drain and recover at the planned rates", () => {
  const world = World.create({ seed: 1 });
  const agent = world.population.list()[0];
  bodyHours(agent, world, 10);
  assert.ok(Math.abs(agent.needs.rest - (1 - 10 * RATES.restDrain)) < 1e-6);
  assert.ok(Math.abs(agent.needs.energy - (1 - 10 * RATES.energyDrain)) < 1e-6);
  assert.ok(agent.needs.social < 1, "alone, social need grows");

  agent.asleep = true;
  const before = agent.needs.rest;
  bodyHours(agent, world, 2);
  assert.ok(agent.needs.rest > before + 0.25, "sleep restores rest");

  agent.needs.social = 0.5;
  bodyHours(agent, world, 1, { hasCompany: true, shelter: 0, warmth: 0, fire: null });
  assert.ok(agent.needs.social > 0.65, "company restores social");
});

test("with no food, an agent starves about two days after energy runs out", () => {
  const world = World.create({ seed: 1 });
  const agent = world.population.list()[0];
  agent.needs.energy = 0;
  agent.needs.rest = 1;
  let hours = 0;
  let cause = null;
  while (!cause && hours < 200) {
    agent.needs.rest = 1; // isolate hunger
    cause = bodyHours(agent, world, 1);
    hours++;
  }
  assert.equal(cause, "starvation");
  assert.ok(hours >= 40 && hours <= 56, `died after ${hours} hours`);
});

test("cold-season nights in the open cost health; other seasons don't", () => {
  const world = World.create({ seed: 1 });
  const agent = world.population.list()[0];
  const hourAt = (day: number) => {
    world.tick = day * TICKS_PER_DAY + HOUR; // 1am
    world.calendar = getCalendar(world.tick);
  };
  const runHour = (sheltered: boolean) => {
    const shelter = sheltered ? 1 : 0;
    for (let i = 0; i < HOUR; i++) updateBody(agent, world, { hasCompany: true, shelter, warmth: 0, fire: null });
  };

  hourAt(2); // growth season
  runHour(false);
  assert.equal(agent.damage.exposure, 0);

  hourAt(32); // cold season
  runHour(false);
  assert.ok(agent.damage.exposure > 0, "exposed in the cold");
  const exposed = agent.damage.exposure;
  runHour(true);
  assert.ok(agent.damage.exposure <= exposed, "shelter prevents exposure");
});

test("old age: health declines near the end of life and ends it", () => {
  assert.equal(healthCeiling(0.5), 1);
  assert.equal(healthCeiling(0.8), 1);
  assert.ok(healthCeiling(0.9) > 0 && healthCeiling(0.9) < 1);
  assert.equal(healthCeiling(1), 0);

  const world = World.create({ seed: 4 });
  const agent = world.population.list()[0];
  world.tick = agent.bornTick + agent.lifespanTicks - 10;
  world.calendar = getCalendar(world.tick);
  agent.health = 0.01;
  let cause = null;
  for (let i = 0; i < 100 && !cause; i++) {
    world.tick++;
    cause = updateBody(agent, world, { hasCompany: true, shelter: 1, warmth: 0, fire: null });
  }
  assert.equal(cause, "old age");
});

test("paths go around water and barriers and never cut corners", () => {
  const grid = new Grid(1);
  // A wall at x = 5 from y = -5..5 on the flat plain.
  for (let y = -5; y <= 5; y++) grid.set("terrain", 5, y, Terrain.barrier);
  const result = findPath(grid, 0, 0, 10, 0)!;
  assert.ok(result.complete);
  for (let i = 0; i < result.path.length; i += 2) {
    assert.ok(grid.isWalkable(result.path[i], result.path[i + 1]), "every step is walkable");
  }
  // Diagonal squeeze between two blocked tiles is refused.
  grid.set("terrain", 20, 1, Terrain.water);
  grid.set("terrain", 21, 0, Terrain.water);
  assert.equal(canStep(grid, 20, 0, 21, 1), false);
});

test("steps may climb at most one level", () => {
  const grid = new Grid(1);
  grid.set("height", 1, 0, 2);
  assert.equal(canStep(grid, 0, 0, 1, 0), false);
  grid.set("height", 1, 0, 1);
  assert.equal(canStep(grid, 0, 0, 1, 0), true);
});

test("an enclosed goal returns the closest reachable route, and a sealed start returns nothing", () => {
  const grid = new Grid(1);
  for (let x = 8; x <= 12; x++) for (let y = -2; y <= 2; y++) if (x === 8 || x === 12 || y === -2 || y === 2) grid.set("terrain", x, y, Terrain.barrier);
  const toward = findPath(grid, 0, 0, 10, 0)!;
  assert.equal(toward.complete, false);
  assert.ok(toward.path.length > 0);
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) if (x || y) grid.set("terrain", 30 + x, 30 + y, Terrain.barrier);
  assert.equal(findPath(grid, 30, 30, 40, 40), null);
});

test("over a first day the group explores, sleeps through the night and stays together", () => {
  const world = World.create({ seed: 9 });
  let asleepAt2am = 0;
  for (let i = 0; i < TICKS_PER_DAY; i++) {
    world.step();
    if (world.calendar.hour === 2 && world.calendar.minute === 0 && asleepAt2am === 0) {
      asleepAt2am = world.population.list().filter((a) => a.asleep).length;
    }
  }
  assert.equal(world.population.count, FOUNDER_COUNT, "no one dies in a day");
  assert.ok(asleepAt2am >= 18, `${asleepAt2am} asleep at 2am`);
  const agents = world.population.list();
  const walked = agents.reduce((s, a) => s + a.stats.tilesWalked, 0);
  assert.ok(walked > 1000, "they moved around");
  const meanDist = agents.reduce((s, a) => s + Math.hypot(a.x, a.y), 0) / agents.length;
  assert.ok(meanDist < 300, `stayed within reach of home (mean ${meanDist.toFixed(0)} tiles)`);
  let worn = 0;
  for (let y = -20; y <= 20; y++) for (let x = -20; x <= 20; x++) if (world.grid.get("wear", x, y) > 0) worn++;
  assert.ok(worn > 50, "footsteps wear the ground");
});

test("the same seed produces exactly the same history", () => {
  const a = World.create({ seed: 123 });
  const b = World.create({ seed: 123 });
  for (let i = 0; i < 20000; i++) {
    a.step();
    b.step();
  }
  assert.equal(JSON.stringify(a.population), JSON.stringify(b.population));
});

test("a death leaves a body that fades after a few days, and the chronicle records it", () => {
  const world = World.create({ seed: 6 });
  const victim = world.population.list()[0];
  victim.needs.energy = 0;
  victim.health = 1e-7;
  world.step();
  assert.equal(world.population.get(victim.id), undefined);
  assert.equal(world.population.count, FOUNDER_COUNT - 1);
  assert.equal(world.population.bodies.length, 1);
  assert.equal(world.population.bodies[0].cause, "starvation");
  const entry = world.chronicle.all().at(-1)!;
  assert.equal(entry.kind, "death");
  assert.match(entry.text, /The first death/);
  // Keep everyone else alive while time passes.
  for (let i = 0; i < (BODY_DAYS + 0.1) * TICKS_PER_DAY; i++) {
    if (i % 3600 === 0) for (const a of world.population.all()) { a.needs.energy = 1; a.health = 1; }
    world.step();
  }
  assert.equal(world.population.bodies.length, 0, "the body has faded");
});

test("when the last one dies, the world records its extinction", () => {
  const world = World.create({ seed: 7 });
  for (const a of world.population.all()) {
    a.needs.energy = 0;
    a.health = 1e-7;
  }
  world.step();
  assert.equal(world.population.count, 0);
  assert.notEqual(world.extinctTick, null);
  assert.equal(world.chronicle.all().at(-1)!.kind, "extinction");
  assert.ok(world.tick > START_TICK);
});
