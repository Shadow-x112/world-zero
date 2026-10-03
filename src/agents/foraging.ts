// Finding, learning about, carrying and eating materials.
//
// AIs start knowing nothing about any material. They learn through their own
// senses: looking reveals size, growth and glow; handling reveals hardness,
// sharpness, flexibility and weight; tasting reveals whether it nourishes and
// whether it harms. Hunger and curiosity push them to try things.

import type { World } from "../core/world.ts";
import {
  TACTILE,
  TASTED,
  UNIT_ENERGY,
  VISIBLE,
  describe,
  harmPerUnit,
  isRipe,
  regrows,
  type MaterialType,
} from "../materials/registry.ts";
import type { Agent, Carried, MaterialKnowledge } from "./agent.ts";
import { followPath, planRoute, type ActionDef, type AgentContext } from "./movement.ts";
import { sightRadius } from "./senses.ts";
import { shelterAt } from "../building/structures.ts";
import { WEAR_PER_USE, breakPower, carryBonus, cutPower, describeItem, type Item } from "../items/item.ts";

/** What the arms alone can carry, in units of mass (a woven carrier adds to it). */
export const CARRY_CAPACITY = 1.2;
/** World seconds to eat one unit. */
export const BITE_TICKS = 90;
/** World seconds to pick up one unit of the softest material, bare-handed. */
export const PICKUP_TICKS = 20;
/** Picking gets slower the harder the material is to work loose (bare-handed). */
export const PICKUP_HARDNESS_FACTOR = 1.0;
/** Nourishment below this isn't worth eating. */
export const FOOD_THRESHOLD = 0.3;
/** Places with food an AI can remember at once. */
export const FOOD_MEMORY = 24;
/** Stop eating once energy is this full. */
export const SATED = 0.97;
/** Units of food an AI likes to have on hand when gathering. */
export const GATHER_TARGET = 6;
/** Sheltered places an AI can remember at once. */
export const SHELTER_MEMORY = 8;
/** A covered place this sheltered is worth remembering. */
export const SHELTER_WORTH_REMEMBERING = 0.4;

export function knowledgeOf(agent: Agent, id: number): MaterialKnowledge | undefined {
  return agent.knowledge[id];
}

/** The first sight of a kind of material: what it looks like. */
export function notice(agent: Agent, world: World, type: MaterialType): MaterialKnowledge {
  let k = agent.knowledge[type.id];
  if (!k) {
    k = { firstSeenTick: world.tick, handled: false, tasted: false, props: {}, timesEaten: 0 };
    for (const p of VISIBLE) k.props[p] = type.props[p];
    agent.knowledge[type.id] = k;
  }
  return k;
}

/** Picking something up: learns how it feels. Returns true if this was new. */
export function handle(agent: Agent, world: World, type: MaterialType): boolean {
  const k = notice(agent, world, type);
  if (k.handled) return false;
  k.handled = true;
  for (const p of TACTILE) k.props[p] = type.props[p];
  return true;
}

/** Tasting one unit: learns whether it nourishes or harms, and feels the effect. */
export function taste(agent: Agent, world: World, type: MaterialType): void {
  const k = notice(agent, world, type);
  handle(agent, world, type);
  const firstTime = !k.tasted;
  k.tasted = true;
  for (const p of TASTED) k.props[p] = type.props[p];
  consumeEffect(agent, type);
  if (firstTime && world.isFirst(`taste:${type.id}`)) {
    const nourishing = type.props.nourishment >= FOOD_THRESHOLD;
    const harmful = harmPerUnit(type) > 0;
    const verdict = harmful ? "It hurt." : nourishing ? "It was nourishing." : "It was not food.";
    world.chronicle.add(world.tick, "discovery", `${agent.label} tasted ${describe(type.props)} for the first time. ${verdict}`, {
      agentId: agent.id,
      material: type.id,
    });
  }
}

/** What eating one unit does to a body. */
function consumeEffect(agent: Agent, type: MaterialType): void {
  agent.needs.energy = Math.min(1, agent.needs.energy + type.props.nourishment * UNIT_ENERGY);
  const harm = harmPerUnit(type);
  if (harm > 0) {
    agent.health -= harm;
    agent.damage.poisoning += harm;
  }
}

/** Whether this AI knows the material to be food (and it is in season). */
/** Whether this AI has learned that a material nourishes (in season or not). */
export function isKnownFood(agent: Agent, type: MaterialType): boolean {
  const k = agent.knowledge[type.id];
  return !!k && k.tasted && (k.props.nourishment ?? 0) >= FOOD_THRESHOLD && harmPerUnit(type) === 0;
}

