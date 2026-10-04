// Feelings: fast-moving states stirred by what happens, fading over hours,
// tilting what an AI chooses to do next. Nothing is scripted onto anyone -
// each feeling comes from something that happened to this one body, in this
// one life. Grief lingers for days; wonder passes in an afternoon. Feeling
// also spreads a little: fear, joy and sorrow pass between people who spend
// an hour close together.

import { WORLD_SECONDS_PER_TICK } from "../core/constants.ts";
import type { World } from "../core/world.ts";
import type { Agent } from "./agent.ts";

export type EmotionKind = "joy" | "fear" | "anger" | "sadness" | "contentment" | "loneliness" | "wonder";

export const EMOTION_KINDS: EmotionKind[] = ["joy", "fear", "anger", "sadness", "contentment", "loneliness", "wonder"];

export type Emotions = Record<EmotionKind, number>;

/** How much of each feeling remains after one quiet hour. */
export const KEEP_PER_HOUR: Record<EmotionKind, number> = {
  joy: 0.8,
  fear: 0.85,
  anger: 0.8,
  sadness: 0.97, // grief is the one that stays: days, not hours
  contentment: 0.88,
  loneliness: 0.92,
  wonder: 0.7,
};

/** Shared sorrow softens: sadness fades this much faster in company. */
export const COMFORT_FACTOR = 1.6;

/** Loneliness grows this much per hour alone (more when the need for others runs empty). */
export const LONELY_PER_HOUR = 0.02;
/** And dissolves this much per hour in company. */
export const LONELY_RELIEF_PER_HOUR = 0.5;

/** Fear this fresh (a recent burn) makes an AI keep clear of flames before they hurt. */
export const SPOOKED_FEAR = 0.7;

/** How far a stronger feeling pulls a calmer heart toward it, per shared hour. */
export const CONTAGION = 0.1;
/** The feelings that pass between people. */
export const CONTAGIOUS: EmotionKind[] = ["fear", "joy", "sadness"];

const HOURS_PER_TICK = WORLD_SECONDS_PER_TICK / 3600;

/** Per-tick decay factors, precomputed from the hourly ones. */
const KEEP_PER_TICK: Record<EmotionKind, number> = Object.fromEntries(
  EMOTION_KINDS.map((k) => [k, Math.pow(KEEP_PER_HOUR[k], HOURS_PER_TICK)]),
) as Record<EmotionKind, number>;
const SADNESS_COMFORT_PER_TICK = Math.pow(KEEP_PER_HOUR.sadness, HOURS_PER_TICK * COMFORT_FACTOR);

export function blankEmotions(): Emotions {
  return { joy: 0, fear: 0, anger: 0, sadness: 0, contentment: 0, loneliness: 0, wonder: 0 };
}

/** Something happened: the feeling rises (and never past full). */
export function feel(agent: Agent, kind: EmotionKind, amount: number): void {
  const e = agent.emotions;
  e[kind] = Math.min(1, e[kind] + amount);
}

/**
 * One tick of feeling: everything fades a little, sorrow fades faster in
 * company, and being long alone becomes its own feeling.
 */
export function tickEmotions(agent: Agent, hasCompany: boolean, warmth: number, cold: boolean): void {
  const e = agent.emotions;
  const h = HOURS_PER_TICK;
  for (const kind of EMOTION_KINDS) {
    if (kind === "loneliness") continue;
    const keep = kind === "sadness" && hasCompany ? SADNESS_COMFORT_PER_TICK : KEEP_PER_TICK[kind];
    if (e[kind] !== 0) {
      e[kind] *= keep;
      if (e[kind] < 1e-6) e[kind] = 0; // tiny enough never to swallow a slow, real gain
    }
  }
  if (hasCompany) {
    if (e.loneliness !== 0) e.loneliness = Math.max(0, e.loneliness - LONELY_RELIEF_PER_HOUR * h);
  } else if (!agent.asleep) {
    e.loneliness = Math.min(1, e.loneliness + LONELY_PER_HOUR * (1.5 - agent.needs.social) * h);
  }
  // The small good of a fire on a cold night: warmth felt becomes contentment.
  if (cold && warmth > 0.3 && !agent.asleep) feel(agent, "contentment", 0.1 * warmth * h);
}

/** An hour spent close together: strong feelings pass between the two, upward only. */
export function shareFeelings(a: Agent, b: Agent): void {
  for (const kind of CONTAGIOUS) {
    const av = a.emotions[kind];
    const bv = b.emotions[kind];
    if (bv > av) a.emotions[kind] = Math.min(1, av + (bv - av) * CONTAGION);
    else if (av > bv) b.emotions[kind] = Math.min(1, bv + (av - bv) * CONTAGION);
  }
}

/**
 * A death reaches everyone who loved the one who died: a mate hardest, then
 * family, then friends in proportion to the warmth that was there. Loss also
 * unsettles - a little fear travels with it.
 */
export function grieveFor(world: World, dead: Agent): void {
  for (const other of world.population.all()) {
    if (other.id === dead.id) continue;
    const bond = other.bondWith(dead.id);
    let loss: number;
    if (other.mate === dead.id) loss = Math.max(0.9, bond.affection);
    else if (other.parents?.includes(dead.id) || dead.parents?.includes(other.id)) loss = Math.max(0.7, bond.affection);
    else loss = bond.affection * 0.7;
    if (loss < 0.15) continue;
    feel(other, "sadness", loss);
    feel(other, "fear", loss * 0.2);
    if (loss >= 0.5 && world.isFirst("grief")) {
      world.chronicle.add(world.tick, "bond", `${other.label} stayed a long time where ${dead.label} fell: the first grief.`, {
        agentId: other.id,
        lost: dead.id,
      });
    }
  }
}

/** Words for how an AI feels right now, strongest first (empty when even-keeled). */
export function feelingWords(agent: Agent): string[] {
  const e = agent.emotions;
  const words: [number, string][] = [];
  if (e.sadness >= 0.5) words.push([e.sadness, "grieving"]);
  else if (e.sadness >= 0.25) words.push([e.sadness, "sad"]);
  if (e.fear >= 0.25) words.push([e.fear, e.fear >= 0.6 ? "afraid" : "uneasy"]);
  if (e.joy >= 0.25) words.push([e.joy, "joyful"]);
  if (e.anger >= 0.25) words.push([e.anger, "angry"]);
  if (e.contentment >= 0.3) words.push([e.contentment, "content"]);
  if (e.loneliness >= 0.3) words.push([e.loneliness, "lonely"]);
  if (e.wonder >= 0.3) words.push([e.wonder, "full of wonder"]);
  return words.sort((a, b) => b[0] - a[0]).map(([, w]) => w);
}
