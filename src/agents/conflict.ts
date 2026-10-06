// Conflict: scarcity given teeth. No weapons and no killing - this is the
// friction of hungry winters between people who know each other. A starving
// AI with nothing in sight may pull food from the hands of someone it holds
// no warmth for. Being wronged leaves a GRUDGE: the bond's dark mirror, quick
// to form and slow to heal, that blocks warmth from growing, keeps rivals out
// of each other's beds, and - when resentment meets anger up close - flares
// into quarrels of harsh sounds. Witnesses remember who took. The one way
// back is the oldest one: food put into the wronged one's hands unmakes most
// of a grudge. Peace is a gift.

import type { Agent } from "./agent.ts";
import { followPath, type ActionDef, type AgentContext } from "./movement.ts";
import { feel } from "./emotions.ts";
import { addCarried, carriedFood, roomFor, goTo } from "./foraging.ts";
import { sightRadius } from "./senses.ts";

/** How much of a grudge one taking leaves. */
export const THEFT_GRUDGE = 0.5;
/** Grudges above this block warmth, shared beds and conversation. */
export const GRUDGE_COLD = 0.3;
/** Grudges fade this much per day: quick to form, slow to heal (a season and more). */
export const GRUDGE_FADE_PER_DAY = 0.008;
/** A gift unmakes most of a grudge: peace is bought with food. */
export const GIFT_FORGIVENESS = 0.3;
/** Hunger above which taking becomes thinkable at all. */
export const TAKE_HUNGER = 0.3;
/** How far desperation looks for someone else's full hands. */
export const TAKE_RADIUS = 8;
/** Taking is for when your own nearest meal is at least this long a march away. */
export const TAKE_FAR = 20;
/** Units pulled from another's hands in one taking. */
export const TAKE_UNITS = 2;

/** The grudge one holds against another (0 when none). */
export function grudgeAgainst(agent: Agent, otherId: number): number {
  return agent.grudges[otherId] ?? 0;
}

/** Whether resentment runs between two, either way, hard enough to go cold. */
export function coldBetween(a: Agent, b: Agent): boolean {
  return grudgeAgainst(a, b.id) >= GRUDGE_COLD || grudgeAgainst(b, a.id) >= GRUDGE_COLD;
}

/** Too close to steal from: family, a mate, or real warmth. */
function tooDear(taker: Agent, other: Agent): boolean {
  if (taker.mate === other.id) return true;
  if (other.parents?.includes(taker.id) || taker.parents?.includes(other.id)) return true;
  return taker.bondWith(other.id).affection >= 0.6;
}

/** A wrong done: the victim's trust collapses, a grudge forms, anger rises, witnesses remember. */
export function wrong(victim: Agent, offender: Agent, ctx: AgentContext): void {
  const world = ctx.world;
  const bond = victim.bonds[offender.id];
  if (bond) {
    bond.trust = Math.max(0, bond.trust - 0.3);
    bond.affection = Math.max(0, bond.affection - 0.15);
  }
  victim.grudges[offender.id] = Math.min(1, grudgeAgainst(victim, offender.id) + THEFT_GRUDGE);
  feel(victim, "anger", 0.5);
  feel(victim, "fear", 0.1);
  feel(offender, "fear", 0.15); // the moment is tense for the taker too
  // Whoever saw it remembers who took.
  const radius = sightRadius(world.calendar.light);
  for (const { agent: witness } of ctx.index.near(victim.x, victim.y, radius, victim)) {
    if (witness === offender || witness.asleep) continue;
    const toward = witness.bonds[offender.id];
    if (toward) toward.trust = Math.max(0, toward.trust - 0.05);
    // Family rises for its own.
    if (witness.mate === victim.id || victim.parents?.includes(witness.id) || witness.parents?.includes(victim.id)) {
      witness.grudges[offender.id] = Math.min(1, grudgeAgainst(witness, offender.id) + 0.15);
      feel(witness, "anger", 0.2);
    }
  }
}

/** The nearest other within reach whose hands are visibly full, and not dear. */
export function takeTarget(agent: Agent, ctx: AgentContext): Agent | null {
  const world = ctx.world;
  let best: Agent | null = null;
  let bestD = Infinity;
  for (const { agent: other, dist } of ctx.index.near(agent.x, agent.y, TAKE_RADIUS, agent)) {
    if (tooDear(agent, other)) continue;
    const food = carriedFood(other, world);
    if (!food) continue;
    if (dist < bestD) {
      bestD = dist;
      best = other;
    }
  }
  return best;
}

