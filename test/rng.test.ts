import { test } from "node:test";
import assert from "node:assert/strict";

import { Rng, hash32 } from "../src/core/rng.ts";

test("the same seed gives the same sequence", () => {
  const a = Rng.fromSeed(42);
  const b = Rng.fromSeed(42);
  for (let i = 0; i < 1000; i++) assert.equal(a.nextUint32(), b.nextUint32());
});

test("different seeds give different sequences", () => {
  const a = Rng.fromSeed(1);
  const b = Rng.fromSeed(2);
  const same = Array.from({ length: 100 }, () => a.nextUint32() === b.nextUint32()).filter(Boolean).length;
  assert.ok(same < 3);
});

test("saved state resumes the exact same sequence", () => {
  const a = Rng.fromSeed(7);
  for (let i = 0; i < 50; i++) a.next();
  const b = new Rng(a.getState());
  for (let i = 0; i < 1000; i++) assert.equal(a.next(), b.next());
});

test("values are in range and roughly uniform", () => {
  const rng = Rng.fromSeed(123);
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 100000; i++) {
    const v = rng.next();
    assert.ok(v >= 0 && v < 1);
    buckets[Math.floor(v * 10)]++;
  }
  for (const count of buckets) assert.ok(Math.abs(count - 10000) < 500, `bucket ${count}`);
  for (let i = 0; i < 1000; i++) {
    const n = rng.int(3, 6);
    assert.ok(Number.isInteger(n) && n >= 3 && n <= 6);
  }
});

test("hash32 is stable and sensitive to every input", () => {
  assert.equal(hash32(1, 2, 3), hash32(1, 2, 3));
  assert.notEqual(hash32(1, 2, 3), hash32(1, 2, 4));
  assert.notEqual(hash32(1, 2, 3), hash32(3, 2, 1));
  assert.notEqual(hash32(-5, 0), hash32(5, 0));
});
