// The endless grid. Tiles are addressed by world coordinates (any integers,
// including negatives). Chunks are generated on first access and kept.

import { CHUNK_SIZE, Chunk, Terrain } from "./chunk.ts";
import { generateChunk } from "./generator.ts";

/** Floor division that works for negative numbers. */
export function toChunkCoord(v: number): number {
  return Math.floor(v / CHUNK_SIZE);
}

export function toLocalCoord(v: number): number {
  return ((v % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
}

export class Grid {
  readonly seed: number;
  private readonly chunks = new Map<string, Chunk>();

  constructor(seed: number) {
    this.seed = seed;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  hasChunk(cx: number, cy: number): boolean {
    return this.chunks.has(Chunk.key(cx, cy));
  }

  /** Returns the chunk, generating it if it has never existed. */
  getChunk(cx: number, cy: number): Chunk {
    const key = Chunk.key(cx, cy);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = generateChunk(this.seed, cx, cy);
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  /** Inserts a chunk loaded from a save. */
  putChunk(chunk: Chunk): void {
    this.chunks.set(chunk.key, chunk);
  }

  allChunks(): IterableIterator<Chunk> {
    return this.chunks.values();
  }

  get(layer: string, x: number, y: number): number {
    const chunk = this.getChunk(toChunkCoord(x), toChunkCoord(y));
    return chunk.layer(layer)[Chunk.index(toLocalCoord(x), toLocalCoord(y))];
  }

  set(layer: string, x: number, y: number, value: number): void {
    const chunk = this.getChunk(toChunkCoord(x), toChunkCoord(y));
    const array = chunk.layer(layer);
    const i = Chunk.index(toLocalCoord(x), toLocalCoord(y));
    if (array[i] !== value) {
      array[i] = value;
      chunk.dirty = true;
    }
  }

  heightAt(x: number, y: number): number {
    return this.get("height", x, y);
  }

  terrainAt(x: number, y: number): number {
    return this.get("terrain", x, y);
  }

  /** Whether a tile can be stood on (later systems will add more rules). */
  isWalkable(x: number, y: number): boolean {
    return this.terrainAt(x, y) === Terrain.open;
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
}
