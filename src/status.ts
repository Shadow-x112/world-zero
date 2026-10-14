// The world's vital signs, as one line for the console and as data for the server.

import type { Runner } from "./core/runner.ts";
import { formatCalendar } from "./core/time.ts";
import { countBlocks } from "./building/structures.ts";
import { describeWinter, winterSeverity } from "./world/weather.ts";
import { worldName } from "./agents/language.ts";

export interface StatusData {
  worldId: string;
  generation: number;
  seed: number;
  name: string | null;
  tick: number;
  date: string;
  season: string;
  year: number;
  hour: number;
  light: number;
  winter: string | null;
  speed: number;
  paused: boolean;
  alive: number;
  asleep: number;
  born: number;
  dead: number;
  walls: number;
  roofs: number;
  fires: number;
  chunks: number;
  ticksPerSecond: number;
  lagging: boolean;
  droppedTicks: number;
  chronicleSize: number;
}

export function statusData(runner: Runner): StatusData {
  const w = runner.world;
  const c = w.calendar;
  const pop = w.population;
  const built = countBlocks(w.grid);
  return {
    worldId: w.meta.id,
    generation: w.meta.generation,
    seed: w.meta.seed,
    name: worldName(w) ?? null,
    tick: w.tick,
    date: formatCalendar(c),
    season: c.season,
    year: c.year,
    hour: c.hour,
    light: c.light,
    winter: c.season === "cold" ? describeWinter(winterSeverity(w.meta.seed, c.year)) : null,
    speed: runner.speed,
    paused: runner.speed === 0,
    alive: pop.count,
    asleep: pop.list().filter((a) => a.asleep).length,
    born: pop.births,
    dead: pop.deaths,
    walls: built.walls,
    roofs: built.roofs,
    fires: w.fireTiles.size,
    chunks: w.grid.chunkCount,
    ticksPerSecond: runner.measuredTps,
    lagging: runner.lagging,
    droppedTicks: runner.droppedTicks,
    chronicleSize: w.chronicle.size,
  };
}

export function statusLine(runner: Runner): string {
  const s = statusData(runner);
  const parts = [
    s.date,
    `light ${Math.round(s.light * 100)}%`,
    `speed ${s.paused ? "paused" : `${s.speed}x`}`,
    `${s.alive} alive (${s.asleep} asleep), ${s.born} born, ${s.dead} dead`,
    `${s.chunks} chunks loaded`,
  ];
  if (s.winter) parts.splice(1, 0, `${s.winter} winter`);
  if (s.walls + s.roofs > 0) parts.splice(4, 0, `${s.walls} walls, ${s.roofs} roofs`);
  if (s.fires > 0) parts.push(`${s.fires} fires burning`);
  if (s.generation > 1) parts.unshift(`World ${s.generation}`);
  if (s.ticksPerSecond > 0) parts.push(`${s.ticksPerSecond.toFixed(1)} ticks/s`);
  if (s.lagging || s.droppedTicks > 0) parts.push(`LAGGING (${s.droppedTicks} ticks dropped)`);
  return parts.join(" · ");
}
