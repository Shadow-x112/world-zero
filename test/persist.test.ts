import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { World } from "../src/core/world.ts";
import { Store, serializeWorld, deserializeWorld, SAVE_FORMAT_VERSION } from "../src/persist/store.ts";
import { TICKS_PER_DAY } from "../src/core/constants.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "world-zero-test-"));
}

test("a new world starts with a chronicle entry and the starting plain", () => {
  const world = World.create({ seed: 11 });
  assert.equal(world.chronicle.size, 1);
  assert.ok(world.grid.chunkCount > 0);
  assert.equal(world.meta.generation, 1);
});

test("save then load restores the same world exactly", async () => {
  const dir = await tempDir();
  try {
    const world = World.create({ seed: 4242 });
    for (let i = 0; i < 5000; i++) world.step();
    world.grid.set("height", 10, -10, 3);
    world.grid.heightAt(900, 900); // a far chunk
    world.chronicle.add(world.tick, "test", "Something notable happened");
    world.rng.next();

    const store = new Store(dir);
    await store.save(world, 10);
    const loaded = await store.load();
    assert.ok(loaded);

    assert.equal(loaded.speed, 10);
    assert.deepEqual(loaded.world.meta, world.meta);
    assert.equal(loaded.world.tick, world.tick);
    assert.deepEqual(loaded.world.rng.getState(), world.rng.getState());
    assert.deepEqual(loaded.world.chronicle.toJSON(), world.chronicle.toJSON());
    assert.equal(loaded.world.grid.chunkCount, world.grid.chunkCount);
    assert.equal(loaded.world.grid.heightAt(10, -10), 3);
    assert.equal(loaded.world.grid.heightAt(900, 900), world.grid.heightAt(900, 900));
    assert.deepEqual(serializeWorld(loaded.world, 10).chunks, serializeWorld(world, 10).chunks);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a loaded world continues identically to one that never stopped", () => {
  const a = World.create({ seed: 77 });
  for (let i = 0; i < 1000; i++) a.step();
  const b = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(a, 1)))).world;
  for (let i = 0; i < 1000; i++) {
    a.step();
    b.step();
  }
  assert.equal(a.tick, b.tick);
  assert.deepEqual(a.rng.getState(), b.rng.getState());
  assert.deepEqual(a.calendar, b.calendar);
});

test("calendar events fire as days and seasons pass", () => {
  const world = World.create({ seed: 1 });
  const seen = { newDay: 0, newSeason: 0, dawn: 0, dusk: 0 };
  world.events.on("newDay", () => seen.newDay++);
  world.events.on("newSeason", () => seen.newSeason++);
  world.events.on("dawn", () => seen.dawn++);
  world.events.on("dusk", () => seen.dusk++);
  for (let i = 0; i < 11 * TICKS_PER_DAY; i++) world.step();
  assert.equal(seen.newDay, 11);
  assert.equal(seen.newSeason, 1);
  assert.equal(seen.dawn, 11);
  assert.equal(seen.dusk, 11);
});

test("loading falls back to the previous save if the current one is damaged", async () => {
  const dir = await tempDir();
  try {
    const store = new Store(dir);
    const world = World.create({ seed: 5 });
    await store.save(world, 1);
    for (let i = 0; i < 100; i++) world.step();
    await store.save(world, 1); // previous now holds the first save
    await writeFile(store.currentPath, "garbage");
    const loaded = await store.load();
    assert.ok(loaded);
    assert.equal(loaded.source, store.previousPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("there is no save in an empty folder", async () => {
  const dir = await tempDir();
  try {
    assert.equal(await new Store(dir).load(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saves from a newer format are refused rather than misread", () => {
  const data = serializeWorld(World.create({ seed: 1 }), 1);
  assert.throws(() => deserializeWorld({ ...data, format: SAVE_FORMAT_VERSION + 1 }), /newer/);
});

test("old backups are pruned: recent ones kept, then one per day", async () => {
  const dir = await tempDir();
  try {
    const store = new Store(dir);
    await store.ensureDirs();
    // 5 days x 10 backups each.
    for (let d = 1; d <= 5; d++) {
      for (let h = 0; h < 10; h++) {
        const name = `world-g1-202610${String(d).padStart(2, "0")}-${String(h).padStart(2, "0")}0000.json.gz`;
        await writeFile(join(store.backupsDir, name), "x");
      }
    }
    await store.prune({ keepRecent: 12, keepDaily: 2 });
    const left = (await readdir(store.backupsDir)).sort();
    assert.equal(left.length, 14);
    // newest 12 are kept
    assert.ok(left.includes("world-g1-20261005-090000.json.gz"));
    // the two days before those keep exactly one each
    assert.ok(left.some((n) => n.includes("20261004")));
    assert.ok(!left.some((n) => n.includes("20261001")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
