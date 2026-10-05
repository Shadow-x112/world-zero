// Skill: what hands learn by doing. No menus and no levels - every attempt
// teaches a little (a success more than a failure), and the gains shrink as
// mastery grows, so the first fire teaches more than the hundredth. Skill
// never fades; the body remembers. It shows only in the work itself: things
// come loose faster, edges take surer, flame answers oftener, walls rise
// quicker, meals char less.
//
// And knowledge finally escapes the skull. Whoever SEES a skilled act succeed
// learns a little - enough to understand, never mastery - and can catch the
// recipe itself, so a village that loses its firemaker keeps fire if anyone
// watched. The skilled also TEACH: an idle adult near someone it holds dear
// will stop and show them - a recipe, a food that is safe, the herb that
// loosens poison - and the lesson warms the bond both ways.

import type { World } from "../core/world.ts";
import type { Agent, MaterialKnowledge } from "./agent.ts";
import { feel } from "./emotions.ts";
import { harmPerUnit, describe } from "../materials/registry.ts";
import type { AgentContext } from "./movement.ts";
import { sightRadius } from "./senses.ts";

export type SkillKind = "gathering" | "crafting" | "firecraft" | "building" | "cooking";

export const SKILL_KINDS: SkillKind[] = ["gathering", "crafting", "firecraft", "building", "cooking"];

export type Skills = Record<SkillKind, number>;

export function blankSkills(): Skills {
  return { gathering: 0, crafting: 0, firecraft: 0, building: 0, cooking: 0 };
}

/** What one rep teaches, before diminishing returns, by how often reps come.
 * Frequent work (gathering) teaches in crumbs; rare triumphs (fire) in leaps -
 * the first raised flame IS the knack of it. */
const GAIN: Record<SkillKind, { success: number; fail: number }> = {
  gathering: { success: 0.002, fail: 0.001 },
  crafting: { success: 0.015, fail: 0.007 },
  firecraft: { success: 0.6, fail: 0.012 },
  building: { success: 0.008, fail: 0.004 },
  cooking: { success: 0.02, fail: 0.01 },
};

/** Watching gets you this far; your own hands take you the rest. */
export const WATCH_CAP = 0.3;
/** Being shown gets you this far. */
export const TEACH_CAP = 0.5;
/** Skill past this is mastery, and the world's first of each is history. */
export const MASTERY = 0.9;

const MASTERY_LINES: Record<SkillKind, string> = {
  gathering: "nothing comes loose from the ground faster than under its hands",
  crafting: "no hands in the world shape and bind surer",
  firecraft: "no one raises flame as surely",
  building: "no one raises a wall as quickly",
  cooking: "no meal is as good as one from its fire",
};

/** One rep of real work: the hands learn, and mastery is noticed once per world. */
export function practice(agent: Agent, kind: SkillKind, success: boolean, world: World): void {
  const before = agent.skills[kind];
  const gain = (success ? GAIN[kind].success : GAIN[kind].fail) * (1 - before);
  const after = Math.min(1, before + gain);
  agent.skills[kind] = after;
  if (after >= MASTERY && before < MASTERY) {
    feel(agent, "contentment", 0.5);
    feel(agent, "joy", 0.4);
    if (world.isFirst(`mastery:${kind}`)) {
      world.chronicle.add(world.tick, "mastery", `${agent.label} has mastered its craft: ${MASTERY_LINES[kind]}.`, {
        agentId: agent.id,
        skill: kind,
      });
    }
  }
}

/** How much faster skilled hands make a piece of work (divide the time by this). */
export function workSpeed(skill: number, weight = 0.5): number {
  return 1 + weight * skill;
}

/**
 * A skilled act succeeded in the open: whoever saw it learns a little - capped
 * well below mastery - and may catch the recipe itself (the tried-combination
 * memory that otherwise dies with its holder).
 */
export function watchSuccess(ctx: AgentContext, doer: Agent, kind: SkillKind, recipeKey?: string): void {
  const world = ctx.world;
  const radius = sightRadius(world.calendar.light);
  for (const { agent: watcher } of ctx.index.near(doer.x, doer.y, radius, doer)) {
    if (watcher.asleep) continue;
    const s = watcher.skills[kind];
    if (s < WATCH_CAP) {
      watcher.skills[kind] = Math.min(WATCH_CAP, s + 0.1 * Math.max(0, doer.skills[kind] - s));
    }
    if (recipeKey) {
      const memory = watcher.tried[recipeKey];
      if (!memory || memory.ok === 0) {
        watcher.tried[recipeKey] = { n: (memory?.n ?? 0) + 1, ok: 1 }; // seen working: it can be done
        feel(watcher, "wonder", 0.15);
      }
    }
  }
}

// --- Teaching -------------------------------------------------------------------

/** Food knowledge worth passing on: tasted, nourishing, and harmless. */
function knownSafeFood(k: MaterialKnowledge, harm: number): boolean {
  return k.tasted && (k.props.nourishment ?? 0) >= 0.3 && harm === 0;
}

/** Tells another about a material, as if they had tasted it themselves. */
function tellAbout(learner: Agent, id: number, from: MaterialKnowledge, tick: number): MaterialKnowledge {
  const k = (learner.knowledge[id] ??= { firstSeenTick: tick, handled: false, tasted: false, props: {}, timesEaten: 0 });
  k.tasted = true;
  if (from.props.nourishment !== undefined) k.props.nourishment = from.props.nourishment;
  if (from.props.reactivity !== undefined) k.props.reactivity = from.props.reactivity;
  return k;
}

