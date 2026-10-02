// Creates the contents of a chunk the first time it is visited.
//
// The area around the origin is a perfectly flat, empty plain. Further out
// the world grows gradually wilder: rolling elevation, then water, then
// barrier ridges. Generation depends only on the seed and position.
//
// Once a chunk is generated it is saved as-is, so changing this file never
// alters ground the AIs have already seen. Bump GENERATOR_VERSION whenever
// the output for a given seed and position changes.

import { CHUNK_SIZE, Chunk, Terrain } from "./chunk.ts";
import { fractalNoise, valueNoise } from "./noise.ts";

export const GENERATOR_VERSION = 1;

/** Radius (in tiles) of the perfectly flat starting plain. */
export const FLAT_RADIUS = 48;
/** Distance at which the world reaches full wildness. */
export const WILD_RADIUS = 480;
/** Maximum elevation, in levels, at full wildness. */
export const MAX_ELEVATION = 12;

const SALT = { elevation: 1000, broad: 2000, water: 3000, ridge: 4000 } as const;

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

/** What generation would place at a world tile. */
export function sampleTile(seed: number, x: number, y: number): TileSample {
  const w = wildnessAt(x, y);
  if (w <= 0) return { height: 0, terrain: Terrain.open };

  // Elevation: broad rises and falls with finer detail on top.
  const broad = valueNoise(seed, SALT.broad, x, y, 160) * 2 - 1;
  const detail = fractalNoise(seed, SALT.elevation, x, y, 48, 4) * 2 - 1;
  const raw = broad * 0.65 + detail * 0.35;
  let height = Math.round(raw * MAX_ELEVATION * w);

  // Water: collects in low ground, and only away from the plain.
  const wet = fractalNoise(seed, SALT.water, x, y, 64, 3);
  const waterLine = 0.66 - 0.06 * w;
  if (w > 0.08 && wet > waterLine && height <= 1) {
    return { height: Math.min(height, 0) - 1, terrain: Terrain.water };
  }

  // Barriers: thin ridge lines that split the land into regions.
  const r = fractalNoise(seed, SALT.ridge, x, y, 96, 3);
  const ridge = 1 - Math.abs(r * 2 - 1);
  if (w > 0.25 && ridge > 0.975 - 0.03 * w) {
    height = Math.max(height, 0) + 3;
    return { height, terrain: Terrain.barrier };
  }

  return { height, terrain: Terrain.open };
}

export function generateChunk(seed: number, cx: number, cy: number): Chunk {
  const chunk = new Chunk(cx, cy, GENERATOR_VERSION);
  const height = chunk.layer("height");
  const terrain = chunk.layer("terrain");
  const baseX = cx * CHUNK_SIZE;
  const baseY = cy * CHUNK_SIZE;
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const sample = sampleTile(seed, baseX + lx, baseY + ly);
      const i = Chunk.index(lx, ly);
      height[i] = sample.height;
      terrain[i] = sample.terrain;
    }
  }
  return chunk;
}
