import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import {
  GRUDGE_COLD,
  THEFT_GRUDGE,
  coldBetween,
  dailyGrudges,
  giftForgives,
  grudgeAgainst,
  quarrels,
  takeTarget,
  wrong,
} from "../src/agents/conflict.ts";
import { scoreActions, act } from "../src/agents/brain.ts";
import { hourTogether, receivedGift } from "../src/agents/kinship.ts";
import { addCarried } from "../src/agents/foraging.ts";
import { SpatialIndex } from "../src/agents/senses.ts";
import { serializeWorld, deserializeWorld } from "../src/persist/store.ts";
import type { Agent } from "../src/agents/agent.ts";
import type { AgentContext } from "../src/agents/movement.ts";

function ctxOf(world: World): AgentContext {
  const index = new SpatialIndex(8);
  index.rebuild(world.population.list());
  return { world, population: world.population, index };
}

function knowsFood(agent: Agent, material = 1): void {
  agent.knowledge[material] = { firstSeenTick: 0, handled: true, tasted: true, props: { nourishment: 0.7, reactivity: 0 }, timesEaten: 3 };
}

test("a starving AI will take from full hands nearby - but never from the dear", () => {
  const world = World.create({ seed: 121 });
  const [hungry, rich, dear] = world.population.list();
  rich.x = hungry.x + 2;
  rich.y = hungry.y;
  dear.x = hungry.x - 2;
  dear.y = hungry.y;
  for (const x of [rich, dear]) {
    knowsFood(x);
    addCarried(x, 1, 5);
  }
  hungry.bonds[dear.id] = { trust: 0.7, affection: 0.8, lastNear: world.tick };
  hungry.needs.energy = 0.1;
  const target = takeTarget(hungry, ctxOf(world));
  assert.equal(target?.id, rich.id, "the unloved full hands, not the dear ones");
  const scores = scoreActions(hungry, ctxOf(world));
  assert.ok(scores.take > scores.seekFood, "desperation beside full hands outweighs wandering");
  hungry.needs.energy = 0.8;
  assert.equal(scoreActions(hungry, ctxOf(world)).take, 0, "a fed body does not take");
});

test("the taking happens: food changes hands, the victim rages, the grudge forms, history is kept", () => {
  const world = World.create({ seed: 122 });
  const [hungry, rich] = world.population.list();
  rich.x = hungry.x + 1;
  rich.y = hungry.y;
  knowsFood(rich);
  addCarried(rich, 1, 5);
  hungry.needs.energy = 0.08;
  for (const x of world.population.list()) {
    x.action = { type: "idle", startedTick: world.tick, untilTick: world.tick + 100000 };
    x.nextDecisionTick = x === hungry ? world.tick : world.tick + 100000;
  }
  const before = rich.carrying[0].units;
  for (let i = 0; i < 400 && hungry.carrying.length === 0; i++) {
    act(hungry, ctxOf(world));
    world.tick++;
  }
  assert.ok(hungry.carrying.length > 0, "the taking happened");
  assert.ok(rich.carrying.length === 0 || rich.carrying[0].units < before, "from those hands");
  assert.ok(grudgeAgainst(rich, hungry.id) >= THEFT_GRUDGE, "the victim will not forget soon");
  assert.ok(rich.emotions.anger >= 0.4, "and rages");
  assert.equal(hungry.stats.taken, 1);
  assert.ok(world.chronicle.all().some((e) => /The first taking/.test(e.text)));
});

test("witnesses remember who took, and family rises for its own", () => {
  const world = World.create({ seed: 123 });
  const [victim, thief, bystander, mother] = world.population.list();
  bystander.x = victim.x + 2;
  bystander.y = victim.y;
  mother.x = victim.x - 2;
  mother.y = victim.y;
  victim.parents = [mother.id, 99];
  bystander.bonds[thief.id] = { trust: 0.5, affection: 0.3, lastNear: world.tick };
  wrong(victim, thief, ctxOf(world));
  assert.ok(bystander.bonds[thief.id].trust < 0.5, "a witness trusts the taker less");
  assert.ok(grudgeAgainst(mother, thief.id) > 0, "the mother holds it against them");
  assert.ok(grudgeAgainst(bystander, thief.id) === 0, "a stranger's quarrel is not the bystander's");
});

test("resentment goes cold: no warmth grows between the grudged, and their beds stay apart", () => {
  const world = World.create({ seed: 124 });
  const [a, b] = world.population.list();
  b.x = a.x + 1;
  b.y = a.y;
  a.grudges[b.id] = GRUDGE_COLD + 0.2;
  assert.ok(coldBetween(a, b) && coldBetween(b, a), "cold runs both ways from one side's grudge");
  const before = a.bondWith(b.id).affection;
  hourTogether(ctxOf(world));
  assert.equal(a.bondWith(b.id).affection, before, "an hour beside a rival grows nothing");
});

test("anger beside resentment flares into a quarrel, once in the world's history", () => {
  const world = World.create({ seed: 125 });
  const [a, b] = world.population.list();
  b.x = a.x + 1;
  b.y = a.y;
  a.emotions.anger = 0.6;
  a.grudges[b.id] = 0.4;
  let flared = false;
  for (let i = 0; i < 40 && !flared; i++) {
    quarrels(ctxOf(world));
    flared = world.chronicle.all().some((e) => /the first quarrel/.test(e.text));
  }
  assert.ok(flared, "harsh sounds came");
  assert.ok(grudgeAgainst(b, a.id) > 0, "and the other side holds it now too");
  assert.ok(b.emotions.anger > 0, "both come away angrier");
});

test("grudges heal slowly with days, and at once with a gift", () => {
  const world = World.create({ seed: 126 });
  const [a, giver] = world.population.list();
  a.grudges[giver.id] = 0.5;
  dailyGrudges(ctxOf(world));
  const after = grudgeAgainst(a, giver.id);
  assert.ok(after < 0.5 && after > 0.45, "a day softens almost nothing");
  receivedGift(a, giver, world.tick);
  assert.ok(grudgeAgainst(a, giver.id) < 0.2, "food into wronged hands unmakes most of it");
  giftForgives(a, giver.id);
  giftForgives(a, giver.id);
  assert.equal(grudgeAgainst(a, giver.id), 0, "and peace, finally");
});

test("grudges survive save and load exactly, and die with the dead", () => {
  const world = World.create({ seed: 127 });
  const [a, b] = world.population.list();
  a.grudges[b.id] = 0.6;
  a.stats.taken = 2;
  const copy = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world, 1)))).world;
  assert.equal(JSON.stringify(copy.population), JSON.stringify(world.population));
  for (let i = 0; i < 3000; i++) {
    world.step();
    copy.step();
  }
  assert.equal(JSON.stringify(copy.population), JSON.stringify(world.population), "and the worlds carry on identically");
  world.population.remove(b.id);
  dailyGrudges(ctxOf(world));
  assert.equal(grudgeAgainst(a, b.id), 0, "the dead are let go");
  // A format-12 save (before conflict) wakes with no resentments.
  const raw = JSON.parse(JSON.stringify(serializeWorld(copy, 1)));
  raw.format = 12;
  for (const ag of raw.population.agents) {
    delete ag.grudges;
    delete ag.stats.taken;
  }
  const loaded = deserializeWorld(raw).world;
  for (const ag of loaded.population.list()) {
    assert.deepEqual(ag.grudges, {});
    assert.equal(ag.stats.taken, 0);
  }
});
