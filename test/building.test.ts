import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import { TICKS_PER_DAY } from "../src/core/constants.ts";
import { getCalendar } from "../src/core/time.ts";
import {
  FULL_HP,
  Structures,
  addToBlock,
  blockAt,
  blockLifeDays,
  canEscape,
  countBlocks,
  roofSpan,
  roofSupported,
  shelterAt,
  unitsPerBlock,
} from "../src/building/structures.ts";
import { findPath } from "../src/agents/pathfinding.ts";
import { SpatialIndex } from "../src/agents/senses.ts";
import { updateBody, RATES } from "../src/agents/needs.ts";
import { buildUrge, nestOf, placements, wakeAtNest, wallAllowed } from "../src/agents/building.ts";
import { serializeWorld, deserializeWorld, SAVE_FORMAT_VERSION } from "../src/persist/store.ts";
import type { AgentContext } from "../src/agents/movement.ts";
import { WINTER_MAX, WINTER_MIN, describeWinter, winterSeverity } from "../src/world/weather.ts";

const FIBER = 2;
const GROVE = 3;
const STONE = 4;

/** A world with everyone moved far away, so a patch of ground near (x, y) is free to build on. */
function emptyWorld(seed = 3): World {
  const world = World.create({ seed });
  let i = 0;
  for (const a of world.population.all()) {
    a.x = -200 - i;
    a.y = -200;
    i++;
  }
  return world;
}

/** Clears any material lying in a square around a point. */
function clearGround(world: World, x: number, y: number, r: number): void {
  for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
    world.grid.set("material", x + ox, y + oy, 0);
    world.grid.set("amount", x + ox, y + oy, 0);
  }
}

function wall(world: World, x: number, y: number, material: number, agentId = 1): void {
  const type = world.materials.require(material);
  addToBlock(world, "wall", x, y, type, unitsPerBlock(type), agentId);
}

function ctxOf(world: World): AgentContext {
  const index = new SpatialIndex(8);
  index.rebuild(world.population.list());
  return { world, population: world.population, index };
}

test("block properties follow from material properties", () => {
  const w = World.create({ seed: 1 });
  const m = (id: number) => w.materials.require(id);
  assert.ok(blockLifeDays(m(FIBER)) < 10, "fibers crumble within days");
  assert.ok(blockLifeDays(m(GROVE)) > 60 && blockLifeDays(m(GROVE)) < 200, "sturdy poles last seasons");
  assert.ok(blockLifeDays(m(STONE)) > 250, "stone lasts years");
  assert.equal(roofSpan(m(STONE)), 0, "rigid stone can't span anything");
  assert.equal(roofSpan(m(FIBER)), 1);
  assert.equal(roofSpan(m(GROVE)), 2, "long sturdy poles reach farthest");
  assert.equal(unitsPerBlock(m(STONE)), 1);
  assert.equal(unitsPerBlock(m(GROVE)), 2);
  assert.equal(unitsPerBlock(m(FIBER)), 8);
});

test("walls block walking; paths go around them; nothing is stored where nothing is built", () => {
  const world = emptyWorld();
  clearGround(world, 5, 0, 6);
  for (let y = -4; y <= 4; y++) wall(world, 5, y, STONE);
  assert.equal(world.grid.isWalkable(5, 0), false);
  const path = findPath(world.grid, 0, 0, 10, 0)!;
  assert.ok(path.complete);
  for (let i = 0; i < path.path.length; i += 2) {
    const [px, py] = [path.path[i], path.path[i + 1]];
    assert.ok(!(px === 5 && py >= -4 && py <= 4), "never through the wall");
  }
  assert.ok(path.path.length / 2 > 10, "the way around is longer");
  // A chunk with nothing built carries no structure layers at all.
  const far = world.grid.getChunk(10, 10);
  assert.equal(far.peekLayer("wall"), undefined);
  assert.equal(world.grid.isWalkable(330, 330), world.grid.terrainAt(330, 330) === 0);
});

