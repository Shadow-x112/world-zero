// Structures: material placed on the ground (walls) or held up above head
// height (roofs), and the shelter they give.
//
// A block is made of one kind of material. Its soundness ("hp", 0-1000)
// grows as material is added and fades with time; how long it lasts, how well
// it keeps the cold out and how far it can reach as a roof all follow from the
// material's properties. No block type is named or special-cased.

import type { System, World } from "../core/world.ts";
import { hashFloat } from "../core/rng.ts";
import type { MaterialType } from "../materials/registry.ts";
import { CHUNK_SIZE, Terrain, type Chunk } from "../world/chunk.ts";
import type { Grid } from "../world/grid.ts";

export type Level = "wall" | "roof";

/** Soundness of a complete block. */
export const FULL_HP = 1000;
/** Mass of material that makes one complete block (one stone, a couple of sturdy poles, an armful of fibers). */
export const BLOCK_MASS = 0.8;

const LAYER = {
  wall: { mat: "wall", hp: "wallHp", by: "wallBy", day: "wallDay" },
  roof: { mat: "roof", hp: "roofHp", by: "roofBy", day: "roofDay" },
} as const;

export interface Block {
  material: number;
  hp: number;
  /** Agent that first placed it (0 = unknown). */
  by: number;
  /** World day it was first placed (-1 = unknown). */
  day: number;
}

/** Days a complete block of this material stands before it has crumbled away. Harder lasts longer. */
export function blockLifeDays(type: MaterialType): number {
  const h = type.props.hardness;
  return 4 + 400 * h * h;
}

/** How well a complete block of this material keeps the cold out (0.5-1). Dense, hard things are best. */
export function blockQuality(type: MaterialType): number {
  return 0.5 + 0.5 * Math.min(1, type.props.hardness + type.props.mass);
}

/**
 * How far from a wall a roof of this material can reach, in tiles.
 * Rigid things can't span anything; long sturdy poles reach farthest.
 */
export function roofSpan(type: MaterialType): number {
  if (type.props.flexibility < 0.15) return 0;
  return type.props.hardness >= 0.4 ? 2 : 1;
}

/** Units of a material needed to make a block from nothing. */
export function unitsPerBlock(type: MaterialType): number {
  return Math.max(1, Math.ceil(BLOCK_MASS / Math.max(0.01, type.props.mass) - 1e-9));
}

export function blockAt(grid: Grid, level: Level, x: number, y: number): Block | null {
  const l = LAYER[level];
  const material = grid.peek(l.mat, x, y);
  if (material === 0) return null;
  return { material, hp: grid.peek(l.hp, x, y), by: grid.peek(l.by, x, y), day: grid.peek(l.day, x, y) - 1 };
}

export function hasWall(grid: Grid, x: number, y: number): boolean {
  return grid.peek("wall", x, y) !== 0;
}

/**
 * Adds units of material to the block at a tile, creating it if there is none.
 * Returns the soundness gained (0 if the tile holds a block of another material).
 */
export function addToBlock(world: World, level: Level, x: number, y: number, type: MaterialType, units: number, agentId: number): number {
  const grid = world.grid;
  const l = LAYER[level];
  const existing = grid.peek(l.mat, x, y);
  if (existing !== 0 && existing !== type.id) return 0;
  const hp = existing === 0 ? 0 : grid.peek(l.hp, x, y);
  const added = Math.min(FULL_HP - hp, Math.round((units * type.props.mass * FULL_HP) / BLOCK_MASS));
  if (added <= 0) return 0;
  if (existing === 0) {
    grid.set(l.mat, x, y, type.id);
    grid.set(l.by, x, y, agentId);
    grid.set(l.day, x, y, Math.min(65535, world.calendar.day + 1));
  }
  grid.set(l.hp, x, y, hp + added);
  return added;
}

/** Units that would bring a block to full soundness (all of them for a new block). */
export function unitsToComplete(grid: Grid, level: Level, x: number, y: number, type: MaterialType): number {
  const hp = grid.peek(LAYER[level].hp, x, y);
  const missing = FULL_HP - hp;
  return Math.max(0, Math.ceil((missing * BLOCK_MASS) / FULL_HP / Math.max(0.01, type.props.mass) - 1e-9));
}

