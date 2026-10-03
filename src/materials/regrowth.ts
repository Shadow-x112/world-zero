// Growing materials regrow on harvested ground, faster in the warm seasons
// and not at all in the cold. Untouched ground needs no upkeep: it is always
// at its natural state.

import { TICKS_PER_DAY } from "../core/constants.ts";
import type { System, World } from "../core/world.ts";
import { CHUNK_SIZE, Chunk } from "../world/chunk.ts";
import { isRipe, regrows } from "./registry.ts";

/** How often regrowth is applied, in ticks (one world hour). */
export const REGROW_INTERVAL = TICKS_PER_DAY / 24;

/** Share of a tile's capacity regained per world hour, per point of the material's growth property. */
export const REGROW_RATE = 0.03;

export const SEASON_GROWTH: Record<string, number> = {
  growth: 1,
  peak: 0.7,
  decline: 0.25,
  cold: 0,
};

export class Regrowth implements System {
  readonly name = "regrowth";

  update(world: World): void {
    if (world.tick % REGROW_INTERVAL !== 0) return;
    const season = world.calendar.season;
    const seasonFactor = SEASON_GROWTH[season] ?? 0;
    if (seasonFactor === 0) return;
    const registry = world.materials;
    const rng = world.rng;

    for (const chunk of world.grid.changedChunks()) {
      const material = chunk.layer("material");
      const amount = chunk.layer("amount");
      const wall = chunk.wallLayer; // nothing grows under a wall
      let changed = false;
      for (let i = 0; i < material.length; i++) {
        const id = material[i];
        if (id === 0 || (wall !== null && wall[i] !== 0)) continue;
        const type = registry.get(id);
        if (!type || !regrows(type) || amount[i] >= type.maxAmount) continue;
        if (type.ripeIn && !isRipe(type, season)) continue;
        const expected = type.props.growth * REGROW_RATE * seasonFactor * type.maxAmount;
        let gain = Math.floor(expected);
        if (rng.next() < expected - gain) gain++;
        if (gain > 0) {
          amount[i] = Math.min(type.maxAmount, amount[i] + gain);
          changed = true;
        }
      }
      if (changed) chunk.dirty = true;
    }
  }
}

/** World tile coordinates for a chunk-local index (helper for systems that scan chunks). */
export function tileOf(chunk: Chunk, index: number): [number, number] {
  return [chunk.cx * CHUNK_SIZE + (index % CHUNK_SIZE), chunk.cy * CHUNK_SIZE + Math.floor(index / CHUNK_SIZE)];
}
