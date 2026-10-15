import type { World } from "../../src/core/world.ts";
import type { MaterialType } from "../../src/materials/registry.ts";
import { FULL_HP, addToBlock, blockAt, type Level } from "../../src/building/structures.ts";
import { unitsPerPiece } from "../../src/building/pieces.ts";

/** Builds a wall or roof up piece by piece until it is whole, or nothing more helps. */
export function buildUp(world: World, level: Level, x: number, y: number, type: MaterialType, by = 1, toward?: { x: number; y: number }): void {
  let stale = 0;
  for (let i = 0; i < 80 && stale < 8 && (blockAt(world.grid, level, x, y)?.hp ?? 0) < FULL_HP; i++) {
    stale = addToBlock(world, level, x, y, type, unitsPerPiece(type), by, toward) === 0 ? 99 : 0;
  }
}
