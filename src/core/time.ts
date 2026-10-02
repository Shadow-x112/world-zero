// World calendar: turns a tick count into day, season, year, time of day and light.
// Everything here is a pure function of the tick, so time never drifts.

import {
  DAYLIGHT_HOURS,
  DAYS_PER_SEASON,
  DAYS_PER_YEAR,
  SEASONS,
  TICKS_PER_DAY,
  TWILIGHT_HOURS,
  WORLD_SECONDS_PER_TICK,
  type Season,
} from "./constants.ts";

export interface Calendar {
  tick: number;
  /** Days since the world began (0-based). */
  day: number;
  /** Year number (1-based). */
  year: number;
  /** Day within the year (0-based, 0..39). */
  dayOfYear: number;
  season: Season;
  /** Day within the season (1-based, 1..10). */
  dayOfSeason: number;
  hour: number;
  minute: number;
  /** Fraction of the day elapsed, 0..1. */
  timeOfDay: number;
  daylightHours: number;
  sunriseHour: number;
  sunsetHour: number;
  /** Ambient light, 0 (full night) to 1 (full day). */
  light: number;
  isDay: boolean;
}

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** Daylight hours for a fractional day of the year, blended smoothly between season midpoints. */
export function daylightHoursAt(dayOfYearFrac: number): number {
  const half = DAYS_PER_SEASON / 2;
  const n = SEASONS.length;
  let p = (dayOfYearFrac - half) / DAYS_PER_SEASON;
  p = ((p % n) + n) % n;
  const i = Math.floor(p);
  const f = smoothstep(p - i);
  const a = DAYLIGHT_HOURS[SEASONS[i]];
  const b = DAYLIGHT_HOURS[SEASONS[(i + 1) % n]];
  return a + (b - a) * f;
}

/** Ambient light for an hour of day given sunrise and sunset, with soft twilight. */
export function lightAt(hour: number, sunrise: number, sunset: number): number {
  const t = TWILIGHT_HOURS;
  const rise = smoothstep((hour - (sunrise - t / 2)) / t);
  const set = 1 - smoothstep((hour - (sunset - t / 2)) / t);
  return Math.min(rise, set);
}

export function getCalendar(tick: number): Calendar {
  const day = Math.floor(tick / TICKS_PER_DAY);
  const tickOfDay = tick - day * TICKS_PER_DAY;
  const timeOfDay = tickOfDay / TICKS_PER_DAY;
  const secondsOfDay = tickOfDay * WORLD_SECONDS_PER_TICK;
  const hourFrac = secondsOfDay / 3600;

  const dayOfYear = ((day % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  const year = Math.floor(day / DAYS_PER_YEAR) + 1;
  const seasonIndex = Math.floor(dayOfYear / DAYS_PER_SEASON);
  const season = SEASONS[seasonIndex];
  const dayOfSeason = (dayOfYear % DAYS_PER_SEASON) + 1;

  const daylightHours = daylightHoursAt(dayOfYear + timeOfDay);
  const sunriseHour = 12 - daylightHours / 2;
  const sunsetHour = 12 + daylightHours / 2;
  const light = lightAt(hourFrac, sunriseHour, sunsetHour);

  return {
    tick,
    day,
    year,
    dayOfYear,
    season,
    dayOfSeason,
    hour: Math.floor(hourFrac),
    minute: Math.floor((secondsOfDay % 3600) / 60),
    timeOfDay,
    daylightHours,
    sunriseHour,
    sunsetHour,
    light,
    isDay: light >= 0.5,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Human-readable stamp, e.g. "Year 1, Growth day 3, 14:05 (day)". */
export function formatCalendar(c: Calendar): string {
  const season = c.season[0].toUpperCase() + c.season.slice(1);
  return `Year ${c.year}, ${season} day ${c.dayOfSeason}, ${pad(c.hour)}:${pad(c.minute)} (${c.isDay ? "day" : "night"})`;
}
