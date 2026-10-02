import { test } from "node:test";
import assert from "node:assert/strict";

import { Grid, toChunkCoord, toLocalCoord } from "../src/world/grid.ts";
import { CHUNK_SIZE, Terrain } from "../src/world/chunk.ts";
import { FLAT_RADIUS, sampleTile, wildnessAt } from "../src/world/generator.ts";

test("coordinates map to chunks correctly, including negatives", () => {
  assert.equal(toChunkCoord(0), 0);
  assert.equal(toChunkCoord(CHUNK_SIZE - 1), 0);
  assert.equal(toChunkCoord(CHUNK_SIZE), 1);
  assert.equal(toChunkCoord(-1), -1);
  assert.equal(toChunkCoord(-CHUNK_SIZE), -1);
  assert.equal(toChunkCoord(-CHUNK_SIZE - 1), -2);
  assert.equal(toLocalCoord(-1), CHUNK_SIZE - 1);
  assert.equal(toLocalCoord(-CHUNK_SIZE), 0);
});

test("the starting plain is perfectly flat and open", () => {
  const grid = new Grid(99);
  for (let y = -FLAT_RADIUS; y <= FLAT_RADIUS; y++) {
    for (let x = -FLAT_RADIUS; x <= FLAT_RADIUS; x++) {
      if (Math.hypot(x, y) > FLAT_RADIUS) continue;
      assert.equal(grid.heightAt(x, y), 0);
      assert.equal(grid.terrainAt(x, y), Terrain.open);
    }
  }
});

test("chunks are created only when visited", () => {
  const grid = new Grid(1);
  assert.equal(grid.chunkCount, 0);
  grid.heightAt(5000, -7000);
  assert.equal(grid.chunkCount, 1);
  assert.ok(grid.hasChunk(toChunkCoord(5000), toChunkCoord(-7000)));
});

test("generation is determined by the seed and position", () => {
  for (const [x, y] of [[600, 40], [-900, 1200], [3000, -3000]]) {
    assert.deepEqual(sampleTile(5, x, y), sampleTile(5, x, y));
  }
  const a = new Grid(5);
  const b = new Grid(5);
  assert.equal(a.heightAt(777, -333), b.heightAt(777, -333));
});

test("the world grows wilder with distance", () => {
  assert.equal(wildnessAt(0, 0), 0);
  assert.equal(wildnessAt(FLAT_RADIUS, 0), 0);
  assert.ok(wildnessAt(200, 0) > 0);
  assert.equal(wildnessAt(5000, 0), 1);
});

test("far land has elevation, water and barriers in sensible amounts", () => {
  const counts = { open: 0, water: 0, barrier: 0 };
  const heights = new Set<number>();
  let total = 0;
  for (let y = 2000; y < 2400; y += 2) {
    for (let x = 2000; x < 2400; x += 2) {
      const t = sampleTile(2024, x, y);
      total++;
      heights.add(t.height);
      if (t.terrain === Terrain.open) counts.open++;
      else if (t.terrain === Terrain.water) counts.water++;
      else counts.barrier++;
    }
  }
  assert.ok(counts.water / total > 0.02 && counts.water / total < 0.4, `water ${counts.water / total}`);
  assert.ok(counts.barrier / total > 0.001 && counts.barrier / total < 0.15, `barrier ${counts.barrier / total}`);
  assert.ok(counts.open / total > 0.5, `open ${counts.open / total}`);
  assert.ok(heights.size > 5, "expected varied elevation");
});

test("changes to tiles are kept and mark the chunk for saving", () => {
  const grid = new Grid(3);
  const chunk = grid.getChunk(0, 0);
  chunk.dirty = false;
  grid.set("height", 3, 4, 2);
  assert.equal(grid.heightAt(3, 4), 2);
  assert.ok(chunk.dirty);
});
