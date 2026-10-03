import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import { getCalendar } from "../src/core/time.ts";
import { TICKS_PER_DAY } from "../src/core/constants.ts";
import {
  FIRE_INTERVAL,
  FireSystem,
  burnable,
  extinguishAt,
  fireAt,
  fireDanger,
  fuelOf,
  igniteAt,
  personalLight,
  warmthAt,
} from "../src/world/fire.ts";
import { updateBody, RATES } from "../src/agents/needs.ts";
import { addToBlock, blockAt, unitsPerBlock } from "../src/building/structures.ts";
import { findPath } from "../src/agents/pathfinding.ts";
import { addCarried, isFoodTo } from "../src/agents/foraging.ts";
import { performAttempt, possibleAttempts } from "../src/items/crafting.ts";
import { serializeWorld, deserializeWorld } from "../src/persist/store.ts";

const FIBER = 2;
const GROVE = 3;
const STONE = 4;
const EARTH = 6;

function emptyWorld(seed = 31): World {
  const world = World.create({ seed });
  let i = 0;
  for (const a of world.population.all()) {
    a.x = -400 - i;
    a.y = -400;
    i++;
  }
  return world;
}

function clear(world: World, x: number, y: number, r: number): void {
  for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
    world.grid.set("material", x + ox, y + oy, 0);
    world.grid.set("amount", x + ox, y + oy, 0);
  }
}

/** Runs only the fire system for some world hours. */
function burnHours(world: World, hours: number): void {
  const fire = new FireSystem();
  for (let i = 0; i < hours * 10; i++) {
    world.tick += FIRE_INTERVAL;
    world.tick -= world.tick % FIRE_INTERVAL;
    world.calendar = getCalendar(world.tick);
    fire.update(world);
  }
}

test("what burns: organic material with stored energy; stone and earth never", () => {
  const world = World.create({ seed: 1 });
  assert.ok(burnable(world.materials.require(GROVE)), "grove growth burns well");
  assert.ok(burnable(world.materials.require(FIBER)), "fibers are tinder");
  assert.ok(!burnable(world.materials.require(STONE)));
  assert.ok(!burnable(world.materials.require(EARTH)));
  assert.ok(!burnable(world.materials.require(10)), "bricks don't burn");
  assert.ok(fuelOf(world.materials.require(GROVE), 1) > fuelOf(world.materials.require(FIBER), 2), "wood outburns tinder");
});

test("a fire eats its fuel and dies out; warmth and glow reach only so far", () => {
  const world = emptyWorld();
  clear(world, 0, 0, 6);
  igniteAt(world, 0, 0, 20); // two hours
  assert.ok(fireAt(world, 0, 0) > 0);
  assert.equal(world.grid.isWalkable(0, 0), false, "no one walks through flames");
  assert.equal(fireDanger(world, 0, 0), "in");
  assert.equal(fireDanger(world, 1, 1), "beside");
  assert.equal(fireDanger(world, 3, 0), null);
  assert.ok(warmthAt(world, 1, 0) > warmthAt(world, 3, 0), "warmth fades with distance");
  assert.equal(warmthAt(world, 6, 0), 0);
  world.tick = 0;
  world.calendar = getCalendar(world.tick);
  assert.ok(personalLight(world, 1, 0) >= 0.7, "bright beside the fire at midnight");
  assert.ok(personalLight(world, 20, 0) < 0.1, "dark away from it");
  burnHours(world, 3);
  assert.equal(fireAt(world, 0, 0), 0, "burned out");
  assert.equal(world.fireTiles.size, 0);
});

test("fire spreads through a grove but a brick wall stops it", () => {
  const world = emptyWorld(32);
  clear(world, 100, 100, 8);
  // A line of grove growth leading away from the fire, with a brick wall partway.
  for (let i = 1; i <= 6; i++) {
    world.grid.set("material", 100 + i, 100, GROVE);
    world.grid.set("amount", 100 + i, 100, 10);
  }
  const brick = world.materials.require(10);
  addToBlock(world, "wall", 104, 100, brick, unitsPerBlock(brick), 1);
  world.grid.set("material", 104, 100, 0);
  world.grid.set("amount", 104, 100, 0);
  igniteAt(world, 100, 100, 50);
  burnHours(world, 8);
  assert.equal(world.grid.get("amount", 101, 100), 0, "the near growth burned");
  assert.ok(world.firsts.has("wildfire"), "the chronicle noticed the fire spreading");
  assert.ok(blockAt(world.grid, "wall", 104, 100), "the brick wall stands");
  assert.equal(world.grid.get("amount", 105, 100), 10, "what stood behind it was spared");
  assert.equal(world.grid.get("material", 101, 100), 0, "a burned grove is gone, roots and all");
});

test("a fiber hut burns down around its fire; the roof falls into the flames", () => {
  const world = emptyWorld(33);
  const [x, y] = [-60, 80];
  clear(world, x, y, 4);
  const fiber = world.materials.require(FIBER);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) addToBlock(world, "wall", x + dx, y + dy, fiber, 8, 2);
  addToBlock(world, "roof", x, y, fiber, 8, 2);
  igniteAt(world, x, y, 30);
  burnHours(world, 6);
  assert.equal(blockAt(world.grid, "roof", x, y), null, "the roof is gone");
  const wallsLeft = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => blockAt(world.grid, "wall", x + dx, y + dy)).length;
  assert.ok(wallsLeft < 4, `${wallsLeft} walls survived a fire inside a fiber hut`);
  assert.ok(world.firsts.has("burnedBuilding"));
});