export function removeBlock(grid: Grid, level: Level, x: number, y: number): void {
  const l = LAYER[level];
  grid.set(l.mat, x, y, 0);
  grid.set(l.hp, x, y, 0);
  grid.set(l.by, x, y, 0);
  grid.set(l.day, x, y, 0);
}

/** Whether a roof of this material over a tile would be held up by a wall within its reach. */
export function roofSupported(grid: Grid, x: number, y: number, type: MaterialType): boolean {
  const span = roofSpan(type);
  if (span === 0) return false;
  for (let oy = -span; oy <= span; oy++) {
    for (let ox = -span; ox <= span; ox++) {
      if ((ox !== 0 || oy !== 0) && hasWall(grid, x + ox, y + oy)) return true;
    }
  }
  return false;
}

// --- Shelter -------------------------------------------------------------------

/** Neighbors and how much each counts toward enclosure (the four sides more than the corners). */
const NEIGHBORS: [number, number, number][] = [
  [1, 0, 0.15], [-1, 0, 0.15], [0, 1, 0.15], [0, -1, 0.15],
  [1, 1, 0.1], [1, -1, 0.1], [-1, 1, 0.1], [-1, -1, 0.1],
];

/** Natural cover: a bank of ground at least this many levels higher shelters from the wind. */
const BANK_SHELTER = 0.5;
/** Sturdy material growing or lying next to a tile (a grove, a boulder) gives a little shelter. */
const NATURAL_SHELTER = 0.3;

/** How much one neighboring tile blocks the wind (0-1). */
function blockingAt(world: World, x: number, y: number, fromHeight: number): number {
  const grid = world.grid;
  const terrain = grid.terrainAt(x, y);
  if (terrain === Terrain.barrier) return 1;
  let best = 0;
  const wall = grid.peek("wall", x, y);
  if (wall !== 0) {
    const type = world.materials.get(wall);
    if (type) best = blockQuality(type) * (grid.peek("wallHp", x, y) / FULL_HP);
  }
  if (best < BANK_SHELTER && grid.heightAt(x, y) - fromHeight >= 1) best = BANK_SHELTER;
  if (best < NATURAL_SHELTER && terrain === Terrain.open) {
    const id = grid.get("material", x, y);
    if (id !== 0 && grid.get("amount", x, y) > 0) {
      const type = world.materials.get(id);
      if (type && type.props.hardness >= 0.5 && type.props.mass >= 0.4) best = NATURAL_SHELTER;
    }
  }
  return best;
}

/**
 * How sheltered a tile is, from 0 (open ground) to 1 (fully enclosed and covered).
 * Cover overhead counts for half; the surrounding tiles for the other half.
 */
export function shelterAt(world: World, x: number, y: number): number {
  const grid = world.grid;
  let cover = 0;
  const roof = grid.peek("roof", x, y);
  if (roof !== 0) {
    const type = world.materials.get(roof);
    if (type) cover = blockQuality(type) * (grid.peek("roofHp", x, y) / FULL_HP);
  }
  const h = grid.heightAt(x, y);
  let enclosure = 0;
  for (const [dx, dy, weight] of NEIGHBORS) enclosure += weight * blockingAt(world, x + dx, y + dy, h);
  return 0.5 * cover + 0.5 * enclosure;
}

// --- Not trapping anyone ---------------------------------------------------------

/** How far around a new wall to check that everyone can still get out. */
export const ESCAPE_RADIUS = 6;
const ESCAPE_SIDE = ESCAPE_RADIUS * 2 + 1;
const escapeSeen = new Uint32Array(ESCAPE_SIDE * ESCAPE_SIDE);
let escapeStamp = 0;

/**
 * Whether someone standing at (sx, sy) could still walk out of the area
 * around (bx, by) if a wall stood at (bx, by).
 */
