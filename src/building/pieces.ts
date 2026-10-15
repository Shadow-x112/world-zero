// Pieces: everything anyone builds is made of real objects lying, standing, leaning or
// resting in the world - a pole, a stone, a slab, a woven mat - each with a place, an
// angle, a size and a weight. What a piece is follows from its material (long and
// springy things make poles, lumps make stones, flaky hard things make slabs, fibres
// make mats); nothing is named or special-cased.
//
// A piece rests on the ground or on other pieces. Each knows what holds it up, and
// gravity is kept honest:
//   - take away what holds a piece up and it falls (and whatever it held falls too);
//   - every piece carries its own weight and a share of everything resting on it, and a
//     piece asked to carry more than its material and soundness allow gives way;
//   - pieces wear a little every day (hard things last, fibres rot), so a structure
//     weakens with age until one day it comes down;
//   - a falling piece is damaged by the fall, and anyone beneath it is hurt.
//
// Everything here runs only when something changes (a piece placed, burned, worn
// through), never every tick. Randomness comes from hashes of the world seed and the
// piece, so a loaded world behaves exactly like one that never stopped.
//
// For now (step 9a) the old way of seeing structures is kept up to date from the pieces:
// each tile's "wall" and "roof" layers say how much stands there, so walking, shelter
// and the viewer go on as before. Shelter and walking from the real shapes come in 9b.

import type { World } from "../core/world.ts";
import { hashFloat } from "../core/rng.ts";
import { CHUNK_SIZE } from "../world/chunk.ts";
import type { MaterialType } from "../materials/registry.ts";
import type { Agent } from "../agents/agent.ts";
import { feel } from "../agents/emotions.ts";

/** Scene height of one ground level, in tiles (a tile is 1 across). */
export const LEVEL_Z = 0.5;

export const FORM = { pole: 0, stone: 1, slab: 2, mat: 3 } as const;
export type Form = (typeof FORM)[keyof typeof FORM];
export const FORM_NAMES = ["pole", "stone", "slab", "mat"] as const;

/** What a piece is part of: a wall, a roof, or neither (fallen, lying loose). */
export const ROLE = { wall: 0, roof: 1, rubble: 2 } as const;
export type Role = (typeof ROLE)[keyof typeof ROLE];

/** What holds a piece up: another piece's id, or the ground. */
export const GROUND = -1;

export const FULL_HP = 1000;

export interface Piece {
  id: number;
  material: number;
  /** Units of material bound into it. */
  units: number;
  /** Its weight (units x the material's mass). */
  mass: number;
  form: Form;
  /** Size along its length, across, and through (tiles). */
  len: number;
  wid: number;
  thk: number;
  /** Centre, in world tiles; z is height (ground level n is at n x LEVEL_Z). */
  x: number;
  y: number;
  z: number;
  /** Which way its length points (radians, in the x/y plane), and how steeply it rises (0 lying, pi/2 upright). */
  yaw: number;
  pitch: number;
  /** Soundness, 0-1000. */
  hp: number;
  /** Who placed it (0 = unknown) and on what world day (-1 = unknown). */
  by: number;
  day: number;
  role: Role;
  /** The tile it belongs to (a wall's tile; the tile a roof covers). */
  tx: number;
  ty: number;
  /** Where in a wall it sits (for stacking), or -1. */
  slot: number;
  /** What holds it up (piece ids, or GROUND). */
  on: number[];
  /** Tiles it reaches over (kept by the store; not saved). */
  reach?: number[];
}

// ---------- What a piece of a material is ----------

/** The form a material takes when built with, from how it feels. */
export function formOf(type: MaterialType): Form {
  const p = type.props;
  if (p.hardness < 0.3 && p.flexibility >= 0.2 && p.mass < 0.3) return FORM.mat; // fibres and soft growth: woven, bundled
  if (p.flexibility >= 0.2 && p.hardness >= 0.25) return FORM.pole; // long and springy
  if (p.sharpness >= 0.5 && p.hardness >= 0.5) return FORM.slab; // flakes into sheets
  return FORM.stone; // lumps (stone, baked earth, packed earth)
}

/** How much material goes into one piece (by weight). */
const PIECE_MASS: Record<Form, number> = { 0: 0.4, 1: 0.4, 2: 0.3, 3: 0.2 };

export function unitsPerPiece(type: MaterialType): number {
  return Math.max(1, Math.round(PIECE_MASS[formOf(type)] / Math.max(0.01, type.props.mass)));
}

/** Size of a piece of this material and weight. */
export function sizeOf(type: MaterialType, form: Form, mass: number): { len: number; wid: number; thk: number } {
  const h = type.props.hardness;
  switch (form) {
    case FORM.pole:
      return { len: 1.8 + 1.2 * h, wid: 0.08 + 0.2 * mass, thk: 0.08 + 0.2 * mass };
    case FORM.slab:
      return { len: 0.55, wid: 0.4, thk: 0.07 + 0.05 * mass };
    case FORM.mat:
      return { len: 0.9, wid: 0.6, thk: 0.04 + 0.1 * mass };
    default: {
      const s = 0.3 + 0.25 * mass;
      return { len: s * 1.15, wid: s, thk: s * 0.75 };
    }
  }
}

