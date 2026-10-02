// What agents can do, and how each action plays out tick by tick.

import type { World } from "../core/world.ts";
import { blockOf, type ActionType, type Agent } from "./agent.ts";
import { RATES } from "./needs.ts";
import { findPath } from "./pathfinding.ts";
import type { Population } from "./population.ts";
import { learnAround, sightRadius, type SpatialIndex } from "./senses.ts";

export interface AgentContext {
  world: World;
  population: Population;
  index: SpatialIndex;
}

export interface ActionDef {
  type: ActionType;
  /** Begin the action. Returns false if it can't be done right now. */
  start(agent: Agent, ctx: AgentContext): boolean;
  /** Advance one tick. Returns true when the action is finished. */
  step(agent: Agent, ctx: AgentContext): boolean;
  /** Clean up when the action ends or is replaced. */
  end?(agent: Agent, ctx: AgentContext): void;
}

const TICKS_PER_MINUTE = 60;

/** Walking speed in tiles per world second, before health and tiredness. */
export const WALK_SPEED = 1.2;

export function walkSpeed(agent: Agent): number {
  let speed = WALK_SPEED * (0.4 + 0.6 * agent.health);
  if (agent.needs.rest < 0.15) speed *= 0.7;
  return speed;
}

/** Longest stretch planned in one go; longer trips are walked in legs. */
export const MAX_LEG = 32;
/** Search effort limit for one leg. */
const LEG_SEARCH_NODES = 800;

/**
 * Plans a route toward a tile. Far destinations get a route to a point at most
 * MAX_LEG tiles along the way; arriving there, the agent plans the next leg.
 * Returns false if no progress toward it is possible.
 */
export function planRoute(agent: Agent, ctx: AgentContext, tx: number, ty: number): boolean {
  const dx = tx - agent.x;
  const dy = ty - agent.y;
  const dist = Math.hypot(dx, dy);
  if (dist > MAX_LEG) {
    // Aim for the farthest walkable point along the way, up to one leg out.
    const grid = ctx.world.grid;
    let found = false;
    for (let along = MAX_LEG; along >= MAX_LEG / 2; along -= 2) {
      const lx = Math.round(agent.x + (dx / dist) * along);
      const ly = Math.round(agent.y + (dy / dist) * along);
      if (grid.isWalkable(lx, ly)) {
        tx = lx;
        ty = ly;
        found = true;
        break;
      }
    }
    if (!found) {
      tx = Math.round(agent.x + (dx / dist) * MAX_LEG);
      ty = Math.round(agent.y + (dy / dist) * MAX_LEG);
    }
  }
  if (!ctx.world.grid.isWalkable(tx, ty)) {
    // Can't stand there: head for the nearest standable tile next to it.
    const near = nearestWalkable(ctx, tx, ty, 3);
    if (!near) {
      agent.clearPath();
      return false;
    }
    [tx, ty] = near;
  }
  const result = findPath(ctx.world.grid, agent.tileX, agent.tileY, tx, ty, LEG_SEARCH_NODES);
  if (!result) {
    agent.clearPath();
    return false;
  }
  agent.path = result.path;
  agent.pathIndex = 0;
  return true;
}

/** The closest walkable tile within `radius` of a point, or null. */
export function nearestWalkable(ctx: AgentContext, x: number, y: number, radius: number): [number, number] | null {
  const grid = ctx.world.grid;
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (let oy = -radius; oy <= radius; oy++) {
    for (let ox = -radius; ox <= radius; ox++) {
      const d = ox * ox + oy * oy;
      if (d < bestD && grid.isWalkable(x + ox, y + oy)) {
        bestD = d;
        best = [x + ox, y + oy];
      }
    }
  }
  return best;
}

/**
 * Moves along the current route for one tick.
 * Returns true when the route is finished (or there is none).
 */
