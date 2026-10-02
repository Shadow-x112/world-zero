// The chronicle: a permanent record of important events only.
// Routine activity never goes here; systems call add() for things worth
// remembering (first shelter, first death, a new word, a population milestone).

import { formatCalendar, getCalendar } from "./time.ts";

export interface ChronicleEntry {
  id: number;
  tick: number;
  /** Short machine-readable category, e.g. "world", "death", "discovery". */
  kind: string;
  /** Human-readable description. */
  text: string;
  /** Optional details for the viewer (ids, positions, values). */
  data?: Record<string, unknown>;
}

export class Chronicle {
  private entries: ChronicleEntry[] = [];
  private nextId = 1;

  add(tick: number, kind: string, text: string, data?: Record<string, unknown>): ChronicleEntry {
    const entry: ChronicleEntry = { id: this.nextId++, tick, kind, text };
    if (data) entry.data = data;
    this.entries.push(entry);
    return entry;
  }

  get size(): number {
    return this.entries.length;
  }

  all(): readonly ChronicleEntry[] {
    return this.entries;
  }

  recent(count: number): readonly ChronicleEntry[] {
    return this.entries.slice(-count);
  }

  /** "Year 1, Growth day 1, 07:00 (day) · World created" */
  static describe(entry: ChronicleEntry): string {
    return `${formatCalendar(getCalendar(entry.tick))} · ${entry.text}`;
  }

  toJSON(): { nextId: number; entries: ChronicleEntry[] } {
    return { nextId: this.nextId, entries: this.entries };
  }

  static fromJSON(data: { nextId: number; entries: ChronicleEntry[] }): Chronicle {
    const chronicle = new Chronicle();
    chronicle.entries = [...data.entries];
    chronicle.nextId = data.nextId;
    return chronicle;
  }
}
