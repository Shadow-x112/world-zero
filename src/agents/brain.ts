// Choosing what to do: every option gets a score from the agent's needs and
// surroundings, and the highest wins. Personality and emotions will tilt these
// scores in later steps; for now every agent weighs things the same way, apart
// from tiny fixed quirks and a little chance.

import type { ActionType, Agent } from "./agent.ts";
import { ACTIONS, type AgentContext } from "./actions.ts";
import { GATHER_TARGET, carriedFoodUnits, hasFoodOption, survey } from "./foraging.ts";
import { mustCollapse } from "./needs.ts";
import { sightRadius } from "./senses.ts";

/** How often an awake agent reconsiders, in ticks (world seconds). */
export const DECISION_INTERVAL = 60;
/** Bonus for carrying on with the current action, so agents don't flip back and forth. */
export const INERTIA = 0.08;
/** Random variation added to each score at each decision. */
export const NOISE = 0.04;

const ORDER: ActionType[] = ["sleep", "eat", "seekFood", "taste", "inspect", "gather", "explore", "socialize", "idle"];

export type Scores = Record<ActionType, number>;

/** How much the agent wants each action right now, before noise and inertia. */
export function scoreActions(agent: Agent, ctx: AgentContext): Scores {
  const n = agent.needs;
  const light = ctx.world.calendar.light;
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
  const restless = 1 - n.curiosity;
  let taste = 0;
  if (seen.untasted) taste = (canEat ? 0 : hunger * 1.3) + restless * 0.35;
  const inspect = seen.unhandled ? restless * 0.7 : 0;

  // Not hungry and food in sight: gather some to carry, more so as the warm seasons end.
  let gather = 0;
  if (seen.food && n.energy > 0.55 && carriedFoodUnits(agent, world) < GATHER_TARGET) {
    const season = world.calendar.season;
    gather = 0.1 + (season === "decline" || season === "cold" ? 0.15 : 0);
  }

  const explore = restless * 0.65 * (light < 0.3 ? 0.25 : 1);

  const knowsSomeone =
    agent.lastSeenOther !== null || ctx.index.any(agent.x, agent.y, sightRadius(light), agent);
  const socialize = knowsSomeone ? Math.pow(1 - n.social, 1.2) * 0.75 : 0;

  return { sleep, eat, seekFood, taste, inspect, gather, explore, socialize, idle: 0.08 };
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
    if (startAction(agent, ctx, type)) return;
  }
  startAction(agent, ctx, "idle");
}

/** One tick of behavior for an agent. */
export function act(agent: Agent, ctx: AgentContext): void {
  const tick = ctx.world.tick;
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
