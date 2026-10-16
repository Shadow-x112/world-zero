// Fire: the HEAT rule made real. A fire lives on a tile, eats fuel by the
// hour, warms and lights everything near it - and takes whatever burnable
// thing it can reach: the growth on the ground, what is built, and flesh.
// It is dangerous from the first day it exists.
//
// A fire blazes, then smoulders. A fed fire blazes as long as it is fed; a
// patch of growth that catches flares for a few hours and then lies as embers
// for about a day. Blazing, it leaps to what is beside it; embers rarely do.
// Built things burn piece by piece: a pole that catches burns where it is,
// and whatever it held comes down.

import { TICKS_PER_DAY } from "../core/constants.ts";
import type { System, World } from "../core/world.ts";
import { hashFloat } from "../core/rng.ts";
import type { MaterialType } from "../materials/registry.ts";
import { BRICK_ID } from "../materials/registry.ts";
import { FULL_HP, burnPieces } from "../building/structures.ts";
import type { Piece } from "../building/pieces.ts";

/** Hours one unit of mass burns, per point of the material's energy. */
export const FUEL_HOURS_PER_MASS_ENERGY = 12;
/** What burns: organic material with energy stored in it. */
export function burnable(type: MaterialType): boolean {
  return type.props.energy >= 0.2 && type.props.growth > 0;
}
/** Fuel (tenths of an hour) that burning `units` of a material gives. */
export function fuelOf(type: MaterialType, units: number): number {
  return Math.round(type.props.energy * type.props.mass * units * FUEL_HOURS_PER_MASS_ENERGY * 10);
}

/** How far warmth reaches, in tiles, and how far the glow lets eyes see. */
export const WARMTH_RADIUS = 3;
export const GLOW_RADIUS = 5;
/** Fully warm beside a fire: this share of the night chill never reaches the body. */
export const WARMTH_FULL = 0.75;

/** The system looks at every fire this often (every 6 world minutes). */
export const FIRE_INTERVAL = 360;
/** Chance per look that a fire leaps to one adjacent burnable thing, in an ordinary season. */
export const SPREAD_CHANCE = 0.08;
export const SPREAD_WALL_CHANCE = 0.1;
export const SPREAD_ROOF_CHANCE = 0.2;
/** Chance per look that one burnable piece beside (or over) a blaze catches. */
export const SPREAD_PIECE_CHANCE = 0.06;
/** Embers leap this much less often than a blaze. */
export const EMBER_SPREAD = 0.1;
/** A patch of growth: the most it burns in all (tenths of an hour), and how long of that it blazes. */
export const WILD_FUEL_CAP = 240;
export const WILD_BLAZE = 50;
/** Dry late seasons burn fiercest; the cold is damp. */
export const SEASON_SPREAD: Record<string, number> = { growth: 0.6, peak: 1, decline: 1.5, cold: 0.7 };
/** Chance per look that wet earth beside a fire bakes hard. */
export const BAKE_CHANCE = 0.1;

/** Health lost per hour standing in a fire, and beside one. */
export const BURN_IN_FIRE = 2.0;
export const BURN_BESIDE_FIRE = 0.2;

const key = (x: number, y: number) => (x + 1048576) * 2097152 + (y + 1048576);
const AROUND: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * Starts (or feeds) a fire on a tile; what is fed blazes (all of it, unless told
 * how much). Returns the fuel now in it, in tenths of an hour.
 */
export function igniteAt(world: World, x: number, y: number, fuelTenths: number, blazeTenths = fuelTenths): number {
  const grid = world.grid;
  const add = Math.max(0, fuelTenths);
  const now = Math.min(65535, grid.peek("fire", x, y) + add);
  grid.set("fire", x, y, now);
  grid.set("blaze", x, y, Math.min(now, grid.peek("blaze", x, y) + Math.max(0, Math.min(add, blazeTenths))));
  world.fireTiles.set(key(x, y), { x, y });
  return now;
}

/** Fires from before blazes and embers: whatever burns is cut to at most a day of embers. */
export function tameOldFires(world: World): void {
  for (const chunk of world.grid.changedChunks()) {
    const fire = chunk.peekLayer("fire");
    if (!fire) continue;
    const blaze = chunk.peekLayer("blaze");
    for (let i = 0; i < fire.length; i++) {
      if (fire[i] > WILD_FUEL_CAP) fire[i] = WILD_FUEL_CAP;
      if (blaze) blaze[i] = 0; // (only embers came from before)
    }
  }
}

