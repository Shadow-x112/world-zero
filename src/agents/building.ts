// The nesting instinct: the one built-in push toward shelter.
//
// An AI that has been hurt by the cold remembers it. While that memory is
// strong, it is drawn (most of all in the late afternoon) to fetch material
// it doesn't eat and pile it around the place where it sleeps. Where exactly
// it puts each piece starts out random among the spots it can reach: beside
// its sleeping place (a wall) or, once something stands close enough to hold
// it up, over its head (a roof). After each night it compares how sheltered
// its place felt with the night before and leans toward whichever kind of
// placement helped. Walls closing a circle, roofs, huts and shared shelters
// are left to emerge from that.

import { TICKS_PER_DAY } from "../core/constants.ts";
import type { World } from "../core/world.ts";
import { BRICK_ID, describe, type MaterialType } from "../materials/registry.ts";
import {
  addToBlock,
  blockAt,
  canEscape,
  ESCAPE_RADIUS,
  roofSupported,
  shelterAt,
  unitsPerBlock,
  unitsToComplete,
  type Level,
} from "../building/structures.ts";
import type { Agent, Nest } from "./agent.ts";
import {
  addCarried,
  approach,
  goTo,
  handle,
  isKnownFood,
  roomFor,
  pickupTicks,
  survey,
  takeFromTile,
  toolDidWork,
} from "./foraging.ts";
import type { ActionDef, AgentContext } from "./movement.ts";
import { practice, workSpeed } from "./skill.ts";

/** Remembered cold (health lost) at which the urge to build is at its strongest. */
export const COLD_URGE_FULL = 0.3;
/** World seconds to set one load of material in place. */
export const PLACE_TICKS = 120;
/** An existing block weaker than this gets topped up with matching material. */
export const REPAIR_BELOW = 700;
/** Farthest an AI will carry material home to its nest, in tiles. */
export const NEST_REACH = 60;
/** A nest not slept in for this many days, far from where it now sleeps, is given up. */
export const NEST_ABANDON_DAYS = 3;
/** Ground material at least this hard must be cleared before a wall can stand there; softer things are built over. */
export const BUILD_OVER_HARDNESS = 0.3;
/** How strongly one night's change in warmth shifts its leaning. */
export const LEARN_RATE = 4;
export const LEANING_MIN = 0.2;
export const LEANING_MAX = 5;

const AROUND: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

const label = (id: number) => `#${String(id).padStart(2, "0")}`;

/** Days into a pairing after which the two want a proper roof. */
export const PAIR_NESTING_DAYS = 5;

/**
 * How strongly it wants to build right now (0-1): remembered cold - and, cold
 * or not, a bonded pair wants a roof over its nest for what may come. Either
 * way the urge eases as the sleeping place grows snug.
 */
export function buildUrge(agent: Agent, world: World): number {
  let want = Math.min(1, agent.coldMemory / COLD_URGE_FULL);
  if (agent.mate !== null && world.tick - agent.bondedTick > PAIR_NESTING_DAYS * TICKS_PER_DAY) {
    if (world.population.get(agent.mate)) want = Math.max(want, 0.55);
  }
  if (want === 0 || !agent.nest) return want;
  const snug = shelterAt(world, agent.nest.x, agent.nest.y);
  return want * Math.min(1, (1 - snug) * 2);
}

export interface CarriedBuilding {
  material: number;
  units: number;
  mass: number;
  type: MaterialType;
}

/** The material it carries that it doesn't eat (the most of, by weight), if any. */
export function carriedBuilding(agent: Agent, world: World): CarriedBuilding | null {
  let best: CarriedBuilding | null = null;
  for (const c of agent.carrying) {
    const type = world.materials.get(c.material);
    if (!type || isKnownFood(agent, type)) continue;
    const mass = c.units * type.props.mass;
    if (!best || mass > best.mass) best = { material: c.material, units: c.units, mass, type };
  }
  return best;
}

function unitsCarried(agent: Agent, material: number): number {
  return agent.carrying.find((c) => c.material === material)?.units ?? 0;
}

function dropUnits(agent: Agent, material: number, units: number): void {
  const entry = agent.carrying.find((c) => c.material === material);
  if (!entry) return;
  entry.units -= units;
  if (entry.units <= 0) agent.carrying = agent.carrying.filter((c) => c !== entry);
}

