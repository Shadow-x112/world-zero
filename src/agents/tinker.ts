// Tinkering: a restless AI sits down and tries the things it carries against
// each other. Most attempts come to nothing and waste a little material; a new
// thing is a flood of satisfied curiosity, and whether it is ever USEFUL only
// shows up later, in how work goes while holding it (see foraging).
//
// If nothing in hand can be tried, it first goes and picks up something that
// might change that: flexible stuff if it has none, a hard thing otherwise.

import { describe } from "../materials/registry.ts";
import { describeItem } from "../items/item.ts";
import {
  BINDER_FLEXIBILITY,
  MIX_EARTH_UNITS,
  PART_HARDNESS,
  TINKER_TICKS,
  mixable,
  interestIn,
  performAttempt,
  possibleAttempts,
  probeResult,
  type Attempt,
} from "../items/crafting.ts";
import type { Agent } from "./agent.ts";
import { buildUrge } from "./building.ts";
import { feel } from "./emotions.ts";
import { warmthAt } from "../world/fire.ts";
import { approach, goTo, handle, pickupTicks, roomFor, survey, takeFromTile } from "./foraging.ts";
import type { ActionDef, AgentContext } from "./movement.ts";

/** Curiosity satisfied by just trying something, and by making something it never made before. */
export const TRY_REWARD = 0.05;
export const NOVELTY_REWARD = 0.35;

/** The best attempt it could make right now, by interest, or null. */
export function bestAttempt(agent: Agent, ctx: AgentContext): { attempt: Attempt; interest: number } | null {
  const world = ctx.world;
  let best: { attempt: Attempt; interest: number } | null = null;
  // Cold in the bones and no warmth near the sleeping place: a flame first.
  const needsFire =
    buildUrge(agent, world) > 0.05 &&
    warmthAt(world, agent.tileX, agent.tileY) <= 0.3 &&
    (agent.nest === null || warmthAt(world, agent.nest.x, agent.nest.y) <= 0.3);
  for (const attempt of possibleAttempts(agent, world)) {
    let interest = interestIn(agent, attempt, probeResult(attempt, world, agent));
    if (needsFire && attempt.verb === "heat") interest = Math.max(interest, 1.5);
    if (interest > 0.05 && (!best || interest > best.interest)) best = { attempt, interest };
  }
  return best;
}

/** Something within sight worth fetching to make tinkering possible. */
function missingIngredient(agent: Agent, ctx: AgentContext): { x: number; y: number; material: number } | null {
  const world = ctx.world;
  let hasBinder = false;
  let hasHard = false;
  let hasEarth = false;
  for (const c of agent.carrying) {
    const type = world.materials.get(c.material);
    if (!type) continue;
    if (type.props.flexibility >= BINDER_FLEXIBILITY && c.units >= 2) hasBinder = true;
    if (type.props.hardness >= PART_HARDNESS) hasHard = true;
    if (mixable(type) && c.units >= MIX_EARTH_UNITS) hasEarth = true;
  }
  if (hasBinder && (hasHard || hasEarth)) return null;
  const radius = 10;
  const grid = world.grid;
  const ax = agent.tileX;
  const ay = agent.tileY;
  let best: { x: number; y: number; material: number; d2: number } | null = null;
  for (let oy = -radius; oy <= radius; oy++) {
    for (let ox = -radius; ox <= radius; ox++) {
      const d2 = ox * ox + oy * oy;
      if (d2 > radius * radius) continue;
      const x = ax + ox;
      const y = ay + oy;
      if (grid.peek("wall", x, y) !== 0) continue;
      const id = grid.get("material", x, y);
      if (id === 0 || grid.get("amount", x, y) === 0) continue;
      const type = world.materials.get(id);
      if (!type) continue;
      const wanted =
        (!hasBinder && type.props.flexibility >= BINDER_FLEXIBILITY) ||
        (hasBinder && !hasHard && type.props.hardness >= PART_HARDNESS) ||
        (hasBinder && !hasEarth && mixable(type));
      if (!wanted || roomFor(agent, world, type) === 0) continue;
      if (!best || d2 < best.d2) best = { x, y, material: id, d2 };
    }
  }
  return best;
}

