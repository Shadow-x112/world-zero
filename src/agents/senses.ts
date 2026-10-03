// What agents can perceive, and a spatial index so "who is near me?" stays
// fast as the population grows.

import type { World } from "../core/world.ts";
import { KNOWN_BLOCK_SIZE, blockOf, type Agent } from "./agent.ts";

/** How far an agent can see in full daylight and in full darkness, in tiles. */
export const SIGHT_DAY = 12;
export const SIGHT_NIGHT = 4;

export function sightRadius(light: number): number {
  return SIGHT_NIGHT + (SIGHT_DAY - SIGHT_NIGHT) * light;
}

/** Buckets agents into square cells for quick neighbor lookups. Rebuilt every tick. */
export class SpatialIndex {
  private readonly cellSize: number;
  private cells = new Map<number, Agent[]>();

  constructor(cellSize = 8) {
    this.cellSize = cellSize;
  }

  private key(cx: number, cy: number): number {
    return (cx + 32768) * 65536 + (cy + 32768);
  }

  rebuild(agents: Iterable<Agent>): void {
    this.cells.clear();
    for (const a of agents) {
      const k = this.key(Math.floor(a.x / this.cellSize), Math.floor(a.y / this.cellSize));
      let cell = this.cells.get(k);
      if (!cell) {
        cell = [];
        this.cells.set(k, cell);
      }
      cell.push(a);
    }
  }

  /** Agents within `radius` tiles of a point, excluding `except`, nearest first. */
  near(x: number, y: number, radius: number, except?: Agent): { agent: Agent; dist: number }[] {
    const out: { agent: Agent; dist: number }[] = [];
    const s = this.cellSize;
    const minCx = Math.floor((x - radius) / s);
    const maxCx = Math.floor((x + radius) / s);
    const minCy = Math.floor((y - radius) / s);
    const maxCy = Math.floor((y + radius) / s);
    const r2 = radius * radius;
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const cell = this.cells.get(this.key(cx, cy));
        if (!cell) continue;
        for (const a of cell) {
          if (a === except) continue;
          const dx = a.x - x;
          const dy = a.y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= r2) out.push({ agent: a, dist: Math.sqrt(d2) });
        }
      }
    }
    out.sort((p, q) => p.dist - q.dist || p.agent.id - q.agent.id);
    return out;
  }

  /** Whether anyone other than `except` is within `radius` tiles. */
  any(x: number, y: number, radius: number, except: Agent): boolean {
    const s = this.cellSize;
    const r2 = radius * radius;
    for (let cy = Math.floor((y - radius) / s); cy <= Math.floor((y + radius) / s); cy++) {
      for (let cx = Math.floor((x - radius) / s); cx <= Math.floor((x + radius) / s); cx++) {
        const cell = this.cells.get(this.key(cx, cy));
        if (!cell) continue;
        for (const a of cell) {
          if (a === except) continue;
          const dx = a.x - x;
          const dy = a.y - y;
          if (dx * dx + dy * dy <= r2) return true;
        }
      }
    }
    return false;
  }
}

/**
 * Marks the coarse blocks within sight as known. Each new block satisfies
 * some curiosity. Returns how many blocks were new.
 */
export function learnAround(agent: Agent, world: World): number {
  const radius = sightRadius(world.calendar.light);
  const minBx = blockOf(agent.x - radius);
  const maxBx = blockOf(agent.x + radius);
  const minBy = blockOf(agent.y - radius);
  const maxBy = blockOf(agent.y + radius);
  const half = KNOWN_BLOCK_SIZE / 2;
  let learned = 0;
  for (let by = minBy; by <= maxBy; by++) {
    for (let bx = minBx; bx <= maxBx; bx++) {
      // Count a block as seen when its center is within sight.
      const cx = bx * KNOWN_BLOCK_SIZE + half;
      const cy = by * KNOWN_BLOCK_SIZE + half;
      if (Math.hypot(cx - agent.x, cy - agent.y) > radius) continue;
      if (agent.learnBlock(bx, by, world.tick)) learned++;
    }
  }
  return learned;
}
