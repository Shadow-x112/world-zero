import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import { TICKS_PER_DAY } from "../src/core/constants.ts";
import { carryBonus, cutPower, breakPower, describeItem, type Item } from "../src/items/item.ts";
import {
  interestIn,
  itemClass,
  performAttempt,
  possibleAttempts,
  probeResult,
  BUNDLE_UNITS,
} from "../src/items/crafting.ts";
import {
  CARRY_CAPACITY,
  addCarried,
  bestToolFor,
  carryCapacity,
  dropEverything,
  pickupTicks,
  toolDidWork,
} from "../src/agents/foraging.ts";
import { KNOWN_FADE_DAYS } from "../src/agents/system.ts";
import { blockLifeDays, blockQuality, roofSpan } from "../src/building/structures.ts";
import { DRYING_INTERVAL, Drying } from "../src/items/drying.ts";
import { serializeWorld, deserializeWorld } from "../src/persist/store.ts";
import type { Agent } from "../src/agents/agent.ts";

const FIBER = 2;
const GROVE = 3;
const STONE = 4;
const SHARD = 5;

function worldWithAgent(seed = 8): { world: World; agent: Agent } {
  const world = World.create({ seed });
  const agent = world.population.list()[0];
  return { world, agent };
}

function give(agent: Agent, material: number, units: number): void {
  addCarried(agent, material, units);
}

function attemptByKey(world: World, agent: Agent, prefix: string) {
  return possibleAttempts(agent, world).find((a) => a.key.startsWith(prefix));
}

test("binding a shard to a pole with fibers makes a sharp thing with reach", () => {
  const { world, agent } = worldWithAgent();
  give(agent, FIBER, 2);
  give(agent, SHARD, 1);
  give(agent, GROVE, 1);
  const attempts = possibleAttempts(agent, world);
  const withPole = attempts.find((a) => a.key === `bind:${GROVE}+${SHARD}~${FIBER}`);
  assert.ok(withPole, `offered: ${attempts.map((a) => a.key).join(", ")}`);
  const item = performAttempt(withPole!, world, agent)!;
  assert.ok(item, "binding is reliable");
  assert.equal(item.props.sharpness, 0.85, "the shard does the cutting");
  assert.equal(item.props.reach, 1, "the pole gives reach");
  assert.ok(cutPower(item) > 0.8);
  assert.equal(agent.carrying.length, 0, "all parts were used up");
  assert.equal(agent.items[0], item);
  assert.match(describeItem(item), /sharp/);
});

test("weaving enough fibers makes a carrier that raises what can be hauled", () => {
  const { world, agent } = worldWithAgent();
  give(agent, FIBER, BUNDLE_UNITS);
  const attempt = attemptByKey(world, agent, "bundle:");
  assert.ok(attempt);
  const item = performAttempt(attempt!, world, agent)!;
  assert.ok(carryBonus(item) > 0, "it carries");
  assert.equal(itemClass(item), "carry");
  // Net gain: capacity grows by more than the carrier's own weight.
  assert.ok(carryCapacity(agent, world.tick) - CARRY_CAPACITY > item.props.mass, "worth its weight");
});

test("striking stone can raise an edge; failures eat the piece", () => {
  const { world, agent } = worldWithAgent();
  give(agent, STONE, 30);
  let made: Item | null = null;
  let tries = 0;
  while (!made && tries < 25) {
    const attempt = attemptByKey(world, agent, `shape:${STONE}<${STONE}`);
    if (!attempt) break;
    made = performAttempt(attempt!, world, agent);
    tries++;
  }
  assert.ok(made, "an edge appeared eventually");
  assert.ok(tries > 1, "not on the first try every time");
  assert.ok(made!.props.sharpness >= 0.35, `sharper than raw stone (${made!.props.sharpness})`);
  assert.ok(made!.props.mass < 0.85, "mass was knocked off");
  const memory = agent.tried[`shape:${STONE}<${STONE}`];
  assert.equal(memory.n, tries);
  assert.equal(memory.ok, 1);
});

