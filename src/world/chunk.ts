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
  /** How often agents have walked across the tile. Well-worn tiles become paths, then roads. */
  wear: "u16",
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
  /** True once anything other than wear differs from what generation produced. */
  edited = false;
  /** Number of tiles with any wear. Wear fades, so this can return to zero. */
  wearTiles = 0;
  private terrainCache: LayerArray | null = null;
  private heightCache: LayerArray | null = null;

  constructor(cx: number, cy: number, generatorVersion: number) {
    this.cx = cx;
    this.cy = cy;
    this.generatorVersion = generatorVersion;
    for (const [name, kind] of Object.entries(LAYERS)) this.layers.set(name, createLayer(kind));
  }

  /** Packs chunk coordinates into one number (chunk coordinates stay well within ±1,000,000). */
  static key(cx: number, cy: number): number {
    return (cx + 1048576) * 2097152 + (cy + 1048576);
  }

  get key(): number {
    return Chunk.key(this.cx, this.cy);
  }

  layer(name: string): LayerArray {
    // Fast paths for the layers read constantly.
    if (name === "terrain" && this.terrainCache) return this.terrainCache;
    if (name === "height" && this.heightCache) return this.heightCache;
    let array = this.layers.get(name);
    if (!array) {
      const kind = LAYERS[name];
      if (!kind) throw new Error(`Unknown chunk layer "${name}"`);
      // A layer added in a later version: older saved chunks get it empty.
      array = createLayer(kind);
      this.layers.set(name, array);
    }
    if (name === "terrain") this.terrainCache = array;
    else if (name === "height") this.heightCache = array;
    return array;
  }

  get heightLayer(): LayerArray {
    return this.heightCache ?? this.layer("height");
  }

  get terrainLayer(): LayerArray {
    return this.terrainCache ?? this.layer("terrain");
  }

  /** Replaces a layer's data (used when loading). */
  setLayer(name: string, array: LayerArray): void {
    this.layers.set(name, array);
    if (name === "terrain") this.terrainCache = array;
    else if (name === "height") this.heightCache = array;
  }

  /**
   * Pristine chunks are exactly what generation produces, so they need not be
   * saved or kept in memory: they can be regenerated at any time.
   */
  get pristine(): boolean {
    return !this.edited && this.wearTiles === 0;
  }

  /** Recounts wear after loading. */
  recountWear(): void {
    const wear = this.layers.get("wear");
    let n = 0;
    if (wear) for (let i = 0; i < wear.length; i++) if (wear[i] !== 0) n++;
    this.wearTiles = n;
  }

  /** Index of a local tile (0..CHUNK_SIZE-1 on each axis). */
  static index(lx: number, ly: number): number {
    return ly * CHUNK_SIZE + lx;
  }
}
