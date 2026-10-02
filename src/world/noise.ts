// Smooth 2D value noise, built on the coordinate hash so it is fully
// determined by the world seed.

import { hashFloat } from "../core/rng.ts";

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Value noise in [0, 1) at a point, with lattice spacing `scale` (in tiles). */
export function valueNoise(seed: number, salt: number, x: number, y: number, scale: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fade(fx - x0);
  const ty = fade(fy - y0);
  const v00 = hashFloat(seed, salt, x0, y0);
  const v10 = hashFloat(seed, salt, x0 + 1, y0);
  const v01 = hashFloat(seed, salt, x0, y0 + 1);
  const v11 = hashFloat(seed, salt, x0 + 1, y0 + 1);
  return lerp(lerp(v00, v10, tx), lerp(v01, v11, tx), ty);
}

/** Layered (fractal) noise in roughly [0, 1). */
export function fractalNoise(
  seed: number,
  salt: number,
  x: number,
  y: number,
  scale: number,
  octaves = 4,
  persistence = 0.5,
): number {
  let total = 0;
  let amplitude = 1;
  let max = 0;
  let s = scale;
  for (let i = 0; i < octaves; i++) {
    total += valueNoise(seed, salt + i * 101, x, y, s) * amplitude;
    max += amplitude;
    amplitude *= persistence;
    s /= 2;
  }
  return total / max;
}