/** Take: hunger past shame, pull food from another's hands. Never from the dear. */
export const TAKE: ActionDef = {
  type: "take",
  start(agent, ctx) {
    const target = takeTarget(agent, ctx);
    if (!target) return false;
    const a = agent.action!;
    a.targetId = target.id;
    a.untilTick = ctx.world.tick + 3600; // give up within the hour
    return goTo(agent, ctx, { x: target.tileX, y: target.tileY });
  },
  step(agent, ctx) {
    const world = ctx.world;
    const a = agent.action!;
    if (world.tick >= (a.untilTick ?? 0)) return true;
    const target = ctx.population.get(a.targetId!);
    if (!target) return true;
    const dist = Math.hypot(target.x - agent.x, target.y - agent.y);
    if (dist > 1.5) {
      // Keep after them; they move.
      if (!agent.hasPath() || Math.hypot((a.targetX ?? target.tileX) - target.tileX, (a.targetY ?? target.tileY) - target.tileY) > 2) {
        if (!goTo(agent, ctx, { x: target.tileX, y: target.tileY })) return true;
      }
      followPath(agent, ctx); // a step closer; the hour's deadline still runs
      return false;
    }
    // Within reach: pull what can be pulled.
    const food = carriedFood(target, world);
    if (!food) return true;
    const type = world.materials.require(food.material);
    const units = Math.min(TAKE_UNITS, food.units, Math.max(0, roomFor(agent, world, type)));
    if (units <= 0) return true;
    food.units -= units;
    if (food.units <= 0) target.carrying = target.carrying.filter((c) => c !== food);
    addCarried(agent, type.id, units);
    agent.stats.taken++;
    wrong(target, agent, ctx);
    if (world.isFirst("theft")) {
      world.chronicle.add(
        world.tick,
        "conflict",
        `The first taking: ${agent.label}, hollow with hunger, pulled food from ${target.label}'s hands and would not give it back.`,
        { taker: agent.id, victim: target.id, material: type.id, units },
      );
    }
    return true;
  },
};

/**
 * The hourly flare: anger beside resentment, up close, turns into harsh
 * sounds. Both come away angrier and sadder, trust chips, grudges deepen a
 * little - and the chronicle keeps the world's first quarrel.
 */
export function quarrels(ctx: AgentContext): void {
  const world = ctx.world;
  for (const agent of ctx.population.list()) {
    if (agent.asleep || agent.emotions.anger < 0.3) continue;
    for (const { agent: other } of ctx.index.near(agent.x, agent.y, 2, agent)) {
      if (other.asleep || other.id < agent.id) continue; // each pair once
      if (grudgeAgainst(agent, other.id) < 0.2 && grudgeAgainst(other, agent.id) < 0.2) continue;
      if (!world.rng.chance(0.25)) continue;
      for (const [x, y] of [[agent, other], [other, agent]] as [Agent, Agent][]) {
        feel(x, "anger", 0.2);
        feel(x, "sadness", 0.1);
        const bond = x.bonds[y.id];
        if (bond) {
          bond.trust = Math.max(0, bond.trust - 0.05);
          bond.affection = Math.max(0, bond.affection - 0.05);
        }
        x.grudges[y.id] = Math.min(1, grudgeAgainst(x, y.id) + 0.08);
      }
      if (world.isFirst("quarrel")) {
        world.chronicle.add(
          world.tick,
          "conflict",
          `${agent.label} and ${other.label} turned on each other with harsh sounds and parted: the first quarrel.`,
          { a: agent.id, b: other.id },
        );
      }
      break; // one quarrel per hour is enough for anyone
    }
  }
}

/** The slow healing: grudges fade a little each day, and the dead are let go. */
export function dailyGrudges(ctx: AgentContext): void {
  for (const agent of ctx.population.list()) {
    for (const [id, grudge] of Object.entries(agent.grudges)) {
      const faded = grudge - GRUDGE_FADE_PER_DAY;
      if (faded <= 0 || !ctx.population.get(Number(id))) delete agent.grudges[id];
      else agent.grudges[id] = faded;
    }
  }
}

/** Food into the wronged one's hands unmakes most of a grudge: peace is a gift. */
export function giftForgives(receiver: Agent, giverId: number): void {
  const held = grudgeAgainst(receiver, giverId);
  if (held <= 0) return;
  const left = held * GIFT_FORGIVENESS;
  if (left < 0.02) delete receiver.grudges[giverId];
  else receiver.grudges[giverId] = left;
}

/** Who this AI resents, hardest first (for the creator's eye). */
export function resentments(agent: Agent): { id: number; grudge: number }[] {
  return Object.entries(agent.grudges)
    .map(([id, grudge]) => ({ id: Number(id), grudge }))
    .filter((e) => e.grudge >= 0.1)
    .sort((a, b) => b.grudge - a.grudge);
}
