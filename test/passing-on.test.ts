import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import { teachNearby } from "../src/agents/skill.ts";
import { coinWords } from "../src/agents/language.ts";
import { TOLD_CAP, lessonOf, lessonToTeach, tellLesson } from "../src/agents/building-sense.ts";
import { roofFirsts } from "../src/agents/building.ts";
import { addToBlock } from "../src/building/structures.ts";
import { SpatialIndex } from "../src/agents/senses.ts";
import type { Agent } from "../src/agents/agent.ts";
import type { AgentContext } from "../src/agents/movement.ts";
import { buildUp } from "./support/build.ts";

const FIBER = 2, GROVE = 3, STONE = 4;

function ctxOf(world: World): AgentContext {
  const index = new SpatialIndex(8);
  index.rebuild(world.population.list());
  return { world, population: world.population, index };
}

function adult(agent: Agent, world: World): Agent {
  agent.bornTick = world.tick - Math.round(agent.lifespanTicks * 0.3);
  return agent;
}

/** Teacher and learner side by side at the teaching minute, the teacher idle and fond of the learner. */
function lessonScene(seed: number): { world: World; teacher: Agent; learner: Agent; stranger: Agent } {
  const world = World.create({ seed });
  const [teacher, learner, stranger] = world.population.list();
  adult(teacher, world);
  world.tick = Math.ceil(world.tick / 3600) * 3600 + 2520;
  world.calendar = { ...world.calendar, light: 1 };
  Object.assign(teacher, { x: 300, y: 300 });
  Object.assign(learner, { x: 301, y: 300 });
  Object.assign(stranger, { x: 302, y: 300 });
  teacher.personality.warmth = 1;
  teacher.bonds[learner.id] = { trust: 0.7, affection: 0.8, lastNear: world.tick };
  delete teacher.bonds[stranger.id];
  teacher.action = { type: "idle", startedTick: world.tick };
  for (const kind of Object.keys(teacher.skills) as (keyof typeof teacher.skills)[]) teacher.skills[kind] = 0;
  return { world, teacher, learner, stranger };
}

test("what one has learned about building, it shows those it holds dear - never as sure as living it", () => {
  const { world, teacher, learner, stranger } = lessonScene(301);
  world.isFirst("lesson"); // (someone, somewhere, has already taught something)
  teacher.buildSense.lessons["wall:2"] = { v: -0.8, n: 12 };
  teacher.buildSense.lessons["frame:3"] = { v: 0.7, n: 10 };
  for (let i = 0; i < 200 && !(lessonOf(learner, "wall", FIBER) && lessonOf(learner, "frame", GROVE)); i++) {
    teachNearby(teacher, ctxOf(world));
    world.tick += 3600;
  }
  const wall = lessonOf(learner, "wall", FIBER)!;
  const frame = lessonOf(learner, "frame", GROVE)!;
  assert.ok(wall.v < 0 && wall.v >= -TOLD_CAP, `fibre walls: ${wall.v}`);
  assert.ok(frame.v > 0.15 && frame.v <= TOLD_CAP, `grove poles overhead: ${frame.v}`);
  assert.equal(lessonOf(stranger, "wall", FIBER), undefined, "strangers are told nothing");
  assert.ok(world.chronicle.all().some((e) => /first knowledge of building passed on/.test(e.text)));
});

test("being told never unsettles what one already knows more surely", () => {
  const world = World.create({ seed: 302 });
  const [teacher, learner] = world.population.list();
  teacher.buildSense.lessons["wall:2"] = { v: -0.8, n: 12 };
  learner.buildSense.lessons["wall:2"] = { v: -0.9, n: 30 };
  assert.equal(lessonToTeach(teacher, learner), null, "nothing worth saying");
  tellLesson(learner, "wall", FIBER, -0.8);
  assert.equal(lessonOf(learner, "wall", FIBER)!.v, -0.9);
  // A lesson half-learned is not worth stopping for; an unsure one is not passed on at all.
  teacher.buildSense.lessons["cover:2"] = { v: 0.3, n: 40 };
  teacher.buildSense.lessons["wall:4"] = { v: 0.9, n: 2 };
  assert.equal(lessonToTeach(teacher, learner), null);
});

test("hands that have built walls want a sound for them; the word travels with the lesson", () => {
  const { world, teacher, learner } = lessonScene(303);
  teacher.buildSense.lessons["wall:4"] = { v: 0.8, n: 20 };
  world.isFirst("word"); // (words are already spoken in this world)
  const ctx = ctxOf(world);
  for (let i = 0; i < 2000 && !teacher.lexicon["wall"]; i++) coinWords(teacher, ctx);
  assert.ok(teacher.lexicon["wall"], "a word for a wall");
  assert.ok(world.chronicle.all().some((e) => /a sound for a wall, a thing its own hands had made/.test(e.text)));
  for (let i = 0; i < 200 && !lessonOf(learner, "wall", STONE); i++) {
    teachNearby(teacher, ctxOf(world));
    world.tick += 3600;
  }
  assert.ok(lessonOf(learner, "wall", STONE));
  assert.equal(learner.lexicon["wall"]?.w, teacher.lexicon["wall"].w, "and heard the word for it");
});

test("the chronicle marks the first lean-to, the first roof that spans, the first covered roof", () => {
  const world = World.create({ seed: 304 });
  const [a, b] = world.population.list();
  for (const ag of world.population.all()) Object.assign(ag, { x: -500, y: -500 });
  const clear = (x: number, y: number) => {
    for (let oy = -3; oy <= 3; oy++) for (let ox = -3; ox <= 3; ox++) {
      for (const l of ["terrain", "height", "material", "amount"]) world.grid.set(l, x + ox, y + oy, 0);
    }
  };
  const grove = world.materials.require(GROVE);
  const fiber = world.materials.require(FIBER);
  // A lean-to: one wall, poles leaned from it.
  clear(40, 40);
  buildUp(world, "wall", 41, 40, world.materials.require(STONE), a.id, { x: 40, y: 40 });
  addToBlock(world, "roof", 40, 40, grove, 1, a.id);
  roofFirsts(a, world, { level: "roof", x: 40, y: 40, existing: false }, grove);
  // A span: two walls, poles across.
  clear(80, 80);
  buildUp(world, "wall", 79, 80, world.materials.require(STONE), b.id, { x: 80, y: 80 });
  buildUp(world, "wall", 81, 80, world.materials.require(STONE), b.id, { x: 80, y: 80 });
  for (let i = 0; i < 4; i++) addToBlock(world, "roof", 80, 80, grove, 1, b.id);
  roofFirsts(b, world, { level: "roof", x: 80, y: 80, existing: true }, grove);
  // Covered.
  addToBlock(world, "roof", 80, 80, fiber, 2, b.id);
  roofFirsts(b, world, { level: "roof", x: 80, y: 80, existing: true }, fiber);
  const text = world.chronicle.all().map((e) => e.text).join("\n");
  assert.match(text, new RegExp(`${a.label} leaned .* the first lean-to`));
  assert.match(text, new RegExp(`${b.label} laid .* the first roof that spans`));
  assert.match(text, new RegExp(`${b.label} laid .* the first covered roof`));
});
