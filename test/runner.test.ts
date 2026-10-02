import { test } from "node:test";
import assert from "node:assert/strict";

import { Runner } from "../src/core/runner.ts";
import { World } from "../src/core/world.ts";

function fakeClock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function setup(speed: number) {
  const clock = fakeClock();
  const world = World.create({ seed: 1 });
  const runner = new Runner(world, speed as never, { now: clock.now, budgetMs: 1e9 });
  runner.frame(); // establishes the starting time
  return { clock, world, runner, startTick: world.tick };
}

test("1x runs 4 ticks per real second", () => {
  const { clock, world, runner, startTick } = setup(1);
  for (let i = 0; i < 40; i++) {
    clock.advance(250);
    runner.frame();
  }
  assert.equal(world.tick - startTick, 40);
});

test("speed multiplies the pace", () => {
  const { clock, world, runner, startTick } = setup(10);
  clock.advance(1000);
  runner.frame();
  assert.equal(world.tick - startTick, 40);
});

test("pause stops time completely", () => {
  const { clock, world, runner, startTick } = setup(1);
  runner.setSpeed(0);
  clock.advance(60_000);
  runner.frame();
  assert.equal(world.tick, startTick);
});

test("invalid speeds are rejected", () => {
  const { runner } = setup(1);
  assert.throws(() => runner.setSpeed(3));
  assert.throws(() => runner.setSpeed(-1));
});

test("a long stall drops time instead of freezing to catch up", () => {
  const { clock, world, runner, startTick } = setup(1);
  clock.advance(10 * 60 * 1000); // 10 real minutes frozen
  runner.frame();
  assert.equal(world.tick - startTick, 8); // only the 2-second backlog is run
  assert.ok(runner.droppedTicks > 2000);
});

test("fractional ticks carry over between frames", () => {
  const { clock, world, runner, startTick } = setup(1);
  for (let i = 0; i < 16; i++) {
    clock.advance(62.5); // a quarter tick per frame
    runner.frame();
  }
  assert.equal(world.tick - startTick, 4);
});
