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
import { learnFromPieces } from "../agents/building-sense.ts";
import { FORM, LEVEL_Z, ROLE, WALL_HEIGHT, aftermath, formOf, build, contains, rayHit, removePiece, settle, tileKey, tileOfKey, touch, unitsPerPiece, wear, type Piece, type PieceEvents, type Role } from "./pieces.ts";

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
 * Returns the units used (0 if nothing could be set there: another material's wall, a
 * roof with nothing to rest on, or a whole wall with nothing worn enough to replace).
 * Units set in are used up even if what they made gives way at once.
 * Skill (0-1) is the builder's: unpractised hands set pieces less true, and
 * don't always feel a pole bend or a wall sag before loading it.
 */
export function addToBlock(
  world: World, level: Level, x: number, y: number, type: MaterialType, units: number, agentId: number, toward?: { x: number; y: number },
  skill = 1,
): number {
  const grid = world.grid;
  const l = LAYER[level];
  const existing = grid.peek(l.mat, x, y);
  // Walls are of one stuff; a roof can take other stuff laid over its poles.
  if (existing !== 0 && existing !== type.id && !(level === "roof" && formOf(type) !== FORM.pole && roofSupported(world, x, y, type))) return 0;
  const hp = existing === 0 ? 0 : grid.peek(l.hp, x, y);
  if (hp >= FULL_HP) return 0;
  const made = build(world, roleOf(level), x, y, type, units, agentId, Math.max(1, roofSpan(type)), toward, skill);
  if (made.length === 0) return 0;
  const ev = settle(world);
  ev.tiles.add(tileKey(x, y));
  for (const p of made) if (world.pieces.get(p.id)) touch(ev, p);
  afterChange(world, ev);
  return made.reduce((n, p) => n + p.units, 0);
}

export { WALL_HEIGHT };
/** Cover counts only above someone lying down (tiles above the ground). */
export const COVER_ABOVE = 0.3;

const S4 = [-0.375, -0.125, 0.125, 0.375];
/** Finer, for cover overhead: about one pole's width apart, so every pole laid counts. */
const S10 = Array.from({ length: 10 }, (_, i) => -0.45 + i * 0.1);
const DIRS = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4];

/** Soundness-weighted share of sample rays that meet a piece, and what most of it is made of. */
interface Cover {
  share: number;
  sound: number;
  material: number;
  first: Piece | null;
}

function tally(hits: Piece[], rays: number): Cover {
  if (hits.length === 0) return { share: 0, sound: 0, material: 0, first: null };
  let sound = 0;
  const byMaterial = new Map<number, number>();
  for (const p of hits) {
    sound += p.hp / FULL_HP;
    byMaterial.set(p.material, (byMaterial.get(p.material) ?? 0) + 1);
  }
  let material = 0, most = -1;
  for (const [m, n] of [...byMaterial].sort((a, b) => a[0] - b[0])) if (n > most) [material, most] = [m, n];
  const first = hits.reduce((a, b) => (b.id < a.id ? b : a));
  return { share: hits.length / rays, sound: sound / hits.length, material, first };
}

/** The first piece (of those given) a ray meets within reach, if any. */
function firstHit(pieces: Piece[], ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, from: number, to: number): Piece | null {
  let best: Piece | null = null, bt = Infinity;
  for (const p of pieces) {
    const t = rayHit(p, ox, oy, oz, dx, dy, dz, to);
    if (t >= from && t < bt) [best, bt] = [p, t];
    else if (t < from && t !== Infinity && contains(p, ox + dx * from, oy + dy * from, oz + dz * from) && from < bt) [best, bt] = [p, from];
  }
  return best;
}

/**
 * How much of a wall's face is filled: rays sent across the tile at heights up to
 * WALL_HEIGHT, from whichever side it is most closed against.
 */
function wallFace(world: World, x: number, y: number, near: Piece[]): Cover {
  const z0 = world.grid.heightAt(x, y) * LEVEL_Z;
  let best: Cover = { share: 0, sound: 0, material: 0, first: null };
  for (const a of DIRS) {
    const dx = Math.cos(a), dy = Math.sin(a);
    const hits: Piece[] = [];
    for (const s of S4) {
      for (const h of [0.12, 0.38, 0.64, WALL_HEIGHT - 0.04]) {
        const ox = x - dx * 0.7 - dy * s, oy = y - dy * 0.7 + dx * s;
        const p = firstHit(near, ox, oy, z0 + h, dx, dy, 0, 0.2, 1.2);
        if (p) hits.push(p);
      }
    }
    const c = tally(hits, 16);
    if (c.share * c.sound > best.share * best.sound) best = c;
  }
  return best;
}