/** Days a piece of this material lasts before it has crumbled away. Harder lasts longer. */
export function lifeDays(type: MaterialType): number {
  const h = type.props.hardness;
  return 4 + 400 * h * h;
}

// ---------- Geometry ----------

/** Unit vector along a piece's length. */
function axis(p: Piece): [number, number, number] {
  const c = Math.cos(p.pitch);
  return [Math.cos(p.yaw) * c, Math.sin(p.yaw) * c, Math.sin(p.pitch)];
}

/** The two ends of a piece along its length. */
export function ends(p: Piece): [[number, number, number], [number, number, number]] {
  const [ax, ay, az] = axis(p);
  const h = p.len / 2;
  return [
    [p.x - ax * h, p.y - ay * h, p.z - az * h],
    [p.x + ax * h, p.y + ay * h, p.z + az * h],
  ];
}

/** Height of a piece's top surface. */
export function topOf(p: Piece): number {
  return p.z + (p.len / 2) * Math.abs(Math.sin(p.pitch)) + (p.thk / 2) * Math.cos(p.pitch);
}

/** Height of a piece's lowest point. */
export function bottomOf(p: Piece): number {
  return p.z - (p.len / 2) * Math.abs(Math.sin(p.pitch)) - (p.thk / 2) * Math.cos(p.pitch);
}

/** A piece's own directions: along its length (u), across it, level (v), and through it (w). */
function frame(p: Piece): [[number, number, number], [number, number, number], [number, number, number]] {
  const u = axis(p);
  const v: [number, number, number] = [-Math.sin(p.yaw), Math.cos(p.yaw), 0];
  const w: [number, number, number] = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  return [u, v, w];
}

/** Whether a point is inside a piece (pieces are taken as boxes). */
export function contains(p: Piece, x: number, y: number, z: number): boolean {
  const [u, v, w] = frame(p);
  const dx = x - p.x, dy = y - p.y, dz = z - p.z;
  return (
    Math.abs(dx * u[0] + dy * u[1] + dz * u[2]) <= p.len / 2 &&
    Math.abs(dx * v[0] + dy * v[1] + dz * v[2]) <= p.wid / 2 &&
    Math.abs(dx * w[0] + dy * w[1] + dz * w[2]) <= p.thk / 2
  );
}