export function isFoodTo(agent: Agent, type: MaterialType, season: string): boolean {
  const k = agent.knowledge[type.id];
  return !!k && k.tasted && (k.props.nourishment ?? 0) >= FOOD_THRESHOLD && harmPerUnit(type) === 0 && isRipe(type, season);
}

// --- Carrying ---------------------------------------------------------------

export function carriedMass(agent: Agent, world: World): number {
  let mass = 0;
  for (const c of agent.carrying) mass += c.units * (world.materials.get(c.material)?.props.mass ?? 0);
  for (const item of agent.items) mass += item.props.mass;
  return mass;
}

/** What this AI can carry: its arms, plus whatever woven carriers it holds spread. */
export function carryCapacity(agent: Agent): number {
  let bonus = 0;
  for (const item of agent.items) bonus += carryBonus(item);
  return CARRY_CAPACITY + Math.min(1.2, bonus);
}

export function roomFor(agent: Agent, world: World, type: MaterialType): number {
  const free = carryCapacity(agent) - carriedMass(agent, world);
  return Math.max(0, Math.floor(free / Math.max(0.01, type.props.mass) + 1e-9));
}

// --- Tools --------------------------------------------------------------------

/** The carried item that most speeds working this material loose, if any helps. */
export function bestToolFor(agent: Agent, type: MaterialType): { item: Item; factor: number } | null {
  let best: { item: Item; factor: number } | null = null;
  for (const item of agent.items) {
    // Soft and fibrous things are cut free; hard things are broken loose.
    const factor = type.props.hardness < 0.5 ? 1 + cutPower(item) : 1 + breakPower(item) * 1.5;
    if (factor >= 1.15 && (!best || factor > best.factor)) best = { item, factor };
  }
  return best;
}

/** World seconds to work one unit loose, given what the AI holds. */
export function pickupTicks(agent: Agent, world: World, type: MaterialType): number {
  const bare = PICKUP_TICKS * (1 + PICKUP_HARDNESS_FACTOR * type.props.hardness);
  const tool = bestToolFor(agent, type);
  return Math.max(5, Math.round(bare / (tool ? tool.factor : 1)));
}

/** After a unit came loose: the tool that helped wears a little, and its help is remembered. */
export function toolDidWork(agent: Agent, world: World, type: MaterialType): void {
  const tool = bestToolFor(agent, type);
  if (!tool) return;
  tool.item.uses++;
  tool.item.wear -= WEAR_PER_USE;
  if (tool.item.uses === 3 && world.isFirst("toolHelped")) {
    world.chronicle.add(
      world.tick,
      "crafting",
      `${agent.label}'s work keeps going faster with ${describeItem(tool.item)} in hand: the first tool.`,
      { agentId: agent.id, item: tool.item.id },
    );
  }
  if (tool.item.wear <= 0) agent.items = agent.items.filter((i) => i !== tool.item);
}

/** Sets down the least proven item to make room (remembering not to re-grab it at once). */
export function shedLeastUseful(agent: Agent, world: World): boolean {
  if (agent.items.length === 0) return false;
  let worst: Item | null = null;
  for (const item of agent.items) {
    if (carryBonus(item) > 0) continue; // a carrier is making room, not taking it
    if (!worst || item.uses < worst.uses) worst = item;
  }
  if (!worst || worst.uses > 10) return false;
  agent.items = agent.items.filter((i) => i !== worst);
  world.groundItems.drop(agent.tileX, agent.tileY, worst);
  agent.recentlyDropped.push(worst.id);
  if (agent.recentlyDropped.length > 4) agent.recentlyDropped.shift();
  return true;
}

/** Everything falls where the AI stands (called when it dies). */
export function dropEverything(agent: Agent, world: World): void {
  for (const item of agent.items) world.groundItems.drop(agent.tileX, agent.tileY, item);
  agent.items = [];
  const grid = world.grid;
  for (const c of agent.carrying) {
    // Onto its own tile, or the first neighboring tile that can take it.
    for (let r = 0; r <= 1; r++) {
      let placed = false;
      for (let oy = -r; oy <= r && !placed; oy++) {
        for (let ox = -r; ox <= r && !placed; ox++) {
          const x = agent.tileX + ox;
          const y = agent.tileY + oy;
          if (grid.peek("wall", x, y) !== 0) continue;
          const here = grid.get("material", x, y);
          if (here !== 0 && here !== c.material) continue;
          grid.set("material", x, y, c.material);
          grid.set("amount", x, y, Math.min(65535, grid.get("amount", x, y) + c.units));
          placed = true;
        }
      }
      if (placed) break;
    }
  }
  agent.carrying = [];
}