export const TINKER: ActionDef = {
  type: "tinker",
  start(agent, ctx) {
    const a = agent.action!;
    if (bestAttempt(agent, ctx)) {
      a.phase = "work";
      a.untilTick = ctx.world.tick + TINKER_TICKS;
      agent.clearPath();
      return true;
    }
    const fetch = missingIngredient(agent, ctx);
    if (!fetch) return false;
    a.phase = "fetch";
    a.material = fetch.material;
    a.untilTick = ctx.world.tick + pickupTicks(agent, ctx.world, ctx.world.materials.require(fetch.material));
    return goTo(agent, ctx, fetch);
  },
  step(agent, ctx) {
    const world = ctx.world;
    const a = agent.action!;

    if (a.phase === "fetch") {
      const state = approach(agent, ctx);
      if (state === "stuck") return true;
      const type = world.materials.require(a.material!);
      if (state === "walking") {
        a.untilTick = world.tick + pickupTicks(agent, world, type);
        return false;
      }
      if (world.tick < (a.untilTick ?? 0)) return false;
      const taken = takeFromTile(world, a.targetX!, a.targetY!, a.material!);
      if (taken) {
        handle(agent, world, taken);
        const entry = agent.carrying.find((c) => c.material === taken.id);
        if (entry) entry.units++;
        else agent.carrying.push({ material: taken.id, units: 1 });
      }
      // Enough to try something? Sit down. Otherwise keep picking (or give up).
      if (bestAttempt(agent, ctx)) {
        a.phase = "work";
        a.targetX = undefined;
        a.targetY = undefined;
        a.untilTick = world.tick + TINKER_TICKS;
        agent.clearPath();
        return false;
      }
      if (!taken) return true;
      a.untilTick = world.tick + pickupTicks(agent, world, type);
      return false;
    }

    // Working at it.
    if (world.tick < (a.untilTick ?? 0)) return false;
    const best = bestAttempt(agent, ctx);
    if (!best) return true;
    const memory = agent.tried[best.attempt.key];
    const neverMade = !memory || memory.ok === 0;
    const result = performAttempt(best.attempt, world, agent);
    agent.needs.curiosity = Math.min(1, agent.needs.curiosity + TRY_REWARD);
    if (result) {
      if (neverMade) {
        agent.needs.curiosity = Math.min(1, agent.needs.curiosity + NOVELTY_REWARD);
        feel(agent, "joy", 0.35); // it worked, and nothing like it existed before
        feel(agent, "wonder", 0.3);
      }
      recordFirsts(agent, ctx, result, best.attempt.verb);
      return true; // made something: step back and look at it
    }
    // Nothing came of it; maybe try again a while longer.
    feel(agent, "anger", 0.05); // wasted material grates a little
    a.untilTick = world.tick + TINKER_TICKS;
    return world.rng.chance(0.5);
  },
};

function recordFirsts(agent: Agent, ctx: AgentContext, result: ReturnType<typeof performAttempt>, verb: string): void {
  const world = ctx.world;
  if (!result || result === true) return; // successes without an item tell their own story
  const what = describeItem(result);
  if (verb === "bundle" && world.isFirst("bundle")) {
    world.chronicle.add(world.tick, "crafting", `${agent.label} wove fibers into ${what}: things can be carried now.`, {
      agentId: agent.id,
      item: result.id,
    });
  } else if (verb === "shape" && world.isFirst("shaped")) {
    world.chronicle.add(world.tick, "crafting", `${agent.label} struck stone against stone until an edge appeared: ${what}.`, {
      agentId: agent.id,
      item: result.id,
    });
  } else if (verb === "mix" && world.isFirst("paste")) {
    world.chronicle.add(world.tick, "crafting", `${agent.label} worked wet earth and fibers together into ${what}.`, {
      agentId: agent.id,
      item: result.id,
    });
  } else if (verb === "bind" && world.isFirst("bound")) {
    const partNames = Object.keys(result.parts)
      .map((id) => describe(world.materials.get(Number(id))?.props ?? {}))
      .join(" and ");
    world.chronicle.add(world.tick, "crafting", `${agent.label} tied ${partNames} together and made ${what}.`, {
      agentId: agent.id,
      item: result.id,
    });
  }
  if (world.isFirst("crafted")) {
    world.chronicle.add(world.tick, "crafting", `The first made thing: ${what}, by ${agent.label}.`, {
      agentId: agent.id,
      item: result.id,
    });
  }
}
