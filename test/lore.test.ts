import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import { TICKS_PER_DAY } from "../src/core/constants.ts";
import { Lore, LORE_TICK, waysHeld, wayName } from "../src/culture/lore.ts";
import { killAgent } from "../src/agents/system.ts";
import { hear } from "../src/agents/language.ts";
import { serializeWorld, deserializeWorld } from "../src/persist/store.ts";
import type { Agent } from "../src/agents/agent.ts";

const FIRE = "craft:fire";
const knowFire = (a: Agent) => (a.tried["heat:2"] = { n: 1, ok: 1 });
const loreText = (world: World) => world.chronicle.all().filter((e) => e.kind === "lore").map((e) => e.text);

test("a way found is on record with its finder; passed on, it keeps where it came from", () => {
  const world = World.create({ seed: 401 });
  const [a, b, c] = world.population.list();
  knowFire(a);
  world.tick = Math.ceil(world.tick / 3600) * 3600 + LORE_TICK - 1;
  world.step(); // the hourly pass
  const way = world.lore.get(FIRE)!;
  assert.equal(way.by, a.id);
  assert.deepEqual(world.lore.of(a.id).filter((k) => k.startsWith("craft:")), [FIRE]);
  assert.equal(way.holders[a.id].how, "found");

  knowFire(b);
  world.lore.learned(world, b, a, "taught");
  knowFire(c);
  world.lore.learned(world, c, b, "watched");
  assert.equal(way.known, 3);
  assert.equal(way.passed, 2);
  assert.equal(way.holders[c.id].g, 2);
  assert.equal(way.holders[c.id].how, "watched");
  assert.deepEqual(world.lore.chain(FIRE, c.id), [c.id, b.id, a.id]);
  assert.equal(wayName(world, FIRE), "how to raise flame from dry tinder");
});

test("a long chain of hands is history: the chronicle traces it back to whoever found it", () => {
  const world = World.create({ seed: 402 });
  const [a, b, c, d] = world.population.list();
  knowFire(a);
  world.lore.sync(a, world);
  for (const [learner, teacher] of [[b, a], [c, b], [d, c]] as [Agent, Agent][]) {
    knowFire(learner);
    world.lore.learned(world, learner, teacher, "taught");
  }
  const line = loreText(world).find((t) => t.startsWith(`${d.label} learned how to raise flame`));
  assert.ok(line, loreText(world).join("\n"));
  assert.match(line!, new RegExp(`from ${c.label}, who had it from ${b.label}, who had it from ${a.label}, who found it\\.$`));
});

test("when the last who knew a way dies, the way is lost; found again, it is remembered", () => {
  const world = World.create({ seed: 403 });
  const [a, b, c] = world.population.list();
  knowFire(a);
  world.lore.sync(a, world);
  knowFire(b);
  world.lore.learned(world, b, a, "taught");
  killAgent(world, a, "starvation");
  assert.equal(world.lore.get(FIRE)!.lost, null, "one still knows");
  killAgent(world, b, "starvation");
  const way = world.lore.get(FIRE)!;
  assert.notEqual(way.lost, null);
  assert.ok(loreText(world).some((t) => t.includes(`When ${b.label} died, how to raise flame from dry tinder, first found by ${a.label}, died with it`)));
  // Days later, someone works it out again.
  world.tick += 3 * TICKS_PER_DAY;
  knowFire(c);
  world.lore.sync(c, world);
  assert.equal(way.lost, null);
  assert.equal(way.by, a.id, "the first finder stays the first");
  assert.ok(loreText(world).some((t) => t === `${c.label} found how to raise flame from dry tinder again, 3 days after the last who knew it was gone.`));
});

test("forgetting is caught; a lesson on the edge of sure is not counted lost and found over and over", () => {
  const world = World.create({ seed: 404 });
  const [a] = world.population.list();
  a.buildSense.lessons["frame:3"] = { v: 0.35, n: 5 };
  world.lore.sync(a, world);
  assert.ok(world.lore.of(a.id).includes("build:frame+:3"));
  a.buildSense.lessons["frame:3"].v = 0.25; // a little less sure: still known
  world.lore.sync(a, world);
  assert.ok(world.lore.of(a.id).includes("build:frame+:3"));
  a.buildSense.lessons["frame:3"].v = -0.4; // changed its mind
  world.lore.sync(a, world);
  assert.deepEqual(world.lore.of(a.id).filter((k) => k.startsWith("build:")), ["build:frame-:3"]);
  assert.equal(world.lore.get("build:frame+:3")!.known, 0);
});

