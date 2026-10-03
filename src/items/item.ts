// Items: single crafted things, as opposed to loose material on the ground.
//
// An item has no name and no type. It is a bundle of parts and the properties
// that follow from them; what it is "for" is whatever its properties turn out
// to be good at, and only use reveals that. Items wear out and break.

import type { World } from "../core/world.ts";
import { PROPERTIES, describe, type Properties } from "../materials/registry.ts";

export interface ItemProps extends Properties {
  /** Extra working reach in tiles (a long pole), 0 for handheld things. */
  reach: number;
}

export interface Item {
  /** Unique in this world. */
  id: number;
  /** What went into it: material id -> units. */
  parts: Record<string, number>;
  props: ItemProps;
  /** 1 = fresh, 0 = broken. Falls with use. */
  wear: number;
  /** Who made it (0 = unknown). */
  madeBy: number;
  madeTick: number;
  /** Times its holder was measurably helped by it. */
  uses: number;
}

/** An item lying in the world. */
export interface GroundItem {
  x: number;
  y: number;
  item: Item;
}

export function emptyProps(): ItemProps {
  const props = {} as ItemProps;
  for (const p of PROPERTIES) props[p] = 0;
  props.reach = 0;
  return props;
}

/** Plain-language description built from an item's properties and parts. */
export function describeItem(item: Item): string {
  const base = describe(item.props).replace(/^a /, "").replace(/ material$/, " thing");
  const reach = item.props.reach > 0 ? " with reach" : "";
  const carry = carryBonus(item) > 0 ? " for carrying" : "";
  return `a ${base}${reach}${carry}`;
}

// --- What an item is good at (all derived, nothing declared) -------------------

/** Cutting and plucking: a sharp edge speeds the harvest of soft and fibrous things. */
export function cutPower(item: Item): number {
  return item.props.sharpness >= 0.4 ? item.props.sharpness : 0;
}

/** Breaking: something hard and HEAVY speeds the breaking of hard things (an edge alone doesn't). */
export function breakPower(item: Item): number {
  const p = item.props.hardness * item.props.mass;
  return p >= 0.55 ? p : 0;
}

/** Carrying: something woven and flexible spreads a load (extra carry capacity in mass). */
export function carryBonus(item: Item): number {
  if (item.props.flexibility < 0.7 || item.props.mass < 0.3) return 0;
  return Math.min(1.2, item.props.mass * 2);
}

export function itemMass(item: Item): number {
  return item.props.mass;
}

/** Wear lost each time an item does real work. About 250 uses in a tool's life. */
export const WEAR_PER_USE = 0.004;
/** Wear a carrier loses per day of service. */
export const CARRIER_WEAR_PER_DAY = 0.02;

// --- Items lying on the ground -------------------------------------------------

const tileKey = (x: number, y: number) => (x + 1048576) * 2097152 + (y + 1048576);

/** Every item in the world that no one is carrying. */
export class GroundItems {
  private readonly byTile = new Map<number, GroundItem[]>();
  private count = 0;

  get size(): number {
    return this.count;
  }

  at(x: number, y: number): GroundItem[] {
    return this.byTile.get(tileKey(x, y)) ?? [];
  }

  drop(x: number, y: number, item: Item): void {
    const key = tileKey(x, y);
    let list = this.byTile.get(key);
    if (!list) {
      list = [];
      this.byTile.set(key, list);
    }
    list.push({ x, y, item });
    this.count++;
  }

  /** Removes and returns one item by id at a tile, or null. */
  take(x: number, y: number, itemId: number): Item | null {
    const key = tileKey(x, y);
    const list = this.byTile.get(key);
    if (!list) return null;
    const i = list.findIndex((g) => g.item.id === itemId);
    if (i < 0) return null;
    const [taken] = list.splice(i, 1);
    if (list.length === 0) this.byTile.delete(key);
    this.count--;
    return taken.item;
  }

  all(): GroundItem[] {
    const out: GroundItem[] = [];
    for (const list of this.byTile.values()) out.push(...list);
    return out;
  }

  toJSON(): GroundItem[] {
    return this.all();
  }

  static fromJSON(data: GroundItem[]): GroundItems {
    const store = new GroundItems();
    for (const g of data) store.drop(g.x, g.y, structuredClone(g.item));
    return store;
  }
}

/** Mints item ids (kept on the world so they stay unique across saves). */
export function nextItemId(world: World): number {
  return world.itemSeq++;
}
