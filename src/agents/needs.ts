// The body: how needs drain and recover, how health is lost and regained,
// and when an agent dies. Called once per tick for every living agent.
//
// All rates are "per world hour" and converted per tick.

import { TICKS_PER_DAY, WORLD_SECONDS_PER_TICK } from "../core/constants.ts";
import type { World } from "../core/world.ts";
import type { Agent, DeathCause } from "./agent.ts";

const HOURS_PER_TICK = WORLD_SECONDS_PER_TICK / 3600;

export const RATES = {
  /** Energy runs from full to empty in about 3 days of normal activity. */
  energyDrain: 1 / 72,
  /** Sleeping burns less. */
  energyDrainAsleepFactor: 0.6,
  /** The cold season makes bodies burn more. */
  energyDrainColdFactor: 1.3,

  /** Awake for about 20 hours empties rest. */
  restDrain: 1 / 20,
  /** A full night's sleep (about 7 hours) restores it. */
  restRecover: 1 / 7,

  /** Alone for about 2 days empties social. A mild need: it never harms health. */
  socialDrain: 1 / 48,
  /** Company restores it within a few hours. */
  socialRecover: 1 / 5,
  /** Others within this many tiles count as company. */
  companyRadius: 4,

  /** Curiosity grows restless over about 12 hours without anything new. */
  curiosityDrain: 1 / 12,
  /** Each newly seen block of the world satisfies some of it. */
  curiosityPerNewBlock: 0.05,

  /** With no energy left, health fails over about 2 days. */
  starvationDamage: 1 / 48,
  /** With no rest left, health fails over about 3 days (and the agent collapses asleep). */
  exhaustionDamage: 1 / 72,
  /** A cold-season night in the open costs health; shelter will prevent it. */
  exposureDamage: 1 / 40,
  /** Light below this counts as night for exposure. */
  exposureLightThreshold: 0.3,
  /** Sleeping close to others cuts exposure harm to this fraction. */
  huddleFactor: 0.5,

  /** Health recovers over about 2 days when fed and rested. */
  healthRecover: 1 / 48,
  /** Minimum energy and rest for health to recover. */
  recoverThreshold: 0.3,

  /** Damage log entries fade over about 2 days, so the cause of death reflects recent harm. */
  damageLogDecay: 1 / 48,
} as const;

/** Old age: from this fraction of lifespan, the body's ceiling on health begins to fall. */
export const OLD_AGE_START = 0.8;
/** At the end of its natural lifespan the ceiling reaches zero. */
export const OLD_AGE_END = 1.0;

/** The most health an agent of this age can have. */
export function healthCeiling(lifeFraction: number): number {
  if (lifeFraction <= OLD_AGE_START) return 1;
  return Math.max(0, 1 - (lifeFraction - OLD_AGE_START) / (OLD_AGE_END - OLD_AGE_START));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface BodyContext {
  /** Whether at least one other agent is within company range. */
  hasCompany: boolean;
  /** Whether the agent is under shelter (always false until building exists). */
  sheltered: boolean;
}

/**
 * Advances one agent's body by one tick.
 * Returns the cause of death if the agent died this tick, otherwise null.
 */
export function updateBody(agent: Agent, world: World, ctx: BodyContext): DeathCause | null {
  const h = HOURS_PER_TICK;
  const cal = world.calendar;
  const needs = agent.needs;
  const cold = cal.season === "cold";

  // Energy
  let drain = RATES.energyDrain;
  if (agent.asleep) drain *= RATES.energyDrainAsleepFactor;
  if (cold) drain *= RATES.energyDrainColdFactor;
  needs.energy = clamp01(needs.energy - drain * h);

  // Rest
  if (agent.asleep) {
    needs.rest = clamp01(needs.rest + RATES.restRecover * (ctx.sheltered ? 1.5 : 1) * h);
  } else {
    needs.rest = clamp01(needs.rest - RATES.restDrain * h);
  }

  // Social (mild)
  if (ctx.hasCompany) needs.social = clamp01(needs.social + RATES.socialRecover * h);
  else needs.social = clamp01(needs.social - RATES.socialDrain * h);

  // Curiosity grows restless over time; discovery restores it (see learnAround).
  needs.curiosity = clamp01(needs.curiosity - RATES.curiosityDrain * (agent.asleep ? 0.2 : 1) * h);

  // Health
  const damage = agent.damage;
  for (const cause of Object.keys(damage) as DeathCause[]) {
    damage[cause] = Math.max(0, damage[cause] - RATES.damageLogDecay * h);
  }
  const hurt = (cause: DeathCause, amount: number) => {
    agent.health -= amount;
    damage[cause] += amount;
  };
  if (needs.energy <= 0) hurt("starvation", RATES.starvationDamage * h);
  if (needs.rest <= 0) hurt("exhaustion", RATES.exhaustionDamage * h);
  // Cold-season nights in the open: huddling with others halves the harm; shelter prevents it.
  const exposed = cold && cal.light < RATES.exposureLightThreshold && !ctx.sheltered;
  if (exposed) hurt("exposure", RATES.exposureDamage * (ctx.hasCompany ? RATES.huddleFactor : 1) * h);

  // A freezing body can't heal.
  const canRecover = !exposed && needs.energy > RATES.recoverThreshold && needs.rest > RATES.recoverThreshold;
  if (canRecover) agent.health += RATES.healthRecover * h;

  // Old age lowers the ceiling health can recover to, and eventually takes it.
  const ceiling = healthCeiling(agent.lifeFraction(world.tick));
  if (agent.health > ceiling) {
    const lost = agent.health - ceiling;
    if (ceiling < 1) damage["old age"] += lost;
    agent.health = ceiling;
  }
  agent.health = Math.min(1, agent.health);

  if (agent.asleep) agent.stats.daysAsleep += 1 / TICKS_PER_DAY;

  if (agent.health <= 0) {
    agent.health = 0;
    return ceiling <= 0 ? "old age" : causeOfDeath(agent);
  }
  return null;
}

/** The cause that did the most recent harm. */
export function causeOfDeath(agent: Agent): DeathCause {
  let worst: DeathCause = "old age";
  let most = -1;
  for (const [cause, amount] of Object.entries(agent.damage) as [DeathCause, number][]) {
    if (amount > most) {
      most = amount;
      worst = cause;
    }
  }
  return worst;
}

/** Collapse: an exhausted agent falls asleep wherever it is. */
export function mustCollapse(agent: Agent): boolean {
  return !agent.asleep && agent.needs.rest <= 0;
}
