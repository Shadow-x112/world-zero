// Weather that changes from year to year.
//
// Each winter has its own severity: most are ordinary, some mild, and now and
// then one is brutal. It depends only on the world's seed and the year, so it
// is fixed for every world from the start (no one, not even the AIs, can know
// it in advance) and needs no saving.

import { hashFloat } from "../core/rng.ts";
import type { System, World } from "../core/world.ts";

const SALT_WINTER = 9100;

/** Mildest and harshest winters, as multiples of an ordinary winter's cold. */
export const WINTER_MIN = 0.8;
export const WINTER_MAX = 1.4;

/**
 * How harsh a year's winter is. Skewed so ordinary winters are common and
 * brutal ones rare: about 1 in 11 is bitter (1.3 or worse).
 */
export function winterSeverity(seed: number, year: number): number {
  const u = hashFloat(seed, SALT_WINTER, year, 0);
  return WINTER_MIN + (WINTER_MAX - WINTER_MIN) * u * u;
}

export function describeWinter(severity: number): string {
  if (severity >= 1.3) return "bitter";
  if (severity >= 1.12) return "hard";
  if (severity <= 0.9) return "mild";
  return "ordinary";
}

/** Notes unusual winters in the chronicle as they begin. */
export class Weather implements System {
  readonly name = "weather";
  private unsubscribe: (() => void) | null = null;

  init(world: World): void {
    this.unsubscribe = world.events.on("newSeason", (e) => {
      if (e.season !== "cold") return;
      const kind = describeWinter(winterSeverity(world.meta.seed, e.year));
      if (kind === "bitter") world.chronicle.add(world.tick, "weather", "A bitter winter set in.", { year: e.year });
      else if (kind === "hard") world.chronicle.add(world.tick, "weather", "A hard winter set in.", { year: e.year });
      else if (kind === "mild") world.chronicle.add(world.tick, "weather", "The cold came gently this year.", { year: e.year });
    });
  }

  update(_world: World): void {}

  dispose(): void {
    this.unsubscribe?.();
  }
}
