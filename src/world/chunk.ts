// A chunk is a square block of tiles. The world is an endless grid of chunks,
// created only when something first needs them.
//
// Tile data lives in named layers (typed arrays), so later systems can add
// their own layers (materials, structures, wear from walking) without
// changing how chunks are stored or saved.

export const CHUNK_SIZE = 32;
export const TILES_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

export type LayerArray = Uint8Array | Int16Array | Uint16Array | Int32Array | Float32Array;
export type LayerKind = "u8" | "i16" | "u16" | "i32" | "f32";

const CONSTRUCTORS = {
  u8: Uint8Array,
  i16: Int16Array,
  u16: Uint16Array,
  i32: Int32Array,
  f32: Float32Array,
} as const;

/** Every layer a chunk can have, and its storage type. Add new layers here. */
export const LAYERS: Record<string, LayerKind> = {
  /** Ground elevation in whole levels. 0 is the starting plain. */
  height: "i16",
  /** Ground type: see Terrain. */
  terrain: "u8",
};

export const Terrain = {
  open: 0,
  water: 1,
  barrier: 2,
} as const;
export type TerrainType = (typeof Terrain)[keyof typeof Terrain];

export function createLayer(kind: LayerKind): LayerArray {
  return new CONSTRUCTORS[kind](TILES_PER_CHUNK);
}

export function kindOf(array: LayerArray): LayerKind {
  if (array instanceof Uint8Array) return "u8";
  if (array instanceof Int16Array) return "i16";
  if (array instanceof Uint16Array) return "u16";
  if (array instanceof Int32Array) return "i32";
  return "f32";
}

export class Chunk {
  readonly cx: number;
  readonly cy: number;
  readonly layers = new Map<string, LayerArray>();
  /** Which generator version created this chunk. Saved chunks are never regenerated. */
  generatorVersion: number;
  /** True when the chunk has changed since it was last saved. */
  dirty = true;

  constructor(cx: number, cy: number, generatorVersion: number) {
    this.cx = cx;
    this.cy = cy;
    this.generatorVersion = generatorVersion;
    for (const [name, kind] of Object.entries(LAYERS)) this.layers.set(name, createLayer(kind));
  }

  static key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  get key(): string {
    return Chunk.key(this.cx, this.cy);
  }

  layer(name: string): LayerArray {
    let array = this.layers.get(name);
    if (!array) {
      const kind = LAYERS[name];
      if (!kind) throw new Error(`Unknown chunk layer "${name}"`);
      // A layer added in a later version: older saved chunks get it empty.
      array = createLayer(kind);
      this.layers.set(name, array);
    }
    return array;
  }

  /** Index of a local tile (0..CHUNK_SIZE-1 on each axis). */
  static index(lx: number, ly: number): number {
    return ly * CHUNK_SIZE + lx;
  }
}
