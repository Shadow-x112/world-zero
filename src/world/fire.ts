// Fire: the HEAT rule made real. A fire lives on a tile, eats fuel by the
// hour, warms and lights everything near it - and takes whatever burnable
// thing it can reach: the growth on the ground, walls, roofs, and flesh.
// It is dangerous from the first day it exists.

import { TICKS_PER_DAY } from "../core/constants.ts";
import type { System, World } from "../core/world.ts";
import { hashFloat } from "../core/rng.ts";
import type { MaterialType } from "../materials/registry.ts";
import { BRICK_ID } from "../materials/registry.ts";
import { FULL_HP, BLOCK_MASS, blockAt, removeBlock, type Level } from "../building/structures.ts";

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

/** Starts (or feeds) a fire on a tile. Returns the fuel now in it, in tenths of an hour. */
export function igniteAt(world: World, x: number, y: number, fuelTenths: number): number {
  const grid = world.grid;
  const now = Math.min(65535, grid.peek("fire", x, y) + Math.max(0, fuelTenths));
  grid.set("fire", x, y, now);
  world.fireTiles.set(key(x, y), { x, y });
  return now;
}

export function fireAt(world: World, x: number, y: number): number {
  return world.grid.peek("fire", x, y);
}

export function extinguishAt(world: World, x: number, y: number): void {
  world.grid.set("fire", x, y, 0);
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
      // Spread to whatever burnable thing lies or stands beside it.
      for (const [dx, dy] of AROUND) {
        const x = f.x + dx;
        const y = f.y + dy;
        if (fireAt(world, x, y) > 0) continue;
        const wall = blockAt(grid, "wall", x, y);
        if (wall) {
          const type = world.materials.get(wall.material);
          if (type && burnable(type) && roll(8304, x, y) < SPREAD_WALL_CHANCE * season) {
            this.burnBlock(world, "wall", x, y, wall.hp, type);
          }
          continue; // a wall that can't burn shields what's behind it
        }
        const id = grid.get("material", x, y);
        const amount = id === 0 ? 0 : grid.get("amount", x, y);
        if (id !== 0 && amount > 0) {
          const type = world.materials.get(id);
          if (!type) continue;
          if (burnable(type) && roll(8305, x, y) < SPREAD_CHANCE * season) {
            // The patch goes up: its substance becomes the new fire's fuel.
            grid.set("amount", x, y, 0);
            if (type.props.growth < 0.5) grid.set("material", x, y, 0); // roots and all
            igniteAt(world, x, y, fuelOf(type, amount));
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
      // A roof over the flames catches easily, and feeds them.
      const roof = blockAt(grid, "roof", f.x, f.y);
      if (roof) {
        const type = world.materials.get(roof.material);
        if (type && burnable(type) && roll(8307, f.x, f.y) < SPREAD_ROOF_CHANCE * season) {
          removeBlock(grid, "roof", f.x, f.y);
          fuel = igniteAt(world, f.x, f.y, Math.round((roof.hp / FULL_HP) * BLOCK_MASS * type.props.energy * FUEL_HOURS_PER_MASS_ENERGY * 10));
          this.noteBurnedBuilding(world, f.x, f.y);
        }
      }
      // It eats its fuel: a tenth of an hour per look.
      fuel -= 1;
      if (fuel <= 0) extinguishAt(world, f.x, f.y);
      else grid.set("fire", f.x, f.y, fuel);
    }
  }

  /** A standing block catches: it is gone, and a fire with its substance burns in its place. */
  private burnBlock(world: World, level: Level, x: number, y: number, hp: number, type: MaterialType): void {
    removeBlock(world.grid, level, x, y);
    igniteAt(world, x, y, Math.round((hp / FULL_HP) * BLOCK_MASS * type.props.energy * FUEL_HOURS_PER_MASS_ENERGY * 10));
    this.noteBurnedBuilding(world, x, y);
  }

  private noteBurnedBuilding(world: World, x: number, y: number): void {
    if (world.isFirst("burnedBuilding")) {
      world.chronicle.add(world.tick, "fire", "Flames took something someone had built. Fire keeps no friends.", { x, y });
    }
  }
}
