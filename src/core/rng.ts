// Deterministic randomness.
// Rng: a seeded generator whose state can be saved, so a loaded world continues
//      the exact same random sequence it would have had.
// hash*: stateless coordinate hashes, used for world generation so a tile's
//      content depends only on the world seed and its position.

export type RngState = [number, number, number, number];

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(state: RngState) {
    [this.a, this.b, this.c, this.d] = state.map((v) => v >>> 0) as RngState;
  }

  static fromSeed(seed: number): Rng {
    // Spread the seed across four words, then warm up the generator.
    const s = seed >>> 0;
    const rng = new Rng([hash32(s, 1), hash32(s, 2), hash32(s, 3), hash32(s, 4)]);
    for (let i = 0; i < 16; i++) rng.nextUint32();
    return rng;
  }

  /** sfc32: fast, well-distributed 32-bit generator. */
  nextUint32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = (this.b ^ (this.b >>> 9)) >>> 0;
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick called with an empty list");
    return items[Math.floor(this.next() * items.length)];
  }

  /** Normally distributed value (Box-Muller). */
  normal(mean = 0, sd = 1): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  getState(): RngState {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
  }
}

/** Mixes any number of integers into one well-scrambled uint32. */
export function hash32(...values: number[]): number {
  let h = 0x811c9dc5;
  for (const value of values) {
    let k = Math.imul(value | 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  // Final avalanche.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Stateless float in [0, 1) from integers. */
export function hashFloat(...values: number[]): number {
  return hash32(...values) / 4294967296;
}

/** A fresh random 32-bit seed for a brand-new world. */
export function randomSeed(): number {
  return (Math.floor(Math.random() * 4294967296) ^ Date.now()) >>> 0;
}