export function addCarried(agent: Agent, material: number, units: number): void {
  const entry = agent.carrying.find((c) => c.material === material);
  if (entry) entry.units += units;
  else agent.carrying.push({ material, units });
}

function takeCarried(agent: Agent, material: number): boolean {
  const entry = agent.carrying.find((c) => c.material === material);
  if (!entry || entry.units <= 0) return false;
  entry.units--;
  if (entry.units === 0) agent.carrying = agent.carrying.filter((c) => c !== entry);
  return true;
}

/** The best food the AI is carrying, if any. */
export function carriedFood(agent: Agent, world: World): Carried | null {
  let best: Carried | null = null;
  let bestN = -1;
  for (const c of agent.carrying) {
    const type = world.materials.get(c.material);
    if (!type || !isFoodTo(agent, type, world.calendar.season)) continue;
    if (type.props.nourishment > bestN) {
      bestN = type.props.nourishment;
      best = c;
    }
  }
  return best;
}

export function carriedFoodUnits(agent: Agent, world: World): number {
  let n = 0;
  for (const c of agent.carrying) {
    const type = world.materials.get(c.material);
    if (type && isFoodTo(agent, type, world.calendar.season)) n += c.units;
  }
  return n;
}

// --- Looking around ---------------------------------------------------------

export interface Spot {
  x: number;
  y: number;
  material: number;
  dist: number;
}

export interface Survey {
  /** Nearest visible food (as this AI understands food). */
  food: Spot | null;
  /** Nearest visible material it has never tasted. */
  untasted: Spot | null;
  /** Nearest visible material it has never handled. */
  unhandled: Spot | null;
  /** Nearest visible material it doesn't eat (something to build with). */
  buildable: Spot | null;
}

const surveys = new WeakMap<Agent, { tick: number; survey: Survey }>();

/** What the AI can see around it right now (computed at most once per tick). */
export function survey(agent: Agent, ctx: AgentContext): Survey {
  const cached = surveys.get(agent);
  if (cached && cached.tick === ctx.world.tick) return cached.survey;
  const result = look(agent, ctx);
  surveys.set(agent, { tick: ctx.world.tick, survey: result });
  return result;
}

function look(agent: Agent, ctx: AgentContext): Survey {
  const world = ctx.world;
  const grid = world.grid;
  const season = world.calendar.season;
  const radius = Math.floor(sightRadius(world.calendar.light));
  const r2 = radius * radius;
  const ax = agent.tileX;
  const ay = agent.tileY;
  const out: Survey = { food: null, untasted: null, unhandled: null, buildable: null };
  const seenFood: Spot[] = [];

  for (let oy = -radius; oy <= radius; oy++) {
    for (let ox = -radius; ox <= radius; ox++) {
      const d2 = ox * ox + oy * oy;
      if (d2 > r2) continue;
      const x = ax + ox;
      const y = ay + oy;
      // Covered places are noticed and remembered as somewhere to shelter.
      if (grid.peek("roof", x, y) !== 0) noticeShelter(agent, world, x, y);
      if (grid.peek("wall", x, y) !== 0) continue; // whatever is under a wall can't be reached
      const id = grid.get("material", x, y);
      if (id === 0 || grid.get("amount", x, y) === 0) continue;
      const type = world.materials.get(id);
      if (!type) continue;
      const k = notice(agent, world, type);
      const dist = Math.sqrt(d2);
      if (isFoodTo(agent, type, season)) {
        seenFood.push({ x, y, material: id, dist });
        if (!out.food || dist < out.food.dist) out.food = { x, y, material: id, dist };
      } else if (!k.tasted && (!out.untasted || dist < out.untasted.dist)) {
        out.untasted = { x, y, material: id, dist };
      }
      if (!k.handled && (!out.unhandled || dist < out.unhandled.dist)) out.unhandled = { x, y, material: id, dist };
      if (!isKnownFood(agent, type) && (!out.buildable || dist < out.buildable.dist)) out.buildable = { x, y, material: id, dist };
    }
  }

  // Refresh food memory: forget remembered spots in view that no longer have food; remember what's seen.
  agent.foodSpots = agent.foodSpots.filter((s) => {
    const inView = (s.x - ax) ** 2 + (s.y - ay) ** 2 <= r2;
    return !inView || seenFood.some((f) => f.x === s.x && f.y === s.y);
  });
  seenFood.sort((a, b) => a.dist - b.dist);
  for (const f of seenFood.slice(0, 6)) remember(agent, world, f.x, f.y, f.material);
  return out;
}