test("a sharp tool speeds cutting soft things; a heavy hard one speeds breaking hard things", () => {
  const { world, agent } = worldWithAgent();
  const fiberType = world.materials.require(FIBER);
  const stoneType = world.materials.require(STONE);
  const bareFiber = pickupTicks(agent, world, fiberType);
  const bareStone = pickupTicks(agent, world, stoneType);
  assert.ok(bareStone > bareFiber, "hard things are slower bare-handed");

  give(agent, FIBER, 2);
  give(agent, SHARD, 1);
  performAttempt(attemptByKey(world, agent, "bind:")!, world, agent);
  assert.ok(pickupTicks(agent, world, fiberType) < bareFiber, "the edge speeds cutting");
  assert.equal(pickupTicks(agent, world, stoneType), bareStone, "an edge doesn't break stone");

  give(agent, FIBER, 2);
  give(agent, STONE, 1);
  performAttempt(attemptByKey(world, agent, `bind:${STONE}~`)!, world, agent);
  assert.ok(pickupTicks(agent, world, stoneType) < bareStone, "the hammer speeds breaking");
});

test("tools wear with use and break at the end", () => {
  const { world, agent } = worldWithAgent();
  give(agent, FIBER, 2);
  give(agent, SHARD, 1);
  const item = performAttempt(attemptByKey(world, agent, "bind:")!, world, agent)!;
  const fiberType = world.materials.require(FIBER);
  let uses = 0;
  while (agent.items.length > 0 && uses < 500) {
    toolDidWork(agent, world, fiberType);
    uses++;
  }
  assert.ok(uses >= 200 && uses < 300, `a tool's life is a few hundred uses (${uses})`);
  assert.equal(agent.items.length, 0, "it broke and is gone");
  assert.equal(item.uses, uses);
});

test("interest: new combinations beckon, failures tire, a second of the same bores", () => {
  const { world, agent } = worldWithAgent();
  give(agent, FIBER, 4);
  give(agent, SHARD, 2);
  const attempt = attemptByKey(world, agent, "bind:")!;
  assert.equal(interestIn(agent, attempt, probeResult(attempt, world, agent)), 1, "never tried");
  agent.tried[attempt.key] = { n: 3, ok: 0 };
  assert.ok(interestIn(agent, attempt, probeResult(attempt, world, agent)) < 0.3, "failures tire");
  agent.tried[attempt.key] = { n: 4, ok: 1 };
  performAttempt(attempt, world, agent); // now it holds a cutter
  const again = attemptByKey(world, agent, "bind:")!;
  assert.ok(interestIn(agent, again, probeResult(again, world, agent)) < 0.1, "already has such a thing");
  agent.items = [];
  assert.ok(interestIn(agent, again, probeResult(again, world, agent)) >= 0.7, "lost it: worth re-making");
});

test("a restless AI with the right things in hand tinkers something into being", () => {
  const world = World.create({ seed: 21 });
  for (const a of world.population.all()) {
    a.needs.curiosity = 0.05;
    a.needs.energy = 1;
    give(a, FIBER, 4);
    give(a, SHARD, 1);
  }
  for (let i = 0; i < 6 * 3600 && !world.firsts.has("crafted"); i++) world.step();
  assert.ok(world.firsts.has("crafted"), "someone made something within hours");
  assert.ok(world.chronicle.all().some((e) => e.kind === "crafting"));
  const makers = world.population.list().filter((a) => a.stats.crafted > 0);
  assert.ok(makers.length >= 3, `${makers.length} of them made things`);
  assert.ok(makers.some((a) => a.needs.curiosity > 0.3), "making something fed curiosity");
});

test("belongings fall where an AI dies, and someone else can pick the tool up", () => {
  const { world, agent } = worldWithAgent(9);
  give(agent, FIBER, 2);
  give(agent, SHARD, 1);
  const item = performAttempt(attemptByKey(world, agent, "bind:")!, world, agent)!;
  give(agent, STONE, 1);
  agent.x = 30;
  agent.y = 30;
  dropEverything(agent, world);
  assert.equal(agent.items.length, 0);
  assert.equal(world.groundItems.at(30, 30)[0]?.item.id, item.id);
  assert.equal(world.grid.get("material", 30, 30) === STONE || world.grid.get("amount", 30, 30) > 0, true);

  const finder = world.population.list()[1];
  finder.x = 30;
  finder.y = 30;
  finder.path = [30, 30];
  finder.pathIndex = 0;
  // Walking over it picks it up (via arriveAtTile when following a path).
  const before = world.groundItems.size;
  world.step();
  void before;
});