/** Where along a ray (origin + t * dir, 0 <= t <= maxT) it first meets a piece, or Infinity. */
export function rayHit(p: Piece, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
  const axes = frame(p);
  const half = [p.len / 2, p.wid / 2, p.thk / 2];
  const rx = ox - p.x, ry = oy - p.y, rz = oz - p.z;
  let t0 = 0, t1 = maxT;
  for (let i = 0; i < 3; i++) {
    const a = axes[i];
    const o = rx * a[0] + ry * a[1] + rz * a[2];
    const d = dx * a[0] + dy * a[1] + dz * a[2];
    if (Math.abs(d) < 1e-9) {
      if (Math.abs(o) > half[i]) return Infinity;
      continue;
    }
    let ta = (-half[i] - o) / d, tb = (half[i] - o) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/** The tiles a piece reaches over (its bounding box on the ground). */
export function tilesUnder(p: Piece): Array<[number, number]> {
  const [a, b] = ends(p);
  const r = Math.max(p.wid, p.thk) / 2;
  const x0 = Math.round(Math.min(a[0], b[0]) - r), x1 = Math.round(Math.max(a[0], b[0]) + r);
  const y0 = Math.round(Math.min(a[1], b[1]) - r), y1 = Math.round(Math.max(a[1], b[1]) + r);
  const out: Array<[number, number]> = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
  return out;
}

/** Distance in the ground plane from a point to a piece's footprint (0 if under it). */
function groundDistance(p: Piece, x: number, y: number): number {
  const [a, b] = ends(p);
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
  const d = Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
  return Math.max(0, d - p.wid / 2);
}

export const tileKey = (x: number, y: number) => (x + 1048576) * 2097152 + (y + 1048576);
export const tileOfKey = (k: number): [number, number] => [Math.floor(k / 2097152) - 1048576, (k % 2097152) - 1048576];
const TAU = Math.PI * 2;

// ---------- The store ----------

export interface PieceEvents {
  /** Pieces that fell (with how far, and what they were before), for injuries, lessons and the chronicle. */
  fell: Array<{ piece: Piece; drop: number; role: Role }>;
  /** Pieces that wore away to nothing (and what they were). */
  rotted: Array<{ piece: Piece; role: Role }>;
  /** Pieces that broke under a load. */
  broke: Piece[];
  /** Tiles whose wall or roof changed. */
  tiles: Set<number>;
}

/** The chunk a piece lies in, as a key. */
function chunkKeyOf(p: Piece): number {
  return tileKey(Math.floor(Math.round(p.x) / CHUNK_SIZE), Math.floor(Math.round(p.y) / CHUNK_SIZE));
}

export class PieceStore {
  /** Every piece, by id. */
  readonly all = new Map<number, Piece>();
  /** Standing pieces by the tile they belong to (wall and roof roles). */
  private byTile = new Map<number, Set<number>>();
  /** Who rests on whom: piece id -> ids resting on it. */
  private resting = new Map<number, Set<number>>();
  /** Standing pieces by every tile they reach over (for shelter and walking). */
  private over = new Map<number, Set<number>>();
  /** Every piece, rubble too, by the chunk it lies in (for the viewer). */
  private byChunk = new Map<number, Set<number>>();
  seq = 1;

  get size(): number {
    return this.all.size;
  }

  get(id: number): Piece | undefined {
    return this.all.get(id);
  }

  /** Standing pieces of a role belonging to a tile, oldest first. */
  at(x: number, y: number, role?: Role): Piece[] {
    const ids = this.byTile.get(tileKey(x, y));
    if (!ids) return [];
    const out: Piece[] = [];
    for (const id of ids) {
      const p = this.all.get(id)!;
      if (role === undefined || p.role === role) out.push(p);
    }
    return out.sort((a, b) => a.id - b.id);
  }

  /** Standing pieces reaching over a tile (any role but rubble), by id. */
  near(x: number, y: number): Piece[] {
    const ids = this.over.get(tileKey(x, y));
    if (!ids) return [];
    return [...ids].sort((a, b) => a - b).map((i) => this.all.get(i)!);
  }

  /** Every piece lying in a chunk (standing or fallen), by id. */
  inChunk(cx: number, cy: number): Piece[] {
    const ids = this.byChunk.get(tileKey(cx, cy));
    if (!ids) return [];
    return [...ids].sort((a, b) => a - b).map((i) => this.all.get(i)!);
  }

  /** Pieces resting on a piece. */
  onTopOf(id: number): Piece[] {
    const ids = this.resting.get(id);
    if (!ids) return [];
    return [...ids].sort((a, b) => a - b).map((i) => this.all.get(i)!);
  }

  add(p: Piece): Piece {
    this.all.set(p.id, p);
    this.index(p);
    return p;
  }

  private index(p: Piece): void {
    const c = chunkKeyOf(p);
    let cs = this.byChunk.get(c);
    if (!cs) this.byChunk.set(c, (cs = new Set()));
    cs.add(p.id);
    if (p.role !== ROLE.rubble) {
      const k = tileKey(p.tx, p.ty);
      let s = this.byTile.get(k);
      if (!s) this.byTile.set(k, (s = new Set()));
      s.add(p.id);
      p.reach = tilesUnder(p).map(([x, y]) => tileKey(x, y));
      for (const t of p.reach) {
        let o = this.over.get(t);
        if (!o) this.over.set(t, (o = new Set()));
        o.add(p.id);
      }
    }
    for (const s of p.on) {
      if (s === GROUND) continue;
      let r = this.resting.get(s);
      if (!r) this.resting.set(s, (r = new Set()));
      r.add(p.id);
    }
  }

  private unindex(p: Piece): void {
    const c = chunkKeyOf(p);
    const cs = this.byChunk.get(c);
    if (cs) {
      cs.delete(p.id);
      if (cs.size === 0) this.byChunk.delete(c);
    }
    for (const t of p.reach ?? []) {
      const o = this.over.get(t);
      if (o) {
        o.delete(p.id);
        if (o.size === 0) this.over.delete(t);
      }
    }
    p.reach = undefined;
    const k = tileKey(p.tx, p.ty);
    const s = this.byTile.get(k);
    if (s) {
      s.delete(p.id);
      if (s.size === 0) this.byTile.delete(k);
    }
    for (const sup of p.on) {
      const r = this.resting.get(sup);
      if (r) {
        r.delete(p.id);
        if (r.size === 0) this.resting.delete(sup);
      }
    }
  }

  /** Changes a piece's pose, role or supports, keeping the indexes right. */
  update(p: Piece, change: Partial<Piece>): void {
    this.unindex(p);
    Object.assign(p, change);
    this.index(p);
  }

  delete(p: Piece): void {
    this.unindex(p);
    this.all.delete(p.id);
    this.resting.delete(p.id);
  }

  toJSON(): { seq: number; pieces: number[][] } {
    const pieces: number[][] = [];
    // Exact numbers: a loaded world must go on exactly as if it never stopped.
    for (const p of [...this.all.values()].sort((a, b) => a.id - b.id)) {
      pieces.push([p.id, p.material, p.units, p.form, p.x, p.y, p.z, p.yaw, p.pitch, p.hp, p.by, p.day, p.role, p.tx, p.ty, p.slot, ...p.on]);
    }
    return { seq: this.seq, pieces };
  }

  static fromJSON(data: { seq: number; pieces: number[][] }, world: World): PieceStore {
    const store = new PieceStore();
    store.seq = data.seq;
    for (const row of data.pieces) {
      const [id, material, units, form, x, y, z, yaw, pitch, hp, by, day, role, tx, ty, slot, ...on] = row;
      const type = world.materials.get(material);
      const mass = units * (type?.props.mass ?? 0.5);
      const size = type ? sizeOf(type, form as Form, mass) : { len: 0.5, wid: 0.3, thk: 0.3 };
      store.add({ id, material, units, mass, form: form as Form, ...size, x, y, z, yaw, pitch, hp, by, day, role: role as Role, tx, ty, slot, on });
    }
    return store;
  }
}

// ---------- Placing ----------

function newPiece(world: World, type: MaterialType, units: number, by: number, role: Role, tx: number, ty: number): Piece {
  const form = formOf(type);
  const mass = units * type.props.mass;
  return {
    id: world.pieces.seq++,
    material: type.id,
    units,
    mass,
    form,
    ...sizeOf(type, form, mass),
    x: tx,
    y: ty,
    z: 0,
    yaw: 0,
    pitch: 0,
    hp: FULL_HP,
    by,
    day: Math.min(65534, world.calendar.day),
    role,
    tx,
    ty,
    slot: -1,
    on: [GROUND],
  };
}

/** How tall a wall must stand to fully shelter someone lying beside it (tiles). */
export const WALL_HEIGHT = 0.9;

const groundZ = (world: World, x: number, y: number) => world.grid.heightAt(Math.round(x), Math.round(y)) * LEVEL_Z;
const jitter = (world: World, salt: number, id: number) => hashFloat(world.meta.seed, salt, id, 0, 0) - 0.5;

/**
 * Which way a tile's wall runs. The first piece sets it: across the direction it faces
 * (toward the sleeping place it shelters), or its own way if it faces nothing.
 */
function wallLine(world: World, p: Piece, toward?: { x: number; y: number }): number {
  const first = world.pieces.at(p.tx, p.ty, ROLE.wall)[0];
  if (first) return first.slot >= 1000 ? (first.slot - 1000) / 1000 : halfTurn(first.yaw);
  if (toward && (toward.x !== p.tx || toward.y !== p.ty)) return halfTurn(Math.atan2(toward.y - p.ty, toward.x - p.tx) + Math.PI / 2);
  return halfTurn(jitter(world, 1, p.id) * Math.PI);
}

/** A line's direction folded into [0, π), rounded as the slot stores it, so every piece agrees. */
function halfTurn(a: number): number {
  return Math.round((((a % Math.PI) + Math.PI) % Math.PI) * 1000) / 1000;
}

/** Offsets along a wall for the nth piece in a row of a given width: from the middle outward. */
function alongRow(n: number, perRow: number, width: number): number {
  const i = n % perRow;
  const step = width / perRow;
  const k = Math.ceil(i / 2) * (i % 2 === 0 ? 1 : -1);
  return Math.max(-0.5 + step / 2, Math.min(0.5 - step / 2, k * step + (perRow % 2 === 0 ? step / 2 : 0)));
}

/**
 * Sets a new wall piece into a tile's wall, along the wall's line: lumps laid in
 * courses, poles stood side by side into a palisade, mats stood up as woven screens.
 */
function placeInWall(world: World, p: Piece, toward: { x: number; y: number } | undefined, skill: number): boolean {
  const store = world.pieces;
  const here = store.at(p.tx, p.ty, ROLE.wall);
  const z0 = groundZ(world, p.tx, p.ty);
  // Unpractised hands set things less true: gaps, leans, crooked courses.
  const slop = 1 + 3 * (1 - skill);
  const j = (salt: number) => jitter(world, salt, p.id) * slop;
  const line = wallLine(world, p, toward);
  const lx = Math.cos(line), ly = Math.sin(line);
  const same = here.filter((q) => q.form === p.form);
  const n = same.length;
  if (p.form === FORM.pole) {
    // Standing side by side, set a little into the ground.
    const perRow = Math.max(2, Math.floor(1 / (p.wid * 1.05)));
    const row = Math.floor(n / perRow);
    if (row >= 2) return false; // a row and a staggered row behind it close every gap
    const along = alongRow(n, perRow, 1) + (row % 2) * p.wid * 0.5;
    const off = (row % 3 === 0 ? 0 : row % 3 === 1 ? 1 : -1) * p.wid * 0.9;
    p.x = p.tx + lx * along - ly * off + j(2) * 0.01;
    p.y = p.ty + ly * along + lx * off + j(3) * 0.01;
    p.yaw = line;
    p.pitch = Math.PI / 2 - 0.04 * j(4);
    p.z = z0 + p.len / 2 - 0.15;
    p.on = [GROUND];
    p.slot = 1000 + Math.round((((line % Math.PI) + Math.PI) % Math.PI) * 1000);
    return true;
  }
  if (p.form === FORM.mat) {
    // Upright screens, side by side, then a second course on top of the first.
    const perRow = Math.max(1, Math.ceil(1 / (p.wid * 1.05)));
    const course = Math.floor(n / perRow);
    const along = alongRow(n, perRow, Math.min(1.1, perRow * p.wid));
    const below = course > 0 ? same[n - perRow] : undefined;
    if (below && topOf(below) >= z0 + WALL_HEIGHT - 0.05) return false; // tall enough already
    p.yaw = line - Math.PI / 2; // its width runs along the wall
    p.pitch = Math.PI / 2;
    p.x = p.tx + lx * along + j(2) * 0.02;
    p.y = p.ty + ly * along + j(3) * 0.02;
    p.z = (below ? topOf(below) : z0) + p.len / 2;
    p.on = [below ? below.id : GROUND];
    p.slot = 1000 + Math.round((((line % Math.PI) + Math.PI) % Math.PI) * 1000);
    return true;
  }
  // Lumps and slabs: laid in courses along the wall, each on the one below.
  const perRow = Math.max(1, Math.round(1 / Math.max(0.25, p.len)));
  const course = Math.floor(n / perRow);
  const along = alongRow(n, perRow, 1);
  const below = course > 0 ? same[n - perRow] : undefined;
  if (below && topOf(below) >= z0 + WALL_HEIGHT - 0.05) return false; // tall enough already
  p.yaw = line + 0.06 * j(1);
  p.pitch = p.form === FORM.slab ? 0 : 0.04 * j(4);
  p.x = p.tx + lx * along + j(2) * 0.03;
  p.y = p.ty + ly * along + j(3) * 0.03;
  p.z = (below ? topOf(below) : z0) + p.thk / 2;
  p.on = [below ? below.id : GROUND];
  p.slot = 1000 + Math.round((((line % Math.PI) + Math.PI) % Math.PI) * 1000);
  return true;
}

/** What more a piece could hold, judging only by what rests directly on it. */
function spare(world: World, q: Piece): number {
  let load = 0;
  for (const r of world.pieces.onTopOf(q.id)) if (r.role !== ROLE.rubble) load += r.mass / Math.max(1, r.on.length);
  return capacity(world, q) - load;
}

/** The tallest standing thing in a wall, if any (of the near-tallest, the one nearest a point). */
function topOfWall(world: World, x: number, y: number, nearX = x, nearY = y, bearing = 0): Piece | null {
  const here = world.pieces.at(x, y, ROLE.wall);
  let max = -Infinity;
  for (const q of here) max = Math.max(max, topOf(q));
  let best: Piece | null = null, bestD = Infinity;
  for (const q of here) {
    if (topOf(q) < max - 0.1) continue;
    if (bearing > 0 && spare(world, q) < bearing) continue; // (only those that could take the weight)
    const d = Math.hypot(q.x - nearX, q.y - nearY);
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && best && q.id < best.id)) [best, bestD] = [q, d];
  }
  return best;
}

