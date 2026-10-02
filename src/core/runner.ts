// Runs the world in real time.
// At 1x, 4 ticks (world seconds) pass per real second, so a world day lasts
// 6 real hours. Speed multiplies that. If the machine can't keep up, the
// runner drops the excess instead of freezing to catch up, and reports lag.

import { SPEEDS, TICKS_PER_REAL_SECOND } from "./constants.ts";
import type { World } from "./world.ts";

export type Speed = (typeof SPEEDS)[number];

export interface RunnerOptions {
  /** Real milliseconds between frames. */
  frameMs?: number;
  /** Maximum real milliseconds of simulation work per frame. */
  budgetMs?: number;
  /** Real seconds of backlog allowed before excess time is dropped. */
  maxBacklogSeconds?: number;
  /** Source of real time in ms (replaceable in tests). */
  now?: () => number;
  /** Called after each frame (used for autosave, status output). */
  onFrame?: (runner: Runner) => void;
}

export function isSpeed(value: number): value is Speed {
  return (SPEEDS as readonly number[]).includes(value);
}

export class Runner {
  world: World;
  private speedValue: Speed;
  private backlog = 0; // ticks owed
  private last = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly frameMs: number;
  private readonly budgetMs: number;
  private readonly maxBacklogSeconds: number;
  private readonly now: () => number;
  private readonly onFrame?: (runner: Runner) => void;

  /** Ticks dropped because the machine could not keep up. */
  droppedTicks = 0;
  /** True if the last frame ran out of time budget. */
  lagging = false;
  /** Measured ticks per real second over the last few seconds. */
  measuredTps = 0;
  private tpsWindowStart = 0;
  private tpsWindowTicks = 0;

  constructor(world: World, speed: Speed = 1, options: RunnerOptions = {}) {
    this.world = world;
    this.speedValue = speed;
    this.frameMs = options.frameMs ?? 25;
    this.budgetMs = options.budgetMs ?? 40;
    this.maxBacklogSeconds = options.maxBacklogSeconds ?? 2;
    this.now = options.now ?? (() => performance.now());
    this.onFrame = options.onFrame;
  }

  /** Swaps in a different world (used after an extinction). */
  setWorld(world: World): void {
    this.world = world;
    this.backlog = 0;
  }

  get speed(): Speed {
    return this.speedValue;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  setSpeed(speed: number): void {
    if (!isSpeed(speed)) throw new Error(`Speed must be one of ${SPEEDS.join(", ")}`);
    this.speedValue = speed;
    if (speed === 0) this.backlog = 0;
  }

  start(): void {
    if (this.timer) return;
    this.last = this.now();
    this.tpsWindowStart = this.last;
    this.tpsWindowTicks = 0;
    const loop = () => {
      this.frame();
      if (this.timer !== null) this.timer = setTimeout(loop, this.frameMs);
    };
    this.timer = setTimeout(loop, this.frameMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Runs one frame: works off as many owed ticks as the time budget allows. */
  frame(): void {
    const start = this.now();
    const elapsedSeconds = Math.max(0, (start - this.last) / 1000);
    this.last = start;

    this.backlog += elapsedSeconds * TICKS_PER_REAL_SECOND * this.speedValue;
    const maxBacklog = Math.max(1, this.maxBacklogSeconds * TICKS_PER_REAL_SECOND * this.speedValue);
    if (this.backlog > maxBacklog) {
      this.droppedTicks += Math.floor(this.backlog - maxBacklog);
      this.backlog = maxBacklog;
    }

    let ran = 0;
    this.lagging = false;
    while (this.backlog >= 1) {
      this.world.step();
      this.backlog -= 1;
      ran++;
      if ((ran & 31) === 0 && this.now() - start > this.budgetMs) {
        this.lagging = this.backlog >= 1;
        break;
      }
    }

    this.tpsWindowTicks += ran;
    const windowMs = start - this.tpsWindowStart;
    if (windowMs >= 2000) {
      this.measuredTps = (this.tpsWindowTicks * 1000) / windowMs;
      this.tpsWindowStart = start;
      this.tpsWindowTicks = 0;
    }

    this.onFrame?.(this);
  }
}
