// One world, one keeper. A lock file in the data folder says which process is running
// the world right now. A second process pointed at the same folder (for example a new
// deployment starting while the old one is still saving) waits until the lock is released
// or goes stale, so two copies never run side by side and split the world in two.

import { readFile, rm, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** How often the keeper refreshes the lock. */
export const LOCK_HEARTBEAT_MS = 15_000;
/** A lock not refreshed for this long belongs to a process that is gone. */
export const LOCK_STALE_MS = 60_000;

export interface LockInfo {
  instance: string;
  pid: number;
  host: string;
  since: string;
  heartbeat: number;
}

export class WorldLock {
  readonly path: string;
  readonly instance = randomUUID();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(dir: string, now: () => number = () => Date.now()) {
    this.path = join(dir, "world.lock");
    this.now = now;
  }

  async read(): Promise<LockInfo | null> {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as LockInfo;
    } catch {
      return null; // half-written or damaged: treat as no lock
    }
  }

  /** True if someone else holds a fresh lock. */
  async heldByOther(): Promise<LockInfo | null> {
    const info = await this.read();
    if (!info || info.instance === this.instance) return null;
    return this.now() - info.heartbeat < LOCK_STALE_MS ? info : null;
  }

  /** Waits until the lock is free, then takes it and keeps it fresh. */
  async acquire(opts: { pollMs?: number; log?: (line: string) => void; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
    const pollMs = opts.pollMs ?? 2000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let told = false;
    for (;;) {
      const other = await this.heldByOther();
      if (!other) break;
      if (!told) {
        opts.log?.(`Another keeper (${other.host}, pid ${other.pid}) holds this world; waiting for it to let go...`);
        told = true;
      }
      await sleep(pollMs);
    }
    await this.write();
    this.timer = setInterval(() => void this.write().catch(() => {}), LOCK_HEARTBEAT_MS);
    this.timer.unref?.();
  }

  private async write(): Promise<void> {
    const info: LockInfo = { instance: this.instance, pid: process.pid, host: hostname(), since: new Date().toISOString(), heartbeat: this.now() };
    const tmp = `${this.path}.${this.instance}.tmp`;
    await writeFile(tmp, JSON.stringify(info));
    await rename(tmp, this.path);
  }

  /** Lets go of the lock (only if it is still ours). */
  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const info = await this.read();
    if (info?.instance === this.instance) await rm(this.path, { force: true });
  }
}
