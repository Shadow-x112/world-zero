// Finding a walkable route between two tiles (A* over the grid, 8 directions).
//
// A tile can be walked on if its terrain is open, and a step between tiles may
// climb or drop at most one level. Diagonal steps may not cut past corners.

import type { Grid } from "../world/grid.ts";

/** How far a single step may climb or drop, in levels. */
export const MAX_STEP_HEIGHT = 1;

const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

export function canStep(grid: Grid, fx: number, fy: number, tx: number, ty: number): boolean {
  if (!grid.isWalkable(tx, ty)) return false;
  if (Math.abs(grid.heightAt(tx, ty) - grid.heightAt(fx, fy)) > MAX_STEP_HEIGHT) return false;
  const dx = tx - fx;
  const dy = ty - fy;
  if (dx !== 0 && dy !== 0) {
    // No squeezing diagonally between two blocked tiles.
    if (!grid.isWalkable(fx + dx, fy) || !grid.isWalkable(fx, fy + dy)) return false;
  }
  return true;
}

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

/** Minimal binary heap of node ids ordered by score. */
class Heap {
  private ids: number[] = [];
  private scores: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, score: number): void {
    const ids = this.ids;
    const scores = this.scores;
    let i = ids.length;
    ids.push(id);
    scores.push(score);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (scores[parent] <= score) break;
      ids[i] = ids[parent];
      scores[i] = scores[parent];
      i = parent;
    }
    ids[i] = id;
    scores[i] = score;
  }

  pop(): number {
    const ids = this.ids;
    const scores = this.scores;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastScore = scores.pop()!;
    if (ids.length > 0) {
      let i = 0;
      const n = ids.length;
      while (true) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let ms = lastScore;
        if (l < n && scores[l] < ms) { m = l; ms = scores[l]; }
        if (r < n && scores[r] < ms) { m = r; ms = scores[r]; }
        if (m === i) break;
        ids[i] = ids[m];
        scores[i] = scores[m];
        i = m;
      }
      ids[i] = lastId;
      scores[i] = lastScore;
    }
    return top;
  }
}

/** Running totals, for diagnosing performance. */
export const PATH_STATS = { searches: 0, expanded: 0, failed: 0, partial: 0 };

export interface PathResult {
  /** Flat [x0, y0, x1, y1, ...] from the first step to the goal (start excluded). */
  path: number[];
  /** True if the goal was reached; false means the closest reachable tile was used. */
  complete: boolean;
}

/** Searches are confined to a square window this many tiles beyond the start and goal. */
const WINDOW_MARGIN = 48;
/** Largest window side (tiles). Routes are planned in legs, so this is ample. */
const MAX_WINDOW = 321;

// Search buffers, reused between searches. A "stamp" marks which entries
// belong to the current search, so nothing has to be cleared.
const CELLS = MAX_WINDOW * MAX_WINDOW;
const gCost = new Float64Array(CELLS);
const parentOf = new Int32Array(CELLS);
const seenStamp = new Uint32Array(CELLS);
const closedStamp = new Uint32Array(CELLS);
let stamp = 0;

/**
 * Finds a route from start to goal. If the goal can't be reached within the
 * search limit, returns a route to the closest tile found, or null if no
 * progress is possible at all.
 */
export function findPath(
  grid: Grid,
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  maxNodes = 4000,
): PathResult | null {
  if (sx === gx && sy === gy) return { path: [], complete: true };

  // Local window around start and goal.
  const half = Math.min((MAX_WINDOW - 1) / 2, Math.max(Math.abs(gx - sx), Math.abs(gy - sy)) + WINDOW_MARGIN);
  const side = half * 2 + 1;
  const ox = sx - half;
  const oy = sy - half;
  // A goal outside the window is approached as far as the window allows.
  const inWindow = (x: number, y: number) => x >= ox && y >= oy && x < ox + side && y < oy + side;

  stamp++;
  if (stamp === 0xffffffff) {
    seenStamp.fill(0);
    closedStamp.fill(0);
    stamp = 1;
  }

  const open = new Heap();
  const start = (sy - oy) * side + (sx - ox);
  gCost[start] = 0;
  parentOf[start] = -1;
  seenStamp[start] = stamp;
  open.push(start, octile(sx, sy, gx, gy));

  let best = start;
  let bestH = octile(sx, sy, gx, gy);
  let expanded = 0;
  let goalId = -1;

  while (open.size > 0) {
    const current = open.pop();
    if (closedStamp[current] === stamp) continue;
    closedStamp[current] = stamp;
    const cx = ox + (current % side);
    const cy = oy + Math.floor(current / side);
    if (cx === gx && cy === gy) {
      goalId = current;
      break;
    }
    const h = octile(cx, cy, gx, gy);
    if (h < bestH) {
      bestH = h;
      best = current;
    }
    if (++expanded > maxNodes) break;

    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inWindow(nx, ny)) continue;
      const next = (ny - oy) * side + (nx - ox);
      if (closedStamp[next] === stamp) continue;
      if (!canStep(grid, cx, cy, nx, ny)) continue;
      const tentative = gCost[current] + cost;
      if (seenStamp[next] !== stamp || tentative < gCost[next]) {
        seenStamp[next] = stamp;
        gCost[next] = tentative;
        parentOf[next] = current;
        open.push(next, tentative + octile(nx, ny, gx, gy));
      }
    }
  }

  PATH_STATS.searches++;
  PATH_STATS.expanded += expanded;
  const end = goalId >= 0 ? goalId : best;
  if (end === start) {
    PATH_STATS.failed++;
    return null;
  }
  if (goalId < 0) PATH_STATS.partial++;
  const reversed: number[] = [];
  for (let n = end; n !== start; n = parentOf[n]) reversed.push(n);
  const path: number[] = [];
  for (let i = reversed.length - 1; i >= 0; i--) {
    const n = reversed[i];
    path.push(ox + (n % side), oy + Math.floor(n / side));
  }
  return { path, complete: goalId >= 0 };
}