test("wet earth beside a fire bakes into brick", () => {
  const world = emptyWorld(34);
  const [x, y] = [70, -70];
  clear(world, x, y, 3);
  world.grid.set("material", x + 1, y, EARTH);
  world.grid.set("amount", x + 1, y, 10);
  igniteAt(world, x, y, 60);
  burnHours(world, 6);
  assert.equal(world.grid.get("material", x + 1, y), 10, "baked hard");
  assert.equal(world.grid.get("amount", x + 1, y), 10, "nothing lost");
  assert.ok(world.firsts.has("bakedEarth"));
});

test("standing in flames burns; a fire's warmth tames the cold-season night", () => {
  const world = World.create({ seed: 1 });
  const [a, b, c] = world.population.list();
  world.tick = 32 * TICKS_PER_DAY + 3600;
  world.calendar = getCalendar(world.tick);
  for (const x of [a, b, c]) x.health = 1;
  for (let i = 0; i < 1800; i++) updateBody(a, world, { hasCompany: false, shelter: 0, warmth: 0, fire: "in" });
  assert.ok(a.health < 0.2, `half an hour in flames: ${a.health.toFixed(2)}`);
  assert.ok(a.damage.burns > 0.5);
  for (let i = 0; i < 3600; i++) {
    updateBody(b, world, { hasCompany: true, shelter: 0, warmth: 1, fire: null });
    updateBody(c, world, { hasCompany: true, shelter: 0, warmth: 0, fire: null });
  }
  assert.ok(b.health > c.health, "the fire kept the worst of the cold off");
  assert.ok(1 - b.health < (1 - c.health) * 0.35, "three quarters of the chill never reached it");
});

test("an AI flees flames, even out of its sleep, and paths go around fire", () => {
  const world = World.create({ seed: 35 });
  const agent = world.population.list()[0];
  agent.asleep = true;
  clear(world, agent.tileX, agent.tileY, 6);
  igniteAt(world, agent.tileX, agent.tileY + 1, 40);
  const start = { x: agent.tileX, y: agent.tileY };
  for (let i = 0; i < 300; i++) world.step();
  assert.ok(agent.health > 0.8, "it got away in time");
  assert.equal(agent.asleep, false, "the flames woke it");
  assert.equal(fireDanger(world, agent.tileX, agent.tileY), null, "clear of the fire");
  assert.ok(Math.hypot(agent.x - start.x, agent.y - start.y) >= 2);
  const route = findPath(world.grid, start.x - 6, start.y + 1, start.x + 6, start.y + 1)!;
  for (let i = 0; i < route.path.length; i += 2) {
    assert.ok(fireAt(world, route.path[i], route.path[i + 1]) === 0, "the route avoids the flames");
  }
});

test("striking sparks over tinder can raise a flame (the HEAT rule)", () => {
  const world = emptyWorld(36);
  const agent = world.population.list()[0];
  agent.x = 200;
  agent.y = 200;
  clear(world, 200, 200, 3);
  addCarried(agent, STONE, 2);
  addCarried(agent, GROVE, 2);
  let lit = false;
  for (let i = 0; i < 60 && !lit; i++) {
    const heat = possibleAttempts(agent, world).find((a) => a.verb === "heat");
    assert.ok(heat, "striking sparks offers itself");
    lit = performAttempt(heat!, world, agent) === true;
  }
  assert.ok(lit, "flame rose within an hour of trying");
  assert.ok(world.fireTiles.size > 0);
  assert.ok(world.firsts.has("fire"));
  assert.ok(world.chronicle.all().some((e) => /flame rose: fire/.test(e.text)));
  assert.ok((agent.carrying.find((c) => c.material === GROVE)?.units ?? 0) < 2, "the tinder went into it");
});

test("someone beside a dying fire throws what burns onto it", () => {
  const world = World.create({ seed: 37 });
  const agent = world.population.list()[0];
  clear(world, agent.tileX + 10, agent.tileY, 4);
  agent.x += 10;
  addCarried(agent, GROVE, 4);
  assert.ok(!isFoodTo(agent, world.materials.require(GROVE), world.calendar.season));
  const [hx, hy] = [agent.tileX, agent.tileY];
  igniteAt(world, hx + 2, hy, 10); // one hour left
  const before = fireAt(world, hx + 2, hy);
  // Keep it standing there (habits fire between steps of whatever it is doing).
  agent.action = { type: "idle", startedTick: world.tick, untilTick: world.tick + 100000 };
  agent.nextDecisionTick = world.tick + 100000;
  for (let i = 0; i < 61; i++) {
    world.step();
    agent.x = hx;
    agent.y = hy;
    agent.clearPath();
  }
  assert.ok(fireAt(world, hx + 2, hy) > before, "the fire was fed");
});

test("burning ground survives save and load, and the index of fires comes back", () => {
  const world = emptyWorld(38);
  clear(world, 300, 300, 2);
  igniteAt(world, 300, 300, 77);
  const copy = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world, 1)))).world;
  assert.equal(fireAt(copy, 300, 300), 77);
  assert.equal(copy.fireTiles.size, world.fireTiles.size);
  extinguishAt(world, 300, 300);
  assert.equal(world.fireTiles.size, copy.fireTiles.size - 1);
});
