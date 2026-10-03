// Choosing what to do: every option gets a score from the agent's needs and
// surroundings, and the highest wins. Personality and emotions will tilt these
// scores in later steps; for now every agent weighs things the same way, apart
// from tiny fixed quirks and a little chance.

import type { ActionType, Agent } from "./agent.ts";
import { ACTIONS, type AgentContext } from "./actions.ts";
import { GATHER_TARGET, carriedFoodUnits, hasCureOption, hasFoodOption, isFoodTo, survey } from "./foraging.ts";
import { SICK_TOXIN, mustCollapse } from "./needs.ts";
import { buildUrge } from "./building.ts";
import { bestAttempt } from "./tinker.ts";
import { burnable, fireDanger, fuelOf, igniteAt, fireAt, personalLight, warmthAt } from "../world/fire.ts";
import { sightRadius } from "./senses.ts";

/** How often an awake agent reconsiders, in ticks (world seconds). */
export const DECISION_INTERVAL = 60;
/** Bonus for carrying on with the current action, so agents don't flip back and forth. */
export const INERTIA = 0.08;
/** Random variation added to each score at each decision. */
export const NOISE = 0.04;
/** How strongly a full urge to build competes with other needs. */
export const BUILD_WEIGHT = 0.6;


const ORDER: ActionType[] = ["treat", "sleep", "eat", "seekFood", "taste", "inspect", "gather", "tinker", "build", "explore", "socialize", "idle"];

export type Scores = Record<ActionType, number>;

/** How much the agent wants each action right now, before noise and inertia. */
export function scoreActions(agent: Agent, ctx: AgentContext): Scores {
  const n = agent.needs;
  const light = personalLight(ctx.world, agent.tileX, agent.tileY);
  const dark = 1 - light;

  // Daytime naps only when genuinely tired; darkness pulls strongly toward sleep.
  const tired = 1 - n.rest;
  let sleep = Math.pow(tired, 3) * 1.6 + dark * (n.rest < 0.85 ? 0.55 : 0.1);
  if (n.rest <= 0.05) sleep = 2;

  const world = ctx.world;
  const seen = survey(agent, ctx);
  const canEat = hasFoodOption(agent, ctx);
  const hunger = 1 - n.energy;
  const starving = n.energy < 0.2 ? 0.5 : 0;

  // Hungry with food known: eat. Hungry with none known: search, or try something new.
  const eat = canEat ? Math.pow(hunger, 1.2) * 1.6 + starving : 0;
  const seekFood = canEat ? 0 : Math.pow(hunger, 1.5) * 1.3 + starving;
  // Poison-sick: treat it with what is known to work, or - desperate - put
  // strange and even known-bitter things in the mouth. That is how cures are found.
  const sickness = Math.min(1, agent.toxin / (SICK_TOXIN * 3));
  const treat = agent.toxin >= SICK_TOXIN && hasCureOption(agent, ctx) ? 0.8 + sickness : 0;

  const restless = 1 - n.curiosity;
  let taste = 0;
  if (seen.untasted) taste = (canEat ? 0 : hunger * 1.3) + restless * 0.35;
  if (treat === 0 && agent.toxin >= SICK_TOXIN && (seen.untasted || seen.bitter)) taste += sickness * 0.9;
  const inspect = seen.unhandled ? restless * 0.7 : 0;

  // Not hungry and food in sight: gather some to carry, more so as the warm seasons end.
  let gather = 0;
  if (seen.food && n.energy > 0.55 && carriedFoodUnits(agent, world) < GATHER_TARGET) {
    const season = world.calendar.season;
    gather = 0.1 + (season === "decline" || season === "cold" ? 0.15 : 0);
  }

  // Restlessness with something in hand turns inward: trying things against
  // each other. A promising untried combination beats wandering; without one,
  // tinkering is only an occasional whim (which can mean fetching parts).
  let tinker = 0;
  if (light >= 0.35 && n.energy > 0.3) {
    const promising = agent.carrying.length + agent.items.length > 0 ? bestAttempt(agent, ctx) : null;
    tinker = restless * (promising ? 0.45 + 0.4 * promising.interest : 0.3);
    // A mind full of the cold has no room for play: survival outranks hobbies.
    const urge = buildUrge(agent, world);
    tinker *= 1 - 0.6 * urge;
    // But a FIRE is not a hobby. Cold in the bones, the makings in hand, and no
    // warmth near where it sleeps: striking a flame is the survival move itself.
    if (urge > 0.05) {
      // bestAttempt already favors a flame when the cold calls for one.
      const canSpark = promising?.attempt.verb === "heat";
      if (canSpark) {
        const warmAlready =
          warmthAt(world, agent.tileX, agent.tileY) > 0.3 ||
          (agent.nest !== null && warmthAt(world, agent.nest.x, agent.nest.y) > 0.3);
        if (!warmAlready) {
          const cal = world.calendar;
          const hoursLeft = cal.sunsetHour - (cal.hour + cal.minute / 60);
          tinker = Math.max(tinker, (0.4 + 0.6 * urge) * (hoursLeft > 0 && hoursLeft <= 4 ? 1 : 0.5));
        }
      }
    }
  }

  // Remembered cold draws it to build around its sleeping place, above all late in the day.
  let build = 0;
  const urge = buildUrge(agent, world);
  if (urge > 0.05 && light >= 0.35 && n.energy > 0.35 && n.rest > 0.2) {
    const cal = world.calendar;
    const hoursLeft = cal.sunsetHour - (cal.hour + cal.minute / 60);
    build = urge * BUILD_WEIGHT * (hoursLeft > 0 && hoursLeft <= 4 ? 1 : 0.4);
  }

  const explore = restless * 0.65 * (light < 0.3 ? 0.25 : 1);

  const knowsSomeone =
    agent.lastSeenOther !== null || ctx.index.any(agent.x, agent.y, sightRadius(light), agent);
  const socialize = knowsSomeone ? Math.pow(1 - n.social, 1.2) * 0.75 : 0;

  return { treat, sleep, eat, seekFood, taste, inspect, gather, tinker, build, explore, socialize, idle: 0.08, flee: 0 };
}

