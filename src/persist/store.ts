// Saving and loading the world.
//
// Layout of the data directory:
//   saves/world.json.gz        current save
//   saves/world.prev.json.gz   the save before it (fallback if the current one is damaged)
//   backups/*.json.gz          periodic snapshots, pruned over time
//
// Writes are atomic: data goes to a temporary file which is then renamed over
// the old one, so a crash mid-save can never leave a half-written world.

import { mkdir, readFile, readdir, rename, copyFile, rm, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

import { Chronicle } from "../core/chronicle.ts";
import { Rng, type RngState } from "../core/rng.ts";
import { World, type WorldMeta } from "../core/world.ts";
import { Chunk, kindOf, type LayerArray, type LayerKind } from "../world/chunk.ts";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Bump when the save layout changes, and add a migration below. */
export const SAVE_FORMAT_VERSION = 1;

interface SavedChunk {
  cx: number;
  cy: number;
  gen: number;
  layers: Record<string, { kind: LayerKind; data: string }>;
}

export interface SaveData {
  format: number;
  savedAt: string;
  meta: WorldMeta;
  tick: number;
  rng: RngState;
  speed: number;
  chronicle: ReturnType<Chronicle["toJSON"]>;
  chunks: SavedChunk[];
}

/** Upgrades older saves step by step. Key = format version being upgraded from. */
const MIGRATIONS: Record<number, (data: any) => any> = {};

function encodeLayer(array: LayerArray): string {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString("base64");
}

function decodeLayer(kind: LayerKind, data: string): LayerArray {
  const buf = Buffer.from(data, "base64");
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  switch (kind) {
    case "u8": return bytes;
    case "i16": return new Int16Array(bytes.buffer);
    case "u16": return new Uint16Array(bytes.buffer);
    case "i32": return new Int32Array(bytes.buffer);
    case "f32": return new Float32Array(bytes.buffer);
  }
}

/** Captures the full world state. Synchronous, so the snapshot is consistent. */
export function serializeWorld(world: World, speed: number): SaveData {
  const chunks: SavedChunk[] = [];
  for (const chunk of world.grid.allChunks()) {
    const layers: SavedChunk["layers"] = {};
    for (const [name, array] of chunk.layers) layers[name] = { kind: kindOf(array), data: encodeLayer(array) };
    chunks.push({ cx: chunk.cx, cy: chunk.cy, gen: chunk.generatorVersion, layers });
  }
  return {
    format: SAVE_FORMAT_VERSION,
    savedAt: new Date().toISOString(),
    meta: world.meta,
    tick: world.tick,
    rng: world.rng.getState(),
    speed,
    chronicle: world.chronicle.toJSON(),
    chunks,
  };
}

export function deserializeWorld(raw: any): { world: World; speed: number } {
  let data = raw;
  if (typeof data?.format !== "number") throw new Error("Not a world save");
  if (data.format > SAVE_FORMAT_VERSION) {
    throw new Error(`Save format ${data.format} is newer than this code supports (${SAVE_FORMAT_VERSION})`);
  }
  while (data.format < SAVE_FORMAT_VERSION) {
    const migrate = MIGRATIONS[data.format];
    if (!migrate) throw new Error(`No migration from save format ${data.format}`);
    data = migrate(data);
  }
  const save = data as SaveData;
  const world = new World(save.meta, save.tick, new Rng(save.rng), Chronicle.fromJSON(save.chronicle));
  for (const saved of save.chunks) {
    const chunk = new Chunk(saved.cx, saved.cy, saved.gen);
    for (const [name, layer] of Object.entries(saved.layers)) chunk.layers.set(name, decodeLayer(layer.kind, layer.data));
    chunk.dirty = false;
    world.grid.putChunk(chunk);
  }
  return { world, speed: save.speed };
}

async function writeAtomic(path: string, contents: Buffer): Promise<void> {
  const tmp = `${path}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

async function readSave(path: string): Promise<SaveData> {
  const raw = await gunzipAsync(await readFile(path));
  return JSON.parse(raw.toString("utf8"));
}

function stamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}

export interface BackupPolicy {
  /** Keep this many of the newest backups. */
  keepRecent: number;
  /** Beyond those, keep one backup per day for this many days. */
  keepDaily: number;
}

export const DEFAULT_BACKUP_POLICY: BackupPolicy = { keepRecent: 48, keepDaily: 30 };

export class Store {
  readonly dir: string;
  readonly savesDir: string;
  readonly backupsDir: string;
  private saving: Promise<void> | null = null;

  constructor(dir: string) {
    this.dir = dir;
    this.savesDir = join(dir, "saves");
    this.backupsDir = join(dir, "backups");
  }

  get currentPath(): string {
    return join(this.savesDir, "world.json.gz");
  }

  get previousPath(): string {
    return join(this.savesDir, "world.prev.json.gz");
  }

  async ensureDirs(): Promise<void> {
    await mkdir(this.savesDir, { recursive: true });
    await mkdir(this.backupsDir, { recursive: true });
  }

  hasSave(): boolean {
    return existsSync(this.currentPath) || existsSync(this.previousPath);
  }

  /** Saves the world. Concurrent calls wait for the previous save to finish. */
  async save(world: World, speed: number): Promise<void> {
    const snapshot = serializeWorld(world, speed);
    const previous = this.saving;
    const job = (async () => {
      if (previous) await previous.catch(() => {});
      await this.ensureDirs();
      const contents = await gzipAsync(Buffer.from(JSON.stringify(snapshot)));
      if (existsSync(this.currentPath)) await copyFile(this.currentPath, this.previousPath);
      await writeAtomic(this.currentPath, contents);
      for (const chunk of world.grid.allChunks()) chunk.dirty = false;
    })();
    this.saving = job;
    try {
      await job;
    } finally {
      if (this.saving === job) this.saving = null;
    }
  }

  /** Loads the newest readable save: current, then previous, then backups. */
  async load(): Promise<{ world: World; speed: number; source: string } | null> {
    const candidates = [this.currentPath, this.previousPath, ...(await this.listBackups()).reverse()];
    const errors: string[] = [];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        const { world, speed } = deserializeWorld(await readSave(path));
        return { world, speed, source: path };
      } catch (err) {
        errors.push(`${path}: ${(err as Error).message}`);
      }
    }
    if (errors.length) throw new Error(`No readable save found:\n${errors.join("\n")}`);
    return null;
  }

  async listBackups(): Promise<string[]> {
    if (!existsSync(this.backupsDir)) return [];
    const names = (await readdir(this.backupsDir)).filter((n) => /\d{8}-\d{6}\.json\.gz$/.test(n));
    const time = (n: string) => n.match(/(\d{8}-\d{6})\.json\.gz$/)![1];
    names.sort((a, b) => (time(a) < time(b) ? -1 : time(a) > time(b) ? 1 : a < b ? -1 : 1));
    return names.map((n) => join(this.backupsDir, n));
  }

  /** Writes a timestamped backup snapshot and prunes old ones. */
  async backup(world: World, speed: number, policy = DEFAULT_BACKUP_POLICY): Promise<string> {
    await this.ensureDirs();
    const snapshot = serializeWorld(world, speed);
    const name = `world-g${world.meta.generation}-${stamp()}.json.gz`;
    const path = join(this.backupsDir, name);
    await writeAtomic(path, await gzipAsync(Buffer.from(JSON.stringify(snapshot))));
    await this.prune(policy);
    return path;
  }

  async prune(policy = DEFAULT_BACKUP_POLICY): Promise<void> {
    const backups = await this.listBackups(); // oldest first
    const keep = new Set(backups.slice(-policy.keepRecent));
    const older = backups.slice(0, Math.max(0, backups.length - policy.keepRecent)).reverse(); // newest first
    const daysKept = new Set<string>();
    for (const path of older) {
      const day = path.match(/(\d{8})-\d{6}\.json\.gz$/)?.[1];
      if (day && !daysKept.has(day) && daysKept.size < policy.keepDaily) {
        daysKept.add(day);
        keep.add(path);
      }
    }
    for (const path of backups) if (!keep.has(path)) await rm(path, { force: true });
  }
}