/** Remembers (or forgets) a covered place depending on how sheltered it is now. */
function noticeShelter(agent: Agent, world: World, x: number, y: number): void {
  const spots = agent.shelterSpots;
  const i = spots.findIndex((s) => s.x === x && s.y === y);
  const value = world.grid.isWalkable(x, y) ? shelterAt(world, x, y) : 0;
  if (value < SHELTER_WORTH_REMEMBERING) {
    if (i >= 0) spots.splice(i, 1);
    return;
  }
  if (i >= 0) spots.splice(i, 1);
  spots.push({ x, y, value, tick: world.tick });
  if (spots.length > SHELTER_MEMORY) {
    // Forget the least sheltered.
    let worst = 0;
    for (let j = 1; j < spots.length; j++) if (spots[j].value < spots[worst].value) worst = j;
    spots.splice(worst, 1);
  }
}

function remember(agent: Agent, world: World, x: number, y: number, material: number): void {
  const spots = agent.foodSpots;
  const existing = spots.findIndex((s) => s.x === x && s.y === y);
  if (existing >= 0) spots.splice(existing, 1);
  spots.push({ x, y, material, tick: world.tick });
  if (spots.length > FOOD_MEMORY) spots.shift();
}

function forget(agent: Agent, x: number, y: number): void {
  agent.foodSpots = agent.foodSpots.filter((s) => s.x !== x || s.y !== y);
}

/** The nearest remembered place with food (that is still in season). */
export function rememberedFood(agent: Agent, world: World): Spot | null {
  let best: Spot | null = null;
  for (const s of agent.foodSpots) {
    const type = world.materials.get(s.material);
    if (!type || !isFoodTo(agent, type, world.calendar.season)) continue;
    const dist = Math.hypot(s.x - agent.x, s.y - agent.y);
    if (!best || dist < best.dist) best = { ...s, dist };
  }
  return best;
}

/** Whether the AI has any way to eat right now: food in hand, in sight or in memory. */
export function hasFoodOption(agent: Agent, ctx: AgentContext): boolean {
  return carriedFood(agent, ctx.world) !== null || survey(agent, ctx).food !== null || rememberedFood(agent, ctx.world) !== null;
}

// --- Taking from the ground ---------------------------------------------------

/** Removes one unit from a tile. Returns the material type taken, or null if nothing is there. */
export function takeFromTile(world: World, x: number, y: number, material: number): MaterialType | null {
  const grid = world.grid;
  if (grid.get("material", x, y) !== material) return null;
  const amount = grid.get("amount", x, y);
  if (amount <= 0) return null;
  const type = world.materials.get(material);
  if (!type) return null;
  grid.set("amount", x, y, amount - 1);
  // Things that don't grow are gone once used up; growing things keep their roots.
  if (amount - 1 === 0 && !regrows(type)) grid.set("material", x, y, 0);
  return type;
}

export function atTarget(agent: Agent): boolean {
  const a = agent.action!;
  return a.targetX === undefined || (agent.tileX === a.targetX && agent.tileY === a.targetY && !agent.hasPath());
}

/** Starts walking to a spot. Returns false if it can't be reached at all. */
export function goTo(agent: Agent, ctx: AgentContext, spot: { x: number; y: number }): boolean {
  agent.action!.targetX = spot.x;
  agent.action!.targetY = spot.y;
  if (agent.tileX === spot.x && agent.tileY === spot.y) return true;
  return planRoute(agent, ctx, spot.x, spot.y);
}

/** Walks toward the action's target. Returns "arrived", "walking" or "stuck". */
export function approach(agent: Agent, ctx: AgentContext): "arrived" | "walking" | "stuck" {
  if (atTarget(agent)) return "arrived";
  if (agent.hasPath()) {
    followPath(agent, ctx);
    return atTarget(agent) ? "arrived" : "walking";
  }
  // Route ran out before the target (long trips are walked in legs).
  const a = agent.action!;
  if (!planRoute(agent, ctx, a.targetX!, a.targetY!)) return "stuck";
  return "walking";
}

function eatOne(agent: Agent, world: World, type: MaterialType): void {
  consumeEffect(agent, type);
  const k = notice(agent, world, type);
  k.timesEaten++;
  agent.stats.meals++;
  if (world.isFirst("meal")) {
    world.chronicle.add(world.tick, "discovery", `The first meal: ${agent.label} ate ${describe(type.props)} and was nourished.`, {
      agentId: agent.id,
      material: type.id,
    });
  }
}

