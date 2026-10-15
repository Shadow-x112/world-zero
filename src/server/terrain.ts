// The ground as the viewer sees it: chunks packed small, and the materials as they
// look (never what they truly are).
//
// A chunk is sent as base64 typed arrays, one per layer, CHUNK_SIZE x CHUNK_SIZE tiles
// in row order (index = ly * CHUNK_SIZE + lx). Values are squeezed to what a picture
// needs: amounts and wear capped to 0-255, soundness (0-1000) scaled to 0-255.
// Layers that a chunk does not have (nothing built, nothing burning) are left out.

import type { Chunk } from "../world/chunk.ts";
import { CHUNK_SIZE, TILES_PER_CHUNK } from "../world/chunk.ts";
import type { Grid } from "../world/grid.ts";
import type { MaterialRegistry } from "../materials/registry.ts";
import { VISIBLE } from "../materials/registry.ts";
import { FULL_HP } from "../building/structures.ts";
import { LEVEL_Z } from "../building/pieces.ts";
import type { World } from "../core/world.ts";

export interface ChunkView {
  cx: number;
  cy: number;
  rev: number;
  size: number;
  /** Little-endian Int16 heights, base64. */
  height: string;
  /** The rest: Uint8 per tile, base64. */
  terrain: string;
  material: string;
  amount: string;
  wear: string;
  wall?: string;
  wallHp?: string;
  roof?: string;
  roofHp?: string;
  fire?: string;
  /**
   * What is built here, piece by piece (present whenever the world is made of pieces):
   * 14 numbers each - id, form, material, role, x, y, z above the ground, length, width,
   * thickness, yaw, pitch (positions and sizes in thousandths of a tile, angles in
   * thousandths of a radian), soundness (0-1000), builder.
   */
  pieces?: number[];
}

/** Numbers per piece in a chunk's pieces list. */
export const PIECE_FIELDS = 14;

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function squeeze(src: ArrayLike<number>, scale = 1): Uint8Array {
  const out = new Uint8Array(TILES_PER_CHUNK);
  for (let i = 0; i < TILES_PER_CHUNK; i++) {
    const v = src[i] * scale;
    out[i] = v <= 0 ? 0 : v >= 255 ? 255 : v < 1 ? 1 : Math.round(v); // anything present stays visible
  }
  return out;
}

function hasAny(layer: ArrayLike<number> | undefined): boolean {
  if (!layer) return false;
  for (let i = 0; i < layer.length; i++) if (layer[i] !== 0) return true;
  return false;
}

/** Reads a chunk for the viewer. Only peeks at layers: looking never creates or changes one. */
export function encodeChunk(chunk: Chunk, world?: World): ChunkView {
  const heights = new Int16Array(TILES_PER_CHUNK);
  heights.set(chunk.peekLayer("height") ?? new Int16Array(TILES_PER_CHUNK));
  const bytes = new Uint8Array(heights.buffer);
  // Typed arrays use the machine's byte order; the wire format is little-endian.
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] === 0) {
    for (let i = 0; i < bytes.length; i += 2) [bytes[i], bytes[i + 1]] = [bytes[i + 1], bytes[i]];
  }
  const zero = new Uint8Array(TILES_PER_CHUNK);
  const view: ChunkView = {
    cx: chunk.cx,
    cy: chunk.cy,
    rev: chunk.revision,
    size: CHUNK_SIZE,
    height: b64(bytes),
    terrain: b64(squeeze(chunk.peekLayer("terrain") ?? zero)),
    material: b64(squeeze(chunk.peekLayer("material") ?? zero)),
    amount: b64(squeeze(chunk.peekLayer("amount") ?? zero)),
    wear: b64(squeeze(chunk.peekLayer("wear") ?? zero)),
  };
  const hp = 255 / FULL_HP;
  if (hasAny(chunk.peekLayer("wall"))) {
    view.wall = b64(squeeze(chunk.peekLayer("wall")!));
    view.wallHp = b64(squeeze(chunk.peekLayer("wallHp") ?? zero, hp));
  }
  if (hasAny(chunk.peekLayer("roof"))) {
    view.roof = b64(squeeze(chunk.peekLayer("roof")!));
    view.roofHp = b64(squeeze(chunk.peekLayer("roofHp") ?? zero, hp));
  }
  if (hasAny(chunk.peekLayer("fire"))) view.fire = b64(squeeze(chunk.peekLayer("fire")!));
  if (world) {
    const out: number[] = [];
    const k = (v: number) => Math.round(v * 1000);
    for (const p of world.pieces.inChunk(chunk.cx, chunk.cy)) {
      const ground = world.grid.heightAt(Math.round(p.x), Math.round(p.y)) * LEVEL_Z;
      out.push(p.id, p.form, p.material, p.role, k(p.x), k(p.y), k(p.z - ground), k(p.len), k(p.wid), k(p.thk), k(p.yaw), k(p.pitch), Math.max(0, p.hp), p.by);
    }
    view.pieces = out;
  }
  return view;
}

/** Every chunk the world has ever had: [cx, cy, revision]. Unloaded chunks are untouched (revision 0). */
export function chunkIndex(grid: Grid): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const { cx, cy, loaded } of grid.knownChunks()) out.push([cx, cy, loaded?.revision ?? 0]);
  return out;
}

/** How each material looks: only what an AI could tell by looking at it. */
export function publicPalette(materials: MaterialRegistry) {
  return materials.all().map((t) => {
    const looks: Record<string, number> = {};
    for (const p of VISIBLE) looks[p] = t.props[p];
    return { id: t.id, looks, maxAmount: t.maxAmount };
  });
}

/** Everything about each material (creator only). */
export function fullPalette(materials: MaterialRegistry) {
  return materials.all().map((t) => ({ id: t.id, props: { ...t.props }, maxAmount: t.maxAmount, ripeIn: t.ripeIn ?? null, custom: t.custom === true }));
}