/** How much of a tile is covered overhead: rays straight up from above someone lying there. */
function overhead(world: World, x: number, y: number, near: Piece[]): Cover {
  const z0 = world.grid.heightAt(x, y) * LEVEL_Z;
  const hits: Piece[] = [];
  for (const sy of S10) for (const sx of S10) {
    const p = firstHit(near, x + sx, y + sy, z0 + COVER_ABOVE, 0, 0, 1, 0, 3);
    if (p) hits.push(p);
  }
  return tally(hits, 100);
}

/** Whether the pieces on a tile leave no way through it (body-high, mostly filled, or closed straight across). */
function solidAt(world: World, x: number, y: number, near: Piece[]): boolean {
  if (near.length === 0) return false;
  const z0 = world.grid.heightAt(x, y) * LEVEL_Z;
  const blocked: boolean[] = [];
  for (const sy of S4) for (const sx of S4) {
    blocked.push(near.some((p) => contains(p, x + sx, y + sy, z0 + 0.3) || contains(p, x + sx, y + sy, z0 + 0.75)));
  }
  const n = blocked.filter(Boolean).length;
  if (n >= 7) return true;
  for (let i = 0; i < 4; i++) {
    if ([0, 1, 2, 3].every((k) => blocked[i * 4 + k])) return true; // straight across one way
    if ([0, 1, 2, 3].every((k) => blocked[k * 4 + i])) return true; // or the other
  }
  return false;
}

/**
 * Brings a tile's layers up to date with the pieces around it, measured from their real
 * shapes:
 *   wall   what was built into a wall here, and how much of its face it fills (0-1000)
 *   roof   how much of the tile is covered overhead, by what (0-1000)
 *   solid  whether there is no way through
 * Soundness counts: a rotten screen keeps out less than a sound one.
 */
export function deriveTile(world: World, x: number, y: number): void {
  const grid = world.grid;
  const near = world.pieces.near(x, y);
  const own = world.pieces.at(x, y, ROLE.wall);
  const set = (name: string, value: number) => {
    if (grid.peek(name, x, y) !== value) grid.set(name, x, y, value);
  };
  // Wall: only where something was built as a wall.
  if (own.length === 0) {
    if (grid.peek("wall", x, y) !== 0) clearLayers(grid, "wall", x, y);
  } else {
    const face = wallFace(world, x, y, near);
    const byMass = new Map<number, number>();
    for (const p of own) byMass.set(p.material, (byMass.get(p.material) ?? 0) + p.mass);
    let material = 0, most = -1;
    for (const [m, mass] of [...byMass].sort((a, b) => a[0] - b[0])) if (mass > most) [material, most] = [m, mass];
    set("wall", material);
    set("wallHp", Math.max(1, Math.round(face.share * face.sound * FULL_HP)));
    set("wallBy", own[0].by);
    set("wallDay", Math.min(65535, own[0].day + 1));
  }
  // Roof: whatever covers the tile overhead (not the tile's own wall).
  const above = near.filter((p) => !(p.role === ROLE.wall && p.tx === x && p.ty === y));
  const cover = overhead(world, x, y, above);
  const hp = Math.round(cover.share * cover.sound * FULL_HP);
  if (hp <= 0) {
    if (grid.peek("roof", x, y) !== 0) clearLayers(grid, "roof", x, y);
  } else {
    const roofs = world.pieces.at(x, y, ROLE.roof);
    const first = roofs[0] ?? cover.first!;
    set("roof", cover.material);
    set("roofHp", hp);
    set("roofBy", first.by);
    set("roofDay", Math.min(65535, first.day + 1));
  }
  // Solid.
  const solid = solidAt(world, x, y, near) ? 1 : 0;
  if (solid || grid.peek("solid", x, y) !== 0) set("solid", solid);
}

/** After pieces changed: the injured, the chronicle, and every touched tile's layers. */
function afterChange(world: World, ev: PieceEvents): void {
  forgetShelter(world);
  aftermath(world, ev);
  learnFromPieces(world, ev);
  for (const k of [...ev.tiles].sort((a, b) => a - b)) {
    const [x, y] = tileOfKey(k);
    deriveTile(world, x, y);
    world.grid.touchTile(x, y); // (the eye sees it changed)
  }
}

