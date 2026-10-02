// Creates the contents of a chunk the first time it is visited.
//
// The area around the origin is a perfectly flat, empty plain. Further out
// the world grows gradually wilder: rolling elevation, then water, then
// barrier ridges. Generation depends only on the seed, the position and the
// generator version.
//
// Rule: never change an existing version's output. Ground that has been seen
// but not changed is not saved; it is regenerated from its seed and version
// when needed, so every version must stay available and exact. To change how
// new land looks, add a new version and point GENERATOR_VERSION at it.

import { CHUNK_SIZE, Chunk, Terrain } from "./chunk.ts";
import { fractalNoise, valueNoise } from "./noise.ts";

export const GENERATOR_VERSION = 2;

/** Radius (in tiles) of the perfectly flat starting plain. */
export const FLAT_RADIUS = 48;
/** Distance at which the world reaches full wildness. */
export const WILD_RADIUS = 480;
/** Maximum elevation, in levels, at full wildness. */
export const MAX_ELEVATION = 12;

const SALT = { elevation: 1000, broad: 2000, water: 3000, ridge: 4000, gap: 5000 } as const;

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** 0 on the starting plain, rising to 1 far from the origin. */
export function wildnessAt(x: number, y: number): number {
  const dist = Math.hypot(x, y);
  return smoothstep((dist - FLAT_RADIUS) / (WILD_RADIUS - FLAT_RADIUS));
}

export interface TileSample {
  height: number;
  terrain: number;
}

function elevation(seed: number, x: number, y: number, w: number): number {
  // Broad rises and falls with finer detail on top.
  const broad = valueNoise(seed, SALT.broad, x, y, 160) * 2 - 1;
  const detail = fractalNoise(seed, SALT.elevation, x, y, 48, 4) * 2 - 1;
  return Math.round((broad * 0.65 + detail * 0.35) * MAX_ELEVATION * w);
}

function water(seed: number, x: number, y: number, w: number, height: number): TileSample | null {
  // Collects in low ground, and only away from the plain.
  const wet = fractalNoise(seed, SALT.water, x, y, 64, 3);
  if (w > 0.08 && wet > 0.66 - 0.06 * w && height <= 1) {
    return { height: Math.min(height, 0) - 1, terrain: Terrain.water };
  }
  return null;
}

/** Version 1 (frozen). Its barriers came out as thick walls; kept only to regenerate old ground exactly. */
function sampleV1(seed: number, x: number, y: number): TileSample {
  const w = wildnessAt(x, y);
  if (w <= 0) return { height: 0, terrain: Terrain.open };
  let height = elevation(seed, x, y, w);
  const wet = water(seed, x, y, w, height);
  if (wet) return wet;
  const r = fractalNoise(seed, SALT.ridge, x, y, 96, 3);
  const ridge = 1 - Math.abs(r * 2 - 1);
  if (w > 0.25 && ridge > 0.975 - 0.03 * w) {
    height = Math.max(height, 0) + 3;
    return { height, terrain: Terrain.barrier };
  }
  return { height, terrain: Terrain.open };
}

/** Version 2: barriers are long thin ridge lines with gaps, so land is divided but rarely sealed off. */
function sampleV2(seed: number, x: number, y: number): TileSample {
  const w = wildnessAt(x, y);
  if (w <= 0) return { height: 0, terrain: Terrain.open };
  const height = elevation(seed, x, y, w);
  const wet = water(seed, x, y, w, height);
  if (wet) return wet;
  if (w > 0.25) {
    const r = valueNoise(seed, SALT.ridge, x, y, 140);
    const band = 0.006 + 0.008 * w;
    if (Math.abs(r - 0.5) < band) {
      const gap = valueNoise(seed, SALT.gap, x, y, 40);
      if (gap > 0.3) return { height: Math.max(height, 0) + 3, terrain: Terrain.barrier };
    }
  }
  return { height, terrain: Terrain.open };
}

const SAMPLERS: Record<number, (seed: number, x: number, y: number) => TileSample> = {
  1: sampleV1,
  2: sampleV2,
};

/** What generation (of the given version) places at a world tile. */
export function sampleTile(seed: number, x: number, y: number, version = GENERATOR_VERSION): TileSample {
  const sampler = SAMPLERS[version];
  if (!sampler) throw new Error(`Unknown generator version ${version}`);
  return sampler(seed, x, y);
}

export function generateChunk(seed: number, cx: number, cy: number, version = GENERATOR_VERSION): Chunk {
  const sampler = SAMPLERS[version];
  if (!sampler) throw new Error(`Unknown generator version ${version}`);
  const chunk = new Chunk(cx, cy, version);
  const height = chunk.layer("height");
  const terrain = chunk.layer("terrain");
  const baseX = cx * CHUNK_SIZE;
  const baseY = cy * CHUNK_SIZE;
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const sample = sampler(seed, baseX + lx, baseY + ly);
      const i = Chunk.index(lx, ly);
      height[i] = sample.height;
      terrain[i] = sample.terrain;
    }
  }
  chunk.dirty = false;
  return chunk;
}