/**
 * Lays a new roof piece over a tile: across two walls on either side if it can reach,
 * otherwise from the top of one wall down to the ground beyond (a lean-to). Mats are
 * laid over roof poles already there, if any.
 */
function placeInRoof(world: World, p: Piece, reach: number, skill: number): boolean | "full" {
  const store = world.pieces;
  const { tx, ty } = p;
  const slop = 1 + 3 * (1 - skill);
  const j = (salt: number) => jitter(world, salt, p.id) * slop;
  // Skilled hands feel a pole bend or a wall sag before it is too late; the unpractised often don't.
  const feels = hashFloat(world.meta.seed, 8420, p.id, 0, 0) < 0.7 + 0.3 * skill;
  const existing = store.at(tx, ty, ROLE.roof);
  // Over other roof pieces: a mat (or anything) laid on a pole already spanning the tile.
  const beams = existing.filter((q) => q.form === FORM.pole);
  if (p.form !== FORM.pole && beams.length > 0) {
    const k = existing.length - beams.length;
    if (k >= 6) return "full";
    // Laid across the poles, a little further along them each time, resting on every pole beneath.
    const ref = beams[0];
    const bx = Math.cos(ref.yaw), by = Math.sin(ref.yaw); // along the poles
    const flat = Math.abs(ref.pitch) < 0.3;
    const step = [0, 1, -1, 0.5, -0.5, 1.5][k];
    const centre = beams.reduce((acc, q) => [acc[0] + q.x, acc[1] + q.y], [0, 0]).map((v) => v / beams.length);
    // On a flat roof the tile's middle; on a lean-to, the middle of the slope.
    const [cx, cy] = flat ? [tx, ty] : centre;
    const along = step * (flat ? p.wid * 0.85 : p.len * 0.85);
    p.x = cx + bx * along + j(2) * 0.03;
    p.y = cy + by * along + j(3) * 0.03;
    if (flat) {
      p.yaw = ref.yaw + Math.PI / 2; // its length across the poles
      p.pitch = 0.04 * j(1);
    } else {
      p.yaw = ref.yaw; // down the slope with them
      p.pitch = ref.pitch;
    }
    const half = flat ? p.len / 2 : p.wid / 2;
    const under = beams.filter((q) => {
      // Sideways distance between this and the pole, across the poles' direction.
      const side = Math.abs((q.x - p.x) * -by + (q.y - p.y) * bx);
      const reachAlong = Math.abs((q.x - p.x) * bx + (q.y - p.y) * by) <= (q.len * Math.cos(q.pitch)) / 2 + 0.05;
      return side <= half + q.wid / 2 && reachAlong;
    });
    if (under.length === 0) return "full";
    // Not onto poles already bending, or onto walls already sagging under them.
    const share = p.mass / under.length;
    for (const q of under) {
      if (!feels) break;
      if (spare(world, q) < share) return false;
      for (const id of q.on) {
        const w = id === GROUND ? undefined : store.get(id);
        if (w && spare(world, w) < share / q.on.length) return false;
      }
    }
    // Height: on top of the highest pole beneath, where it passes under the middle.
    let z = -Infinity;
    for (const q of under) {
      const t = (p.x - q.x) * Math.cos(q.yaw) + (p.y - q.y) * Math.sin(q.yaw);
      z = Math.max(z, q.z + t * Math.tan(q.pitch) + q.thk / 2);
    }
    p.z = z + p.thk / 2 + 0.01 * k;
    p.on = under.map((q) => q.id).sort((a, b) => a - b);
    return true;
  }
  // Walls within reach that can hold it, nearest first.
  const walls: { x: number; y: number; top: Piece }[] = [];
  for (let oy = -reach; oy <= reach; oy++) {
    for (let ox = -reach; ox <= reach; ox++) {
      if (ox === 0 && oy === 0) continue;
      // A builder can feel a wall that already sags under what it holds.
      const top = topOfWall(world, tx + ox, ty + oy, tx, ty, feels ? p.mass / 2 : 0);
      if (top) walls.push({ x: tx + ox, y: ty + oy, top });
    }
  }
  if (walls.length === 0) return false;
  walls.sort((a, b) => Math.hypot(a.x - tx, a.y - ty) - Math.hypot(b.x - tx, b.y - ty) || a.x - b.x || a.y - b.y);
  // Two walls facing each other across the tile, close enough to span: a beam between them.
  const n = existing.length;
  for (const a of walls) {
    for (const b of walls) {
      if (a === b) continue;
      const dax = a.x - tx, day = a.y - ty, dbx = b.x - tx, dby = b.y - ty;
      const cos = (dax * dbx + day * dby) / (Math.hypot(dax, day) * Math.hypot(dbx, dby));
      if (cos > -0.7) continue;
      const span = Math.hypot(b.top.x - a.top.x, b.top.y - a.top.y);
      if (span + 0.15 > p.len) continue;
      const za = topOf(a.top), zb = topOf(b.top);
      p.yaw = Math.atan2(b.top.y - a.top.y, b.top.x - a.top.x);
      p.pitch = Math.atan2(zb - za, span) + 0.03 * j(6);
      // Laid side by side, outward from the line through the tile's middle.
      const mx = (a.top.x + b.top.x) / 2, my = (a.top.y + b.top.y) / 2;
      const nx = -Math.sin(p.yaw), ny = Math.cos(p.yaw);
      const mid = (tx - mx) * nx + (ty - my) * ny;
      const k = (n % 2 === 0 ? 1 : -1) * Math.ceil(n / 2) * p.wid * 1.02;
      if (Math.abs(k) > 0.5) return "full"; // the tile is covered side to side
      const off = mid + k + j(5) * 0.04;
      p.x = mx + nx * off;
      p.y = my + ny * off;
      p.z = (za + zb) / 2 + p.thk / 2;
      p.on = [a.top.id, b.top.id];
      return true;
    }
  }
  // A lean-to: from the top of the nearest wall, down over the tile to the ground beyond.
  const w = walls[0];
  const z0 = groundZ(world, tx, ty);
  const dir = Math.atan2(ty - w.y, tx - w.x);
  // Side by side along the wall, each leaning on whichever top piece is under it.
  const even = (n % 2 === 0 ? 1 : -1) * Math.ceil(n / 2) * p.wid * 1.02;
  if (Math.abs(even) > 0.5) return "full";
  const side = even + j(7) * 0.04;
  const wantX = w.x - Math.sin(dir) * side, wantY = w.y + Math.cos(dir) * side;
  const top = topOfWall(world, w.x, w.y, wantX, wantY, feels ? p.mass / 2 : 0) ?? w.top;
  const along = (top.x - w.x) * -Math.sin(dir) + (top.y - w.y) * Math.cos(dir);
  const topX = top.x - Math.sin(dir) * (side - along), topY = top.y + Math.cos(dir) * (side - along);
  const rise = Math.max(0.05, topOf(top) - z0);
  const run = Math.sqrt(Math.max(0.01, p.len * p.len - rise * rise));
  p.yaw = dir;
  p.pitch = -Math.atan2(rise, run);
  p.x = topX + (Math.cos(dir) * run) / 2;
  p.y = topY + (Math.sin(dir) * run) / 2;
  p.z = z0 + rise / 2 + p.thk / 2;
  p.on = [top.id, GROUND];
  return true;
}

