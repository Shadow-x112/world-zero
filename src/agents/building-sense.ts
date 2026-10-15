// What an AI learns about building: which stuff is good for what.
//
// Nothing about materials is built in. Each AI keeps, for every material it
// has put to a use, a sense of how well that went: as a wall, as poles laid
// over its head (a frame), or as something laid over poles (a cover). The
// sense comes from its own life -
//   - the night after building: warmer than the night before, or not;
//   - what it built coming down: breaking under a load, or simply falling
//     because what held it went (and worse if it was beneath);
//   - what it built rotting away, soon or late;
// - and from watching others: a neighbour's place that is plainly snugger
// than its own teaches what that place is made of, and a collapse seen
// teaches anyone who saw it.
//
// What it has learned decides what it fetches and where it puts it. Things it
// has never tried carry a little curiosity; things that keep failing, it stops
// carrying home.

import type { World } from "../core/world.ts";
import { FORM, ROLE, type Piece, type PieceEvents, type Role } from "../building/pieces.ts";
import type { Agent } from "./agent.ts";
import { feel } from "./emotions.ts";

export type Use = "wall" | "frame" | "cover";
export const USES: Use[] = ["wall", "frame", "cover"];

/** One lesson: how well a material has done at a use (-1 to 1), and how many times it was learned. */
export interface Lesson {
  v: number;
  n: number;
}

export interface BuildSense {
  /** "use:material" -> what it has learned. */
  lessons: Record<string, Lesson>;
  /** Pieces placed since it last woke at its nest, by "use:material" (credited against the next night). */
  placed: Record<string, number>;
  /** When it last studied someone else's shelter (-1 = never). */
  studied: number;
}

export function blankBuildSense(): BuildSense {
  return { lessons: {}, placed: {}, studied: -1 };
}

export const lessonKey = (use: Use, material: number) => `${use}:${material}`;

/** What a piece is for: a wall, poles overhead, or what lies on them. */
export function useOf(role: Role, form: number): Use {
  if (role === ROLE.wall) return "wall";
  return form === FORM.pole ? "frame" : "cover";
}

/** Value of something never tried: a little curiosity. */
export const CURIOSITY = 0.15;
/** A night's change in shelter, per piece, is worth this much in a lesson. */
export const NIGHT_WEIGHT = 3;
/** Most a single night can teach about one thing either way. */
const NIGHT_MAX = 0.25;
/** Blame for something of its own that broke under a load; for something that fell because its support went. */
export const BROKE_BLAME = 0.3;
export const FELL_BLAME = 0.1;
/** Struck by it: a lesson felt in the body. */
export const STRUCK_BLAME = 0.35;
/** What a collapse teaches those who only saw it. */
export const SEEN_BLAME = 0.08;
/** How far a collapse can be seen from (tiles). */
const SEEN_RADIUS = 8;
/** Lifetime (days) at which rotting away teaches nothing either way. */
export const ROT_EVEN_DAYS = 20;
/** Minimum time between studies of others' shelters. */
export const STUDY_EVERY = 3600;
/** How much snugger someone else's place must be to be worth studying. */
export const STUDY_MARGIN = 0.15;
/** What one study is worth, per unit of snugness it has over its own. */
export const STUDY_WEIGHT = 0.4;

export function lessonOf(agent: Agent, use: Use, material: number): Lesson | undefined {
  return agent.buildSense.lessons[lessonKey(use, material)];
}

/** How good it believes a material to be at a use (curiosity if never tried). */
export function valueOf(agent: Agent, use: Use, material: number): number {
  const l = lessonOf(agent, use, material);
  return l ? l.v : CURIOSITY;
}

/** Moves a lesson: new things move it a lot, much experience less so. */
export function learn(agent: Agent, use: Use, material: number, delta: number): void {
  const key = lessonKey(use, material);
  const l = (agent.buildSense.lessons[key] ??= { v: 0, n: 0 });
  const step = delta / (1 + 0.05 * l.n);
  l.v = Math.max(-1, Math.min(1, l.v + step));
  l.n = Math.min(9999, l.n + 1);
}

/** Notes a piece placed, to be credited (or blamed) after the next night at its nest. */
export function notePlaced(agent: Agent, use: Use, material: number): void {
  const key = lessonKey(use, material);
  agent.buildSense.placed[key] = (agent.buildSense.placed[key] ?? 0) + 1;
}

/**
 * Waking at its nest: the change in shelter since last time, shared out among
 * the pieces placed since then.
 */
export function learnFromNight(agent: Agent, change: number): void {
  const placed = agent.buildSense.placed;
  const keys = Object.keys(placed).sort();
  const total = keys.reduce((s, k) => s + placed[k], 0);
  if (total > 0) {
    const per = change / total;
    for (const key of keys) {
      const [use, material] = splitKey(key);
      const d = Math.max(-NIGHT_MAX, Math.min(NIGHT_MAX, NIGHT_WEIGHT * per * placed[key]));
      learn(agent, use, material, d);
    }
  }
  agent.buildSense.placed = {};
}

