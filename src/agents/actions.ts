// What agents can do, and how each action plays out tick by tick.

import type { ActionType, Agent } from "./agent.ts";
import { EAT, GATHER, INSPECT, TASTE } from "./foraging.ts";
import {
  TICKS_PER_MINUTE,
  followPath,
  pickFrontier,
  planRoute,
  type ActionDef,
  type AgentContext,
} from "./movement.ts";
import { RATES } from "./needs.ts";
import { sightRadius } from "./senses.ts";

export * from "./movement.ts";

/** At nightfall, an AI alone will walk this far to sleep near others. */
export const GATHER_FOR_NIGHT_RADIUS = 60;

const sleep: ActionDef = {
  type: "sleep",
  start(agent, ctx) {
    agent.clearPath();
    // Settling down for the night alone? First go to where the others are.
    const world = ctx.world;
    const alone = !ctx.index.any(agent.x, agent.y, RATES.companyRadius, agent);
    const cal = world.calendar;
    const forTheNight = cal.hour + cal.minute / 60 >= cal.sunsetHour - 2 || cal.hour < cal.sunriseHour;
    if (alone && agent.needs.rest > 0.05 && forTheNight) {
      // Join someone already settled for the night (a still point everyone can converge on);
      // otherwise head home, where the others are likely to gather too.
      const others = ctx.index.near(agent.x, agent.y, GATHER_FOR_NIGHT_RADIUS, agent);
      const near = others.find((o) => o.agent.asleep);
      const fromHome = Math.hypot(agent.home.x - agent.x, agent.home.y - agent.y);
      const target = near ? { x: near.agent.tileX, y: near.agent.tileY } : fromHome > 12 ? agent.home : null;
      if (target) {
        const action = agent.action!;
        action.targetX = target.x;
        action.targetY = target.y;
        action.untilTick = world.tick + 90 * TICKS_PER_MINUTE; // give up walking after 1.5 hours
        if (planRoute(agent, ctx, action.targetX, action.targetY)) return true;
      }
    }
    agent.asleep = true;
    return true;
  },
  step(agent, ctx) {
    if (!agent.asleep) {
      // Still walking to company.
      const action = agent.action!;
      const close = ctx.index.any(agent.x, agent.y, 2, agent);
      if (close || ctx.world.tick >= (action.untilTick ?? 0) || agent.needs.rest <= 0.05) {
        agent.clearPath();
        agent.asleep = true;
      } else if (followPath(agent, ctx)) {
        // Reached the end of this leg: carry on if not there yet.
        const far = Math.hypot(action.targetX! - agent.x, action.targetY! - agent.y) > 2;
        if (!far || !planRoute(agent, ctx, action.targetX!, action.targetY!)) agent.asleep = true;
      }
      return false;
    }
    const n = agent.needs;
    const light = ctx.world.calendar.light;
    // Hunger can wake a sleeper who has had some rest.
    if (n.energy < 0.15 && n.rest > 0.4) return true;
    // Fully rested and it is light out: wake up. In the dark, stay down until morning.
    if (n.rest >= 0.98 && light >= 0.3) return true;
    return false;
  },
  end(agent, ctx) {
    agent.asleep = false;
    // Home drifts toward where it sleeps, especially when sleeping among others,
    // so a group that moves on carries its home with it.
    const withOthers = ctx.index.any(agent.x, agent.y, RATES.companyRadius, agent);
    const pull = withOthers ? HOME_PULL_COMPANY : HOME_PULL_ALONE;
    agent.home = {
      x: Math.round(agent.home.x + (agent.tileX - agent.home.x) * pull),
      y: Math.round(agent.home.y + (agent.tileY - agent.home.y) * pull),
    };
  },
};

/** How far home moves toward a night's sleeping place (with company / alone). */
export const HOME_PULL_COMPANY = 0.35;
export const HOME_PULL_ALONE = 0;

const seekFood: ActionDef = {
  type: "seekFood",
  // Searching unfamiliar ground when no food is known or in sight.
  start(agent, ctx) {
    const target = pickFrontier(agent, ctx, 15, 40);
    if (!target) return false;
    agent.action!.targetX = target[0];
    agent.action!.targetY = target[1];
    return planRoute(agent, ctx, target[0], target[1]);
  },
  step(agent, ctx) {
    return followPath(agent, ctx);
  },
};

