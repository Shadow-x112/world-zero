// Core constants for world time and scale.
// Changing any of these after a world exists changes how that world runs,
// so treat them as part of the save format (see SAVE_FORMAT_VERSION).

/** One simulation tick equals one world second. */
export const WORLD_SECONDS_PER_TICK = 1;

/** A world day lasts 6 real hours at 1x speed (a quarter of a real day). */
export const REAL_SECONDS_PER_WORLD_DAY = 6 * 60 * 60;

export const WORLD_SECONDS_PER_DAY = 24 * 60 * 60;

/** World seconds that pass per real second at 1x speed (86400 / 21600 = 4). */
export const WORLD_SECONDS_PER_REAL_SECOND = WORLD_SECONDS_PER_DAY / REAL_SECONDS_PER_WORLD_DAY;

/** Ticks per real second at 1x speed. */
export const TICKS_PER_REAL_SECOND = WORLD_SECONDS_PER_REAL_SECOND / WORLD_SECONDS_PER_TICK;

export const TICKS_PER_DAY = WORLD_SECONDS_PER_DAY / WORLD_SECONDS_PER_TICK;

export const DAYS_PER_SEASON = 10;
export const SEASONS = ["growth", "peak", "decline", "cold"] as const;
export type Season = (typeof SEASONS)[number];
export const DAYS_PER_YEAR = DAYS_PER_SEASON * SEASONS.length; // 40

/** Hours of daylight at the middle of each season. Values in between are blended smoothly. */
export const DAYLIGHT_HOURS: Record<Season, number> = {
  growth: 12,
  peak: 15,
  decline: 12,
  cold: 8,
};

/** Length of dawn and dusk, in world hours, over which light fades in and out. */
export const TWILIGHT_HOURS = 1;

/** The world begins on day 0 at 08:00, shortly after sunrise, so the first AIs wake to morning light. */
export const START_TICK = 8 * 60 * 60 / WORLD_SECONDS_PER_TICK;

/** Allowed speed multipliers. 0 means paused. */
export const SPEEDS = [0, 1, 2, 5, 10, 25, 50, 100] as const;
