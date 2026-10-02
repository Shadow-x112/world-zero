import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import { TICKS_PER_DAY } from "../src/core/constants.ts";
import { getCalendar } from "../src/core/time.ts";
import {
  BASE_MATERIALS,
  MaterialRegistry,
  PROPERTIES,
  describe,
  harmPerUnit,
  isRipe,
} from "../src/materials/registry.ts";
import { placeTile } from "../src/materials/placement.ts";
import { Regrowth } from "../src/materials/regrowth.ts";
import { sampleTile, FLAT_RADIUS } from "../src/world/generator.ts";
import { Terrain } from "../src/world/chunk.ts";
import { serializeWorld, deserializeWorld } from "../src/persist/store.ts";
import { CARRY_CAPACITY, addCarried, carriedFood, handle, isFoodTo, roomFor, taste } from "../src/agents/foraging.ts";
import { updateBody } from "../src/agents/needs.ts";

test("the base set: 9 materials, each defined by all 8 properties between 0 and 1", () => {
  assert.equal(BASE_MATERIALS.length, 9);
  assert.equal(new Set(BASE_MATERIALS.map((m) => m.id)).size, 9);
  for (const m of BASE_MATERIALS) {
    assert.deepEqual(Object.keys(m.props).sort(), [...PROPERTIES].sort());
    for (const v of Object.values(m.props)) assert.ok(v >= 0 && v <= 1);
  }
});

test("materials are described by their properties, not names", () => {
  const reg = new MaterialRegistry();
  assert.equal(describe(reg.require(1).props), "a soft, light, nourishing, growing material");
  assert.match(describe(reg.require(5).props), /hard, sharp/);
  assert.match(describe(reg.require(7).props), /glowing/);
  assert.equal(describe({}), "a plain material");
});

test("the creator can add new materials; they survive save and load", () => {
  const world = World.create({ seed: 1 });
  const id = world.materials.add({ hardness: 1, sharpness: 0, flexibility: 0, mass: 1, energy: 1, nourishment: 0, growth: 0, reactivity: 1 }, 5);
  assert.equal(id, 10);
  const loaded = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world, 1)))).world;
  assert.equal(loaded.materials.require(10).custom, true);
  assert.equal(loaded.materials.all().length, 10);
});

test("placement is deterministic and only on open ground", () => {
  for (const [x, y] of [[3, 4], [300, -200], [-900, 900]]) {
    const t = sampleTile(9, x, y);
    assert.deepEqual(placeTile(9, x, y, t.terrain), placeTile(9, x, y, t.terrain));
  }
  assert.equal(placeTile(9, 500, 500, Terrain.water), null);
  assert.equal(placeTile(9, 500, 500, Terrain.barrier), null);
});

test("abundance is realistic: food common on the plain, rare materials only far out", () => {
  const count = (r0: number, r1: number, step: number) => {
    const c = new Map<number, number>();
    let n = 0;
    for (let y = -r1; y <= r1; y += step) for (let x = -r1; x <= r1; x += step) {
      const d = Math.hypot(x, y);
      if (d < r0 || d >= r1) continue;
      n++;
      const dep = placeTile(4, x, y, sampleTile(4, x, y).terrain);
      if (dep) c.set(dep.material, (c.get(dep.material) ?? 0) + 1);
    }
    return { c, n };
  };
  const plain = count(0, FLAT_RADIUS, 1);
  assert.ok((plain.c.get(1) ?? 0) / plain.n > 0.05, "soft nourishing growth is common on the plain");
  assert.equal(plain.c.get(7) ?? 0, 0, "no glowing material on the plain");
  assert.equal(plain.c.get(8) ?? 0, 0, "no reactive deposits on the plain");
  const far = count(700, 1100, 6);
  const share = (id: number) => (far.c.get(id) ?? 0) / far.n;
  assert.ok(share(1) > share(4) && share(4) > share(5) && share(5) > share(7), "common > moderate > rare");
});

test("untouched ground comes back with exactly the same materials", () => {
  const world = World.create({ seed: 21 });
  const before: number[] = [];
  for (let x = 900; x < 940; x++) before.push(world.grid.get("material", x, 900), world.grid.get("amount", x, 900));
  world.grid.unloadIdle(() => false);
  const after: number[] = [];
  for (let x = 900; x < 940; x++) after.push(world.grid.get("material", x, 900), world.grid.get("amount", x, 900));
  assert.deepEqual(after, before);
});

test("growing materials regrow in warm seasons, not in the cold; used-up stone is gone", () => {
  const world = World.create({ seed: 1 });
  const regrowth = new Regrowth();
  world.grid.set("material", 10, 10, 1);
  world.grid.set("amount", 10, 10, 0);
  world.grid.set("material", 11, 10, 4);
  world.grid.set("amount", 11, 10, 0);

  const runHours = (day: number, hours: number) => {
    for (let h = 0; h < hours; h++) {
      world.tick = day * TICKS_PER_DAY + h * 3600;
      world.calendar = getCalendar(world.tick);
      regrowth.update(world);
    }
  };
  runHours(32, 24); // cold
  assert.equal(world.grid.get("amount", 10, 10), 0, "nothing grows in the cold");
  runHours(2, 48); // growth season
  assert.ok(world.grid.get("amount", 10, 10) >= 6, "mostly regrows within two days in the growth season");
  assert.equal(world.grid.get("amount", 11, 10), 0, "stone does not regrow");
});