function splitKey(key: string): [Use, number] {
  const i = key.indexOf(":");
  return [key.slice(0, i) as Use, Number(key.slice(i + 1))];
}

/**
 * Pieces came down or rotted away: their builders learn (if they were near
 * enough to know), those beneath learn harder, and anyone who saw learns a little.
 */
export function learnFromPieces(world: World, ev: PieceEvents): void {
  if (ev.fell.length === 0 && ev.rotted.length === 0) return;
  const population = world.population;
  // Each lesson at most once per event, per AI and thing learned: the worst one.
  const lessons = new Map<Agent, Map<string, number>>();
  const add = (a: Agent, use: Use, material: number, d: number) => {
    let m = lessons.get(a);
    if (!m) lessons.set(a, (m = new Map()));
    const k = lessonKey(use, material);
    m.set(k, Math.min(m.get(k) ?? 0, d));
  };
  const broke = new Set(ev.broke.map((p) => p.id));
  for (const { piece, role, drop } of ev.fell) {
    if (role === ROLE.rubble) continue;
    const use = useOf(role, piece.form);
    const blame = broke.has(piece.id) ? BROKE_BLAME : FELL_BLAME;
    const owner = population.get(piece.by);
    if (owner && knows(owner, piece)) add(owner, use, piece.material, -blame);
    for (const a of population.all()) {
      if (a.asleep && a !== owner) continue;
      const d = Math.hypot(a.x - piece.x, a.y - piece.y);
      if (d > SEEN_RADIUS) continue;
      if (drop >= 0.15 && d < 0.8) add(a, use, piece.material, -STRUCK_BLAME);
      else add(a, use, piece.material, -SEEN_BLAME);
    }
  }
  for (const { piece, role } of ev.rotted) {
    const owner = population.get(piece.by);
    if (!owner || !knows(owner, piece)) continue;
    const days = Math.max(0, world.calendar.day - piece.day);
    const d = Math.max(-0.2, Math.min(0.1, (days - ROT_EVEN_DAYS) / 100));
    add(owner, useOf(role, piece.form), piece.material, d);
  }
  for (const [a, m] of [...lessons].sort((x, y) => x[0].id - y[0].id)) {
    for (const [key, d] of [...m].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      const [use, material] = splitKey(key);
      learn(a, use, material, d);
    }
  }
}

/** Whether a builder would know what became of a piece: it was near, or it was at its own nest. */
function knows(a: Agent, p: Piece): boolean {
  if (a.nest && Math.abs(a.nest.x - p.tx) <= 1 && Math.abs(a.nest.y - p.ty) <= 1) return true;
  return Math.hypot(a.x - p.x, a.y - p.y) <= SEEN_RADIUS;
}

/**
 * Seeing someone else's sleeping place that is plainly snugger than its own:
 * it takes in what that place is made of, and leans toward the same.
 */
export function studyShelter(agent: Agent, world: World, x: number, y: number, snug: number): void {
  const sense = agent.buildSense;
  if (agent.asleep || (sense.studied >= 0 && world.tick - sense.studied < STUDY_EVERY)) return;
  const own = agent.feltShelter < 0 ? 0 : agent.feltShelter;
  if (snug - own < STUDY_MARGIN) return;
  if (agent.nest && agent.nest.x === x && agent.nest.y === y) return;
  // Someone sleeps there.
  let theirs = false;
  for (const a of world.population.all()) {
    if (a !== agent && a.nest && a.nest.x === x && a.nest.y === y) {
      theirs = true;
      break;
    }
  }
  if (!theirs) return;
  sense.studied = world.tick;
  const mass = new Map<string, number>();
  const take = (p: Piece) => {
    const k = lessonKey(useOf(p.role, p.form), p.material);
    mass.set(k, (mass.get(k) ?? 0) + p.mass);
  };
  for (const p of world.pieces.at(x, y, ROLE.roof)) take(p);
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    if (ox || oy) for (const p of world.pieces.at(x + ox, y + oy, ROLE.wall)) take(p);
  }
  // The main stuff of each use is what it notices.
  const best = new Map<Use, [string, number]>();
  for (const [k, m] of [...mass].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const [use] = splitKey(k);
    const cur = best.get(use);
    if (!cur || m > cur[1]) best.set(use, [k, m]);
  }
  for (const use of USES) {
    const b = best.get(use);
    if (!b) continue;
    const [, material] = splitKey(b[0]);
    learn(agent, use, material, STUDY_WEIGHT * (snug - own));
  }
  if (best.size > 0) feel(agent, "wonder", 0.05);
}