/** Whether one would stop and teach the other: the same hearts that would feed them. */
function wouldTeach(teacher: Agent, learner: Agent): boolean {
  if (teacher.mate === learner.id) return true;
  if (learner.parents?.includes(teacher.id) || teacher.parents?.includes(learner.id)) return true;
  return teacher.bondWith(learner.id).affection >= 0.6;
}

/** The recipe-key prefix(es) belonging to each teachable craft. */
function recipeOf(kind: SkillKind, teacher: Agent, learner: Agent): string | null {
  const prefixes = kind === "firecraft" ? ["heat:"] : kind === "crafting" ? ["shape:", "bind:", "bundle:", "mix:"] : [];
  if (prefixes.length === 0) return null;
  const keys = Object.entries(teacher.tried)
    .filter(([k, v]) => v.ok > 0 && prefixes.some((p) => k.startsWith(p)) && !k.includes("item"))
    .map(([k]) => k)
    .sort();
  for (const key of keys) {
    const theirs = learner.tried[key];
    if (!theirs || theirs.ok === 0) return key;
  }
  return null;
}

/**
 * Habit: an idle grown AI beside someone it holds dear stops and shows them
 * something it knows and they lack - the herb that loosens poison first, then
 * the knack of its best craft, then which things are good to eat. The lesson
 * warms the bond both ways, and the world's first lesson is history.
 */
export function teachNearby(agent: Agent, ctx: AgentContext): void {
  const world = ctx.world;
  if (world.tick % 3600 !== 2520) return; // once an hour, on the hour's quiet stretch
  if (!agent.grown(world.tick) || world.calendar.light < 0.35) return;
  const busy = agent.action && agent.action.type !== "idle" && agent.action.type !== "socialize";
  if (busy) return;
  // The warm-hearted teach most readily; even the solitary do, now and then.
  if (!world.rng.chance(0.2 + 0.2 * Math.max(0, agent.personality.warmth))) return;

  for (const { agent: learner } of ctx.index.near(agent.x, agent.y, 3, agent)) {
    if (learner.asleep || !wouldTeach(agent, learner)) continue;

    // 1. A cure: the one lesson that saves a life outright.
    for (const [id, k] of Object.entries(agent.knowledge).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      if (!k.curative) continue;
      const theirs = learner.knowledge[id];
      if (theirs?.curative) continue;
      tellAbout(learner, Number(id), k, world.tick).curative = true;
      const type = world.materials.get(Number(id));
      lessonLearned(world, agent, learner, `the ${type ? describe(type.props) + " thing" : "thing"} that loosens poison`);
      return;
    }

    // 2. Its best craft: skill into young hands, and the recipe with it.
    let best: SkillKind | null = null;
    for (const kind of SKILL_KINDS) {
      if (agent.skills[kind] < 0.4) continue;
      if (agent.skills[kind] - learner.skills[kind] < 0.25 || learner.skills[kind] >= TEACH_CAP) continue;
      if (!best || agent.skills[kind] > agent.skills[best]) best = kind;
    }
    if (best) {
      const s = learner.skills[best];
      learner.skills[best] = Math.min(TEACH_CAP, s + 0.12 * (1 - s));
      const recipe = recipeOf(best, agent, learner);
      if (recipe) learner.tried[recipe] = { n: (learner.tried[recipe]?.n ?? 0) + 1, ok: 1 };
      lessonLearned(world, agent, learner, best === "firecraft" ? "how to raise flame" : `the knack of its ${best}`);
      return;
    }

    // 3. Which things are good to eat.
    for (const [id, k] of Object.entries(agent.knowledge).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const type = world.materials.get(Number(id));
      if (!type || !knownSafeFood(k, harmPerUnit(type))) continue;
      const theirs = learner.knowledge[id];
      if (theirs?.tasted) continue;
      tellAbout(learner, Number(id), k, world.tick);
      lessonLearned(world, agent, learner, "which things are good to eat");
      return;
    }
  }
}

/** The lesson lands: knowledge, warmth, and - once in the world - history. */
function lessonLearned(world: World, teacher: Agent, learner: Agent, what: string): void {
  const toTeacher = learner.bondWith(teacher.id);
  if (learner.bonds[teacher.id]) {
    toTeacher.trust = Math.min(1, toTeacher.trust + 0.03);
    toTeacher.affection = Math.min(1, toTeacher.affection + 0.02);
  } else {
    learner.bonds[teacher.id] = { trust: 0.03, affection: 0.02, lastNear: world.tick };
  }
  const back = teacher.bonds[learner.id];
  if (back) back.affection = Math.min(1, back.affection + 0.015);
  feel(learner, "wonder", 0.25);
  feel(learner, "contentment", 0.1);
  feel(teacher, "contentment", 0.15);
  if (world.isFirst("lesson")) {
    world.chronicle.add(world.tick, "teaching", `The first lesson: ${teacher.label} showed ${learner.label} ${what}.`, {
      teacher: teacher.id,
      learner: learner.id,
    });
  }
}

/** Words for what an AI is good at, strongest first (empty while unpracticed). */
export function skillWords(agent: Agent): string[] {
  return SKILL_KINDS.map((k) => ({ k, v: agent.skills[k] }))
    .filter(({ v }) => v >= 0.15)
    .sort((a, b) => b.v - a.v)
    .map(({ k, v }) => `${k} ${Math.round(v * 100)}%`);
}
