// The world's vital statistics, one record per world day, for the creator's charts.
// It only reads the world (at the turn of each day) and never changes what happens.
//
// Days from before this was recorded are rebuilt from the chronicle as far as it can
// tell (births, deaths, and so the population); those records are marked partial.

import type { System, World } from "./world.ts";
import type { ChronicleEntry } from "./chronicle.ts";
import { TICKS_PER_DAY } from "./constants.ts";
import { countBlocks } from "../building/structures.ts";
import { commonWord } from "../agents/language.ts";

export interface DayRecord {
  /** World day number (since the calendar began). */
  day: number;
  tick: number;
  alive: number;
  born: number; // during the day just ended
  died: number;
  /** Running totals since the world began (so a restart mid-day loses nothing). */
  totalBorn: number;
  totalDied: number;
  /** Fields below are missing in records rebuilt from the chronicle. */
  partial?: true;
  children?: number;
  pairs?: number;
  walls?: number;
  roofs?: number;
  /** Concepts for which most of the living share one word. */
  sharedWords?: number;
  /** Concepts anyone has a word for. */
  concepts?: number;
  /** Averages over the living, 0-1. */
  energy?: number;
  health?: number;
  joy?: number;
  sadness?: number;
  fear?: number;
  loneliness?: number;
  /** Ground the world has seen, in chunks. */
  explored?: number;
}

/** A word counts as shared once this share of the living use it. */
const SHARED = 0.5;

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function dayRecord(world: World, previous: DayRecord | undefined): DayRecord {
  const p = world.population;
  const bornToday = p.births - (previous?.totalBorn ?? p.births);
  const diedToday = p.deaths - (previous?.totalDied ?? p.deaths);
  const living = world.population.list();
  const built = countBlocks(world.grid);
  const concepts = new Set<string>();
  for (const a of living) for (const k of Object.keys(a.lexicon)) concepts.add(k);
  let shared = 0;
  for (const c of concepts) {
    const common = commonWord(world, c);
    if (common && common.share >= SHARED) shared++;
  }
  const pairs = living.filter((a) => a.mate !== null && a.mate > a.id && world.population.get(a.mate)).length;
  return {
    day: Math.floor(world.tick / TICKS_PER_DAY),
    tick: world.tick,
    alive: living.length,
    born: bornToday,
    died: diedToday,
    totalBorn: p.births,
    totalDied: p.deaths,
    children: living.filter((a) => !a.grown(world.tick)).length,
    pairs,
    walls: built.walls,
    roofs: built.roofs,
    sharedWords: shared,
    concepts: concepts.size,
    energy: r3(avg(living.map((a) => a.needs.energy))),
    health: r3(avg(living.map((a) => a.health))),
    joy: r3(avg(living.map((a) => a.emotions.joy))),
    sadness: r3(avg(living.map((a) => a.emotions.sadness))),
    fear: r3(avg(living.map((a) => a.emotions.fear))),
    loneliness: r3(avg(living.map((a) => a.emotions.loneliness))),
    explored: world.grid.knownChunkCount,
  };
}

/** Records a day at each turn of the day. */
export class HistorySystem implements System {
  readonly name = "history";
  private unsubscribe: (() => void) | null = null;

  init(world: World): void {
    this.unsubscribe = world.events.on("newDay", () => {
      world.history.push(dayRecord(world, world.history[world.history.length - 1]));
    });
  }

  update(_world: World): void {}

  dispose(): void {
    this.unsubscribe?.();
  }
}

/**
 * Rebuilds what can be known of past days from the chronicle: how many lived, were
 * born and died each day. Used once, for worlds older than the history itself.
 */
export function historyFromChronicle(entries: readonly ChronicleEntry[], untilTick: number): DayRecord[] {
  if (entries.length === 0) return [];
  const founders = entries.find((e) => e.kind === "founders");
  let alive = Array.isArray(founders?.data?.ids) ? (founders!.data!.ids as unknown[]).length : 0;
  let totalBorn = 0;
  let totalDied = 0;
  const firstDay = Math.floor(entries[0].tick / TICKS_PER_DAY);
  const lastDay = Math.floor(untilTick / TICKS_PER_DAY);
  const born = new Map<number, number>();
  const died = new Map<number, number>();
  for (const e of entries) {
    const d = Math.floor(e.tick / TICKS_PER_DAY);
    if (e.kind === "birth") born.set(d, (born.get(d) ?? 0) + 1);
    if (e.kind === "death") died.set(d, (died.get(d) ?? 0) + 1);
  }
  const out: DayRecord[] = [];
  // A record for day D describes the day that just ended (D - 1), as the live recorder does.
  for (let d = firstDay + 1; d <= lastDay; d++) {
    const b = born.get(d - 1) ?? 0;
    const k = died.get(d - 1) ?? 0;
    alive += b - k;
    totalBorn += b;
    totalDied += k;
    out.push({ day: d, tick: d * TICKS_PER_DAY, alive, born: b, died: k, totalBorn, totalDied, partial: true });
  }
  return out;
}
