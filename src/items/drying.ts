// Wet things dry. A mixed paste left for some hours turns into what it
// yields (bricks), whether it is carried or lying on the ground.

import { TICKS_PER_DAY } from "../core/constants.ts";
import type { System, World } from "../core/world.ts";
import { addCarried, carriedMass, carryCapacity } from "../agents/foraging.ts";
import { warmthAt } from "../world/fire.ts";

/** How often drying is checked, in ticks (every world quarter hour). */
export const DRYING_INTERVAL = TICKS_PER_DAY / 96;

/** Sets loose units down on or next to a tile (whatever ground has room for them). */
export function depositUnits(world: World, x: number, y: number, material: number, units: number): number {
  const grid = world.grid;
  for (let r = 0; r <= 1; r++) {
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
        const tx = x + ox;
        const ty = y + oy;
        if (grid.peek("wall", tx, ty) !== 0) continue;
        const here = grid.get("material", tx, ty);
        if (here !== 0 && (here !== material || grid.get("amount", tx, ty) === 0)) continue;
        grid.set("material", tx, ty, material);
        grid.set("amount", tx, ty, Math.min(65535, grid.get("amount", tx, ty) + units));
        return units;
      }
    }
  }
  return 0; // nowhere to put it: lost
}

/** A fire near a wet thing hurries it along (heat drives the water out). */
function hurryDrying(world: World, x: number, y: number, items: { dryAtTick?: number }[]): void {
  if (world.fireTiles.size === 0 || warmthAt(world, x, y) < 0.5) return;
  for (const item of items) {
    if (item.dryAtTick !== undefined) item.dryAtTick -= DRYING_INTERVAL * 5;
  }
}

function firstBricks(world: World, who: string): void {
  if (world.isFirst("brick")) {
    world.chronicle.add(world.tick, "crafting", `${who} dried hard: bricks, a material the world never made on its own.`, {});
  }
}

export class Drying implements System {
  readonly name = "drying";

  update(world: World): void {
    if (world.tick % DRYING_INTERVAL !== 0) return;
    const tick = world.tick;

    for (const agent of world.population.all()) {
      if (agent.items.length === 0) continue;
      hurryDrying(world, agent.tileX, agent.tileY, agent.items);
      const dried = agent.items.filter((i) => i.dryAtTick !== undefined && i.dryAtTick <= tick);
      if (dried.length === 0) continue;
      agent.items = agent.items.filter((i) => !dried.includes(i));
      for (const item of dried) {
        if (!item.yields) continue;
        firstBricks(world, `The paste ${agent.label} had worked`);
        const type = world.materials.require(item.yields.material);
        // Take what the arms can hold; the rest goes on the ground at its feet.
        const free = Math.max(0, carryCapacity(agent, world.tick) - carriedMass(agent, world));
        const carried = Math.min(item.yields.units, Math.floor(free / Math.max(0.01, type.props.mass) + 1e-9));
        if (carried > 0) addCarried(agent, item.yields.material, carried);
        const rest = item.yields.units - carried;
        if (rest > 0) depositUnits(world, agent.tileX, agent.tileY, item.yields.material, rest);
      }
    }

    for (const g of world.groundItems.all()) {
      const item = g.item;
      if (item.dryAtTick !== undefined) hurryDrying(world, g.x, g.y, [item]);
      if (item.dryAtTick === undefined || item.dryAtTick > tick) continue;
      world.groundItems.take(g.x, g.y, item.id);
      if (!item.yields) continue;
      firstBricks(world, "A paste someone had left lying");
      depositUnits(world, g.x, g.y, item.yields.material, item.yields.units);
    }
  }
}