test("shelter: open ground gives none; walls around give up to half; cover overhead the other half", () => {
  const world = emptyWorld();
  const [x, y] = [20, 20];
  clearGround(world, x, y, 3);
  assert.equal(shelterAt(world, x, y), 0);
  wall(world, x + 1, y, STONE);
  const one = shelterAt(world, x, y);
  assert.ok(one > 0 && one < 0.1, `one wall: ${one}`);
  for (const [dx, dy] of [[-1, 0], [0, 1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) wall(world, x + dx, y + dy, STONE);
  const ring = shelterAt(world, x, y);
  assert.ok(ring > 0.4 && ring <= 0.5, `ring with a doorway: ${ring}`);
  const grove = world.materials.require(GROVE);
  assert.ok(roofSupported(world.grid, x, y, grove));
  addToBlock(world, "roof", x, y, grove, 2, 1);
  const hut = shelterAt(world, x, y);
  assert.ok(hut > 0.85 && hut <= 1, `walls and a roof: ${hut}`);
});

test("natural features shelter a little: a ridge beside you, a grove", () => {
  const world = emptyWorld();
  const [x, y] = [-30, 25];
  clearGround(world, x, y, 2);
  world.grid.set("terrain", x + 1, y, 2); // barrier
  world.grid.set("material", x - 1, y, GROVE);
  world.grid.set("amount", x - 1, y, 10);
  const s = shelterAt(world, x, y);
  assert.ok(Math.abs(s - 0.5 * (0.15 + 0.15 * 0.3)) < 1e-9, `got ${s}`);
});

test("a roof needs a wall within reach, and falls when its wall weathers away", () => {
  const world = emptyWorld();
  const [x, y] = [40, -10];
  clearGround(world, x, y, 4);
  const fiber = world.materials.require(FIBER);
  assert.equal(roofSupported(world.grid, x, y, fiber), false, "nothing to rest on");
  wall(world, x + 1, y, FIBER);
  assert.ok(roofSupported(world.grid, x, y, fiber));
  assert.equal(roofSupported(world.grid, x - 1, y, fiber), false, "fiber reaches only one tile");
  addToBlock(world, "roof", x, y, fiber, 8, 1);
  assert.ok(blockAt(world.grid, "roof", x, y));
  const structures = new Structures();
  let days = 0;
  while (blockAt(world.grid, "wall", x + 1, y) && days < 30) {
    structures.weather(world);
    days++;
  }
  assert.ok(days >= 6 && days <= 10, `fiber wall lasted ${days} days`);
  assert.equal(blockAt(world.grid, "roof", x, y), null, "the roof came down with it");
});

test("stone walls stand for years; blocks remember who placed them and when", () => {
  const world = emptyWorld();
  clearGround(world, 0, 40, 1);
  wall(world, 0, 40, STONE, 7);
  const structures = new Structures();
  for (let d = 0; d < 80; d++) structures.weather(world);
  const b = blockAt(world.grid, "wall", 0, 40)!;
  assert.ok(b.hp > FULL_HP * 0.6, `after two years: ${b.hp}`);
  assert.equal(b.by, 7);
  assert.equal(b.day, world.calendar.day);
});

test("no one is ever walled in: a sleeping place always keeps a way out", () => {
  const world = emptyWorld();
  const [x, y] = [60, 60];
  clearGround(world, x, y, 3);
  const agent = world.population.list()[0];
  agent.x = x;
  agent.y = y;
  agent.lastSleep = { x, y };
  const ctx = ctxOf(world);
  const nest = nestOf(agent, ctx)!;
  assert.deepEqual([nest.x, nest.y], [x, y]);
  const stone = world.materials.require(STONE);
  let placed = 0;
  for (let i = 0; i < 8; i++) {
    const walls = placements(agent, ctx, nest, stone).filter((p) => p.level === "wall" && !p.existing);
    if (walls.length === 0) break;
    wall(world, walls[0].x, walls[0].y, STONE);
    placed++;
  }
  assert.equal(placed, 7, "seven of the eight sides, leaving a doorway");
  assert.ok(canEscape(world.grid, x, y, x + 100, y + 100), "the way out is still open");
  // And nobody can wall the doorway shut either.
  ctx.index.rebuild([]);
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    if (world.grid.isWalkable(x + ox, y + oy) && (ox || oy)) {
      assert.equal(wallAllowed(ctx, x + ox, y + oy, new Set()), false, "the doorway stays open");
    }
  }
});

test("shelter cuts the cold in proportion; enough of it lets a body heal", () => {
  const world = World.create({ seed: 1 });
  const [a, b, c] = world.population.list();
  world.tick = 32 * TICKS_PER_DAY + 3600; // a cold-season night
  world.calendar = getCalendar(world.tick);
  for (const x of [a, b, c]) x.health = 0.8;
  for (let i = 0; i < 3600; i++) {
    updateBody(a, world, { hasCompany: false, shelter: 0, warmth: 0, fire: null });
    updateBody(b, world, { hasCompany: false, shelter: 0.5, warmth: 0, fire: null });
    updateBody(c, world, { hasCompany: true, shelter: 0.9, warmth: 0, fire: null });
  }
  const lostA = 0.8 - a.health;
  const lostB = 0.8 - b.health;
  const hourOfCold = RATES.exposureDamage * winterSeverity(world.meta.seed, world.calendar.year);
  assert.ok(Math.abs(lostA - hourOfCold) < 1e-6);
  assert.ok(Math.abs(lostB - hourOfCold / 2) < 1e-6, "half the shelter, half the harm");
  assert.ok(c.health > 0.8, "warm enough to heal");
  assert.ok(a.coldMemory > b.coldMemory && b.coldMemory > c.coldMemory, "the cold is remembered");
});

test("remembered cold drives the urge to build, and fades through the warm seasons", () => {
  const world = World.create({ seed: 1 });
  const agent = world.population.list()[0];
  assert.equal(buildUrge(agent, world), 0);
  agent.coldMemory = 0.4;
  assert.equal(buildUrge(agent, world), 1);
  world.tick = 2 * TICKS_PER_DAY;
  world.calendar = getCalendar(world.tick);
  for (let i = 0; i < 20 * TICKS_PER_DAY; i++) updateBody(agent, world, { hasCompany: true, shelter: 0, warmth: 0, fire: null }), (agent.needs.energy = 1), (agent.needs.rest = 1);
  assert.ok(agent.coldMemory < 0.4 * 0.4 && agent.coldMemory > 0.4 * 0.3, `after two warm seasons: ${agent.coldMemory}`);
});

test("waking warmer after building a roof makes it lean toward roofs", () => {
  const world = emptyWorld();
  const [x, y] = [-50, -50];
  clearGround(world, x, y, 2);
  const agent = world.population.list()[0];
  agent.x = x;
  agent.y = y;
  agent.lastSleep = { x, y };
  nestOf(agent, ctxOf(world));
  wall(world, x + 1, y, GROVE);
  agent.placedSinceWake.wall = 1;
  wakeAtNest(agent, world);
  const afterWall = { ...agent.buildLeaning };
  addToBlock(world, "roof", x, y, world.materials.require(GROVE), 2, agent.id);
  agent.placedSinceWake.roof = 1;
  wakeAtNest(agent, world);
  assert.ok(afterWall.wall > 1, "a wall helped a little");
  assert.ok(agent.buildLeaning.roof > agent.buildLeaning.wall, "a roof helped more");
});

test("cold-hardened AIs build around where they sleep, without trapping anyone", () => {
  const world = World.create({ seed: 11 });
  for (const a of world.population.all()) {
    a.coldMemory = 1;
    a.lastSleep = { x: a.tileX, y: a.tileY };
  }
  // From morning until dark (in the growth season, so no one is hurt by cold while we watch).
  for (let i = 0; i < 12 * 3600; i++) world.step();
  const { walls, roofs } = countBlocks(world.grid);
  const placed = world.population.list().reduce((s, a) => s + a.stats.blocksPlaced, 0);
  assert.ok(walls >= 10, `${walls} walls, ${roofs} roofs, ${placed} placements`);
  assert.ok(world.chronicle.all().some((e) => e.kind === "building"), "the chronicle noticed");
  for (const a of world.population.all()) {
    assert.ok(world.grid.isWalkable(a.tileX, a.tileY), "no one stands inside a wall");
    if (a.nest) assert.ok(canEscape(world.grid, a.nest.x, a.nest.y, a.nest.x + 1000, 0), "every nest has a way out");
  }
});

test("structures and building habits survive save and load", () => {
  const world = emptyWorld();
  clearGround(world, 70, 70, 2);
  wall(world, 71, 70, STONE, 3);
  addToBlock(world, "roof", 70, 70, world.materials.require(GROVE), 2, 3);
  const agent = world.population.list()[0];
  agent.coldMemory = 0.7;
  agent.nest = { x: 70, y: 70, lastSlept: world.tick };
  agent.buildLeaning.roof = 2.5;
  const data = JSON.parse(JSON.stringify(serializeWorld(world, 1)));
  const loaded = deserializeWorld(data).world;
  assert.deepEqual(blockAt(loaded.grid, "wall", 71, 70), blockAt(world.grid, "wall", 71, 70));
  assert.deepEqual(blockAt(loaded.grid, "roof", 70, 70), blockAt(world.grid, "roof", 70, 70));
  assert.equal(loaded.grid.isWalkable(71, 70), false);
  const same = loaded.population.get(agent.id)!;
  assert.equal(same.coldMemory, 0.7);
  assert.deepEqual(same.nest, agent.nest);
  assert.equal(same.buildLeaning.roof, 2.5);
  assert.equal(JSON.stringify(serializeWorld(loaded, 1).chunks), JSON.stringify(data.chunks));
});

test("a step-3 save (format 3) upgrades: agents keep their cold as a memory", () => {
  const world = World.create({ seed: 5 });
  const data = JSON.parse(JSON.stringify(serializeWorld(world, 1)));
  data.format = 3;
  for (const a of data.population.agents) {
    for (const k of ["coldMemory", "nest", "lastSleep", "buildLeaning", "placedSinceWake", "feltShelter", "shelterSpots"]) delete a[k];
    delete a.stats.blocksPlaced;
    a.damage.exposure = 0.3;
  }
  const upgraded = deserializeWorld(data).world;
  assert.equal(SAVE_FORMAT_VERSION, 9);
  for (const a of upgraded.population.all()) {
    assert.equal(a.coldMemory, 0.3);
    assert.equal(a.nest, null);
    assert.deepEqual(a.buildLeaning, { wall: 1, roof: 1 });
    assert.equal(a.stats.blocksPlaced, 0);
  }
  for (let i = 0; i < 600; i++) upgraded.step();
});

test("every winter has its own severity: mostly ordinary, sometimes mild, now and then bitter", () => {
  const all: number[] = [];
  for (let seed = 1; seed <= 50; seed++) for (let year = 1; year <= 20; year++) all.push(winterSeverity(seed, year));
  assert.equal(winterSeverity(7, 3), winterSeverity(7, 3), "fixed for a world and year");
  assert.ok(all.every((v) => v >= WINTER_MIN && v <= WINTER_MAX));
  const share = (kind: string) => all.filter((v) => describeWinter(v) === kind).length / all.length;
  assert.ok(share("ordinary") > 0.3, `ordinary ${share("ordinary")}`);
  assert.ok(share("bitter") > 0.05 && share("bitter") < 0.25, `bitter ${share("bitter")}`);
  assert.ok(share("mild") > 0.05, `mild ${share("mild")}`);
});

test("a hard winter is announced as it begins", () => {
  let seed = 1;
  while (describeWinter(winterSeverity(seed, 1)) !== "bitter") seed++;
  const world = World.create({ seed });
  for (const a of world.population.all()) a.needs.energy = 1;
  world.tick = 30 * TICKS_PER_DAY - 5;
  world.calendar = getCalendar(world.tick);
  for (let i = 0; i < 10; i++) world.step();
  assert.ok(world.chronicle.all().some((e) => e.kind === "weather" && /bitter/.test(e.text)));
});