/**
 * Sets a fresh piece in place of the most worn piece like it in the same wall or roof
 * (if any is worn enough to be worth it); what rested on the old one rests on the new.
 */
function replaceWorst(world: World, p: Piece): boolean {
  const store = world.pieces;
  let worst: Piece | null = null;
  for (const q of store.at(p.tx, p.ty, p.role)) {
    if (q.material !== p.material || q.form !== p.form) continue;
    if (!worst || q.hp < worst.hp || (q.hp === worst.hp && q.id < worst.id)) worst = q;
  }
  if (!worst || worst.hp >= FULL_HP * 0.9) return false;
  Object.assign(p, { x: worst.x, y: worst.y, z: worst.z - worst.thk / 2 + p.thk / 2, yaw: worst.yaw, pitch: worst.pitch, slot: worst.slot, on: [...worst.on] });
  store.add(p);
  for (const q of store.onTopOf(worst.id)) store.update(q, { on: q.on.map((s) => (s === worst!.id ? p.id : s)) });
  store.delete(worst);
  return true;
}

/**
 * Builds units of material into a tile's wall or roof, as many pieces as they make.
 * Returns the pieces made (none if a roof had nothing to rest on).
 */
export function build(
  world: World, role: Role, x: number, y: number, type: MaterialType, units: number, by: number,
  roofReach = 1, toward?: { x: number; y: number }, skill = 1,
): Piece[] {
  const made: Piece[] = [];
  const per = unitsPerPiece(type);
  let left = units;
  while (left > 0) {
    const u = Math.min(per, left);
    left -= u;
    const p = newPiece(world, type, u, by, role, x, y);
    const placed = role === ROLE.roof ? placeInRoof(world, p, roofReach, skill) : placeInWall(world, p, toward, skill) || "full";
    if (placed === false) break; // a roof with nothing to rest on
    if (placed !== true) {
      // As big as it gets: the new piece goes in where the most worn one was.
      if (!replaceWorst(world, p)) break;
    } else world.pieces.add(p);
    made.push(p);
  }
  return made;
}

