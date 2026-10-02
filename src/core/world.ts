// The world: everything that exists, advanced one tick at a time.
// Systems (agents, materials, crafting...) plug in and run every tick in order.

import { Chronicle } from "./chronicle.ts";
import { START_TICK } from "./constants.ts";
import { EventBus } from "./events.ts";
import { Rng, randomSeed } from "./rng.ts";
import { getCalendar, type Calendar } from "./time.ts";
import { Grid } from "../world/grid.ts";
import { FLAT_RADIUS } from "../world/generator.ts";

export interface System {
  readonly name: string;
  /** Called once when the world is created or loaded. */
  init?(world: World): void;
  /** Called every tick. */
  update(world: World): void;
}

export interface WorldMeta {
  /** Unique id for this world. A new id only appears after an extinction reset. */
  id: string;
  seed: number;
  /** Real time the world was created (ISO string). */
  createdAt: string;
  /** How many worlds have existed. 1 for the first; increases only after an extinction. */
  generation: number;
}

export class World {
  readonly meta: WorldMeta;
  readonly grid: Grid;
  readonly rng: Rng;
  readonly chronicle: Chronicle;
  readonly events = new EventBus();
  tick: number;
  calendar: Calendar;
  private systems: System[] = [];

  constructor(meta: WorldMeta, tick: number, rng: Rng, chronicle: Chronicle) {
    this.meta = meta;
    this.tick = tick;
    this.rng = rng;
    this.chronicle = chronicle;
    this.grid = new Grid(meta.seed);
    this.calendar = getCalendar(tick);
    this.addSystem(new CalendarSystem());
  }

  /** A brand-new world with an empty plain around the origin. */
  static create(options: { seed?: number; generation?: number } = {}): World {
    const seed = (options.seed ?? randomSeed()) >>> 0;
    const meta: WorldMeta = {
      id: `w${seed.toString(36)}-${Date.now().toString(36)}`,
      seed,
      createdAt: new Date().toISOString(),
      generation: options.generation ?? 1,
    };
    const world = new World(meta, START_TICK, Rng.fromSeed(seed), new Chronicle());
    world.grid.ensureArea(0, 0, FLAT_RADIUS);
    world.chronicle.add(world.tick, "world", "The world began: an empty grid under the morning light.");
    return world;
  }

  addSystem(system: System): void {
    this.systems.push(system);
    system.init?.(this);
  }

  /** Advances the world by one tick. */
  step(): void {
    this.tick++;
    for (const system of this.systems) system.update(this);
  }
}

/** Keeps world.calendar current and announces day, season and light changes. */
class CalendarSystem implements System {
  readonly name = "calendar";

  update(world: World): void {
    const before = world.calendar;
    const now = getCalendar(world.tick);
    world.calendar = now;
    if (now.day !== before.day) world.events.emit("newDay", { day: now.day });
    if (now.season !== before.season) world.events.emit("newSeason", { season: now.season, year: now.year });
    if (now.year !== before.year) world.events.emit("newYear", { year: now.year });
    if (now.isDay && !before.isDay) world.events.emit("dawn", { day: now.day });
    if (!now.isDay && before.isDay) world.events.emit("dusk", { day: now.day });
  }
}
