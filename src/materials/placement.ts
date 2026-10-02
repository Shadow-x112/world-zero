// Where materials lie when ground is first created.
//
// Placement depends only on the seed, the position and the ground beneath,
// and follows realistic abundance: soft growths and fibers are common, sturdy
// and hard things moderately so, glowing and reactive things rare and far out.
//
// Rule (same as terrain): never change an existing placement version's
// output. Untouched ground is regenerated on demand and must come back the
// same. To change placement, add a version and point MATERIAL_VERSION at it.

import { hashFloat } from "../core/rng.ts";
import { CHUNK_SIZE, Chunk, Terrain } from "../world/chunk.ts";
import { fractalNoise, valueNoise } from "../world/noise.ts";
import { wildnessAt } from "../world/generator.ts";
import { BASE_MATERIALS } from "./registry.ts";

export const MATERIAL_VERSION = 1;

const SALT = {
  soft: 7100,
  fiber: 7200,
  grove: 7300,
  stone: 7400,
  shard: 7500,
  wetEarth: 3000, // same field as terrain water, so earth gathers at the water's edge
  glow: 7700,
  ridge: 4000, // same field as terrain ridges, so reactive deposits lie along them
  rich: 7900,
  roll: 8000,
  amount: 8100,
} as const;

const MAX = new Map(BASE_MATERIALS.map((t) => [t.id, t.maxAmount]));

export interface Deposit {
  material: number;
  amount: number;
}

/** What placement (version 1) puts on one tile, given the ground there. */
function placeV1(seed: number, x: number, y: number, terrain: number): Deposit | null {
  if (terrain !== Terrain.open) return null;
  const w = wildnessAt(x, y);
  const roll = hashFloat(seed, SALT.roll, x, y);
  const amountRoll = hashFloat(seed, SALT.amount, x, y);
  const amount = (id: number, min: number) => {
    const max = MAX.get(id)!;
    return Math.max(1, Math.round(min + (max - min) * amountRoll));
  };

  // Rare things first, so commoner patches don't cover them.
  if (w > 0.5 && roll < 0.0006 * w) return { material: 7, amount: amount(7, 3) };

  if (w > 0.4) {
    const r = valueNoise(seed, SALT.ridge, x, y, 140);
    const band = 0.006 + 0.008 * w;
    const d = Math.abs(r - 0.5);
    if (d >= band && d < band * 3 && roll < 0.03) return { material: 8, amount: amount(8, 10) };
  }

  const rich = fractalNoise(seed, SALT.rich, x, y, 60, 2);
  if (rich > 0.72 && roll < 0.05) return { material: 9, amount: amount(9, 3) };

  if (w > 0.08) {
    const wet = fractalNoise(seed, SALT.wetEarth, x, y, 64, 3);
    const waterLine = 0.66 - 0.06 * w;
    if (wet > waterLine - 0.04 && roll < 0.5) return { material: 6, amount: amount(6, 20) };
  }

  if (roll < 0.0012 + 0.003 * w) return { material: 5, amount: amount(5, 5) };
  if (roll > 1 - (0.003 + 0.01 * w)) return { material: 4, amount: amount(4, 10) };

  const grove = fractalNoise(seed, SALT.grove, x, y, 40, 3);
  if (grove > 0.66 && roll < 0.3) return { material: 3, amount: amount(3, 20) };

  const soft = fractalNoise(seed, SALT.soft, x, y, 20, 3);
  if (soft > 0.6 && roll < 0.55) return { material: 1, amount: amount(1, 4) };

  const fiber = fractalNoise(seed, SALT.fiber, x, y, 28, 3);
  if (fiber > 0.64 && roll < 0.45) return { material: 2, amount: amount(2, 5) };

  return null;
}

const PLACERS: Record<number, typeof placeV1> = { 1: placeV1 };

export function placeTile(seed: number, x: number, y: number, terrain: number, version = MATERIAL_VERSION): Deposit | null {
  const placer = PLACERS[version];
  if (!placer) throw new Error(`Unknown material placement version ${version}`);
  return placer(seed, x, y, terrain);
}

/** Fills a chunk's material layers from its terrain. */
export function placeMaterials(chunk: Chunk, seed: number, version = MATERIAL_VERSION): void {
  const placer = PLACERS[version];
  if (!placer) throw new Error(`Unknown material placement version ${version}`);
  const terrain = chunk.terrainLayer;
  const material = chunk.layer("material");
  const amount = chunk.layer("amount");
  const baseX = chunk.cx * CHUNK_SIZE;
  const baseY = chunk.cy * CHUNK_SIZE;
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const i = Chunk.index(lx, ly);
      const d = placer(seed, baseX + lx, baseY + ly, terrain[i]);
      material[i] = d ? d.material : 0;
      amount[i] = d ? d.amount : 0;
    }
  }
  chunk.materialVersion = version;
}
