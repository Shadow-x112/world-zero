import { test } from "node:test";
import assert from "node:assert/strict";

import { getCalendar, daylightHoursAt, formatCalendar } from "../src/core/time.ts";
import {
  TICKS_PER_DAY,
  TICKS_PER_REAL_SECOND,
  START_TICK,
  DAYS_PER_YEAR,
  REAL_SECONDS_PER_WORLD_DAY,
} from "../src/core/constants.ts";

test("a world day lasts 6 real hours at 1x", () => {
  assert.equal(TICKS_PER_REAL_SECOND, 4);
  assert.equal(TICKS_PER_DAY / TICKS_PER_REAL_SECOND, REAL_SECONDS_PER_WORLD_DAY);
});

test("the world starts on day 0 at 08:00 in the growth season, in daylight", () => {
  const c = getCalendar(START_TICK);
  assert.equal(c.day, 0);
  assert.equal(c.year, 1);
  assert.equal(c.season, "growth");
  assert.equal(c.dayOfSeason, 1);
  assert.equal(c.hour, 8);
  assert.equal(c.minute, 0);
  assert.ok(c.isDay);
});

test("seasons last 10 days and the year 40", () => {
  const at = (day: number) => getCalendar(day * TICKS_PER_DAY + 12 * 3600);
  assert.equal(at(0).season, "growth");
  assert.equal(at(9).season, "growth");
  assert.equal(at(9).dayOfSeason, 10);
  assert.equal(at(10).season, "peak");
  assert.equal(at(20).season, "decline");
  assert.equal(at(30).season, "cold");
  assert.equal(at(39).season, "cold");
  assert.equal(at(40).season, "growth");
  assert.equal(at(40).year, 2);
  assert.equal(DAYS_PER_YEAR, 40);
});

test("daylight is longest in peak and shortest in cold, changing smoothly", () => {
  assert.equal(Math.round(daylightHoursAt(15)), 15); // middle of peak
  assert.equal(Math.round(daylightHoursAt(35)), 8); // middle of cold
  let prev = daylightHoursAt(0);
  for (let d = 0.25; d < 80; d += 0.25) {
    const cur = daylightHoursAt(d);
    assert.ok(Math.abs(cur - prev) < 0.5, `daylight jumped at day ${d}`);
    prev = cur;
  }
});

test("midnight is dark and noon is bright in every season", () => {
  for (let day = 0; day < 40; day++) {
    const midnight = getCalendar(day * TICKS_PER_DAY);
    const noon = getCalendar(day * TICKS_PER_DAY + 12 * 3600);
    assert.equal(midnight.light, 0, `day ${day} midnight`);
    assert.equal(noon.light, 1, `day ${day} noon`);
  }
});

test("light fades in and out instead of switching", () => {
  const c = getCalendar(START_TICK);
  const values: number[] = [];
  for (let s = (c.sunriseHour - 1) * 3600; s <= (c.sunriseHour + 1) * 3600; s += 300) {
    values.push(getCalendar(s).light);
  }
  assert.ok(values.some((v) => v > 0 && v < 1), "expected partial light at dawn");
  for (let i = 1; i < values.length; i++) assert.ok(values[i] >= values[i - 1]);
});

test("calendar formats readably", () => {
  assert.equal(formatCalendar(getCalendar(START_TICK)), "Year 1, Growth day 1, 08:00 (day)");
});
