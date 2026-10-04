// Bonds, pairs and births. Feelings grow only from lived history: time spent
// close, nights slept side by side, winters shared under one roof, food put
// into your hands. Enough mutual warmth between two grown AIs becomes a pair,
// and a pair that is safe, fed and sheltered can bring a new life into the
// world. Nothing is arranged; everything is earned.

import { TICKS_PER_DAY } from "../core/constants.ts";
import type { World } from "../core/world.ts";
import { shelterAt } from "../building/structures.ts";
import type { Agent, Bond } from "./agent.ts";
import type { AgentContext } from "./movement.ts";
import { RATES } from "./needs.ts";
import { learnAround } from "./senses.ts";
import { feel, shareFeelings } from "./emotions.ts";

/** How much one quiet hour together adds. */
export const HOUR_TOGETHER = 0.002;
/** How much one night asleep side by side adds (more under real shelter). */
export const NIGHT_TOGETHER = 0.032;
export const NIGHT_SHELTER_FACTOR = 1.5;
/** Receiving food adds trust at once. */
export const GIFT_TRUST = 0.02;
/** Feelings fade this much per day once someone stays out of your life. */
export const BOND_FADE_PER_DAY = 0.004;
export const BOND_FADE_AFTER_DAYS = 3;
/** The most people one heart keeps track of. */
export const BOND_LIMIT = 24;

/** What a pair takes: mutual warmth and reliance between two grown AIs. */
export const PAIR_AFFECTION = 0.5;
export const PAIR_TRUST = 0.45;
/** A pair apart this long comes undone. */
export const PAIR_APART_DAYS = 15;

/** What a birth takes. */
export const BIRTH_BONDED_DAYS = 10;
export const BIRTH_SPACING_DAYS = 15;
export const BIRTH_ENERGY = 0.5;
export const BIRTH_HEALTH = 0.7;
export const BIRTH_SHELTER = 0.4;
/** Daily chance once every condition is met. */
export const BIRTH_CHANCE = 0.7;
/** Too near the end of life to begin one. */
export const BIRTH_LAST_FRACTION = 0.85;

function touch(agent: Agent, other: Agent, tick: number): Bond {
  let bond = agent.bonds[other.id];
  if (!bond) {
    bond = { trust: 0, affection: 0, lastNear: tick };
    agent.bonds[other.id] = bond;
    prune(agent);
  }
  bond.lastNear = tick;
  return bond;
}

function warm(bond: Bond, amount: number): void {
  bond.affection = Math.min(1, bond.affection + amount);
  bond.trust = Math.min(1, bond.trust + amount * 0.8);
}

/** Forgets the faintest connections once the heart is full. */
function prune(agent: Agent): void {
  const entries = Object.entries(agent.bonds);
  if (entries.length <= BOND_LIMIT) return;
  const keep = new Set<string>();
  if (agent.mate !== null) keep.add(String(agent.mate));
  if (agent.parents) for (const p of agent.parents) keep.add(String(p));
  entries.sort((a, b) => b[1].trust + b[1].affection - (a[1].trust + a[1].affection));
  for (const [id] of entries.slice(BOND_LIMIT)) {
    if (!keep.has(id)) delete agent.bonds[id];
  }
}

/** A quiet hour in company: everyone awake near each other grows a little closer. */
export function hourTogether(ctx: AgentContext): void {
  const tick = ctx.world.tick;
  for (const agent of ctx.population.all()) {
    if (agent.asleep) continue;
    for (const { agent: other } of ctx.index.near(agent.x, agent.y, RATES.companyRadius, agent)) {
      if (other.id < agent.id || other.asleep) continue; // each pair once
      warm(touch(agent, other, tick), HOUR_TOGETHER);
      warm(touch(other, agent, tick), HOUR_TOGETHER);
      shareFeelings(agent, other); // fear, joy and sorrow pass between people
    }
  }
}

/** Waking after a night: whoever slept beside you is part of your life now. */
export function nightBeside(agent: Agent, ctx: AgentContext): void {
  const world = ctx.world;
  const sheltered = shelterAt(world, agent.tileX, agent.tileY) >= 0.4;
  for (const { agent: other } of ctx.index.near(agent.x, agent.y, 1.6, agent)) {
    const amount = NIGHT_TOGETHER * (sheltered ? NIGHT_SHELTER_FACTOR : 1);
    warm(touch(agent, other, world.tick), amount);
    warm(touch(other, agent, world.tick), amount);
  }
}

