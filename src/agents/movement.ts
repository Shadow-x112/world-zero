// Moving around: routes, walking, and choosing where to explore.
// Shared by every action that involves going somewhere.

import type { World } from "../core/world.ts";
import { blockOf, type ActionType, type Agent } from "./agent.ts";
import { RATES } from "./needs.ts";
import { findPath } from "./pathfinding.ts";
import type { Population } from "./population.ts";
import { learnAround, type SpatialIndex } from "./senses.ts";
import { carriedMass, carryCapacity } from "./foraging.ts";
import { itemClass } from "../items/crafting.ts";

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

export const TICKS_PER_MINUTE = 60;

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
    if (!ctx.world.grid.isWalkable(tx, ty)) {
      // Something was built across the way since the route was planned.
      agent.clearPath();
      break;
    }
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
  const world = ctx.world;
  const grid = world.grid;
  const wear = grid.get("wear", agent.tileX, agent.tileY);
  if (wear < 65535) grid.set("wear", agent.tileX, agent.tileY, wear + 1);
  agent.stats.tilesWalked++;
  const learned = learnAround(agent, world);
  if (learned > 0) {
    agent.needs.curiosity = Math.min(1, agent.needs.curiosity + learned * RATES.curiosityPerNewBlock);
  }
  // Something someone left lying here: pick it up if it isn't ours-just-dropped,
  // there is room for it, and we don't hold such a thing already.
  const here = world.groundItems.at(agent.tileX, agent.tileY);
  if (here.length > 0) {
    for (const g of [...here]) {
      if (agent.recentlyDropped.includes(g.item.id)) continue;
      if (carriedMass(agent, world) + g.item.props.mass > carryCapacity(agent)) continue;
      const cls = itemClass(g.item);
      if (cls !== "none" && agent.items.some((i) => itemClass(i) === cls)) continue;
      const item = world.groundItems.take(g.x, g.y, g.item.id);
      if (item) {
        agent.items.push(item);
        agent.needs.curiosity = Math.min(1, agent.needs.curiosity + 0.05);
      }
    }
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