export function canEscape(grid: Grid, sx: number, sy: number, bx: number, by: number): boolean {
  if (sx === bx && sy === by) return false;
  const ox = bx - ESCAPE_RADIUS;
  const oy = by - ESCAPE_RADIUS;
  const inside = (x: number, y: number) => x >= ox && y >= oy && x < ox + ESCAPE_SIDE && y < oy + ESCAPE_SIDE;
  if (!inside(sx, sy)) return true;
  const open = (x: number, y: number) => !(x === bx && y === by) && grid.isWalkable(x, y);
  escapeStamp++;
  if (escapeStamp === 0xffffffff) {
    escapeSeen.fill(0);
    escapeStamp = 1;
  }
  const queue: number[] = [sx, sy];
  escapeSeen[(sy - oy) * ESCAPE_SIDE + (sx - ox)] = escapeStamp;
  for (let q = 0; q < queue.length; q += 2) {
    const x = queue[q];
    const y = queue[q + 1];
    const h = grid.heightAt(x, y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!open(nx, ny) || Math.abs(grid.heightAt(nx, ny) - h) > 1) continue;
        if (dx !== 0 && dy !== 0 && (!open(x + dx, y) || !open(x, y + dy))) continue;
        if (!inside(nx, ny)) return true; // made it out of the area
        const i = (ny - oy) * ESCAPE_SIDE + (nx - ox);
        if (escapeSeen[i] === escapeStamp) continue;
        escapeSeen[i] = escapeStamp;
        queue.push(nx, ny);
      }
    }
  }
  return false;
}

// --- Time -------------------------------------------------------------------------

function forEachBlock(chunk: Chunk, level: Level, fn: (i: number, x: number, y: number) => void): void {
  const mat = chunk.peekLayer(LAYER[level].mat);
  if (!mat) return;
  for (let i = 0; i < mat.length; i++) {
    if (mat[i] !== 0) fn(i, chunk.cx * CHUNK_SIZE + (i % CHUNK_SIZE), chunk.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE));
  }
}

/** Counts of everything standing (for status lines). */
export function countBlocks(grid: Grid): { walls: number; roofs: number } {
  let walls = 0;
  let roofs = 0;
  for (const chunk of grid.changedChunks()) {
    forEachBlock(chunk, "wall", () => walls++);
    forEachBlock(chunk, "roof", () => roofs++);
  }
  return { walls, roofs };
}

/** Every block in the world (for inspection). */
export function allBlocks(grid: Grid): { level: Level; x: number; y: number }[] {
  const out: { level: Level; x: number; y: number }[] = [];
  for (const chunk of grid.changedChunks()) {
    for (const level of ["wall", "roof"] as Level[]) forEachBlock(chunk, level, (_i, x, y) => out.push({ level, x, y }));
  }
  return out;
}

/**
 * Structures wear away a little each day; harder materials last longer.
 * A roof whose supporting walls are gone falls down.
 */
export class Structures implements System {
  readonly name = "structures";
  private unsubscribe: (() => void) | null = null;

  init(world: World): void {
    this.unsubscribe = world.events.on("newDay", () => this.weather(world));
  }

  update(_world: World): void {}

  weather(world: World): void {
    const grid = world.grid;
    const seed = world.meta.seed;
    let wallsLost = false;
    const chunks = [...grid.changedChunks()];
    for (const chunk of chunks) {
      for (const level of ["wall", "roof"] as Level[]) {
        const hpLayer = chunk.peekLayer(LAYER[level].hp);
        if (!hpLayer) continue;
        const gone: [number, number][] = [];
        forEachBlock(chunk, level, (i, x, y) => {
          const type = world.materials.get(chunk.layer(LAYER[level].mat)[i]);
          const loss = type ? FULL_HP / blockLifeDays(type) : FULL_HP;
          let whole = Math.floor(loss);
          if (hashFloat(seed, level === "wall" ? 8302 : 8303, x, y, world.tick) < loss - whole) whole++;
          const hp = hpLayer[i] - whole;
          if (hp <= 0) gone.push([x, y]);
          else grid.set(LAYER[level].hp, x, y, hp);
        });
        for (const [x, y] of gone) removeBlock(grid, level, x, y);
        if (level === "wall" && gone.length > 0) wallsLost = true;
      }
    }
    if (wallsLost) this.dropUnsupported(world);
  }

  /** Brings down every roof no longer held up by a wall. */
  dropUnsupported(world: World): number {
    const grid = world.grid;
    const falling: [number, number][] = [];
    for (const chunk of grid.changedChunks()) {
      forEachBlock(chunk, "roof", (i, x, y) => {
        const type = world.materials.get(chunk.layer("roof")[i]);
        if (!type || !roofSupported(grid, x, y, type)) falling.push([x, y]);
      });
    }
    for (const [x, y] of falling) removeBlock(grid, "roof", x, y);
    return falling.length;
  }

  dispose(): void {
    this.unsubscribe?.();
  }
}