/** Whether a fire is blazing (rather than smouldering). */
export function blazingAt(world: World, x: number, y: number): boolean {
  return world.grid.peek("blaze", x, y) > 0;
}

/** Burnable pieces of a fire's reach: those belonging to a tile (standing there, or roofing it). */
function burnablePieces(world: World, x: number, y: number): Piece[] {
  return world.pieces.at(x, y).filter((p) => {
    const t = world.materials.get(p.material);
    return t !== undefined && burnable(t);
  });
}

/** Fuel (tenths of an hour) a burning piece gives. */
function pieceFuel(world: World, p: Piece): number {
  const t = world.materials.get(p.material);
  if (!t) return 0;
  return Math.max(1, Math.round((Math.max(0, p.hp) / FULL_HP) * p.mass * t.props.energy * FUEL_HOURS_PER_MASS_ENERGY * 10));
}

export function fireAt(world: World, x: number, y: number): number {
  return world.grid.peek("fire", x, y);
}

export function extinguishAt(world: World, x: number, y: number): void {
  world.grid.set("fire", x, y, 0);
  if (world.grid.peek("blaze", x, y) !== 0) world.grid.set("blaze", x, y, 0);
  world.fireTiles.delete(key(x, y));
}

/** How close the nearest fire is: 0 = none near, 1 = this very tile. */
function nearness(world: World, x: number, y: number, radius: number): number {
  let best = 0;
  for (const f of world.fireTiles.values()) {
    const d = Math.max(Math.abs(f.x - x), Math.abs(f.y - y));
    if (d > radius) continue;
    const n = 1 - d / (radius + 1);
    if (n > best) best = n;
  }
  return best;
}

/** Warmth from fires at a spot, 0-1 (1 = beside the flames). */
export function warmthAt(world: World, x: number, y: number): number {
  if (world.fireTiles.size === 0) return 0;
  return nearness(world, x, y, WARMTH_RADIUS);
}

/** The light a person standing here lives by: the sun, or a fire's glow. */
export function personalLight(world: World, x: number, y: number): number {
  const sun = world.calendar.light;
  if (sun >= 0.8 || world.fireTiles.size === 0) return sun;
  const glow = nearness(world, x, y, GLOW_RADIUS) * 0.9;
  return Math.max(sun, glow);
}

/** Whether standing here burns (on a fire, or right beside one). */
export function fireDanger(world: World, x: number, y: number): "in" | "beside" | null {
  if (world.fireTiles.size === 0) return null;
  if (fireAt(world, x, y) > 0) return "in";
  for (const [dx, dy] of AROUND) if (fireAt(world, x + dx, y + dy) > 0) return "beside";
  return null;
}

/** Whether any flame burns within `radius` tiles (square distance). */
export function flamesNear(world: World, x: number, y: number, radius: number): boolean {
  if (world.fireTiles.size === 0) return false;
  for (const f of world.fireTiles.values()) {
    if (Math.max(Math.abs(f.x - x), Math.abs(f.y - y)) <= radius) return true;
  }
  return false;
}

/** Burns fuel, spreads to what it can reach, bakes the earth, dies out. */
export class FireSystem implements System {
  readonly name = "fire";

  init(world: World): void {
    // Rebuild the index of burning tiles from the loaded ground.
    world.fireTiles.clear();
    for (const chunk of world.grid.changedChunks()) {
      const fire = chunk.peekLayer("fire");
      if (!fire) continue;
      for (let i = 0; i < fire.length; i++) {
        if (fire[i] === 0) continue;
        const x = chunk.cx * 32 + (i % 32);
        const y = chunk.cy * 32 + Math.floor(i / 32);
        world.fireTiles.set(key(x, y), { x, y });
      }
    }
  }

