// Keeps the grid tidy as time passes: footpaths fade a little each day, and
// untouched ground far from everyone is unloaded from memory.

import { TICKS_PER_DAY } from "../core/constants.ts";
import type { System, World } from "../core/world.ts";
import { toChunkCoord } from "./grid.ts";

/** Chunks within this many chunks of an agent stay in memory. */
export const KEEP_RADIUS_CHUNKS = 3;
/** How often idle ground is unloaded, in ticks (one world hour). */
export const UNLOAD_INTERVAL = TICKS_PER_DAY / 24;

export class GridMaintenance implements System {
  readonly name = "grid";
  private unsubscribe: (() => void) | null = null;

  init(world: World): void {
    this.unsubscribe = world.events.on("newDay", () => world.grid.fadeWear());
  }

  update(world: World): void {
    if (world.tick % UNLOAD_INTERVAL !== 0) return;
    const near = new Set<number>();
    const r = KEEP_RADIUS_CHUNKS;
    for (const agent of world.population.all()) {
      const cx = toChunkCoord(agent.x);
      const cy = toChunkCoord(agent.y);
      for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) near.add((cx + ox) * 100003 + (cy + oy));
    }
    world.grid.unloadIdle((cx, cy) => near.has(cx * 100003 + cy));
  }

  dispose(): void {
    this.unsubscribe?.();
  }
}
