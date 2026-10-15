import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import { Structures, addToBlock, blockAt, removeBlock, shelterAt } from "../src/building/structures.ts";
import { ROLE, build } from "../src/building/pieces.ts";
import { lessonOf, notePlaced, studyShelter, valueOf, CURIOSITY } from "../src/agents/building-sense.ts";
import { chooseSource, nestOf, wakeAtNest } from "../src/agents/building.ts";
import { SpatialIndex } from "../src/agents/senses.ts";
import { serializeWorld, deserializeWorld } from "../src/persist/store.ts";
import type { AgentContext } from "../src/agents/movement.ts";
import { buildUp } from "./support/build.ts";

const FIBER = 2, GROVE = 3, STONE = 4;

function emptyWorld(seed = 21): World {
  const world = World.create({ seed });
  let i = 0;
  for (const a of world.population.all()) {
    a.x = -300 - i++;
    a.y = -300;
  }
  return world;
}

function clear(world: World, x: number, y: number, r: number): void {
  for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
    world.grid.set("terrain", x + ox, y + oy, 0);
    world.grid.set("height", x + ox, y + oy, 0);
    world.grid.set("material", x + ox, y + oy, 0);
    world.grid.set("amount", x + ox, y + oy, 0);
  }
}

function ctxOf(world: World): AgentContext {
  const index = new SpatialIndex(8);
  index.rebuild(world.population.list());
  return { world, population: world.population, index };
}

test("what falls on you is learned against; those who saw learn a little; those far off, nothing", () => {
  const world = emptyWorld();
  const [x, y] = [30, 30];
  clear(world, x, y, 4);
  const [builder, onlooker, far] = world.population.list();
  buildUp(world, "wall", x + 1, y, world.materials.require(STONE), builder.id, { x, y });
  buildUp(world, "wall", x - 1, y, world.materials.require(STONE), builder.id, { x, y });
  for (let i = 0; i < 4; i++) addToBlock(world, "roof", x, y, world.materials.require(GROVE), 1, builder.id);
  assert.ok(blockAt(world.grid, "roof", x, y));
  Object.assign(builder, { x, y, asleep: true });
  Object.assign(onlooker, { x: x + 4, y });
  Object.assign(far, { x: x + 40, y });
  removeBlock(world, "wall", x + 1, y);
  const struck = lessonOf(builder, "frame", GROVE)!;
  const saw = lessonOf(onlooker, "frame", GROVE)!;
  assert.ok(struck.v < -0.2, `the one beneath: ${struck.v}`);
  assert.ok(saw.v < 0 && saw.v > struck.v, `the one who saw: ${saw.v}`);
  assert.equal(lessonOf(far, "frame", GROVE), undefined, "the one far off never knew");
});

test("a warmer night after building credits what was placed", () => {
  const world = emptyWorld();
  const [x, y] = [-40, 20];
  clear(world, x, y, 3);
  const agent = world.population.list()[0];
  Object.assign(agent, { x, y, lastSleep: { x, y } });
  nestOf(agent, ctxOf(world));
  agent.feltShelter = shelterAt(world, x, y);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [1, 1], [-1, 1]]) {
    buildUp(world, "wall", x + dx, y + dy, world.materials.require(STONE), agent.id, { x, y });
    notePlaced(agent, "wall", STONE);
  }
  wakeAtNest(agent, world);
  assert.ok(valueOf(agent, "wall", STONE) > 0, `stone walls: ${valueOf(agent, "wall", STONE)}`);
  assert.deepEqual(agent.buildSense.placed, {}, "and the slate is clean for the next night");
});

test("what rots away soon is learned against; what lasts, for", () => {
  const world = emptyWorld();
  const [x, y] = [50, -50];
  clear(world, x, y, 3);
  const agent = world.population.list()[0];
  Object.assign(agent, { x, y, lastSleep: { x, y } });
  nestOf(agent, ctxOf(world));
  buildUp(world, "wall", x + 1, y, world.materials.require(FIBER), agent.id, { x, y });
  const s = new Structures();
  for (let d = 0; d < 14 && blockAt(world.grid, "wall", x + 1, y); d++) s.weather(world);
  assert.equal(blockAt(world.grid, "wall", x + 1, y), null);
  assert.ok(valueOf(agent, "wall", FIBER) < 0, `fibre walls: ${valueOf(agent, "wall", FIBER)}`);
});