  update(world: World): void {
    if (world.tick % FIRE_INTERVAL !== 0 || world.fireTiles.size === 0) return;
    const grid = world.grid;
    const seed = world.meta.seed;
    const tick = world.tick;
    // Hashed rolls and a fixed order, so a loaded world burns exactly like one that never stopped.
    const roll = (salt: number, x: number, y: number) => hashFloat(seed, salt, x, y, tick);
    const season = SEASON_SPREAD[world.calendar.season] ?? 1;
    const burning = [...world.fireTiles.values()].sort((a, b) => a.x - b.x || a.y - b.y);

    for (const f of burning) {
      let fuel = grid.peek("fire", f.x, f.y);
      if (fuel === 0) {
        world.fireTiles.delete(key(f.x, f.y));
        continue;
      }
      const blaze = grid.peek("blaze", f.x, f.y);
      const fierce = blaze > 0 ? 1 : EMBER_SPREAD;
      const catching: Piece[] = [];
      // What is built here, over the flames, catches easily.
      for (const p of burnablePieces(world, f.x, f.y)) {
        if (hashFloat(seed, 8307, p.id, 0, tick) < SPREAD_ROOF_CHANCE * season * fierce) catching.push(p);
      }
      // Spread to whatever burnable thing lies or stands beside it.
      for (const [dx, dy] of AROUND) {
        const x = f.x + dx;
        const y = f.y + dy;
        if (fireAt(world, x, y) > 0) continue;
        const built = burnablePieces(world, x, y);
        for (const p of built) {
          if (hashFloat(seed, 8304, p.id, 0, tick) < SPREAD_PIECE_CHANCE * season * fierce) catching.push(p);
        }
        if (grid.peek("solid", x, y) !== 0) continue; // a wall shields the ground behind it
        const id = grid.get("material", x, y);
        const amount = id === 0 ? 0 : grid.get("amount", x, y);
        if (id !== 0 && amount > 0) {
          const type = world.materials.get(id);
          if (!type) continue;
          if (burnable(type) && roll(8305, x, y) < SPREAD_CHANCE * season * fierce) {
            // The patch goes up: it flares for a few hours, then smoulders.
            grid.set("amount", x, y, 0);
            if (type.props.growth < 0.5) grid.set("material", x, y, 0); // roots and all
            const wild = Math.min(WILD_FUEL_CAP, fuelOf(type, amount));
            igniteAt(world, x, y, wild, WILD_BLAZE);
            if (world.isFirst("wildfire")) {
              world.chronicle.add(world.tick, "fire", "The fire leapt to the growth around it and began to spread on its own.", { x, y });
            }
          } else if (type.props.reactivity >= 0.4 && type.props.hardness < 0.4 && roll(8306, x, y) < BAKE_CHANCE) {
            // Wet earth beside a fire bakes hard.
            grid.set("material", x, y, BRICK_ID);
            if (world.isFirst("bakedEarth")) {
              world.chronicle.add(world.tick, "fire", "The wet earth beside the fire baked hard as stone.", { x, y });
            }
          }
        }
      }
      if (catching.length > 0) this.burnBuilt(world, catching);
      // It eats its fuel: a tenth of an hour per look (and blazes a tenth less).
      fuel = grid.peek("fire", f.x, f.y) - 1;
      if (fuel <= 0) extinguishAt(world, f.x, f.y);
      else {
        grid.set("fire", f.x, f.y, fuel);
        const b = grid.peek("blaze", f.x, f.y);
        if (b > 0) grid.set("blaze", f.x, f.y, Math.min(fuel, b - 1));
      }
    }
  }

  /** Pieces catch: each burns away where it stood, a blaze in its place; what it held falls. */
  private burnBuilt(world: World, pieces: Piece[]): void {
    const unique = [...new Map(pieces.map((p) => [p.id, p])).values()].sort((a, b) => a.id - b.id);
    const fires = unique.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), fuel: pieceFuel(world, p) }));
    burnPieces(world, unique);
    for (const f of fires) igniteAt(world, f.x, f.y, f.fuel);
    const first = unique[0];
    this.noteBurnedBuilding(world, Math.round(first.x), Math.round(first.y));
  }

  private noteBurnedBuilding(world: World, x: number, y: number): void {
    if (world.isFirst("burnedBuilding")) {
      world.chronicle.add(world.tick, "fire", "Flames took something someone had built. Fire keeps no friends.", { x, y });
    }
  }
}
