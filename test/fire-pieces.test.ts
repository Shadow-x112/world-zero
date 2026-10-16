import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import { getCalendar } from "../src/core/time.ts";
import { FIRE_INTERVAL, FireSystem, WILD_BLAZE, WILD_FUEL_CAP, blazingAt, fireAt, igniteAt } from "../src/world/fire.ts";
import { addToBlock, blockAt } from "../src/building/structures.ts";
import { ROLE } from "../src/building/pieces.ts";
import { serializeWorld, deserializeWorld } from "../src/persist/store.ts";
import { buildUp } from "./support/build.ts";

const GROVE = 3, STONE = 4;

function emptyWorld(seed: number): World {
  const world = World.create({ seed });
  for (const a of world.population.all()) Object.assign(a, { x: -500, y: -500 });
  return world;
}

function clear(world: World, x: number, y: number, r: number): void {
  for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
    for (const l of ["terrain", "height", "material", "amount"]) world.grid.set(l, x + ox, y + oy, 0);
  }
}

/** Runs only the fire system for some world hours, in the given season's weather. */
function burnHours(world: World, hours: number, fire = new FireSystem()): void {
  for (let i = 0; i < hours * 10; i++) {
    world.tick += FIRE_INTERVAL;
    world.tick -= world.tick % FIRE_INTERVAL;
    world.calendar = getCalendar(world.tick);
    fire.update(world);
  }
}

test("a patch of growth flares for a few hours, smoulders about a day, and goes out", () => {
  const world = emptyWorld(401);
  clear(world, 50, 50, 3);
  world.grid.set("material", 51, 50, GROVE);
  world.grid.set("amount", 51, 50, 40); // a full stand of grove: days of fuel by weight
  igniteAt(world, 50, 50, 300); // a big fire beside it
  let caught = false;
  for (let h = 0; h < 30 && !caught; h++) {
    burnHours(world, 1);
    caught = fireAt(world, 51, 50) > 0;
  }
  assert.ok(caught, "the grove caught");
  assert.ok(fireAt(world, 51, 50) <= WILD_FUEL_CAP, "no more than a day's burning in one patch");
  assert.ok(blazingAt(world, 51, 50), "it blazes at first");
  // Keep the first fire from feeding the test: put it out.
  world.grid.set("fire", 50, 50, 0);
  burnHours(world, WILD_BLAZE / 10 + 1);
  assert.ok(fireAt(world, 51, 50) > 0 && !blazingAt(world, 51, 50), "then smoulders");
  burnHours(world, WILD_FUEL_CAP / 10);
  assert.equal(fireAt(world, 51, 50), 0, "and within a day it is out");
});

test("embers seldom spread; a blaze often does", () => {
  // One patch beside a fire, over and over: how often does it catch within two hours?
  const spreadFrom = (blazing: boolean) => {
    let caught = 0;
    for (let s = 0; s < 40; s++) {
      const world = emptyWorld(410 + s);
      clear(world, 0, 0, 3);
      world.grid.set("material", 1, 0, GROVE);
      world.grid.set("amount", 1, 0, 10);
      igniteAt(world, 0, 0, 60, blazing ? 60 : 0);
      burnHours(world, 2);
      if (world.grid.get("amount", 1, 0) === 0) caught++;
    }
    return caught;
  };
  const blaze = spreadFrom(true), embers = spreadFrom(false);
  assert.ok(blaze > embers * 3, `blazing: ${blaze} patches caught; embers: ${embers}`);
});

test("built things burn piece by piece: the poles over a fire burn and what lay on them falls; stone stands", () => {
  const world = emptyWorld(420);
  const [x, y] = [-40, 30];
  clear(world, x, y, 4);
  buildUp(world, "wall", x - 1, y, world.materials.require(STONE), 1, { x, y });
  buildUp(world, "wall", x + 1, y, world.materials.require(STONE), 1, { x, y });
  for (let i = 0; i < 6; i++) addToBlock(world, "roof", x, y, world.materials.require(GROVE), 1, 1);
  const poles = world.pieces.at(x, y, ROLE.roof).length;
  assert.ok(poles >= 4);
  const stones = world.pieces.at(x - 1, y, ROLE.wall).length + world.pieces.at(x + 1, y, ROLE.wall).length;
  igniteAt(world, x, y, 40); // a fire lit under the roof
  let seenPartial = false;
  for (let h = 0; h < 24 && world.pieces.at(x, y, ROLE.roof).length > 0; h++) {
    burnHours(world, 1);
    const left = world.pieces.at(x, y, ROLE.roof).length;
    if (left > 0 && left < poles) seenPartial = true;
  }
  assert.equal(world.pieces.at(x, y, ROLE.roof).length, 0, "the roof burned");
  assert.ok(seenPartial, "pole by pole, not all at once");
  assert.equal(world.pieces.at(x - 1, y, ROLE.wall).length + world.pieces.at(x + 1, y, ROLE.wall).length, stones, "the stone walls stand untouched");
  assert.ok(blockAt(world.grid, "wall", x - 1, y));
  assert.ok(world.firsts.has("burnedBuilding"));
});

test("fires from before blazes and embers are cut to a day of embers when the world loads", () => {
  const world = emptyWorld(430);
  clear(world, 10, 10, 2);
  igniteAt(world, 10, 10, 1300);
  const data = JSON.parse(JSON.stringify(serializeWorld(world, 1)));
  data.format = 16;
  for (const c of data.chunks) delete c.layers.blaze; // (saved before blazes existed)
  const loaded = deserializeWorld(data).world;
  assert.equal(fireAt(loaded, 10, 10), WILD_FUEL_CAP);
  assert.equal(blazingAt(loaded, 10, 10), false);
  // A world saved now keeps its fires exactly.
  const again = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world, 1)))).world;
  assert.equal(fireAt(again, 10, 10), 1300);
  assert.equal(blazingAt(again, 10, 10), true);
});