// ---------- Holding up ----------

/** How much weight (beyond its own) a piece can carry, from its material, form, pose and soundness. */
export function capacity(world: World, p: Piece): number {
  const type = world.materials.get(p.material);
  if (!type) return 0;
  if (bedded(world, p, 0)) return Infinity; // lying flat in a heap on the ground: the ground carries it
  const h = type.props.hardness, f = type.props.flexibility;
  const sound = 0.3 + 0.7 * (p.hp / FULL_HP);
  switch (p.form) {
    case FORM.stone:
      return 12 * Math.pow(h, 1.2) * sound;
    case FORM.slab:
      return Math.abs(p.pitch) < 0.3 ? 3 * h * sound : 1.2 * h * sound; // flat, or on edge
    case FORM.mat:
      return 0.6 * f * sound;
    default: {
      if (Math.abs(p.pitch) > 1.1) return 4 * Math.pow(h, 1.2) * sound; // upright, carrying down its length
      const span = Math.max(0.5, p.len * Math.cos(p.pitch));
      return (4 * Math.pow(h, 1.2) * (0.3 + f) * sound) / span;
    }
  }
}

/** Lying flat on the ground, or on one thing itself lying flat on the ground (a pile, a course of stones). */
function bedded(world: World, p: Piece, depth: number): boolean {
  // (Resting on one thing, flat: a heap. Laid across two is a span, and spans bend.)
  if (Math.abs(p.pitch) >= 0.3 || p.on.length !== 1 || depth > 40) return false;
  for (const s of p.on) {
    if (s === GROUND) continue;
    const q = world.pieces.get(s);
    if (!q || !bedded(world, q, depth + 1)) return false;
  }
  return true;
}

