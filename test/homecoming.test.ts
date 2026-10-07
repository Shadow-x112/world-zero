import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/core/world.ts";
import { getCalendar } from "../src/core/time.ts";
import { Terrain } from "../src/world/chunk.ts";
import { SpatialIndex } from "../src/agents/senses.ts";
import { planRoute } from "../src/agents/movement.ts";
import { ACTIONS } from "../src/agents/actions.ts";
import type { Agent } from "../src/agents/agent.ts";
import type { AgentContext } from "../src/agents/movement.ts";

function ctxOf(world: World): AgentContext {
  const index = new SpatialIndex(8);
  index.rebuild(world.population.list());
  return { world, population: world.population, index };
}

/** Flattens a square of open ground (and clears whatever grows or lies on it). */
function clearGround(world: World, cx: number, cy: number, r: number): void {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      world.grid.set("terrain", x, y, Terrain.open);
      world.grid.set("height", x, y, 0);
      world.grid.set("material", x, y, 0);
      world.grid.set("amount", x, y, 0);
    }
  }
}

test("a long walk blocked straight ahead goes around instead of giving up", () => {
  const world = World.create({ seed: 131 });
  const [walker] = world.population.list();
  clearGround(world, 1000, 1000, 160);
  // A long ridge across the way, far wider than any one leg can search around.
  for (let y = 880; y <= 1120; y++) world.grid.set("terrain", 1040, y, Terrain.barrier);
  walker.x = 1000;
  walker.y = 1000;
  const goal = { x: 1100, y: 1000 };
  let legs = 0;
  while (Math.hypot(walker.x - goal.x, walker.y - goal.y) > 2 && legs < 60) {
    assert.ok(planRoute(walker, ctxOf(world), goal.x, goal.y), `leg ${legs} found a way`);
    const nx = walker.path[walker.path.length - 2];
    const ny = walker.path[walker.path.length - 1];
    walker.heading = Math.atan2(ny - walker.y, nx - walker.x); // it faces the way it walked
    walker.x = nx;
    walker.y = ny;
    legs++;
  }
  assert.ok(Math.hypot(walker.x - goal.x, walker.y - goal.y) <= 2, `got around the ridge in ${legs} legs`);
});

test("at nightfall a partner walks to its sleeping mate, past sleeping strangers", () => {
  const world = World.create({ seed: 132 });
  const [walker, mate, stranger] = world.population.list();
  clearGround(world, 2030, 2000, 50);
  let t = world.tick;
  while (getCalendar(t).hour < getCalendar(t).sunsetHour) t += 600;
  world.tick = t;
  world.calendar = getCalendar(t);
  walker.mate = mate.id;
  mate.mate = walker.id;
  walker.nest = null;
  mate.nest = null;
  walker.x = 2000;
  walker.y = 2000;
  walker.needs.rest = 0.6;
  stranger.x = 2025; // asleep right on the way
  stranger.y = 2000;
  stranger.asleep = true;
  mate.x = 2060;
  mate.y = 2000;
  mate.asleep = true;
  // Everyone else is far away.
  for (const other of world.population.list()) {
    if (other !== walker && other !== mate && other !== stranger) {
      other.x = -5000;
      other.y = -5000;
    }
  }
  walker.action = { type: "sleep", startedTick: world.tick };
  ACTIONS.sleep.start(walker, ctxOf(world));
  for (let i = 0; i < 3600 && !walker.asleep; i++) {
    world.tick++;
    ACTIONS.sleep.step(walker, ctxOf(world));
  }
  assert.ok(walker.asleep, "it lay down");
  const toMate = Math.hypot(walker.x - mate.x, walker.y - mate.y);
  assert.ok(toMate <= 3, `beside its mate (${toMate.toFixed(1)} tiles), not the stranger on the way`);
});
