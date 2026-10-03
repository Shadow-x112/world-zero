// The endless grid. Tiles are addressed by world coordinates (any integers,
// including negatives). Chunks are generated on first access.
//
// Memory and saves stay small by keeping only what matters:
// - Chunks that differ from generated ground (built on, worn by walking) are
//   kept and saved in full.
// - Pristine chunks (exactly as generated) can be unloaded when no one is
//   near. Only their generator version is remembered, so they regenerate
//   exactly as they were first seen.

import { CHUNK_SIZE, Chunk, Terrain } from "./chunk.ts";
import { GENERATOR_VERSION, generateChunk } from "./generator.ts";
import { MATERIAL_VERSION, placeMaterials } from "../materials/placement.ts";

/**
 * Untouched chunks are remembered by a version code: terrain version * 1000 +
 * material placement version. Codes below 1000 come from saves made before
 * materials existed; such ground receives the current placement.
 */
export function versionCode(terrain: number, material: number): number {
  return terrain * 1000 + material;
}

export function splitVersionCode(code: number): { terrain: number; material: number } {
  if (code < 1000) return { terrain: code, material: MATERIAL_VERSION };
  return { terrain: Math.floor(code / 1000), material: code % 1000 };
}

/** Floor division that works for negative numbers. */
export function toChunkCoord(v: number): number {
  return Math.floor(v / CHUNK_SIZE);
}

export function toLocalCoord(v: number): number {
  return ((v % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
}

/** Fraction of wear kept each world day. A single pass fades within a day; regular use builds up. */
export const WEAR_DAILY_KEEP = 0.93;

export class Grid {
  readonly seed: number;
  /** Chunks currently in memory. */
  private readonly loaded = new Map<number, Chunk>();
  /** Chunks seen before but unloaded because they were pristine: key -> version code. */
  private readonly unloaded = new Map<number, number>();
  /** The most recently used chunk; most lookups hit the same one repeatedly. */
  private lastChunk: Chunk | null = null;

  constructor(seed: number) {
    this.seed = seed;
  }

  /** Chunks currently in memory. */
  get chunkCount(): number {
    return this.loaded.size;
  }

  /** Every chunk that has ever existed, loaded or not. */
  get knownChunkCount(): number {
    return this.loaded.size + this.unloaded.size;
  }

  hasChunk(cx: number, cy: number): boolean {
    const key = Chunk.key(cx, cy);
    return this.loaded.has(key) || this.unloaded.has(key);
  }

  /** Returns the chunk, generating it (or regenerating it exactly) if it isn't in memory. */
  getChunk(cx: number, cy: number): Chunk {
    const last = this.lastChunk;
    if (last !== null && last.cx === cx && last.cy === cy) return last;
    const key = Chunk.key(cx, cy);
    let chunk = this.loaded.get(key);
    if (!chunk) {
      const code = this.unloaded.get(key);
      const v = code === undefined ? { terrain: GENERATOR_VERSION, material: MATERIAL_VERSION } : splitVersionCode(code);
      chunk = generateChunk(this.seed, cx, cy, v.terrain);
      placeMaterials(chunk, this.seed, v.material);
      chunk.dirty = false;
      this.unloaded.delete(key);
      this.loaded.set(key, chunk);
    }
    this.lastChunk = chunk;
    return chunk;
  }

  /** Inserts a chunk loaded from a save. */
  putChunk(chunk: Chunk): void {
    this.loaded.set(chunk.key, chunk);
    this.unloaded.delete(chunk.key);
  }

  /** Records a pristine chunk from a save without loading it. */
  rememberPristine(key: number, code: number): void {
    if (!this.loaded.has(key)) this.unloaded.set(key, code);
  }

  allChunks(): IterableIterator<Chunk> {
    return this.loaded.values();
  }

  /** Version code of every pristine chunk, loaded or not: key -> code. */
  pristineVersions(): Map<number, number> {
    const out = new Map(this.unloaded);
    for (const chunk of this.loaded.values()) {
      if (chunk.pristine) out.set(chunk.key, versionCode(chunk.generatorVersion, chunk.materialVersion));
    }
    return out;
  }

  /** Chunks that differ from generated ground. */
  *changedChunks(): IterableIterator<Chunk> {
    for (const chunk of this.loaded.values()) if (!chunk.pristine) yield chunk;
  }

  get(layer: string, x: number, y: number): number {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const chunk = this.getChunk(cx, cy);
    return chunk.layer(layer)[(y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE)];
  }

  /** Like get, but reads 0 from a layer the chunk doesn't have instead of creating it. */
  peek(layer: string, x: number, y: number): number {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const array = this.getChunk(cx, cy).peekLayer(layer);
    return array ? array[(y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE)] : 0;
  }

  set(layer: string, x: number, y: number, value: number): void {
    const chunk = this.getChunk(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));
    const array = chunk.layer(layer);
    const i = Chunk.index(toLocalCoord(x), toLocalCoord(y));
    const old = array[i];
    if (old === value) return;
    array[i] = value;
    chunk.dirty = true;
    if (layer === "wear") {
      if (old === 0) chunk.wearTiles++;
      else if (value === 0) chunk.wearTiles--;
    } else {
      chunk.edited = true;
    }
  }

  // Height and terrain are read constantly (every pathfinding step), so they
  // skip the general layer lookup.
  heightAt(x: number, y: number): number {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    return this.getChunk(cx, cy).heightLayer[(y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE)];
  }

  terrainAt(x: number, y: number): number {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    return this.getChunk(cx, cy).terrainLayer[(y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE)];
  }

  /** Whether a tile can be stood on: open ground with nothing built or burning on it. */
  isWalkable(x: number, y: number): boolean {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const chunk = this.getChunk(cx, cy);
    const i = (y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE);
    if (chunk.terrainLayer[i] !== Terrain.open) return false;
    const wall = chunk.wallLayer;
    if (wall !== null && wall[i] !== 0) return false;
    const fire = chunk.fireLayer;
    return fire === null || fire[i] === 0;
  }

  /** Makes sure every chunk within `radius` tiles of a point exists. */
  ensureArea(x: number, y: number, radius: number): void {
    const minCx = toChunkCoord(x - radius);
    const maxCx = toChunkCoord(x + radius);
    const minCy = toChunkCoord(y - radius);
    const maxCy = toChunkCoord(y + radius);
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) this.getChunk(cx, cy);
    }
  }

  /**
   * Unloads pristine chunks that no one needs right now.
   * `needed` says whether a chunk should stay in memory.
   * Returns how many were unloaded.
   */
  unloadIdle(needed: (cx: number, cy: number) => boolean): number {
    let count = 0;
    for (const [key, chunk] of this.loaded) {
      if (!chunk.pristine || needed(chunk.cx, chunk.cy)) continue;
      this.loaded.delete(key);
      this.unloaded.set(key, versionCode(chunk.generatorVersion, chunk.materialVersion));
      if (this.lastChunk === chunk) this.lastChunk = null;
      count++;
    }
    return count;
  }

  /** Daily fading of footpaths that aren't being used. */
  fadeWear(keep = WEAR_DAILY_KEEP): void {
    for (const chunk of this.loaded.values()) {
      if (chunk.wearTiles === 0) continue;
      const wear = chunk.layer("wear");
      let remaining = 0;
      for (let i = 0; i < wear.length; i++) {
        if (wear[i] === 0) continue;
        wear[i] = Math.floor(wear[i] * keep);
        if (wear[i] !== 0) remaining++;
      }
      chunk.wearTiles = remaining;
      chunk.dirty = true;
    }
  }
}
