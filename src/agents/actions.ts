// What agents can do, and how each action plays out tick by tick.

import type { ActionType, Agent } from "./agent.ts";
import { EAT, GATHER, INSPECT, SHELTER_WORTH_REMEMBERING, TASTE, TREAT } from "./foraging.ts";
import { BUILD, wakeAtNest } from "./building.ts";
import { TINKER } from "./tinker.ts";
import { nightBeside } from "./kinship.ts";
import { shelterAt } from "../building/structures.ts";
import { WARMTH_FULL, fireDanger, warmthAt } from "../world/fire.ts";
import {
  MAX_LEG,
  TICKS_PER_MINUTE,
  followPath,
  pickFrontier,
  planRoute,
  type ActionDef,
  type AgentContext,
} from "./movement.ts";
import { RATES } from "./needs.ts";
import type { World } from "../core/world.ts";
import { sightRadius } from "./senses.ts";
import { TAKE, coldBetween } from "./conflict.ts";

export * from "./movement.ts";

/** At nightfall, an AI alone will walk this far to sleep near others
 * (a scattered few can still find each other across a thinned-out village). */
export const GATHER_FOR_NIGHT_RADIUS = 100;

const sleep: ActionDef = {
  type: "sleep",
  start(agent, ctx) {
    agent.clearPath();
    const world = ctx.world;
    const action = agent.action!;
    const cal = world.calendar;
    const forTheNight = cal.hour + cal.minute / 60 >= cal.sunsetHour - 2 || cal.hour < cal.sunriseHour;
    if (agent.needs.rest > 0.05 && forTheNight) {
      // Somewhere warmer that it knows of: its own nest, a covered place, others already asleep.
      const dest = nightDestination(agent, ctx);
      let target: { x: number; y: number } | null = dest;
      action.toShelter = dest?.shelter ?? false;
      if (!dest && !ctx.index.any(agent.x, agent.y, RATES.companyRadius, agent)) {
        // Alone with nowhere better known: head home, where the others are likely to gather too.
        const fromHome = Math.hypot(agent.home.x - agent.x, agent.home.y - agent.y);
        if (fromHome > 12) target = agent.home;
      }
      if (target && Math.hypot(target.x - agent.x, target.y - agent.y) > ARRIVED) {
        action.targetX = target.x;
        action.targetY = target.y;
        action.phase = "travel";
        action.untilTick = world.tick + 90 * TICKS_PER_MINUTE; // give up walking after 1.5 hours
        if (planRoute(agent, ctx, target.x, target.y)) return true;
      }
    }
    settle(agent, ctx);
    return true;
  },
  step(agent, ctx) {
    if (!agent.asleep) {
      const action = agent.action!;
      const tick = ctx.world.tick;
      if (action.phase === "settle") {
        if (followPath(agent, ctx) || tick >= (action.untilTick ?? 0)) lieDown(agent, ctx);
        return false;
      }
      // Still walking to shelter or company.
      const dist = Math.hypot(action.targetX! - agent.x, action.targetY! - agent.y);
      const arrived = action.toShelter ? dist <= ARRIVED : ctx.index.any(agent.x, agent.y, 2, agent);
      if (arrived || tick >= (action.untilTick ?? 0) || agent.needs.rest <= 0.05) {
        agent.clearPath();
        settle(agent, ctx);
      } else if (followPath(agent, ctx)) {
        // Reached the end of this leg: carry on if not there yet.
        if (dist <= 2 || !planRoute(agent, ctx, action.targetX!, action.targetY!)) settle(agent, ctx);
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
    const wasAsleep = agent.asleep;
    agent.asleep = false;
    if (!wasAsleep) return; // interrupted on the way to bed
    // Home drifts toward where it sleeps, especially when sleeping among others,
    // so a group that moves on carries its home with it.
    // An AI with a nest is at home there.
    const withOthers = ctx.index.any(agent.x, agent.y, RATES.companyRadius, agent);
    const pull = withOthers ? HOME_PULL_COMPANY : HOME_PULL_ALONE;
    agent.home = {
      x: Math.round(agent.home.x + (agent.tileX - agent.home.x) * pull),
      y: Math.round(agent.home.y + (agent.tileY - agent.home.y) * pull),
    };
    wakeAtNest(agent, ctx.world);
    nightBeside(agent, ctx);
    if (agent.nest) agent.home = { x: agent.nest.x, y: agent.nest.y };
  },
};

/** Close enough to a destination for the night to settle in, in tiles. */
const ARRIVED = 1.5;
/** How far around itself an AI looks for the best spot to lie down. */
const BED_RADIUS = 2;

/** Farthest an AI will walk at nightfall to its own nest, and to a covered place it remembers. */
export const NEST_NIGHT_RADIUS = 300;
export const SHELTER_NIGHT_RADIUS = 150;

/** How warm a night at a place would be (1 = no chill at all): shelter, company, and any fire near it. */
function warmth(world: World, x: number, y: number, shelter: number, company: boolean): number {
  const fire = 1 - WARMTH_FULL * Math.min(1, warmthAt(world, x, y));
  return 1 - (1 - Math.min(1, shelter)) * (company ? RATES.huddleFactor : 1) * fire;
}

/**
 * Where it would rather spend the night than here, if anywhere: whichever
 * known place promises the warmest night (shelter, and others close by),
 * a little less appealing the farther it is. Its own nest is favored.
 */
export function nightDestination(agent: Agent, ctx: AgentContext): { x: number; y: number; shelter: boolean } | null {
  const world = ctx.world;
  const grid = world.grid;
  const othersNear = (x: number, y: number) => {
    if (ctx.index.near(x, y, RATES.companyRadius, agent).some((o) => o.agent.asleep)) return true;
    for (const a of ctx.population.all()) {
      if (a !== agent && a.nest && Math.abs(a.nest.x - x) <= RATES.companyRadius && Math.abs(a.nest.y - y) <= RATES.companyRadius) return true;
    }
    return false;
  };
  const hereWarmth = warmth(world, agent.tileX, agent.tileY, shelterAt(world, agent.tileX, agent.tileY), ctx.index.any(agent.x, agent.y, RATES.companyRadius, agent));
  let best: { x: number; y: number; shelter: boolean } | null = null;
  let bestScore = hereWarmth + 0.05;
  const consider = (x: number, y: number, radius: number, bonus: number, shelter: boolean, company?: boolean) => {
    const dist = Math.hypot(x - agent.x, y - agent.y);
    if (dist > radius || !grid.isWalkable(x, y)) return;
    const score = warmth(world, x, y, shelterAt(world, x, y), company ?? othersNear(x, y)) + bonus - dist / 300;
    if (score > bestScore) {
      bestScore = score;
      best = { x, y, shelter };
    }
  };
  if (agent.nest) consider(agent.nest.x, agent.nest.y, NEST_NIGHT_RADIUS, 0.1, true);
  // A paired being goes home to its mate for the night.
  if (agent.mate !== null) {
    const mate = ctx.population.get(agent.mate);
    if (mate) {
      // Home pulls as hard as it is worth: a built refuge draws the pair in;
      // a bare patch of ground never outpulls the warm pile of everyone else.
      if (mate.nest) {
        const worth = 0.15 + 0.35 * Math.min(1, shelterAt(world, mate.nest.x, mate.nest.y));
        consider(mate.nest.x, mate.nest.y, NEST_NIGHT_RADIUS, worth, true);
      }
      if (mate.asleep) consider(mate.tileX, mate.tileY, GATHER_FOR_NIGHT_RADIUS, 0.3, false, true);
    }
  }
  // The young sleep by their family.
  if (agent.parents && !agent.grown(world.tick)) {
    for (const id of agent.parents) {
      const parent = ctx.population.get(id);
      if (parent?.nest) consider(parent.nest.x, parent.nest.y, NEST_NIGHT_RADIUS, 0.2, true);
    }
  }
  for (const s of agent.shelterSpots) if (s.value >= SHELTER_WORTH_REMEMBERING) consider(s.x, s.y, SHELTER_NIGHT_RADIUS, 0, true);
  // Someone already settled for the night: a still point everyone can converge on.
  const sleeper = ctx.index.near(agent.x, agent.y, GATHER_FOR_NIGHT_RADIUS, agent).find((o) => o.agent.asleep);
  if (sleeper) consider(sleeper.agent.tileX, sleeper.agent.tileY, GATHER_FOR_NIGHT_RADIUS, 0, false, true);
  return best;
}

/** Picks the best free spot within a couple of tiles and walks to it (or lies down here). */
function settle(agent: Agent, ctx: AgentContext): void {
  const action = agent.action!;
  action.phase = "settle";
  action.untilTick = ctx.world.tick + 10 * TICKS_PER_MINUTE;
  const bed = bestBed(agent, ctx);
  if (bed && (bed[0] !== agent.tileX || bed[1] !== agent.tileY) && planRoute(agent, ctx, bed[0], bed[1])) return;
  lieDown(agent, ctx);
}

/** At most this many can sleep on one tile (two can squeeze in side by side). */
export const SLEEPERS_PER_TILE = 2;

/**
 * The warmest free tile nearby: sheltered, its own sleeping place, close to others.
 * Someone else's sleeping place can be shared, but room is always left for its owner.
 */
function bestBed(agent: Agent, ctx: AgentContext): [number, number] | null {
  const world = ctx.world;
  const grid = world.grid;
  const owners = new Map<string, Agent>();
  for (const a of ctx.population.all()) if (a !== agent && a.nest) owners.set(`${a.nest.x},${a.nest.y}`, a);
  let best: [number, number] | null = null;
  let bestScore = -Infinity;
  const ax = agent.tileX;
  const ay = agent.tileY;
  for (let oy = -BED_RADIUS; oy <= BED_RADIUS; oy++) {
    for (let ox = -BED_RADIUS; ox <= BED_RADIUS; ox++) {
      const x = ax + ox;
      const y = ay + oy;
      if (!grid.isWalkable(x, y) || fireDanger(world, x, y) !== null) continue; // never bed down against the flames
      const lying = ctx.index.near(x, y, 0.6, agent).filter((o) => o.agent.asleep);
      if (lying.length >= SLEEPERS_PER_TILE) continue;
      const owner = owners.get(`${x},${y}`);
      if (owner && lying.length > 0 && !lying.some((o) => o.agent === owner)) continue; // keep the owner's place
      let score = shelterAt(world, x, y) + 0.25 * warmthAt(world, x, y) - 0.02 * Math.hypot(ox, oy);
      if (agent.nest && agent.nest.x === x && agent.nest.y === y) score += 0.15;
      else if (owner) score -= 0.05;
      // The heart picks the spot: sleeping beside someone you hold dear -
      // and never, if it can help it, beside someone resentment runs with.
      let dearest = 0;
      for (const o of ctx.index.near(x, y, 1.6, agent)) {
        if (coldBetween(agent, o.agent)) score -= 0.3;
        const bond = agent.bondWith(o.agent.id);
        const warmthFor = bond.affection + (agent.mate === o.agent.id ? 0.4 : 0) + (agent.parents?.includes(o.agent.id) ? 0.3 : 0);
        if (warmthFor > dearest) dearest = warmthFor;
      }
      score += 0.45 * Math.min(1, dearest);
      if (score > bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
  }
  return best;
}

/** Lies down for the night where it stands. */
function lieDown(agent: Agent, ctx: AgentContext): void {
  agent.clearPath();
  agent.asleep = true;
  const world = ctx.world;
  const x = agent.tileX;
  const y = agent.tileY;
  if (warmthAt(world, x, y) > 0.4 && world.isFirst("hearthNight")) {
    world.chronicle.add(world.tick, "fire", `${agent.label} lay down to sleep in the warmth of a fire.`, { agentId: agent.id, x, y });
  }
  if (shelterAt(world, x, y) < 0.5) return;
  const builder = world.grid.peek("roofBy", x, y);
  if (builder !== 0 && builder !== agent.id && world.isFirst("borrowedShelter")) {
    world.chronicle.add(world.tick, "building", `${agent.label} lay down for the night under a cover #${String(builder).padStart(2, "0")} had built.`, {
      agentId: agent.id, builder, x, y,
    });
  }
  if (!world.firsts.has("sharedShelter")) {
    const together =
      1 + ctx.index.near(agent.x, agent.y, 3, agent).filter((o) => o.agent.asleep && shelterAt(world, o.agent.tileX, o.agent.tileY) >= 0.5).length;
    if (together >= 3 && world.isFirst("sharedShelter")) {
      world.chronicle.add(world.tick, "building", `For the first time, ${together} of them slept side by side under shelter.`, { x, y });
    }
  }
}

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
    // The nearest one it can actually get to (not someone across a ridge or behind walls).
    const reachable = seen.slice(0, 3).find(({ agent: other, dist }) => {
      if (dist <= SOCIAL_DISTANCE) return true;
      if (!planRoute(agent, ctx, other.tileX, other.tileY)) return false;
      const end = Math.hypot(agent.path[agent.path.length - 2] - other.x, agent.path[agent.path.length - 1] - other.y);
      return dist > MAX_LEG || end <= SOCIAL_DISTANCE + 1;
    });
    agent.clearPath();
    if (reachable) {
      action.targetId = reachable.agent.id;
    } else if (seen.length > 0) {
      return false;
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
          // No way through to them (walls in between): give up rather than keep trying.
          const reach = Math.hypot(agent.path[agent.path.length - 2] - other.x, agent.path[agent.path.length - 1] - other.y);
          if (dist <= MAX_LEG && reach > SOCIAL_DISTANCE + 1) return true;
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

/** A child keeps to its family: walk to a parent until close. */
const follow: ActionDef = {
  type: "follow",
  start(agent, ctx) {
    const parent = nearestParent(agent, ctx);
    if (!parent) return false;
    agent.action!.targetId = parent.id;
    agent.action!.untilTick = ctx.world.tick + 60 * TICKS_PER_MINUTE;
    return planRoute(agent, ctx, parent.tileX, parent.tileY);
  },
  step(agent, ctx) {
    const action = agent.action!;
    const parent = ctx.population.get(action.targetId!);
    if (!parent || ctx.world.tick >= (action.untilTick ?? 0)) return true;
    const dist = Math.hypot(parent.x - agent.x, parent.y - agent.y);
    if (dist <= 4) return true;
    if (followPath(agent, ctx)) {
      if (!planRoute(agent, ctx, parent.tileX, parent.tileY)) return true;
    }
    return false;
  },
};

/** The closest living parent, if any. */
export function nearestParent(agent: Agent, ctx: AgentContext): Agent | null {
  if (!agent.parents) return null;
  let best: Agent | null = null;
  for (const id of agent.parents) {
    const parent = ctx.population.get(id);
    if (!parent) continue;
    if (!best || Math.hypot(parent.x - agent.x, parent.y - agent.y) < Math.hypot(best.x - agent.x, best.y - agent.y)) best = parent;
  }
  return best;
}

/** Picks and routes to the safest open tile a few steps out, away from every nearby flame. */
function planEscape(agent: Agent, ctx: AgentContext): boolean {
  const world = ctx.world;
  let best: [number, number] | null = null;
  let bestScore = -Infinity;
  for (let oy = -4; oy <= 4; oy++) {
    for (let ox = -4; ox <= 4; ox++) {
      const d = Math.max(Math.abs(ox), Math.abs(oy));
      if (d < 2) continue;
      const x = agent.tileX + ox;
      const y = agent.tileY + oy;
      if (!world.grid.isWalkable(x, y) || fireDanger(world, x, y) !== null) continue;
      let nearestFire = Infinity;
      for (const f of world.fireTiles.values()) {
        const df = Math.max(Math.abs(f.x - x), Math.abs(f.y - y));
        if (df < nearestFire) nearestFire = df;
      }
      const score = Math.min(nearestFire, 8) - d * 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
  }
  if (!best) return false;
  agent.action!.targetX = best[0];
  agent.action!.targetY = best[1];
  return planRoute(agent, ctx, best[0], best[1]);
}

/** Away from the flames, now. Never chosen; forced by the fire reflex in brain.ts. */
const flee: ActionDef = {
  type: "flee",
  start(agent, ctx) {
    return planEscape(agent, ctx);
  },
  step(agent, ctx) {
    const inDanger = fireDanger(ctx.world, agent.tileX, agent.tileY) !== null;
    // A route the fire itself has cut off (or none at all): pick a new way out.
    if (!agent.hasPath() && inDanger && !planEscape(agent, ctx)) return false; // trapped: keep trying
    const done = followPath(agent, ctx);
    return done && fireDanger(ctx.world, agent.tileX, agent.tileY) === null;
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
  treat: TREAT,
  take: TAKE,
  seekFood,
  taste: TASTE,
  inspect: INSPECT,
  gather: GATHER,
  tinker: TINKER,
  build: BUILD,
  flee,
  follow,
  explore,
  socialize,
  idle,
};