export function followPath(agent: Agent, ctx: AgentContext): boolean {
  let budget = walkSpeed(agent);
  while (budget > 0 && agent.hasPath()) {
    const tx = agent.path[agent.pathIndex];
    const ty = agent.path[agent.pathIndex + 1];
    const dx = tx - agent.x;
    const dy = ty - agent.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1e-9) agent.heading = Math.atan2(dy, dx);
    if (dist <= budget) {
      agent.x = tx;
      agent.y = ty;
      budget -= dist;
      agent.pathIndex += 2;
      arriveAtTile(agent, ctx);
    } else {
      agent.x += (dx / dist) * budget;
      agent.y += (dy / dist) * budget;
      budget = 0;
    }
  }
  return !agent.hasPath();
}

function arriveAtTile(agent: Agent, ctx: AgentContext): void {
  const grid = ctx.world.grid;
  const wear = grid.get("wear", agent.tileX, agent.tileY);
  if (wear < 65535) grid.set("wear", agent.tileX, agent.tileY, wear + 1);
  agent.stats.tilesWalked++;
  const learned = learnAround(agent, ctx.world);
  if (learned > 0) {
    agent.needs.curiosity = Math.min(1, agent.needs.curiosity + learned * RATES.curiosityPerNewBlock);
  }
}

/** Tiles from home that cost one "unknown block" of appeal when choosing where to explore. */
export const HOME_RANGE = 40;

/**
 * Picks a destination that leads toward unknown ground.
 * Tries several candidates and keeps the one with the most unseen blocks around it.
 */
export function pickFrontier(agent: Agent, ctx: AgentContext, minDist: number, maxDist: number): [number, number] | null {
  const near = sampleFrontier(agent, ctx, minDist, maxDist);
  // If everything nearby is already known, look farther afield.
  if (near && near.unknown > 0) return near.target;
  const far = sampleFrontier(agent, ctx, maxDist, maxDist * 3);
  if (far && (!near || far.score > near.score)) return far.target;
  return near ? near.target : null;
}

function sampleFrontier(
  agent: Agent,
  ctx: AgentContext,
  minDist: number,
  maxDist: number,
): { target: [number, number]; score: number; unknown: number } | null {
  const rng = ctx.world.rng;
  const grid = ctx.world.grid;
  // A restless mind tolerates straying farther from home.
  const range = HOME_RANGE * (1 + 2 * (1 - agent.needs.curiosity));
  let best: { target: [number, number]; score: number; unknown: number } | null = null;
  for (let i = 0; i < 12; i++) {
    // Mostly keep going roughly the way it is facing, sometimes turn anywhere.
    const angle = rng.chance(0.6) ? agent.heading + rng.normal(0, 0.9) : rng.range(0, Math.PI * 2);
    const dist = rng.range(minDist, maxDist);
    const x = Math.round(agent.x + Math.cos(angle) * dist);
    const y = Math.round(agent.y + Math.sin(angle) * dist);
    if (!grid.isWalkable(x, y)) continue;
    let unknown = 0;
    const bx = blockOf(x);
    const by = blockOf(y);
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if (!agent.knows(bx + ox, by + oy)) unknown++;
    // Prefer unknown ground, but the farther from home, the less appealing:
    // the explored area grows outward gradually instead of scattering everyone.
    const fromHome = Math.hypot(x - agent.home.x, y - agent.home.y);
    const score = unknown - fromHome / range + agent.quirk[0] * 0.5 + rng.next() * 0.5;
    if (!best || score > best.score) best = { target: [x, y], score, unknown };
  }
  return best;
}

const sleep: ActionDef = {
  type: "sleep",
  start(agent) {
    agent.asleep = true;
    agent.clearPath();
    return true;
  },
  step(agent, ctx) {
    const n = agent.needs;
    const light = ctx.world.calendar.light;
    // Hunger can wake a sleeper who has had some rest.
    if (n.energy < 0.15 && n.rest > 0.4) return true;
    // Fully rested and it is light out: wake up. In the dark, stay down until morning.
    if (n.rest >= 0.98 && light >= 0.3) return true;
    return false;
  },
  end(agent) {
    agent.asleep = false;
  },
};

const seekFood: ActionDef = {
  type: "seekFood",
  // No food exists yet (materials arrive in the next step), so seeking food
  // means searching unfamiliar ground for something to eat.
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

export const ACTIONS: Record<ActionType, ActionDef> = { sleep, seekFood, explore, socialize, idle };