const tileKey = (x: number, y: number) => (x + 1048576) * 2097152 + (y + 1048576);

/** Tiles where someone alive has made their sleeping place. */
function nestTiles(ctx: AgentContext, except?: Agent): Set<number> {
  const out = new Set<number>();
  for (const a of ctx.population.all()) if (a !== except && a.nest) out.add(tileKey(a.nest.x, a.nest.y));
  return out;
}

/**
 * The AI's nest, settling on one if needed: the place it last slept. A nest
 * long unused and far from where it now sleeps is given up for a new one.
 */
export function nestOf(agent: Agent, ctx: AgentContext): Nest | null {
  const world = ctx.world;
  const grid = world.grid;
  let nest = agent.nest;
  if (nest && !grid.isWalkable(nest.x, nest.y)) nest = null;
  const last = agent.lastSleep;
  if (nest && last) {
    const away = Math.hypot(last.x - nest.x, last.y - nest.y);
    if (away > 20 && world.tick - nest.lastSlept > NEST_ABANDON_DAYS * TICKS_PER_DAY) nest = null;
  }
  // One of a pair without a place of its own shares its mate's.
  if (!nest && agent.mate !== null) {
    const mate = ctx.population.get(agent.mate);
    if (mate?.nest && world.grid.isWalkable(mate.nest.x, mate.nest.y)) {
      nest = { x: mate.nest.x, y: mate.nest.y, lastSlept: world.tick };
    }
  }
  if (!nest && last) {
    // Its last sleeping place, unless that is someone else's; then a free spot beside it.
    const taken = nestTiles(ctx, agent);
    let spot: [number, number] | null = null;
    for (let r = 0; r <= 2 && !spot; r++) {
      for (let oy = -r; oy <= r && !spot; oy++) {
        for (let ox = -r; ox <= r && !spot; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
          const x = last.x + ox;
          const y = last.y + oy;
          if (grid.isWalkable(x, y) && !taken.has(tileKey(x, y))) spot = [x, y];
        }
      }
    }
    if (spot) {
      nest = { x: spot[0], y: spot[1], lastSlept: world.tick };
      agent.home = { x: spot[0], y: spot[1] }; // where it sleeps and builds is home
      agent.feltShelter = shelterAt(world, spot[0], spot[1]);
      agent.placedSinceWake = { wall: 0, roof: 0 };
    }
  }
  agent.nest = nest;
  return nest;
}

export interface Placement {
  level: Level;
  x: number;
  y: number;
  /** Adding to a block already there (of the same material). */
  existing: boolean;
}

/** Whether a new wall may go on a tile without walling anyone (or anyone's sleeping place) in. */
export function wallAllowed(ctx: AgentContext, x: number, y: number, nests: Set<number>): boolean {
  const grid = ctx.world.grid;
  if (!grid.isWalkable(x, y) || nests.has(tileKey(x, y))) return false;
  // Soft things growing there can be built over; anything sturdy has to go first.
  if (grid.get("amount", x, y) > 0) {
    const type = ctx.world.materials.get(grid.get("material", x, y));
    if (type && type.props.hardness >= BUILD_OVER_HARDNESS) return false;
  }
  if (ctx.index.near(x, y, 0.9).length > 0) return false; // someone is standing there
  for (const { agent } of ctx.index.near(x, y, ESCAPE_RADIUS)) {
    if (!canEscape(grid, agent.tileX, agent.tileY, x, y)) return false;
  }
  for (const a of ctx.population.all()) {
    const n = a.nest;
    if (!n || Math.abs(n.x - x) > ESCAPE_RADIUS || Math.abs(n.y - y) > ESCAPE_RADIUS) continue;
    if (!canEscape(grid, n.x, n.y, x, y)) return false;
  }
  return true;
}