// --- Actions ------------------------------------------------------------------

/** Eat: from what it carries, or by going to known food. */
export const EAT: ActionDef = {
  type: "eat",
  start(agent, ctx) {
    const a = agent.action!;
    a.untilTick = ctx.world.tick + BITE_TICKS;
    if (carriedFood(agent, ctx.world)) return true; // eat from hand, right here
    const spot = survey(agent, ctx).food ?? rememberedFood(agent, ctx.world);
    if (!spot) return false;
    a.material = spot.material; // which material it is after
    return goTo(agent, ctx, spot);
  },
  step(agent, ctx) {
    const world = ctx.world;
    const a = agent.action!;
    if (a.targetX !== undefined) {
      const state = approach(agent, ctx);
      if (state === "stuck") {
        forget(agent, a.targetX, a.targetY!);
        return true;
      }
      if (state === "walking") {
        a.untilTick = world.tick + BITE_TICKS;
        return false;
      }
    }
    if (world.tick < (a.untilTick ?? 0)) return false;
    a.untilTick = world.tick + BITE_TICKS;

    // One bite.
    if (a.targetX === undefined) {
      const food = carriedFood(agent, world);
      if (!food) return true;
      const type = world.materials.require(food.material);
      takeCarried(agent, food.material);
      eatOne(agent, world, type);
    } else {
      const type = takeFromTile(world, a.targetX, a.targetY!, a.material!);
      if (!type) {
        forget(agent, a.targetX, a.targetY!);
        return true;
      }
      eatOne(agent, world, type);
    }
    return agent.needs.energy >= SATED;
  },
};

/** Taste something it has never tasted. */
export const TASTE: ActionDef = {
  type: "taste",
  start(agent, ctx) {
    const spot = survey(agent, ctx).untasted;
    if (!spot) return false;
    agent.action!.material = spot.material;
    return goTo(agent, ctx, spot);
  },
  step(agent, ctx) {
    const a = agent.action!;
    const state = approach(agent, ctx);
    if (state === "stuck") return true;
    if (state === "walking") return false;
    const type = takeFromTile(ctx.world, a.targetX!, a.targetY!, a.material!);
    if (type) {
      taste(agent, ctx.world, type);
      agent.needs.curiosity = Math.min(1, agent.needs.curiosity + 0.12);
    }
    return true;
  },
};

/** Pick up and handle something it has never handled (doesn't use it up). */
export const INSPECT: ActionDef = {
  type: "inspect",
  start(agent, ctx) {
    const spot = survey(agent, ctx).unhandled;
    if (!spot) return false;
    agent.action!.material = spot.material;
    return goTo(agent, ctx, spot);
  },
  step(agent, ctx) {
    const a = agent.action!;
    const state = approach(agent, ctx);
    if (state === "stuck") return true;
    if (state === "walking") return false;
    const world = ctx.world;
    if (world.grid.get("material", a.targetX!, a.targetY!) === a.material) {
      const type = world.materials.require(a.material!);
      if (handle(agent, world, type)) agent.needs.curiosity = Math.min(1, agent.needs.curiosity + 0.1);
    }
    return true;
  },
};

/** Gather food to carry for later. */
export const GATHER: ActionDef = {
  type: "gather",
  start(agent, ctx) {
    const spot = survey(agent, ctx).food;
    if (!spot) return false;
    const type = ctx.world.materials.require(spot.material);
    if (roomFor(agent, ctx.world, type) === 0 && !shedLeastUseful(agent, ctx.world)) return false;
    agent.action!.material = spot.material;
    agent.action!.untilTick = ctx.world.tick + pickupTicks(agent, ctx.world, type);
    return goTo(agent, ctx, spot);
  },
  step(agent, ctx) {
    const world = ctx.world;
    const a = agent.action!;
    const state = approach(agent, ctx);
    if (state === "stuck") return true;
    const type = world.materials.require(a.material!);
    if (state === "walking") {
      a.untilTick = world.tick + pickupTicks(agent, world, type);
      return false;
    }
    if (world.tick < (a.untilTick ?? 0)) return false;
    a.untilTick = world.tick + pickupTicks(agent, world, type);
    if (roomFor(agent, world, type) === 0 || carriedFoodUnits(agent, world) >= GATHER_TARGET) return true;
    if (!takeFromTile(world, a.targetX!, a.targetY!, a.material!)) {
      forget(agent, a.targetX!, a.targetY!);
      return true;
    }
    toolDidWork(agent, world, type);
    addCarried(agent, type.id, 1);
    return false;
  },
};