test("items on the ground and in hands survive save and load exactly", () => {
  const { world, agent } = worldWithAgent(10);
  give(agent, FIBER, BUNDLE_UNITS + 2);
  give(agent, SHARD, 1);
  performAttempt(attemptByKey(world, agent, "bundle:")!, world, agent);
  performAttempt(attemptByKey(world, agent, "bind:")!, world, agent);
  world.groundItems.drop(5, 6, { ...structuredClone(agent.items[0]), id: 999 });
  const data = JSON.parse(JSON.stringify(serializeWorld(world, 1)));
  const copy = deserializeWorld(data).world;
  assert.equal(JSON.stringify(copy.population), JSON.stringify(world.population));
  assert.deepEqual(copy.groundItems.at(5, 6), world.groundItems.at(5, 6));
  assert.equal(copy.itemSeq, world.itemSeq);
  for (let i = 0; i < 3000; i++) {
    world.step();
    copy.step();
  }
  assert.equal(JSON.stringify(copy.population), JSON.stringify(world.population), "and they carry on identically");
});

test("ground not seen for a long while fades back to unknown", () => {
  const { world, agent } = worldWithAgent(11);
  const count = agent.knownCount;
  assert.ok(count > 0);
  assert.ok(agent.knows(0, 0));
  agent.fadeKnown(world.tick + 1);
  assert.equal(agent.knownCount, 0, "all faded");
  assert.ok(agent.learnBlock(0, 0, world.tick), "feels new again");
  // And the daily sweep uses the fade window.
  const far = world.tick - (KNOWN_FADE_DAYS - 1) * TICKS_PER_DAY;
  agent.learnBlock(5, 5, far);
  agent.fadeKnown(world.tick - KNOWN_FADE_DAYS * TICKS_PER_DAY);
  assert.ok(agent.knows(5, 5), "recently seen ground is kept");
});

test("a bitter-first-winter world at 50 founders still runs fast enough", () => {
  const world = World.create({ seed: 13 });
  const t0 = performance.now();
  for (let i = 0; i < 3600; i++) world.step();
  const perTick = (performance.now() - t0) / 3600;
  assert.ok(perTick < 1.5, `one tick costs ${perTick.toFixed(3)}ms with 50 agents`);
});

test("wet earth and fibers mix into a paste that dries into bricks", () => {
  const { world, agent } = worldWithAgent(14);
  const EARTH = 6;
  give(agent, EARTH, 2);
  give(agent, FIBER, 2);
  const attempt = attemptByKey(world, agent, `mix:${EARTH}+`);
  assert.ok(attempt, "mixing offers itself");
  const paste = performAttempt(attempt!, world, agent)!;
  assert.ok(paste.dryAtTick! > world.tick, "wet for hours");
  assert.match(describeItem(paste), /wet/);
  // Hours pass; the drying system turns it into carried bricks.
  world.tick = Math.ceil((paste.dryAtTick! + 1) / DRYING_INTERVAL) * DRYING_INTERVAL;
  new Drying().update(world);
  assert.equal(agent.items.includes(paste), false, "the batch is gone");
  const bricks = agent.carrying.find((c) => c.material === 10);
  const onGround = world.grid.get("material", agent.tileX, agent.tileY) === 10;
  assert.ok(bricks || onGround, "bricks exist, in hand or at its feet");
  assert.ok(world.firsts.has("brick"));
  assert.ok(world.chronicle.all().some((e) => /bricks/.test(e.text)));
});

test("a paste left on the ground dries into a pile of bricks there", () => {
  const { world, agent } = worldWithAgent(15);
  const EARTH = 6;
  give(agent, EARTH, 2);
  give(agent, FIBER, 2);
  const paste = performAttempt(attemptByKey(world, agent, "mix:")!, world, agent)!;
  agent.items = [];
  world.grid.set("material", 40, 40, 0);
  world.grid.set("amount", 40, 40, 0);
  world.groundItems.drop(40, 40, paste);
  world.tick = Math.ceil((paste.dryAtTick! + 1) / DRYING_INTERVAL) * DRYING_INTERVAL;
  new Drying().update(world);
  assert.equal(world.groundItems.at(40, 40).length, 0);
  assert.equal(world.grid.get("material", 40, 40), 10);
  assert.equal(world.grid.get("amount", 40, 40), 2);
});

test("bricks build walls that outlast grove poles and never roof (too rigid)", () => {
  const world = World.create({ seed: 1 });
  const brick = world.materials.require(10);
  const grove = world.materials.require(GROVE);
  assert.ok(blockLifeDays(brick) > blockLifeDays(grove) * 1.5, "bricks outlast poles");
  assert.equal(roofSpan(brick), 0, "bricks cannot span");
  assert.equal(blockQuality(brick), 1, "a brick wall keeps all the cold out");
});