/** Everywhere around its nest that a load of this material could go right now. */
export function placements(agent: Agent, ctx: AgentContext, nest: Nest, type: MaterialType): Placement[] {
  const grid = ctx.world.grid;
  const out: Placement[] = [];
  const nests = nestTiles(ctx);
  for (const [dx, dy] of AROUND) {
    const x = nest.x + dx;
    const y = nest.y + dy;
    const wall = blockAt(grid, "wall", x, y);
    if (wall) {
      if (wall.material === type.id && wall.hp < REPAIR_BELOW) out.push({ level: "wall", x, y, existing: true });
    } else if (wallAllowed(ctx, x, y, nests)) {
      out.push({ level: "wall", x, y, existing: false });
    }
  }
  const roof = blockAt(grid, "roof", nest.x, nest.y);
  if (roof) {
    if (roof.material === type.id && roof.hp < REPAIR_BELOW) out.push({ level: "roof", x: nest.x, y: nest.y, existing: true });
  } else if (roofSupported(grid, nest.x, nest.y, type)) {
    out.push({ level: "roof", x: nest.x, y: nest.y, existing: false });
  }
  return out;
}

/** Picks where to put a load: finishing what's started first, otherwise as its leaning says. */
export function choosePlacement(agent: Agent, world: World, options: Placement[]): Placement {
  const rng = world.rng;
  const started = options.filter((o) => o.existing);
  if (started.length > 0) return started[rng.int(0, started.length - 1)];
  const walls = options.filter((o) => o.level === "wall");
  const roofs = options.filter((o) => o.level === "roof");
  const w = walls.length > 0 ? agent.buildLeaning.wall : 0;
  const r = roofs.length > 0 ? agent.buildLeaning.roof : 0;
  const pool = rng.next() * (w + r) < w ? walls : roofs;
  return pool[rng.int(0, pool.length - 1)];
}

function recordFirsts(agent: Agent, world: World, p: Placement, type: MaterialType, nest: Nest): void {
  const what = describe(type.props);
  if (type.id === BRICK_ID && world.isFirst("brickWall")) {
    world.chronicle.add(world.tick, "building", `${agent.label} laid bricks into a wall: the first made material put to work.`, {
      agentId: agent.id, x: p.x, y: p.y,
    });
  }
  if (p.level === "wall" && world.isFirst("block")) {
    world.chronicle.add(world.tick, "building", `${agent.label} piled ${what} beside the place where it sleeps: the first thing anyone has built.`, {
      agentId: agent.id, x: p.x, y: p.y, material: type.id,
    });
  }
  if (p.level === "roof" && world.isFirst("roof")) {
    world.chronicle.add(world.tick, "building", `${agent.label} raised ${what} over the place where it sleeps: the first cover overhead.`, {
      agentId: agent.id, x: p.x, y: p.y, material: type.id,
    });
  }
  if (!world.firsts.has("shelter") && shelterAt(world, nest.x, nest.y) >= 0.75 && world.isFirst("shelter")) {
    world.chronicle.add(world.tick, "building", `${agent.label}'s sleeping place is walled in and covered: the first true shelter.`, {
      agentId: agent.id, x: nest.x, y: nest.y,
    });
  }
}

/**
 * On waking at its nest: how did the night feel compared with the last one
 * there? Whatever it built since then gets the credit (or the blame).
 */
export function wakeAtNest(agent: Agent, world: World): void {
  agent.lastSleep = { x: agent.tileX, y: agent.tileY };
  const nest = agent.nest;
  if (!nest || nest.x !== agent.tileX || nest.y !== agent.tileY) return;
  nest.lastSlept = world.tick;
  const felt = shelterAt(world, nest.x, nest.y);
  const placed = agent.placedSinceWake;
  const total = placed.wall + placed.roof;
  if (total > 0 && agent.feltShelter >= 0) {
    const perPlacement = (felt - agent.feltShelter) / total;
    for (const level of ["wall", "roof"] as Level[]) {
      if (placed[level] === 0) continue;
      const lean = agent.buildLeaning[level] + LEARN_RATE * perPlacement;
      agent.buildLeaning[level] = Math.min(LEANING_MAX, Math.max(LEANING_MIN, lean));
    }
  }
  agent.feltShelter = felt;
  agent.placedSinceWake = { wall: 0, roof: 0 };
}