test("it fetches what it has learned does good, not merely what lies nearest", () => {
  const world = emptyWorld();
  const [x, y] = [0, 60];
  clear(world, x, y, 8);
  const agent = world.population.list()[0];
  Object.assign(agent, { x, y, lastSleep: { x, y }, bornTick: world.tick - Math.round(agent.lifespanTicks * 0.3) }); // grown, strong enough to carry stone
  const ctx = ctxOf(world);
  const nest = nestOf(agent, ctx)!;
  world.grid.set("material", x + 2, y + 2, FIBER);
  world.grid.set("amount", x + 2, y + 2, 10);
  world.grid.set("material", x + 6, y - 5, STONE);
  world.grid.set("amount", x + 6, y - 5, 10);
  // Knowing nothing, the nearest will do.
  assert.equal(chooseSource(agent, ctx, nest)?.material, FIBER);
  // Taught otherwise by its life:
  agent.buildSense.lessons["wall:2"] = { v: -0.7, n: 6 };
  agent.buildSense.lessons["wall:4"] = { v: 0.5, n: 6 };
  assert.equal(chooseSource(agent, ctx, nest)?.material, STONE);
  // And what is no good at anything it could do is not worth carrying home at all.
  agent.buildSense.lessons["wall:4"] = { v: -0.6, n: 9 };
  assert.equal(chooseSource(agent, ctx, nest), null);
  assert.ok(CURIOSITY > 0);
});

test("seeing a neighbour's snugger place teaches what it is made of", () => {
  const world = emptyWorld();
  const [x, y] = [-60, -60];
  clear(world, x, y, 3);
  const [owner, visitor] = world.population.list();
  owner.nest = { x, y, lastSlept: world.tick };
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    buildUp(world, "wall", x + dx, y + dy, world.materials.require(STONE), owner.id, { x, y });
  }
  buildUp(world, "roof", x, y, world.materials.require(GROVE), owner.id);
  const snug = shelterAt(world, x, y);
  assert.ok(snug > 0.6);
  Object.assign(visitor, { x: x + 3, y: y + 3 });
  visitor.feltShelter = 0.1;
  studyShelter(visitor, world, x, y, snug);
  assert.ok(valueOf(visitor, "wall", STONE) > CURIOSITY - 0.15 && lessonOf(visitor, "wall", STONE)!.v > 0);
  assert.ok(lessonOf(visitor, "frame", GROVE)!.v > 0);
  // It doesn't stare: once is enough for a while.
  const before = lessonOf(visitor, "wall", STONE)!.n;
  studyShelter(visitor, world, x, y, snug);
  assert.equal(lessonOf(visitor, "wall", STONE)!.n, before);
  // And one's own place, or a place no snugger than one's own, teaches nothing.
  const [, , third] = world.population.list();
  third.feltShelter = snug;
  studyShelter(third, world, x, y, snug);
  assert.equal(lessonOf(third, "wall", STONE), undefined);
});

test("unpractised hands leave gaps that practised hands don't", () => {
  const world = emptyWorld();
  const stone = world.materials.require(STONE);
  const grove = world.materials.require(GROVE);
  let novice = 0, master = 0;
  const roofAt = (x: number, y: number, skill: number) => {
    clear(world, x, y, 2);
    for (let k = 0; k < 6; k++) {
      build(world, ROLE.wall, x - 1, y, stone, 1, 1, 1, undefined, 1);
      build(world, ROLE.wall, x + 1, y, stone, 1, 1, 1, undefined, 1);
    }
    for (let k = 0; k < 4; k++) build(world, ROLE.roof, x, y, grove, 1, 1, 2, undefined, skill);
  };
  for (let i = 0; i < 10; i++) {
    roofAt(100 + i * 6, 100, 0);
    roofAt(100 + i * 6, 110, 1);
  }
  new Structures().weather(world); // (a day's weather measures everything afresh)
  for (let i = 0; i < 10; i++) {
    novice += blockAt(world.grid, "roof", 100 + i * 6, 100)?.hp ?? 0;
    master += blockAt(world.grid, "roof", 100 + i * 6, 110)?.hp ?? 0;
  }
  assert.ok(novice < master * 0.95, `the same four poles: novice ${novice / 10} vs master ${master / 10}`);
});

test("what it has learned about building survives save and load; older saves start knowing nothing", () => {
  const world = emptyWorld();
  const a = world.population.list()[0];
  a.buildSense.lessons["frame:3"] = { v: 0.4, n: 3 };
  a.buildSense.placed["wall:4"] = 2;
  a.buildSense.studied = 77;
  const loaded = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world, 1)))).world;
  assert.deepEqual(loaded.population.get(a.id)!.buildSense, a.buildSense);
  const old = JSON.parse(JSON.stringify(serializeWorld(world, 1)));
  old.format = 15;
  for (const ag of old.population.agents) delete ag.buildSense;
  const migrated = deserializeWorld(old).world;
  assert.deepEqual(migrated.population.get(a.id)!.buildSense, { lessons: {}, placed: {}, studied: -1 });
});