/** Every piece's load: its own weight plus its share of everything resting on it. */
function loads(store: PieceStore): Map<number, number> {
  const load = new Map<number, number>();
  const standing = [...store.all.values()].filter((p) => p.role !== ROLE.rubble);
  // From the top down, so each piece passes on everything above it.
  standing.sort((a, b) => topOf(b) - topOf(a) || a.id - b.id);
  for (const p of standing) load.set(p.id, p.mass);
  for (const p of standing) {
    const total = load.get(p.id)!;
    const sups = p.on.filter((s) => s !== GROUND && load.has(s));
    const grounded = p.on.includes(GROUND);
    const share = total / (sups.length + (grounded ? 1 : 0) || 1);
    for (const s of sups) load.set(s, load.get(s)! + share);
  }
  return load;
}

// ---------- Falling, breaking, crumbling ----------

export function emptyEvents(): PieceEvents {
  return { fell: [], broke: [], tiles: new Set(), rotted: [] };
}

/** Notes every tile a piece reaches over (and its own) as changed. */
export function touch(ev: PieceEvents, p: Piece): void {
  ev.tiles.add(tileKey(p.tx, p.ty));
  ev.tiles.add(tileKey(Math.round(p.x), Math.round(p.y))); // (where it lies, if it has fallen)
  for (const t of p.reach ?? tilesUnder(p).map(([x, y]) => tileKey(x, y))) ev.tiles.add(t);
}

/** Drops a piece to the ground (it becomes loose rubble) and brings down whatever rested on it. */
function fall(world: World, p: Piece, ev: PieceEvents): void {
  const store = world.pieces;
  const above = store.onTopOf(p.id);
  const from = bottomOf(p);
  const role = p.role;
  touch(ev, p);
  const z0 = groundZ(world, p.x, p.y);
  store.update(p, { role: ROLE.rubble, pitch: 0, z: z0 + p.thk / 2, on: [GROUND], slot: -1 });
  const drop = Math.max(0, from - z0);
  ev.fell.push({ piece: p, drop, role });
  // A hard landing: brittle things crack, springy things bend.
  const type = world.materials.get(p.material);
  const flex = type?.props.flexibility ?? 0;
  p.hp -= Math.round(drop * 300 * (1 - 0.5 * flex));
  for (const q of above) if (q.role !== ROLE.rubble) fall(world, q, ev);
  if (p.hp <= 0) store.delete(p);
}

