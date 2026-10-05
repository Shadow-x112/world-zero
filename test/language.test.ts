import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import {
  LEXEME_CAP,
  SHOUT_RADIUS,
  commonWord,
  converse,
  hear,
  lexiconReport,
  makeWord,
  noticeWorldName,
  shoutDanger,
  worldName,
} from "../src/agents/language.ts";
import { hourTogether } from "../src/agents/kinship.ts";
import { SpatialIndex } from "../src/agents/senses.ts";
import { serializeWorld, deserializeWorld } from "../src/persist/store.ts";
import type { Agent } from "../src/agents/agent.ts";
import type { AgentContext } from "../src/agents/movement.ts";

function ctxOf(world: World): AgentContext {
  const index = new SpatialIndex(8);
  index.rebuild(world.population.list());
  return { world, population: world.population, index };
}

test("coined words are pronounceable sounds, deterministic from the world's dice", () => {
  const a = World.create({ seed: 111 });
  const b = World.create({ seed: 111 });
  for (let i = 0; i < 20; i++) {
    const wa = makeWord(a.rng);
    assert.equal(wa, makeWord(b.rng), "the same world coins the same words");
    assert.ok(/^[a-z]{1,12}$/.test(wa), `a word, not a code: "${wa}"`);
  }
});

test("hearing a word: the wordless adopt, allies reinforce, rivals erode and finally switch", () => {
  const world = World.create({ seed: 112 });
  const [a] = world.population.list();
  hear(a, "fire", "maku", world);
  assert.equal(a.lexicon["fire"].w, "maku", "the wordless adopt what they hear");
  for (let i = 0; i < 20; i++) hear(a, "fire", "maku", world);
  assert.equal(a.lexicon["fire"].n, LEXEME_CAP, "confidence is capped, so minds can still change");
  for (let i = 0; i < LEXEME_CAP; i++) hear(a, "fire", "tissa", world);
  assert.equal(a.lexicon["fire"].w, "tissa", "enough rival voices turn the tongue");
  assert.ok(world.chronicle.all().some((e) => /The first shared word/.test(e.text)));
});

test("two speakers converge on one word: the naming game settles", () => {
  const world = World.create({ seed: 113 });
  const [a, b] = world.population.list();
  b.x = a.x + 1;
  b.y = a.y;
  a.lexicon["cold"] = { w: "bruna", n: 3 };
  b.lexicon["cold"] = { w: "siv", n: 1 };
  world.calendar = { ...world.calendar, season: "cold" };
  const ctx = ctxOf(world);
  for (let i = 0; i < 30; i++) {
    world.tick += 3600;
    converse(a, b, ctx);
  }
  assert.equal(a.lexicon["cold"].w, b.lexicon["cold"].w, "one village, one word for the cold");
});

test("a whole band comes to share words just by living close", () => {
  const world = World.create({ seed: 114 });
  const agents = world.population.list();
  // A tight camp in the cold: everyone within earshot of someone.
  agents.forEach((ag, i) => {
    ag.x = 300 + (i % 8);
    ag.y = 300 + Math.floor(i / 8);
  });
  world.calendar = { ...world.calendar, season: "cold" };
  for (let day = 0; day < 25; day++) {
    for (let h = 0; h < 12; h++) {
      world.tick += 3600;
      hourTogether(ctxOf(world));
    }
  }
  const common = commonWord(world, "cold");
  assert.ok(common, "the cold has words");
  assert.ok(common!.share >= 0.6, `most mouths agree on one (${Math.round(common!.share * 100)}%: "${common!.word}")`);
});

test("the danger cry carries, forewarns whoever understands, and teaches whoever doesn't", () => {
  const world = World.create({ seed: 115 });
  const [crier, friend, stranger, far] = world.population.list();
  friend.x = crier.x + 3;
  friend.y = crier.y;
  stranger.x = crier.x - 3;
  stranger.y = crier.y;
  far.x = crier.x + SHOUT_RADIUS + 5;
  far.y = crier.y;
  crier.lexicon["danger"] = { w: "aiek", n: 3 };
  friend.lexicon["danger"] = { w: "aiek", n: 2 };
  shoutDanger(crier, ctxOf(world));
  assert.ok(friend.emotions.fear >= 0.3, "the one who understands feels it at once");
  assert.equal(stranger.lexicon["danger"]?.w, "aiek", "the one who doesn't still catches the sound");
  assert.ok(stranger.emotions.fear < 0.1, "but a strange sound alone is not yet fear");
  assert.equal(far.lexicon["danger"], undefined, "too far to hear");
});

test("when most living mouths agree on a word for everything there is, the world has a name", () => {
  const world = World.create({ seed: 116 });
  const agents = world.population.list();
  assert.equal(worldName(world), null, "the world begins nameless");
  for (const ag of agents.slice(0, Math.ceil(agents.length * 0.5))) ag.lexicon["world"] = { w: "orun", n: 2 };
  noticeWorldName(world);
  assert.equal(worldName(world), null, "half is not most");
  for (const ag of agents.slice(0, Math.ceil(agents.length * 0.7))) ag.lexicon["world"] = { w: "orun", n: 2 };
  noticeWorldName(world);
  assert.equal(worldName(world), "orun");
  const entries = world.chronicle.all().filter((e) => /The world has a name: Orun/.test(e.text));
  assert.equal(entries.length, 1);
  noticeWorldName(world);
  assert.equal(world.chronicle.all().filter((e) => /has a name/.test(e.text)).length, 1, "named once, ever");
  assert.ok(lexiconReport(world).includes("The world is called Orun"));
});

test("words survive save and load exactly, and older saves wake silent", () => {
  const world = World.create({ seed: 117 });
  const [a, b] = world.population.list();
  a.lexicon["fire"] = { w: "maku", n: 4 };
  b.lexicon["person:" + a.id] = { w: "tessu", n: 2 };
  const copy = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world, 1)))).world;
  assert.equal(JSON.stringify(copy.population), JSON.stringify(world.population));
  for (let i = 0; i < 3000; i++) {
    world.step();
    copy.step();
  }
  assert.equal(JSON.stringify(copy.population), JSON.stringify(world.population), "and the worlds carry on identically");
  const raw = JSON.parse(JSON.stringify(serializeWorld(world, 1)));
  raw.format = 11;
  for (const ag of raw.population.agents) delete ag.lexicon;
  const loaded = deserializeWorld(raw).world;
  for (const ag of loaded.population.list()) assert.deepEqual(ag.lexicon, {});
});