test("a word taken up is heard from whoever said it; names stay off the record", () => {
  const world = World.create({ seed: 405 });
  const [a, b] = world.population.list();
  a.lexicon["home"] = { w: "tolo", n: 3 };
  a.lexicon[`person:${b.id}`] = { w: "bibi", n: 3 };
  hear(b, "home", "tolo", world, a);
  hear(b, `person:${b.id}`, "bibi", world, a);
  const way = world.lore.get("word:home=tolo")!;
  assert.equal(way.holders[b.id].how, "heard");
  assert.equal(way.holders[b.id].from, a.id);
  assert.ok(!waysHeld(b, world).some((k) => k.includes("person:")));
});

test("handed down the generations: a child's child knowing what its grandparent found", () => {
  const world = World.create({ seed: 406 });
  const [a, b, c] = world.population.list();
  b.parents = [a.id, a.id];
  world.lore.kin.clear();
  world.lore.sync(a, world);
  world.lore.sync(b, world);
  c.parents = [b.id, b.id];
  knowFire(a);
  world.lore.sync(a, world);
  knowFire(b);
  world.lore.learned(world, b, a, "taught");
  knowFire(c);
  world.lore.learned(world, c, b, "taught");
  assert.equal(world.lore.kin.get(c.id), 2);
  assert.equal(world.lore.get(FIRE)!.gens, 2);
  assert.ok(loreText(world).some((t) => t === `Knowing how to raise flame from dry tinder has now been handed down 2 generations since ${a.label} found it.`));
});

test("a world already living begins its record from what everyone knows, finders from the chronicle; it survives a save", () => {
  const world = World.create({ seed: 407 });
  const [a, b] = world.population.list();
  world.chronicle.add(world.tick, "fire", `${a.label} struck sparks into dry tinder until flame rose: fire.`, { agentId: a.id });
  knowFire(a);
  knowFire(b);
  const lore = Lore.seed(world);
  const way = lore.get(FIRE)!;
  assert.equal(way.by, a.id);
  assert.equal(way.holders[a.id].how, "found");
  assert.equal(way.holders[b.id].how, "before");
  assert.equal(way.known, 2);
  assert.equal(lore.get("food:1")?.by ?? null, null, "no one on record found it");

  world.lore = lore;
  const json = JSON.parse(JSON.stringify(serializeWorld(world, 1)));
  const back = deserializeWorld(json).world;
  assert.deepEqual(back.lore.toJSON(), world.lore.toJSON());
  assert.deepEqual(back.lore.of(b.id), world.lore.of(b.id));
  // An old save (no record) begins one on load.
  delete json.lore;
  json.format = 17;
  const old = deserializeWorld(json).world;
  assert.equal(old.lore.get(FIRE)!.by, a.id);
});

test("a lesson told that only sinks in later is still credited to whoever told it", () => {
  const world = World.create({ seed: 408 });
  const [a, b] = world.population.list();
  a.buildSense.lessons["wall:4"] = { v: 0.8, n: 20 };
  world.lore.sync(a, world);
  b.buildSense.lessons["wall:4"] = { v: 0.2, n: 1 }; // told, not yet sure
  world.lore.learned(world, b, a, "taught", "build:wall+:4");
  assert.ok(!world.lore.of(b.id).includes("build:wall+:4"));
  world.tick += 2 * TICKS_PER_DAY;
  b.buildSense.lessons["wall:4"] = { v: 0.4, n: 4 }; // its own walls bore it out
  world.lore.sync(b, world);
  const h = world.lore.get("build:wall+:4")!.holders[b.id];
  assert.equal(h.how, "taught");
  assert.equal(h.from, a.id);
  // A lost lesson, merely changed-mind, makes no history.
  b.buildSense.lessons["wall:4"].v = -0.5;
  a.buildSense.lessons["wall:4"].v = -0.5;
  world.lore.sync(a, world);
  world.lore.sync(b, world);
  assert.ok(!loreText(world).some((t) => /good wall any more/.test(t)));
});
