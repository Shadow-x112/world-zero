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
}

// ---------- What a piece of a material is ----------

/** The form a material takes when built with, from how it feels. */
export function formOf(type: MaterialType): Form {
  const p = type.props;
  if (p.hardness < 0.3 && p.flexibility >= 0.35 && p.mass < 0.3) return FORM.mat; // fibres: woven
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
      return { len: 1.8 + 1.2 * h, wid: 0.06 + 0.06 * mass, thk: 0.06 + 0.06 * mass };
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
  /** Pieces that fell (with how far), for injuries and the chronicle. */
  fell: Array<{ piece: Piece; drop: number }>;
  /** Pieces that broke under a load. */
  broke: Piece[];
  /** Tiles whose wall or roof changed. */
  tiles: Set<number>;
}

export class PieceStore {
  /** Every piece, by id. */
  readonly all = new Map<number, Piece>();
  /** Standing pieces by the tile they belong to (wall and roof roles). */
  private byTile = new Map<number, Set<number>>();
  /** Who rests on whom: piece id -> ids resting on it. */
  private resting = new Map<number, Set<number>>();
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
    if (p.role !== ROLE.rubble) {
      const k = tileKey(p.tx, p.ty);
      let s = this.byTile.get(k);
      if (!s) this.byTile.set(k, (s = new Set()));
      s.add(p.id);
    }
    for (const s of p.on) {
      if (s === GROUND) continue;
      let r = this.resting.get(s);
      if (!r) this.resting.set(s, (r = new Set()));
      r.add(p.id);
    }
  }

  private unindex(p: Piece): void {
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
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    for (const p of [...this.all.values()].sort((a, b) => a.id - b.id)) {
      pieces.push([p.id, p.material, p.units, p.form, r3(p.x), r3(p.y), r3(p.z), r3(p.yaw), r3(p.pitch), p.hp, p.by, p.day, p.role, p.tx, p.ty, p.slot, ...p.on]);
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

const groundZ = (world: World, x: number, y: number) => world.grid.heightAt(Math.round(x), Math.round(y)) * LEVEL_Z;
const jitter = (world: World, salt: number, id: number) => hashFloat(world.meta.seed, salt, id, 0, 0) - 0.5;

/** Positions for stacked lumps in a wall: four to a course. */
const SLOTS: [number, number][] = [[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]];

/** Sets a new wall piece into a tile's wall: stones stacked in courses, poles standing in a ring, mats piled or leaned. */
function placeInWall(world: World, p: Piece): void {
  const store = world.pieces;
  const here = store.at(p.tx, p.ty, ROLE.wall);
  const z0 = groundZ(world, p.tx, p.ty);
  const j = (salt: number) => jitter(world, salt, p.id);
  p.yaw = j(1) * TAU;
  if (p.form === FORM.pole) {
    // Standing, set into the ground, around a small ring.
    const n = here.filter((q) => q.form === FORM.pole).length;
    const a = (n / 6) * TAU + 0.4 * Math.floor(n / 6);
    const r = 0.3 - 0.08 * (Math.floor(n / 6) % 3);
    p.x = p.tx + Math.cos(a) * r + j(2) * 0.04;
    p.y = p.ty + Math.sin(a) * r + j(3) * 0.04;
    p.pitch = Math.PI / 2 - 0.06 * j(4);
    p.z = z0 + p.len / 2 - 0.12; // a little sunk into the ground
    p.on = [GROUND];
    return;
  }
  if (p.form === FORM.mat) {
    const uprights = here.filter((q) => q.form !== FORM.mat || q.pitch > 0.6);
    if (uprights.length > 0) {
      // Leaned against the tallest thing already standing there.
      const tall = uprights.reduce((a, b) => (topOf(b) > topOf(a) ? b : a));
      const side = here.filter((q) => q.form === FORM.mat).length;
      const a = (side / 4) * TAU + j(2) * 0.3;
      const height = topOf(tall) - z0;
      const reach = Math.min(p.len * 0.95, Math.max(0.2, height));
      p.pitch = Math.asin(Math.min(1, reach / p.len));
      const out = (p.len / 2) * Math.cos(p.pitch);
      p.yaw = a + Math.PI; // rising toward the middle
      p.x = tall.x + Math.cos(a) * out;
      p.y = tall.y + Math.sin(a) * out;
      p.z = z0 + reach / 2;
      p.on = [GROUND, tall.id];
      return;
    }
    // A pile: laid flat on the ground or on the mat below.
    const pile = here.filter((q) => q.form === FORM.mat);
    const below = pile[pile.length - 1];
    p.x = p.tx + j(2) * 0.1;
    p.y = p.ty + j(3) * 0.1;
    p.pitch = 0;
    p.z = (below ? topOf(below) : z0) + p.thk / 2;
    p.on = [below ? below.id : GROUND];
    return;
  }
  // Lumps and slabs: stacked in courses.
  const stacked = here.filter((q) => q.slot >= 0);
  const k = stacked.length;
  const slot = k % 4;
  p.slot = slot;
  const below = [...stacked].reverse().find((q) => q.slot === slot);
  const [sx, sy] = SLOTS[slot];
  p.x = p.tx + sx + j(2) * 0.04;
  p.y = p.ty + sy + j(3) * 0.04;
  p.pitch = p.form === FORM.slab ? 0 : 0.05 * j(4);
  p.z = (below ? topOf(below) : z0) + p.thk / 2;
  p.on = [below ? below.id : GROUND];
}

/** The tallest standing thing in a wall, if any. */
function topOfWall(world: World, x: number, y: number): Piece | null {
  let best: Piece | null = null;
  for (const q of world.pieces.at(x, y, ROLE.wall)) if (!best || topOf(q) > topOf(best)) best = q;
  return best;
}

/**
 * Lays a new roof piece over a tile: across two walls on either side if it can reach,
 * otherwise from the top of one wall down to the ground beyond (a lean-to). Mats are
 * laid over roof poles already there, if any.
 */
function placeInRoof(world: World, p: Piece, reach: number): boolean {
  const store = world.pieces;
  const { tx, ty } = p;
  const j = (salt: number) => jitter(world, salt, p.id);
  const existing = store.at(tx, ty, ROLE.roof);
  // Over other roof pieces: a mat (or anything) laid on a pole already spanning the tile.
  const beams = existing.filter((q) => q.form === FORM.pole);
  if (p.form !== FORM.pole && beams.length > 0) {
    const beam = beams[existing.filter((q) => q.form !== FORM.pole).length % beams.length];
    p.yaw = beam.yaw + Math.PI / 2;
    p.pitch = 0.04 * j(1);
    p.x = tx + j(2) * 0.2;
    p.y = ty + j(3) * 0.2;
    p.z = topOf(beam) + p.thk / 2 + 0.02 * existing.length;
    p.on = [beam.id];
    return true;
  }
  // Walls within reach that can hold it, nearest first.
  const walls: { x: number; y: number; top: Piece }[] = [];
  for (let oy = -reach; oy <= reach; oy++) {
    for (let ox = -reach; ox <= reach; ox++) {
      if (ox === 0 && oy === 0) continue;
      const top = topOfWall(world, tx + ox, ty + oy);
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
      p.pitch = Math.atan2(zb - za, span);
      const off = (n % 2 === 0 ? 1 : -1) * Math.ceil(n / 2) * 0.18;
      p.x = (a.top.x + b.top.x) / 2 - Math.sin(p.yaw) * off;
      p.y = (a.top.y + b.top.y) / 2 + Math.cos(p.yaw) * off;
      p.z = (za + zb) / 2 + p.thk / 2;
      p.on = [a.top.id, b.top.id];
      return true;
    }
  }
  // A lean-to: from the top of the nearest wall, down over the tile to the ground beyond.
  const w = walls[0];
  const z0 = groundZ(world, tx, ty);
  const rise = Math.max(0.05, topOf(w.top) - z0);
  const run = Math.sqrt(Math.max(0.01, p.len * p.len - rise * rise));
  const dir = Math.atan2(ty - w.y, tx - w.x);
  const side = (n % 2 === 0 ? 1 : -1) * Math.ceil(n / 2) * 0.2;
  const topX = w.top.x - Math.sin(dir) * side, topY = w.top.y + Math.cos(dir) * side;
  p.yaw = dir;
  p.pitch = -Math.atan2(rise, run);
  p.x = topX + (Math.cos(dir) * run) / 2;
  p.y = topY + (Math.sin(dir) * run) / 2;
  p.z = z0 + rise / 2 + p.thk / 2;
  p.on = [w.top.id, GROUND];
  return true;
}

/**
 * Builds units of material into a tile's wall or roof, as many pieces as they make.
 * Returns the pieces made (none if a roof had nothing to rest on).
 */
export function build(world: World, role: Role, x: number, y: number, type: MaterialType, units: number, by: number, roofReach = 1): Piece[] {
  const made: Piece[] = [];
  const per = unitsPerPiece(type);
  let left = units;
  while (left > 0) {
    const u = Math.min(per, left);
    left -= u;
    const p = newPiece(world, type, u, by, role, x, y);
    if (role === ROLE.roof) {
      if (!placeInRoof(world, p, roofReach)) break;
    } else placeInWall(world, p);
    world.pieces.add(p);
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
      return lying ? 3 * h * sound : 1.2 * h * sound;
    case FORM.mat:
      return 0.6 * f * sound;
    default: {
      if (Math.abs(p.pitch) > 1.1) return 4 * Math.pow(h, 1.2) * sound; // upright, carrying down its length
      const span = Math.max(0.5, p.len * Math.cos(p.pitch));
      return (1.5 * Math.pow(h, 1.2) * (0.3 + f) * sound) / span;
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

function emptyEvents(): PieceEvents {
  return { fell: [], broke: [], tiles: new Set() };
}

/** Drops a piece to the ground (it becomes loose rubble) and brings down whatever rested on it. */
function fall(world: World, p: Piece, ev: PieceEvents): void {
  const store = world.pieces;
  const above = store.onTopOf(p.id);
  const from = bottomOf(p);
  ev.tiles.add(tileKey(p.tx, p.ty));
  const z0 = groundZ(world, p.x, p.y);
  store.update(p, { role: ROLE.rubble, pitch: 0, z: z0 + p.thk / 2, on: [GROUND], slot: -1 });
  const drop = Math.max(0, from - z0);
  ev.fell.push({ piece: p, drop });
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
  ev.tiles.add(tileKey(p.tx, p.ty));
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
    if (p.role !== ROLE.rubble) ev.tiles.add(tileKey(p.tx, p.ty));
    if (p.hp <= 0) gone.push(p);
  }
  for (const p of gone) removePiece(world, p, ev);
  settle(world, ev);
  return ev;
}

// ---------- What falling does to those beneath ----------

/** Anyone beneath a falling piece is struck; everyone near is frightened; the chronicle remembers. */
export function aftermath(world: World, ev: PieceEvents): void {
  if (ev.fell.length === 0) return;
  const struck = new Map<Agent, number>();
  for (const { piece, drop } of ev.fell) {
    if (drop < 0.15) continue;
    const type = world.materials.get(piece.material);
    const hard = type?.props.hardness ?? 0.5;
    const blow = 0.25 * piece.mass * drop * (0.5 + 0.5 * hard);
    for (const a of world.population.all()) {
      if (Math.abs(a.x - piece.x) > 2 || Math.abs(a.y - piece.y) > 2) continue;
      if (groundDistance(piece, a.x, a.y) > 0.3) continue;
      struck.set(a, (struck.get(a) ?? 0) + blow);
    }
  }
  const first = ev.fell[0].piece;
  for (const [a, blow] of [...struck].sort((x, y) => x[0].id - y[0].id)) {
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
