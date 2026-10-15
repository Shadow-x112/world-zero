import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import { addToBlock, blockAt, removeBlock, unitsPerBlock, Structures } from "../src/building/structures.ts";
import { FORM, GROUND, ROLE, build, formOf, settle, topOf } from "../src/building/pieces.ts";
import { serializeWorld, deserializeWorld } from "../src/persist/store.ts";

const FIBER = 2, GROVE = 3, STONE = 4, EARTH = 6;

function emptyWorld(seed = 9): World {
  const world = World.create({ seed });
  let i = 0;
  for (const a of world.population.all()) {
    a.x = -200 - i++;
    a.y = -200;
  }
  return world;
}

function clear(world: World, x: number, y: number, r: number): void {
  for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
    world.grid.set("material", x + ox, y + oy, 0);
    world.grid.set("amount", x + ox, y + oy, 0);
  }
}

test("a material's pieces follow from how it feels", () => {
  const w = World.create({ seed: 1 });
  assert.equal(formOf(w.materials.require(FIBER)), FORM.mat, "fibres are woven into mats");
  assert.equal(formOf(w.materials.require(GROVE)), FORM.pole, "sturdy springy stuff makes poles");
  assert.equal(formOf(w.materials.require(STONE)), FORM.stone);
});

test("walls are made of pieces resting on the ground or on each other", () => {
  const world = emptyWorld();
  clear(world, 0, 30, 2);
  const stone = world.materials.require(STONE);
  for (let i = 0; i < 6; i++) addToBlock(world, "wall", 0, 30, stone, unitsPerBlock(stone), 4);
  const pieces = world.pieces.at(0, 30, ROLE.wall);
  assert.ok(pieces.length >= 1);
  assert.equal(world.grid.isWalkable(0, 30), false, "it stands in the way");
  for (const p of pieces) {
    for (const s of p.on) if (s !== GROUND) assert.ok(topOf(world.pieces.get(s)!) <= p.z + 1e-6, "everything rests on something lower");
    assert.equal(p.by, 4);
  }
});

test("a beam across two walls holds a roof; take a wall away and it falls on whoever is beneath", () => {
  const world = emptyWorld();
  const [x, y] = [20, 20];
  clear(world, x, y, 3);
  const stone = world.materials.require(STONE);
  const grove = world.materials.require(GROVE);
  addToBlock(world, "wall", x - 1, y, stone, unitsPerBlock(stone), 1);
  addToBlock(world, "wall", x + 1, y, stone, unitsPerBlock(stone), 1);
  assert.ok(addToBlock(world, "roof", x, y, grove, 2, 1) > 0, "the roof went up");
  const beam = world.pieces.at(x, y, ROLE.roof)[0];
  assert.equal(beam.on.filter((s) => s !== GROUND).length, 2, "resting on both walls");
  const sleeper = world.population.list()[0];
  sleeper.x = x;
  sleeper.y = y;
  sleeper.asleep = true;
  const health = sleeper.health;
  let struck = 0;
  world.events.on("collapse", (c) => (struck += c.struck.length));
  removeBlock(world, "wall", x + 1, y);
  assert.equal(blockAt(world.grid, "roof", x, y), null, "the roof came down");
  assert.ok(sleeper.health < health, "and struck the one sleeping under it");
  assert.ok(sleeper.damage.injury > 0);
  assert.equal(sleeper.asleep, false, "who woke");
  assert.ok(struck >= 1);
  assert.ok(world.firsts.has("collapse"));
});

test("too much weight on a beam breaks it", () => {
  const world = emptyWorld();
  const [x, y] = [-30, 10];
  clear(world, x, y, 3);
  const stone = world.materials.require(STONE);
  const grove = world.materials.require(GROVE);
  const earth = world.materials.require(EARTH);
  build(world, ROLE.wall, x - 1, y, stone, 1, 1);
  build(world, ROLE.wall, x + 1, y, stone, 1, 1);
  build(world, ROLE.roof, x, y, grove, 1, 1, 2);
  assert.equal(settle(world).broke.length, 0, "a bare beam holds itself");
  // Lumps of earth heaped on it.
  build(world, ROLE.roof, x, y, earth, 8, 1, 2);
  const ev = settle(world);
  assert.ok(ev.broke.length >= 1, "something gave way");
  assert.ok(ev.fell.length >= 2, "and everything on it fell");
});

test("pieces wear; when the bottom of a pile rots, what it held falls", () => {
  const world = emptyWorld();
  const [x, y] = [40, -40];
  clear(world, x, y, 3);
  const fiber = world.materials.require(FIBER);
  addToBlock(world, "wall", x + 1, y, fiber, 8, 1);
  addToBlock(world, "roof", x, y, fiber, 8, 1);
  assert.ok(blockAt(world.grid, "roof", x, y));
  const s = new Structures();
  for (let d = 0; d < 12; d++) s.weather(world);
  assert.equal(blockAt(world.grid, "wall", x + 1, y), null, "the fibre wall rotted away");
  assert.equal(blockAt(world.grid, "roof", x, y), null, "and the roof came down");
});

test("pieces survive save and load exactly, and go on wearing the same", () => {
  const world = emptyWorld();
  clear(world, 70, 70, 3);
  const stone = world.materials.require(STONE);
  const grove = world.materials.require(GROVE);
  addToBlock(world, "wall", 69, 70, stone, unitsPerBlock(stone), 3);
  addToBlock(world, "wall", 71, 70, stone, unitsPerBlock(stone), 3);
  addToBlock(world, "roof", 70, 70, grove, 2, 3);
  const data = JSON.parse(JSON.stringify(serializeWorld(world, 1)));
  const loaded = deserializeWorld(data).world;
  assert.deepEqual(loaded.pieces.toJSON(), world.pieces.toJSON());
  const a = new Structures(), b = new Structures();
  for (let d = 0; d < 30; d++) {
    a.weather(world);
    b.weather(loaded);
  }
  assert.deepEqual(loaded.pieces.toJSON(), world.pieces.toJSON());
});

test("a world saved before pieces gets its walls and roofs rebuilt as pieces", () => {
  const world = emptyWorld();
  clear(world, 10, -10, 3);
  // Blocks the old way: layers only, no pieces.
  for (const [x, y] of [[9, -10], [11, -10]]) {
    world.grid.set("wall", x, y, STONE);
    world.grid.set("wallHp", x, y, 900);
    world.grid.set("wallBy", x, y, 5);
    world.grid.set("wallDay", x, y, 3);
  }
  world.grid.set("roof", 10, -10, GROVE);
  world.grid.set("roofHp", 10, -10, 1000);
  world.grid.set("roofBy", 10, -10, 5);
  world.grid.set("roofDay", 10, -10, 4);
  const data = JSON.parse(JSON.stringify(serializeWorld(world, 1)));
  data.format = 14;
  delete data.pieces;
  const loaded = deserializeWorld(data).world;
  assert.ok(loaded.pieces.at(9, -10, ROLE.wall).length > 0);
  assert.ok(loaded.pieces.at(10, -10, ROLE.roof).length > 0);
  const w = blockAt(loaded.grid, "wall", 9, -10)!;
  assert.equal(w.material, STONE);
  assert.equal(w.by, 5);
  assert.ok(w.hp >= 850, `about as sound as it was: ${w.hp}`);
  assert.ok(blockAt(loaded.grid, "roof", 10, -10), "the roof still stands");
  assert.equal(loaded.grid.isWalkable(9, -10), false);
});