/** Food put into your hands: trust, at once. */
export function receivedGift(receiver: Agent, giver: Agent, tick: number): void {
  const bond = touch(receiver, giver, tick);
  bond.trust = Math.min(1, bond.trust + GIFT_TRUST);
  bond.affection = Math.min(1, bond.affection + GIFT_TRUST * 0.5);
  touch(giver, receiver, tick);
  feel(receiver, "joy", 0.15);
  feel(receiver, "contentment", 0.15);
  feel(giver, "contentment", 0.1); // giving feels good too
}

/** The daily quiet work: fading, pairs forming and coming undone, births. */
export function dailyKinship(ctx: AgentContext): void {
  const world = ctx.world;
  const tick = world.tick;
  const population = ctx.population;

  for (const agent of population.list()) {
    // Absence fades feeling (family never fades all the way to strangers).
    for (const [id, bond] of Object.entries(agent.bonds)) {
      const apartDays = (tick - bond.lastNear) / TICKS_PER_DAY;
      if (apartDays > BOND_FADE_AFTER_DAYS) {
        const isFamily = agent.parents?.includes(Number(id)) || population.get(Number(id))?.parents?.includes(agent.id);
        const floor = isFamily ? 0.3 : 0;
        bond.affection = Math.max(floor, bond.affection - BOND_FADE_PER_DAY);
        bond.trust = Math.max(floor, bond.trust - BOND_FADE_PER_DAY);
        if (bond.affection === 0 && bond.trust === 0) delete agent.bonds[id];
      }
    }

    // A mate gone from the world, or gone from your life too long, is no mate.
    if (agent.mate !== null) {
      const mate = population.get(agent.mate);
      if (!mate) {
        agent.mate = null; // the grief itself landed when they died (see emotions.grieveFor)
      } else if ((tick - agent.bondWith(mate.id).lastNear) / TICKS_PER_DAY > PAIR_APART_DAYS) {
        world.chronicle.add(tick, "bond", `${agent.label} and ${mate.label} drifted apart.`, { a: agent.id, b: mate.id });
        agent.mate = null;
        mate.mate = null;
        feel(agent, "sadness", 0.5);
        feel(mate, "sadness", 0.5);
      }
    }
  }

  // New pairs: mutual warmth between two grown, unbonded AIs who are actually
  // in each other's lives right now (not a warmth remembered from far away).
  for (const agent of population.list()) {
    if (agent.mate !== null || !agent.grown(tick)) continue;
    for (const [id, bond] of Object.entries(agent.bonds)) {
      if (bond.affection < PAIR_AFFECTION || bond.trust < PAIR_TRUST) continue;
      if ((tick - bond.lastNear) / TICKS_PER_DAY > 2) continue;
      const other = population.get(Number(id));
      if (!other || other.mate !== null || !other.grown(tick) || other.id === agent.id) continue;
      if (agent.parents?.includes(other.id) || other.parents?.includes(agent.id)) continue; // never within a family
      const back = other.bondWith(agent.id);
      if (back.affection < PAIR_AFFECTION || back.trust < PAIR_TRUST) continue;
      if ((tick - back.lastNear) / TICKS_PER_DAY > 2) continue;
      agent.mate = other.id;
      other.mate = agent.id;
      agent.bondedTick = tick;
      other.bondedTick = tick;
      // A pair makes one home of the better of their two nests (or founds one
      // where the elder last slept), and both nights now point at it.
      const options = [agent.nest, other.nest].filter((n): n is NonNullable<typeof n> => n !== null);
      let home = options[0] ?? null;
      for (const n of options) if (shelterAt(world, n.x, n.y) > shelterAt(world, home!.x, home!.y)) home = n;
      if (!home && agent.lastSleep) home = { x: agent.lastSleep.x, y: agent.lastSleep.y, lastSlept: tick };
      if (!home) home = { x: agent.tileX, y: agent.tileY, lastSlept: tick };
      {
        agent.nest = { x: home.x, y: home.y, lastSlept: tick };
        other.nest = { x: home.x, y: home.y, lastSlept: tick };
        agent.home = { x: home.x, y: home.y };
        other.home = { x: home.x, y: home.y };
      }
      feel(agent, "joy", 0.6);
      feel(other, "joy", 0.6);
      feel(agent, "contentment", 0.3);
      feel(other, "contentment", 0.3);
      const first = world.isFirst("pair") ? "The first pair: " : "";
      world.chronicle.add(tick, "bond", `${first}${agent.label} and ${other.label} began to keep close to each other.`, {
        a: agent.id,
        b: other.id,
      });
      break;
    }
  }

  // Births: a pair that is safe, fed and sheltered, in the growing half of the
  // year - so a child meets its first winter already on its feet.
  if (world.calendar.season === "growth" || world.calendar.season === "peak") {
    for (const agent of population.list()) {
      const mate = agent.mate === null ? undefined : population.get(agent.mate);
      if (!mate || mate.id < agent.id) continue; // each pair once
      const dbg = (globalThis as any).BIRTH_DBG;
      if (dbg) dbg.pairsChecked++;
      if ((tick - agent.bondedTick) / TICKS_PER_DAY < BIRTH_BONDED_DAYS) { if (dbg) dbg.bonded++; continue; }
      const lastBirth = Math.max(agent.lastBirthTick, mate.lastBirthTick);
      if ((tick - lastBirth) / TICKS_PER_DAY < BIRTH_SPACING_DAYS) { if (dbg) dbg.spacing++; continue; }
      if (!wellEnough(agent, tick) || !wellEnough(mate, tick)) { if (dbg) dbg.unwell++; continue; }
      // A properly sheltered nest that both of them actually LIVE at: their
      // last night's sleep was at or beside it.
      const sleptAt = (x: Agent, n: { x: number; y: number }) =>
        x.lastSleep !== null && Math.hypot(x.lastSleep.x - n.x, x.lastSleep.y - n.y) <= 10;
      let nest: { x: number; y: number } | null = null;
      let anySheltered = false;
      for (const n of [agent.nest, mate.nest]) {
        if (!n || shelterAt(world, n.x, n.y) < BIRTH_SHELTER) continue;
        anySheltered = true;
        if (sleptAt(agent, n) && sleptAt(mate, n)) {
          nest = n;
          break;
        }
      }
      // Or simply: wherever they slept last night, side by side, under cover.
      if (!nest && agent.lastSleep && mate.lastSleep) {
        const together = Math.hypot(agent.lastSleep.x - mate.lastSleep.x, agent.lastSleep.y - mate.lastSleep.y) <= 2;
        if (together && shelterAt(world, agent.lastSleep.x, agent.lastSleep.y) >= BIRTH_SHELTER) nest = agent.lastSleep;
      }
      if (!nest) {
        if (dbg) (anySheltered ? dbg.away++ : dbg.noNest++);
        continue;
      }
      if (!world.rng.chance(BIRTH_CHANCE)) { if (dbg) dbg.luck++; continue; }
      // A spot beside the nest for the new one.
      let spot: [number, number] | null = null;
      for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]] as [number, number][]) {
        if (world.grid.isWalkable(nest.x + dx, nest.y + dy)) {
          spot = [nest.x + dx, nest.y + dy];
          break;
        }
      }
      if (!spot) continue;
      const child = population.createChild(world.rng, tick, spot[0], spot[1], agent, mate);
      learnAround(child, world); // it opens its eyes somewhere
      agent.lastBirthTick = tick;
      mate.lastBirthTick = tick;
      feel(agent, "joy", 0.9);
      feel(mate, "joy", 0.9);
      feel(agent, "contentment", 0.4);
      feel(mate, "contentment", 0.4);
      const first = world.isFirst("birth") ? "The first child of the world: " : "A new one: ";
      world.chronicle.add(tick, "birth", `${first}${child.label}, born to ${agent.label} and ${mate.label}. ${population.count} alive.`, {
        child: child.id,
        parents: [agent.id, mate.id],
      });
      milestone(world, population.count);
    }
  }
}

function wellEnough(agent: Agent, tick: number): boolean {
  return (
    agent.needs.energy >= BIRTH_ENERGY &&
    agent.needs.rest >= 0.5 &&
    agent.health >= BIRTH_HEALTH &&
    agent.toxin < 0.03 &&
    agent.lifeFraction(tick) < BIRTH_LAST_FRACTION
  );
}

/** The people growing past round numbers is history worth keeping. */
function milestone(world: World, count: number): void {
  for (const mark of [60, 75, 100, 150, 200, 300, 500, 1000]) {
    if (count === mark && world.isFirst(`pop:${mark}`)) {
      world.chronicle.add(world.tick, "milestone", `The people number ${mark}.`, { count: mark });
    }
  }
}

// --- Feeding your own -----------------------------------------------------------

/** Whether one would put food in the other's hands: family, a mate, or real warmth. */
export function wouldFeed(giver: Agent, receiver: Agent): boolean {
  if (giver.mate === receiver.id) return true;
  if (receiver.parents?.includes(giver.id) || giver.parents?.includes(receiver.id)) return true;
  return giver.bondWith(receiver.id).affection >= 0.6;
}