/** Units to set into a wall or roof at one go: one piece's worth, until it is whole. */
export function unitsToComplete(grid: Grid, level: Level, x: number, y: number, type: MaterialType): number {
  const hp = grid.peek(LAYER[level].hp, x, y);
  return hp >= FULL_HP ? 0 : unitsPerPiece(type);
}

/** Pieces burn away (each where it stands); what rested on them falls. */
export function burnPieces(world: World, pieces: Piece[]): void {
  const ev: PieceEvents = { fell: [], broke: [], tiles: new Set(), rotted: [] };
  for (const p of pieces) removePiece(world, p, ev);
  settle(world, ev);
  afterChange(world, ev);
}

/** Everything of a wall or roof at a tile is gone (burned); what rested on it falls. */
export function removeBlock(world: World, level: Level, x: number, y: number): void {
  const ev: PieceEvents = { fell: [], broke: [], tiles: new Set([tileKey(x, y)]), rotted: [] };
  for (const p of world.pieces.at(x, y, roleOf(level))) removePiece(world, p, ev);
  settle(world, ev);
  afterChange(world, ev);
  if (world.grid.peek(LAYER[level].mat, x, y) !== 0) clearLayers(world.grid, level, x, y);
  forgetShelter(world);
}

function clearLayers(grid: Grid, level: Level, x: number, y: number): void {
  const l = LAYER[level];
  grid.set(l.mat, x, y, 0);
  grid.set(l.hp, x, y, 0);
  grid.set(l.by, x, y, 0);
  grid.set(l.day, x, y, 0);
}

/** Whether a roof of this material over a tile would be held up by a wall within its reach. */
/** Poles a roof needs before anything else can be laid over them. */
export const FRAME_POLES = 3;

export function roofSupported(world: World, x: number, y: number, type: MaterialType): boolean {
  const grid = world.grid;
  const span = roofSpan(type);
  if (span === 0) return false;
  // Only long poles reach from a wall; anything else needs poles across first to lie on.
  if (formOf(type) !== FORM.pole) return world.pieces.at(x, y, ROLE.roof).filter((q) => q.form === FORM.pole).length >= FRAME_POLES;
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
  // Asked for again and again (everyone glances at every roof in sight), so kept for the tick.
  let memo = shelterMemo.get(world);
  if (!memo || memo.tick !== world.tick) shelterMemo.set(world, (memo = { tick: world.tick, values: new Map() }));
  const key = tileKey(x, y);
  const known = memo.values.get(key);
  if (known !== undefined) return known;
  const value = measureShelter(world, x, y);
  memo.values.set(key, value);
  return value;
}

const shelterMemo = new WeakMap<World, { tick: number; values: Map<number, number> }>();

/** Forgets measured shelter (something was built or fell). */
function forgetShelter(world: World): void {
  shelterMemo.delete(world);
}

function measureShelter(world: World, x: number, y: number): number {
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
    // A wall faces the nearest sleeping place beside it, as it was built to.
    let toward: { x: number; y: number } | undefined;
    let best = Infinity;
    for (const a of world.population.list()) {
      const n = a.lastSleep;
      if (!n || Math.max(Math.abs(n.x - x), Math.abs(n.y - y)) > 1 || (n.x === x && n.y === y)) continue;
      const d = (n.x - x) ** 2 + (n.y - y) ** 2;
      if (d < best || (d === best && toward && (n.x < toward.x || (n.x === toward.x && n.y < toward.y)))) [best, toward] = [d, { x: n.x, y: n.y }];
    }
    // As many pieces as it takes to stand as whole as it stood (or as near as its material can).
    const made: Piece[] = [];
    let stale = 0;
    for (let i = 0; i < 40 && stale < 8; i++) {
      const more = build(world, roleOf(level), x, y, type, unitsPerPiece(type), b.by, Math.max(1, roofSpan(type)), toward);
      if (more.length === 0) break;
      made.push(...more);
      const before = world.grid.peek(LAYER[level].hp, x, y);
      deriveTile(world, x, y);
      const after = world.grid.peek(LAYER[level].hp, x, y);
      if (after >= FULL_HP) break;
      stale = after > before ? 0 : stale + 1;
    }
    for (const p of made) {
      p.hp = b.hp;
      p.day = Math.max(-1, b.day);
    }
  }
  const ev = settle(world);
  for (const { x, y } of blocks) ev.tiles.add(tileKey(x, y));
  for (const p of world.pieces.all.values()) touch(ev, p);
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