/** Removes a piece entirely (burned, crumbled), bringing down whatever rested on it. */
export function removePiece(world: World, p: Piece, ev: PieceEvents = emptyEvents()): PieceEvents {
  const store = world.pieces;
  if (!store.get(p.id)) return ev;
  const above = store.onTopOf(p.id);
  touch(ev, p);
  store.delete(p);
  for (const q of above) if (q.role !== ROLE.rubble && store.get(q.id)) fall(world, q, ev);
  return ev;
}

/** Whatever is carrying more than it can gives way (repeatedly, as loads shift). */
export function settle(world: World, ev: PieceEvents = emptyEvents()): PieceEvents {
  for (let round = 0; round < 8; round++) {
    const load = loads(world.pieces);
    const failing: Piece[] = [];
    for (const [id, l] of load) {
      const p = world.pieces.get(id)!;
      if (l - p.mass > capacity(world, p) + 1e-9) failing.push(p);
    }
    if (failing.length === 0) break;
    // The highest give way first; the rest are judged again once they are gone.
    failing.sort((a, b) => topOf(b) - topOf(a) || a.id - b.id);
    const p = failing[0];
    ev.broke.push(p);
    p.hp = Math.max(0, p.hp - 600);
    if (p.role !== ROLE.rubble) fall(world, p, ev);
  }
  return ev;
}

/** Days of wear on every piece; whatever wears through crumbles, and whatever then can't hold, falls. */
export function wear(world: World): PieceEvents {
  const ev = emptyEvents();
  const seed = world.meta.seed;
  const gone: Piece[] = [];
  for (const p of [...world.pieces.all.values()].sort((a, b) => a.id - b.id)) {
    const type = world.materials.get(p.material);
    const loss = type ? FULL_HP / lifeDays(type) : FULL_HP;
    let whole = Math.floor(loss);
    if (hashFloat(seed, 8310, p.id, 0, world.tick) < loss - whole) whole++;
    p.hp -= whole;
    touch(ev, p); // (rubble too: the eye sees it darken)
    if (p.hp <= 0) {
      gone.push(p);
      if (p.role !== ROLE.rubble) ev.rotted.push({ piece: p, role: p.role });
    }
  }
  for (const p of gone) removePiece(world, p, ev);
  settle(world, ev);
  return ev;
}

// ---------- What falling does to those beneath ----------

/** The most one collapse can hurt anyone (of a body's whole health of 1): enough to kill the already weak. */
export const MAX_BLOW = 0.3;

/** Anyone beneath a falling piece is struck; everyone near is frightened; the chronicle remembers. */
export function aftermath(world: World, ev: PieceEvents): void {
  if (ev.fell.length === 0) return;
  const struck = new Map<Agent, number>();
  for (const { piece, drop } of ev.fell) {
    if (drop < 0.15) continue;
    const type = world.materials.get(piece.material);
    const hard = type?.props.hardness ?? 0.5;
    const blow = 0.06 * piece.mass * drop * (0.5 + 0.5 * hard);
    for (const a of world.population.all()) {
      if (Math.abs(a.x - piece.x) > 2 || Math.abs(a.y - piece.y) > 2) continue;
      if (groundDistance(piece, a.x, a.y) > 0.3) continue;
      struck.set(a, (struck.get(a) ?? 0) + blow);
    }
  }
  const first = ev.fell[0].piece;
  for (const [a, total] of [...struck].sort((x, y) => x[0].id - y[0].id)) {
    // Bruised and battered, rarely more: what falls is caught on the way down, and they roll away.
    const blow = Math.min(MAX_BLOW, total);
    a.health -= blow;
    a.damage.injury += blow;
    a.asleep = false;
    feel(a, "fear", Math.min(1, 0.4 + blow * 2));
  }
  // Those nearby see it come down.
  for (const a of world.population.all()) {
    if (struck.has(a) || Math.hypot(a.x - first.x, a.y - first.y) > 6) continue;
    feel(a, "fear", 0.25);
  }
  world.events.emit("collapse", { fell: ev.fell.length, broke: ev.broke.length, struck: [...struck.keys()].map((a) => a.id).sort((a, b) => a - b), x: Math.round(first.x), y: Math.round(first.y) });
  const owner = world.population.get(first.by);
  const big = ev.fell.length >= 2;
  if (big && world.isFirst("collapse")) {
    const whose = owner ? `${owner.label}'s shelter` : "Something someone had built";
    world.chronicle.add(world.tick, "building", `${whose} came down: the first thing built to fall.`, { x: Math.round(first.x), y: Math.round(first.y) });
  }
  const hurt = [...struck.keys()].sort((a, b) => a.id - b.id);
  if (hurt.length > 0 && world.isFirst("crushed")) {
    world.chronicle.add(world.tick, "building", `${hurt[0].label} was caught beneath it as it fell.`, { agentId: hurt[0].id, x: Math.round(first.x), y: Math.round(first.y) });
  }
}