/** Build: fetch material it doesn't eat and add it around its sleeping place. */
export const BUILD: ActionDef = {
  type: "build",
  start(agent, ctx) {
    const world = ctx.world;
    const nest = nestOf(agent, ctx);
    if (!nest || Math.hypot(nest.x - agent.x, nest.y - agent.y) > NEST_REACH) return false;
    const a = agent.action!;
    const carried = carriedBuilding(agent, world);
    const source = survey(agent, ctx).buildable;
    if (carried && (carried.mass >= 0.3 || !source)) {
      if (placements(agent, ctx, nest, carried.type).length === 0) return false;
      a.phase = "place";
      a.material = carried.material;
      a.untilTick = world.tick + Math.round(PLACE_TICKS / workSpeed(agent.skills.building));
      return goTo(agent, ctx, nest);
    }
    if (!source) return false;
    const type = world.materials.require(source.material);
    if (roomFor(agent, world, type) === 0) return false;
    if (placements(agent, ctx, nest, type).length === 0) return false;
    a.phase = "fetch";
    a.material = source.material;
    a.untilTick = world.tick + pickupTicks(agent, world, type);
    return goTo(agent, ctx, source);
  },
  step(agent, ctx) {
    const world = ctx.world;
    const a = agent.action!;
    const nest = agent.nest;
    if (!nest) return true;

    if (a.phase === "fetch") {
      const state = approach(agent, ctx);
      if (state === "stuck") return true;
      const type = world.materials.require(a.material!);
      if (state === "walking") {
        a.untilTick = world.tick + pickupTicks(agent, world, type);
        return false;
      }
      if (world.tick < (a.untilTick ?? 0)) return false;
      a.untilTick = world.tick + pickupTicks(agent, world, type);
      if (unitsCarried(agent, type.id) < unitsPerBlock(type) && roomFor(agent, world, type) > 0) {
        const taken = takeFromTile(world, a.targetX!, a.targetY!, type.id);
        if (taken) {
          handle(agent, world, taken);
          toolDidWork(agent, world, taken);
          practice(agent, "gathering", true, world);
          addCarried(agent, taken.id, 1);
          if (unitsCarried(agent, type.id) < unitsPerBlock(type) && roomFor(agent, world, type) > 0) return false;
        }
      }
      if (unitsCarried(agent, type.id) === 0) return true; // nothing left here
      // Carry it home.
      a.phase = "place";
      a.untilTick = world.tick + Math.round(PLACE_TICKS / workSpeed(agent.skills.building));
      return !goTo(agent, ctx, nest);
    }

    // Placing.
    const state = approach(agent, ctx);
    if (state === "stuck") return true;
    if (state === "walking") {
      a.untilTick = world.tick + Math.round(PLACE_TICKS / workSpeed(agent.skills.building));
      return false;
    }
    if (world.tick < (a.untilTick ?? 0)) return false;
    a.untilTick = world.tick + Math.round(PLACE_TICKS / workSpeed(agent.skills.building));
    const type = world.materials.require(a.material!);
    const have = unitsCarried(agent, type.id);
    if (have === 0) return true;
    const options = placements(agent, ctx, nest, type);
    if (options.length === 0) {
      // Nowhere left for it: set the rest down here.
      dropOnGround(agent, world, type.id, have);
      return true;
    }
    const spot = choosePlacement(agent, world, options);
    const use = Math.min(have, unitsToComplete(world.grid, spot.level, spot.x, spot.y, type));
    if (use > 0 && addToBlock(world, spot.level, spot.x, spot.y, type, use, agent.id) > 0) {
      dropUnits(agent, type.id, use);
      agent.placedSinceWake[spot.level]++;
      agent.stats.blocksPlaced++;
      practice(agent, "building", true, world);
      recordFirsts(agent, world, spot, type, nest);
    }
    return unitsCarried(agent, type.id) === 0;
  },
};

/** Puts carried units down on the tile it stands on (if that tile is bare or holds the same thing). */
function dropOnGround(agent: Agent, world: World, material: number, units: number): void {
  const grid = world.grid;
  const x = agent.tileX;
  const y = agent.tileY;
  const here = grid.get("material", x, y);
  const amount = grid.get("amount", x, y);
  dropUnits(agent, material, units);
  if (here !== 0 && here !== material) return; // no room for it: left scattered (gone)
  grid.set("material", x, y, material);
  grid.set("amount", x, y, Math.min(65535, amount + units));
}
