// The creator's desk: the one door through which anything is done to the world.
//
// Every act goes the same way:
//   1. preview  - the act describes exactly what it will do; nothing changes yet
//   2. confirm  - the creator says yes (the viewer asks twice for grave acts)
//   3. snapshot - the world as it is, kept so the act can be undone
//   4. apply    - between two ticks, so no system ever sees half an act
//   5. save     - at once, so a crash cannot lose it
//   6. log      - a private record, kept apart from the world (an undo never erases it)
//
// Undo restores the snapshot taken just before the last act, for a short while
// afterwards. Whatever the world did in between is undone with it (the creator is told
// how much). Only the last act can be undone, and only while the same world lives.
//
// What the public sees: only an act's effect, told in nature's voice in the chronicle
// (if the act has anything visible to tell). The AIs never learn anything was done.

import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { World } from "../core/world.ts";
import { TICKS_PER_DAY } from "../core/constants.ts";
import { formatCalendar, getCalendar } from "../core/time.ts";
import type { Store } from "../persist/store.ts";
import { ACTS, type ActDef } from "./acts.ts";

/** How long after an act it can still be undone (real time). */
export const UNDO_WINDOW_MS = 10 * 60 * 1000;

export interface LogEntry {
  id: number;
  /** Real time the act was done. */
  at: string;
  /** World time it was done. */
  tick: number;
  worldId: string;
  kind: string;
  params: Record<string, unknown>;
  summary: string;
  /** What the public chronicle was told, if anything. */
  nature?: string;
  grave: boolean;
  snapshot?: string;
  /** Set on an "undo" entry: the act it undid. */
  undid?: number;
  /** Set on an act once it has been undone. */
  undone?: boolean;
}

export interface DeskHost {
  store: Store;
  world: () => World;
  speed: () => number;
  /** Puts a different world in place (after an undo). */
  replaceWorld: (world: World, speed: number) => void;
  save: () => Promise<void>;
  now?: () => number;
}

export class ActError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export class Desk {
  private entries: LogEntry[] = [];
  private nextId = 1;
  private busy = false;
  private readonly host: DeskHost;
  private readonly logPath: string;
  private readonly now: () => number;

  constructor(host: DeskHost) {
    this.host = host;
    this.logPath = join(host.store.dir, "creator-log.jsonl");
    this.now = host.now ?? (() => Date.now());
  }

  /** Reads the log back after a restart. */
  async load(): Promise<void> {
    if (!existsSync(this.logPath)) return;
    const lines = (await readFile(this.logPath, "utf8")).split("\n").filter(Boolean);
    const byId = new Map<number, LogEntry>();
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as LogEntry;
        byId.set(e.id, e); // later lines (an act marked undone) replace earlier ones
      } catch {
        // a torn last line after a crash: skip it
      }
    }
    this.entries = [...byId.values()].sort((a, b) => a.id - b.id);
    this.nextId = (this.entries.at(-1)?.id ?? 0) + 1;
  }

  log(limit = 200): Array<LogEntry & { when: string; undoableFor: number }> {
    const last = this.lastUndoable();
    return this.entries
      .slice(-limit)
      .reverse()
      .map((e) => ({ ...e, when: formatCalendar(getCalendar(e.tick)), undoableFor: last && last.id === e.id ? this.msLeft(e) : 0 }));
  }

  private async write(entry: LogEntry): Promise<void> {
    await appendFile(this.logPath, JSON.stringify(entry) + "\n");
  }

  private def(kind: string): ActDef {
    const def = ACTS[kind];
    if (!def) throw new ActError(`No such act: "${kind}"`);
    return def;
  }

  /** Step 1: what the act would do, without doing it. */
  preview(kind: string, params: Record<string, unknown>) {
    const def = this.def(kind);
    const world = this.host.world();
    const check = def.check(world, params);
    if (check) throw new ActError(check);
    return { kind, title: def.title, grave: def.grave, lines: def.describe(world, params), undoable: true, undoMinutes: UNDO_WINDOW_MS / 60000 };
  }

  /** Steps 2-6: does the act (the caller has confirmed). */
  async perform(kind: string, params: Record<string, unknown>): Promise<LogEntry> {
    const def = this.def(kind);
    if (this.busy) throw new ActError("Another act is still being done", 409);
    this.busy = true;
    try {
      const world = this.host.world();
      const check = def.check(world, params);
      if (check) throw new ActError(check);
      const id = this.nextId++;
      const snapshot = await this.host.store.actSnapshot(world, this.host.speed(), id);
      // The world ran on while the snapshot was written: look again before acting.
      const again = def.check(world, params);
      if (again) throw new ActError(again);
      // Nothing awaits between here and the save's own snapshot: no tick can run in between.
      const result = def.apply(world, params);
      if (result.nature) world.chronicle.add(world.tick, "nature", result.nature, { act: true, ...(result.data ?? {}) });
      const entry: LogEntry = {
        id,
        at: new Date(this.now()).toISOString(),
        tick: world.tick,
        worldId: world.meta.id,
        kind,
        params,
        summary: result.summary,
        grave: def.grave,
        snapshot,
      };
      if (result.nature) entry.nature = result.nature;
      await this.host.save();
      this.entries.push(entry);
      await this.write(entry);
      return entry;
    } finally {
      this.busy = false;
    }
  }

  private lastUndoable(): LogEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.kind === "undo") return null; // undo is one step only
      if (!e.undone) return e;
    }
    return null;
  }

  private msLeft(e: LogEntry): number {
    return Math.max(0, Date.parse(e.at) + UNDO_WINDOW_MS - this.now());
  }

  /** What undoing the last act would cost (world time that would be lost). */
  undoPreview(id: number) {
    const e = this.undoableOrThrow(id);
    const world = this.host.world();
    const lostTicks = world.tick - e.tick;
    return { id, summary: e.summary, lostMinutes: Math.round(lostTicks / 60), lostDays: +(lostTicks / TICKS_PER_DAY).toFixed(2) };
  }

  private undoableOrThrow(id: number): LogEntry {
    const e = this.lastUndoable();
    if (!e || e.id !== id) throw new ActError("Only the most recent act can be undone", 409);
    if (this.msLeft(e) <= 0) throw new ActError("Too late: an act can only be undone in the first ten minutes", 409);
    if (e.worldId !== this.host.world().meta.id) throw new ActError("The world it was done to has ended", 409);
    if (!e.snapshot || !existsSync(e.snapshot)) throw new ActError("Its snapshot is missing", 410);
    return e;
  }

  /** Puts the world back as it was just before the act. */
  async undo(id: number): Promise<LogEntry> {
    if (this.busy) throw new ActError("Another act is still being done", 409);
    this.busy = true;
    try {
      const e = this.undoableOrThrow(id);
      const { world, speed } = await this.host.store.loadFile(e.snapshot!);
      this.host.replaceWorld(world, speed);
      await this.host.save();
      e.undone = true;
      await this.write(e); // the act, now marked undone
      const entry: LogEntry = {
        id: this.nextId++,
        at: new Date(this.now()).toISOString(),
        tick: world.tick,
        worldId: world.meta.id,
        kind: "undo",
        params: { id },
        summary: `Undid: ${e.summary}`,
        grave: false,
        undid: id,
      };
      this.entries.push(entry);
      await this.write(entry);
      return entry;
    } finally {
      this.busy = false;
    }
  }
}