test("rich nourishment is only ripe in the warm seasons", () => {
  const rich = new MaterialRegistry().require(9);
  assert.ok(isRipe(rich, "growth") && isRipe(rich, "peak"));
  assert.ok(!isRipe(rich, "decline") && !isRipe(rich, "cold"));
});

test("AIs learn by their senses: looking, handling, tasting", () => {
  const world = World.create({ seed: 2 });
  const agent = world.population.list()[0];
  const soft = world.materials.require(1);
  assert.equal(isFoodTo(agent, soft, "growth"), false, "knows nothing at first");
  handle(agent, world, soft);
  assert.equal(agent.knowledge[1].props.hardness, soft.props.hardness);
  assert.equal(agent.knowledge[1].props.nourishment, undefined, "handling doesn't reveal taste");
  agent.needs.energy = 0.5;
  taste(agent, world, soft);
  assert.equal(agent.knowledge[1].props.nourishment, soft.props.nourishment);
  assert.ok(agent.needs.energy > 0.5, "tasting food nourishes");
  assert.equal(isFoodTo(agent, soft, "growth"), true);
  assert.ok(world.chronicle.all().some((e) => e.kind === "discovery" && /first time/.test(e.text)));
});

test("tasting something volatile hurts", () => {
  const world = World.create({ seed: 2 });
  const agent = world.population.list()[0];
  const glow = world.materials.require(7);
  assert.ok(harmPerUnit(glow) > 0);
  taste(agent, world, glow);
  assert.ok(agent.health < 1);
  assert.ok(agent.damage.poisoning > 0);
  assert.equal(isFoodTo(agent, glow, "growth"), false);
});

test("carrying is limited by weight", () => {
  const world = World.create({ seed: 2 });
  const agent = world.population.list()[0];
  const stone = world.materials.require(4);
  const soft = world.materials.require(1);
  assert.equal(roomFor(agent, world, stone), Math.floor(CARRY_CAPACITY / stone.props.mass));
  addCarried(agent, 4, 1);
  assert.ok(roomFor(agent, world, soft) < Math.floor(CARRY_CAPACITY / soft.props.mass));
  taste(agent, world, soft);
  addCarried(agent, 1, 2);
  assert.equal(carriedFood(agent, world)!.material, 1);
});

test("on the first day the AIs discover food by themselves and eat", () => {
  const world = World.create({ seed: 5 });
  for (let i = 0; i < TICKS_PER_DAY; i++) world.step();
  const agents = world.population.list();
  const fed = agents.filter((a) => a.stats.meals > 0).length;
  const knowFood = agents.filter((a) => Object.values(a.knowledge).some((k) => k.tasted && (k.props.nourishment ?? 0) >= 0.3)).length;
  assert.ok(knowFood >= 18, `${knowFood} know some food`);
  assert.ok(fed >= 15, `${fed} have eaten`);
  assert.ok(world.firsts.has("meal"));
  assert.ok(agents.every((a) => a.needs.energy > 0.6), "no one is going hungry");
});

test("huddling halves the harm of a cold night", () => {
  const world = World.create({ seed: 1 });
  const [alone, huddled] = world.population.list();
  world.tick = 32 * TICKS_PER_DAY + 3600;
  world.calendar = getCalendar(world.tick);
  for (let i = 0; i < 3600; i++) {
    updateBody(alone, world, { hasCompany: false, sheltered: false });
    updateBody(huddled, world, { hasCompany: true, sheltered: false });
  }
  const lostAlone = 1 - alone.health;
  const lostHuddled = 1 - huddled.health;
  assert.ok(lostAlone > 0);
  assert.ok(Math.abs(lostHuddled - lostAlone / 2) < 1e-9, `${lostHuddled} vs ${lostAlone}`);
});

test("knowledge, carrying, memory and firsts survive save and load", () => {
  const world = World.create({ seed: 3 });
  for (let i = 0; i < 20000; i++) world.step();
  const copy = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world, 1)))).world;
  assert.equal(JSON.stringify(copy.population), JSON.stringify(world.population));
  assert.deepEqual([...copy.firsts].sort(), [...world.firsts].sort());
  for (let i = 0; i < 5000; i++) {
    world.step();
    copy.step();
  }
  assert.equal(JSON.stringify(copy.population), JSON.stringify(world.population), "and they carry on identically");
});

test("ground saved before materials existed receives them on load", () => {
  const world = World.create({ seed: 3 });
  world.grid.set("wear", 2, 2, 50); // makes the chunk saved
  const save = serializeWorld(world, 1) as any;
  for (const c of save.chunks) {
    delete c.layers.material;
    delete c.layers.amount;
    delete c.mat;
  }
  const loaded = deserializeWorld(save).world;
  let found = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (loaded.grid.get("material", x, y) !== 0) found++;
  assert.ok(found > 0);
});