/** Updates what the agent remembers about others' whereabouts. */
function noticeOthers(agent: Agent, ctx: AgentContext): void {
  const seen = ctx.index.near(agent.x, agent.y, sightRadius(ctx.world.calendar.light), agent);
  if (seen.length > 0) {
    const nearest = seen[0].agent;
    agent.lastSeenOther = { x: nearest.x, y: nearest.y, tick: ctx.world.tick };
  }
}

function startAction(agent: Agent, ctx: AgentContext, type: ActionType): boolean {
  const previous = agent.action;
  if (previous) ACTIONS[previous.type].end?.(agent, ctx);
  agent.action = { type, startedTick: ctx.world.tick };
  agent.clearPath();
  if (ACTIONS[type].start(agent, ctx)) return true;
  agent.action = null;
  return false;
}

/** Picks and starts the best action, keeping the current one if it still wins. */
export function decide(agent: Agent, ctx: AgentContext): void {
  const rng = ctx.world.rng;
  noticeOthers(agent, ctx);

  if (mustCollapse(agent)) {
    startAction(agent, ctx, "sleep");
    return;
  }

  const scores = scoreActions(agent, ctx);
  const ranked = ORDER.map((type, i) => {
    let score = scores[type] + rng.range(-NOISE, NOISE) + agent.quirk[(i + 1) % agent.quirk.length] * 0.02;
    if (agent.action?.type === type) score += INERTIA;
    return { type, score };
  }).sort((a, b) => b.score - a.score);

  const current = agent.action?.type;
  for (const { type } of ranked) {
    if (type === current) return; // keep doing what it was doing
    if (type === "build" && scores.build <= 0) continue; // only an urge to build leads to building
    if (type === "tinker" && scores.tinker <= 0) continue;
    if (type === "flee") continue; // only the fire reflex starts a flight
    if (startAction(agent, ctx, type)) return;
  }
  startAction(agent, ctx, "idle");
}

/** Reflex: anyone in or beside flames drops everything and runs, even out of sleep. */
function fireReflex(agent: Agent, ctx: AgentContext): boolean {
  const world = ctx.world;
  if (world.fireTiles.size === 0) return false;
  if (agent.action?.type === "flee") return true;
  if (fireDanger(world, agent.tileX, agent.tileY) === null) return false;
  agent.asleep = false;
  startAction(agent, ctx, "flee");
  return agent.action?.type === "flee";
}

/** Habit: a fire burning low within reach gets a stick thrown on, more generously toward night. */
function tendNearbyFire(agent: Agent, ctx: AgentContext): void {
  const world = ctx.world;
  if (world.fireTiles.size === 0 || world.tick % 30 !== 0) return;
  const keepStocked = world.calendar.light < 0.5 ? 120 : 30; // tenths of an hour
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (const f of world.fireTiles.values()) {
    const d = Math.max(Math.abs(f.x - agent.tileX), Math.abs(f.y - agent.tileY));
    if (d > 2) continue;
    const fuel = fireAt(world, f.x, f.y);
    if (fuel === 0 || fuel >= keepStocked) continue;
    if (d < bestD || (d === bestD && best && (f.x < best.x || (f.x === best.x && f.y < best.y)))) {
      bestD = d;
      best = f;
    }
  }
  {
    const f = best;
    if (!f) return;
    for (const c of agent.carrying) {
      const type = world.materials.get(c.material);
      if (!type || !burnable(type) || isFoodTo(agent, type, world.calendar.season)) continue;
      c.units--;
      if (c.units <= 0) agent.carrying = agent.carrying.filter((x) => x !== c);
      igniteAt(world, f.x, f.y, fuelOf(type, 1));
      return;
    }
  }
}

/** One tick of behavior for an agent. */
export function act(agent: Agent, ctx: AgentContext): void {
  const tick = ctx.world.tick;
  if (fireReflex(agent, ctx)) {
    if (ACTIONS.flee.step(agent, ctx)) {
      agent.action = null;
      agent.clearPath();
      decide(agent, ctx);
      agent.nextDecisionTick = tick + DECISION_INTERVAL;
    }
    return;
  }
  if (!agent.asleep) tendNearbyFire(agent, ctx);
  if (agent.asleep) {
    // Sleepers don't reconsider; they wake when sleep says so.
    if (ACTIONS.sleep.step(agent, ctx)) {
      ACTIONS.sleep.end!(agent, ctx);
      agent.action = null;
      decide(agent, ctx);
      agent.nextDecisionTick = tick + DECISION_INTERVAL;
    }
    return;
  }

  // Someone walking to company for the night stays committed to sleeping.
  const goingToBed = agent.action?.type === "sleep";
  if (!agent.action || mustCollapse(agent) || (!goingToBed && tick >= agent.nextDecisionTick)) {
    decide(agent, ctx);
    agent.nextDecisionTick = tick + DECISION_INTERVAL + ctx.world.rng.int(-10, 10);
  }
  const action = agent.action;
  if (!action) return;
  if (ACTIONS[action.type].step(agent, ctx)) {
    ACTIONS[action.type].end?.(agent, ctx);
    agent.action = null;
    agent.clearPath();
    // Decide again right away rather than standing still until the next check.
    decide(agent, ctx);
    agent.nextDecisionTick = tick + DECISION_INTERVAL + ctx.world.rng.int(-10, 10);
  }
}