const explore: ActionDef = {
  type: "explore",
  start(agent, ctx) {
    const target = pickFrontier(agent, ctx, 10, 25);
    if (!target) return false;
    agent.action!.targetX = target[0];
    agent.action!.targetY = target[1];
    return planRoute(agent, ctx, target[0], target[1]);
  },
  step(agent, ctx) {
    return followPath(agent, ctx);
  },
};

/** How close counts as "together" when seeking company. */
const SOCIAL_DISTANCE = 2;
/** Minimum ticks between re-planning a route to a moving companion. */
const REPLAN_TICKS = 10;

const socialize: ActionDef = {
  type: "socialize",
  start(agent, ctx) {
    const action = agent.action!;
    const seen = ctx.index.near(agent.x, agent.y, sightRadius(ctx.world.calendar.light), agent);
    if (seen.length > 0) {
      action.targetId = seen[0].agent.id;
    } else if (agent.lastSeenOther) {
      action.targetX = Math.round(agent.lastSeenOther.x);
      action.targetY = Math.round(agent.lastSeenOther.y);
      if (!planRoute(agent, ctx, action.targetX, action.targetY)) return false;
    } else {
      return false;
    }
    action.untilTick = ctx.world.tick + ctx.world.rng.int(30, 90) * TICKS_PER_MINUTE;
    return true;
  },
  step(agent, ctx) {
    const action = agent.action!;
    if (agent.needs.social >= 0.98 || ctx.world.tick >= (action.untilTick ?? 0)) return true;
    if (action.targetId !== undefined) {
      const other = ctx.population.get(action.targetId);
      if (!other) return true; // they are gone
      const dist = Math.hypot(other.x - agent.x, other.y - agent.y);
      // Lost sight of them: give up and remember where they were heading.
      if (dist > sightRadius(ctx.world.calendar.light) * 1.5) {
        agent.lastSeenOther = { x: other.x, y: other.y, tick: ctx.world.tick };
        return true;
      }
      if (dist > SOCIAL_DISTANCE) {
        // Re-plan only when the route no longer leads near them, and not more than every few seconds.
        const end = agent.hasPath()
          ? Math.hypot(agent.path[agent.path.length - 2] - other.x, agent.path[agent.path.length - 1] - other.y)
          : Infinity;
        const tick = ctx.world.tick;
        if (end > SOCIAL_DISTANCE + 1 && tick - (action.plannedTick ?? -Infinity) >= REPLAN_TICKS) {
          action.plannedTick = tick;
          if (!planRoute(agent, ctx, other.tileX, other.tileY)) return true;
        }
        followPath(agent, ctx);
      } else {
        agent.clearPath();
        agent.heading = Math.atan2(other.y - agent.y, other.x - agent.x);
      }
      return false;
    }
    // Heading to where someone was last seen, looking out for anyone on the way.
    const seen = ctx.index.near(agent.x, agent.y, sightRadius(ctx.world.calendar.light), agent);
    if (seen.length > 0) {
      action.targetId = seen[0].agent.id;
      agent.clearPath();
      return false;
    }
    if (followPath(agent, ctx)) {
      const tx = action.targetX ?? agent.tileX;
      const ty = action.targetY ?? agent.tileY;
      if (Math.hypot(tx - agent.x, ty - agent.y) <= 1) {
        agent.lastSeenOther = null; // nobody here any more
        return true;
      }
      if (!planRoute(agent, ctx, tx, ty)) return true; // next leg
    }
    return false;
  },
};

const idle: ActionDef = {
  type: "idle",
  start(agent, ctx) {
    agent.clearPath();
    agent.action!.untilTick = ctx.world.tick + ctx.world.rng.int(10, 40) * TICKS_PER_MINUTE;
    return true;
  },
  step(agent, ctx) {
    if (ctx.world.tick >= (agent.action!.untilTick ?? 0)) return true;
    if (!agent.hasPath() && ctx.world.rng.chance(1 / 300)) {
      // Shift a step or two now and then.
      const x = agent.tileX + ctx.world.rng.int(-2, 2);
      const y = agent.tileY + ctx.world.rng.int(-2, 2);
      planRoute(agent, ctx, x, y);
    }
    followPath(agent, ctx);
    return false;
  },
};

export const ACTIONS: Record<ActionType, ActionDef> = {
  sleep,
  eat: EAT,
  seekFood,
  taste: TASTE,
  inspect: INSPECT,
  gather: GATHER,
  explore,
  socialize,
  idle,
};
