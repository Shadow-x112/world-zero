// Structures: material built into walls beside a sleeping place or roofs over it, and
// the shelter they give.
//
// What stands is made of pieces (see pieces.ts): poles, stones, slabs and mats, each
// resting on the ground or on others, wearing with time and falling when what holds
// them up is gone. Each tile's "wall" and "roof" layers are kept up to date from its
// pieces - how much stands there, of what, how sound - and walking, shelter and the
// viewer read those. How long things last, how well they keep the cold out and how far
// a roof can reach all follow from the material's properties. Nothing is named or
// special-cased.

import type { System, World } from "../core/world.ts";
import type { MaterialType } from "../materials/registry.ts";
import { CHUNK_SIZE, Terrain, type Chunk } from "../world/chunk.ts";
import type { Grid } from "../world/grid.ts";
import { ROLE, aftermath, build, removePiece, settle, tileKey, tileOfKey, wear, type PieceEvents, type Role } from "./pieces.ts";

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
export { lifeDays as blockLifeDays } from "./pieces.ts";

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

const roleOf = (level: Level): Role => (level === "wall" ? ROLE.wall : ROLE.roof);

/**
 * Builds units of material into the wall or roof at a tile, as pieces.
 * Returns the soundness gained (0 if the tile holds a block of another material, or a
 * roof has nothing to rest on).
 */
export function addToBlock(world: World, level: Level, x: number, y: number, type: MaterialType, units: number, agentId: number): number {
  const grid = world.grid;
  const l = LAYER[level];
  const existing = grid.peek(l.mat, x, y);
  if (existing !== 0 && existing !== type.id) return 0;
  const hp = existing === 0 ? 0 : grid.peek(l.hp, x, y);
  if (hp >= FULL_HP) return 0;
  const made = build(world, roleOf(level), x, y, type, units, agentId, Math.max(1, roofSpan(type)));
  if (made.length === 0) return 0;
  const ev = settle(world);
  ev.tiles.add(tileKey(x, y));
  afterChange(world, ev);
  return Math.max(0, grid.peek(l.hp, x, y) - hp);
}

/**
 * Brings a tile's wall and roof layers up to date with its pieces: what stands there
 * (the material most of it is made of), and how much of a full block it amounts to.
 */
export function deriveTile(world: World, x: number, y: number): void {
  const grid = world.grid;
  for (const level of ["wall", "roof"] as Level[]) {
    const l = LAYER[level];
    const pieces = world.pieces.at(x, y, roleOf(level));
    let sound = 0;
    const byMaterial = new Map<number, number>();
    for (const p of pieces) {
      sound += p.mass * (p.hp / FULL_HP);
      byMaterial.set(p.material, (byMaterial.get(p.material) ?? 0) + p.mass);
    }
    const hp = Math.min(FULL_HP, Math.round((sound / BLOCK_MASS) * FULL_HP));
    if (pieces.length === 0 || hp <= 0) {
      if (grid.peek(l.mat, x, y) !== 0) clearLayers(grid, level, x, y);
      continue;
    }
    let material = 0, most = -1;
    for (const [m, mass] of [...byMaterial].sort((a, b) => a[0] - b[0])) if (mass > most) [material, most] = [m, mass];
    const first = pieces[0];
    const want: [string, number][] = [[l.mat, material], [l.hp, hp], [l.by, first.by], [l.day, Math.min(65535, first.day + 1)]];
    for (const [name, value] of want) if (grid.peek(name, x, y) !== value) grid.set(name, x, y, value);
  }
}

/** After pieces changed: the injured, the chronicle, and every touched tile's layers. */
function afterChange(world: World, ev: PieceEvents): void {
  aftermath(world, ev);
  for (const k of [...ev.tiles].sort((a, b) => a - b)) {
    const [x, y] = tileOfKey(k);
    deriveTile(world, x, y);
  }
}

/** Units that would bring a block to full soundness (all of them for a new block). */
export function unitsToComplete(grid: Grid, level: Level, x: number, y: number, type: MaterialType): number {
  const hp = grid.peek(LAYER[level].hp, x, y);
  const missing = FULL_HP - hp;
  return Math.max(0, Math.ceil((missing * BLOCK_MASS) / FULL_HP / Math.max(0.01, type.props.mass) - 1e-9));
}

/** Everything of a wall or roof at a tile is gone (burned); what rested on it falls. */
export function removeBlock(world: World, level: Level, x: number, y: number): void {
  const ev: PieceEvents = { fell: [], broke: [], tiles: new Set([tileKey(x, y)]) };
  for (const p of world.pieces.at(x, y, roleOf(level))) removePiece(world, p, ev);
  settle(world, ev);
  afterChange(world, ev);
  if (world.grid.peek(LAYER[level].mat, x, y) !== 0) clearLayers(world.grid, level, x, y);
}

function clearLayers(grid: Grid, level: Level, x: number, y: number): void {
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

/**
 * Builds pieces for every wall and roof in a world saved before pieces existed: each
 * block becomes the pieces its material makes, as sound as the block was, by the same
 * hands on the same day. Walls first, so roofs have something to rest on.
 */
export function piecesFromBlocks(world: World): void {
  const blocks = allBlocks(world.grid).sort((a, b) => (a.level === b.level ? a.x - b.x || a.y - b.y : a.level === "wall" ? -1 : 1));
  for (const { level, x, y } of blocks) {
    const b = blockAt(world.grid, level, x, y)!;
    const type = world.materials.get(b.material);
    if (!type) continue;
    const made = build(world, roleOf(level), x, y, type, unitsPerBlock(type), b.by, Math.max(1, roofSpan(type)));
    for (const p of made) {
      p.hp = b.hp;
      p.day = Math.max(-1, b.day);
    }
  }
  const ev = settle(world);
  for (const { x, y } of blocks) ev.tiles.add(tileKey(x, y));
  for (const k of [...ev.tiles].sort((a, b) => a - b)) {
    const [x, y] = tileOfKey(k);
    deriveTile(world, x, y);
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

  /** A day's wear: every piece weakens; what wears through crumbles, and what it held falls. */
  weather(world: World): void {
    afterChange(world, wear(world));
  }

  dispose(): void {
    this.unsubscribe?.();
  }
}
