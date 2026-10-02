// An AI: one being in the world.
//
// Everything about an agent is plain data so it saves and loads exactly.
// Behavior lives in needs.ts (bodily state), brain.ts (choosing what to do)
// and actions.ts (doing it).

import { TICKS_PER_DAY } from "../core/constants.ts";

export interface Needs {
  /** 1 = well fed, 0 = starving. Restored by eating. */
  energy: number;
  /** 1 = fully rested, 0 = exhausted. Restored by sleeping. */
  rest: number;
  /** 1 = socially satisfied, 0 = lonely. Restored by being near others. Mild. */
  social: number;
  /** 1 = curiosity satisfied, 0 = restless. Restored by finding new places and things. */
  curiosity: number;
}

export type DeathCause = "starvation" | "exhaustion" | "exposure" | "old age" | "injury" | "poisoning";

/** Health lost recently to each cause; used to say why an agent died. Decays over time. */
export type DamageLog = Record<DeathCause, number>;

export type ActionType =
  | "sleep"
  | "eat"
  | "seekFood"
  | "taste"
  | "inspect"
  | "gather"
  | "explore"
  | "socialize"
  | "idle";

/** What one agent has learned about one kind of material, through its own senses. */
export interface MaterialKnowledge {
  firstSeenTick: number;
  /** Picked up and handled: hardness, sharpness, flexibility and mass are known. */
  handled: boolean;
  /** Tasted: nourishment and reactivity are known. */
  tasted: boolean;
  /** Property values learned so far (only those its senses have revealed). */
  props: Partial<Record<string, number>>;
  timesEaten: number;
}

/** Something being carried. */
export interface Carried {
  material: number;
  units: number;
}

/** A remembered place where food was seen. */
export interface FoodSpot {
  x: number;
  y: number;
  material: number;
  tick: number;
}

export interface ActionState {
  type: ActionType;
  startedTick: number;
  /** Destination tile, if the action involves going somewhere. */
  targetX?: number;
  targetY?: number;
  /** Another agent involved, if any. */
  targetId?: number;
  /** The kind of material involved, if any. */
  material?: number;
  /** When the action ends on its own, if it has a fixed duration. */
  untilTick?: number;
  /** When the route was last planned (used to avoid re-planning every tick). */
  plannedTick?: number;
}

export interface AgentData {
  id: number;
  /** Position in tile units (tile centers are whole numbers). */
  x: number;
  y: number;
  /** Facing direction in radians, for the viewer. */
  heading: number;
  /** The place this agent thinks of as home; exploration ranges outward from here. */
  home: { x: number; y: number };
  bornTick: number;
  /** Natural length of life, in ticks. Death from age comes near the end of it. */
  lifespanTicks: number;
  needs: Needs;
  /** 1 = healthy, 0 = dead. */
  health: number;
  damage: DamageLog;
  asleep: boolean;
  action: ActionState | null;
  nextDecisionTick: number;
  /** Remaining route as flat [x0, y0, x1, y1, ...] tile coordinates. */
  path: number[];
  pathIndex: number;
  /** Coarse blocks of the world this agent has seen (see knownBlockKey). */
  known: number[];
  /** Where another agent was last seen, used to find company again. */
  lastSeenOther: { x: number; y: number; tick: number } | null;
  /** Small fixed random offsets that make otherwise identical agents choose a little differently. */
  quirk: number[];
  /** What it has learned about each kind of material it has come across, by material id. */
  knowledge: Record<string, MaterialKnowledge>;
  carrying: Carried[];
  /** Places food was seen recently (most recent last). */
  foodSpots: FoodSpot[];
  stats: { tilesWalked: number; daysAsleep: number; meals: number };
}

export const KNOWN_BLOCK_SIZE = 8;

/** Packs a coarse block coordinate into one number. */
export function knownBlockKey(bx: number, by: number): number {
  return (bx + 32768) * 65536 + (by + 32768);
}

export function blockOf(v: number): number {
  return Math.floor(v / KNOWN_BLOCK_SIZE);
}

/** Average natural lifespan: about 180 world days (1.5 real months at 1x). */
export const LIFESPAN_MEAN_DAYS = 180;
export const LIFESPAN_SD_DAYS = 15;
export const LIFESPAN_MIN_DAYS = 130;
export const LIFESPAN_MAX_DAYS = 235;

/** Agents are grown at this fraction of their lifespan. */
export const MATURITY_FRACTION = 0.25;

export class Agent implements AgentData {
  id!: number;
  x!: number;
  y!: number;
  heading!: number;
  home!: { x: number; y: number };
  bornTick!: number;
  lifespanTicks!: number;
  needs!: Needs;
  health!: number;
  damage!: DamageLog;
  asleep!: boolean;
  action!: ActionState | null;
  nextDecisionTick!: number;
  path!: number[];
  pathIndex!: number;
  known!: number[];
  lastSeenOther!: { x: number; y: number; tick: number } | null;
  quirk!: number[];
  knowledge!: Record<string, MaterialKnowledge>;
  carrying!: Carried[];
  foodSpots!: FoodSpot[];
  stats!: { tilesWalked: number; daysAsleep: number; meals: number };

  /** Fast lookup for `known`; rebuilt from the array on load. */
  private knownSet = new Set<number>();

  constructor(data: AgentData) {
    Object.assign(this, structuredClone(data));
    for (const key of this.known) this.knownSet.add(key);
  }

  get label(): string {
    return `#${String(this.id).padStart(2, "0")}`;
  }

  ageTicks(tick: number): number {
    return tick - this.bornTick;
  }

  ageDays(tick: number): number {
    return this.ageTicks(tick) / TICKS_PER_DAY;
  }

  /** 0 at birth, 1 at the end of the natural lifespan. */
  lifeFraction(tick: number): number {
    return this.ageTicks(tick) / this.lifespanTicks;
  }

  get tileX(): number {
    return Math.round(this.x);
  }

  get tileY(): number {
    return Math.round(this.y);
  }

  knows(bx: number, by: number): boolean {
    return this.knownSet.has(knownBlockKey(bx, by));
  }

  /** Records a block as seen. Returns true if it was new. */
  learnBlock(bx: number, by: number): boolean {
    const key = knownBlockKey(bx, by);
    if (this.knownSet.has(key)) return false;
    this.knownSet.add(key);
    this.known.push(key);
    return true;
  }

  get knownCount(): number {
    return this.knownSet.size;
  }

  clearPath(): void {
    this.path = [];
    this.pathIndex = 0;
  }

  hasPath(): boolean {
    return this.pathIndex < this.path.length;
  }

  toJSON(): AgentData {
    const { knownSet: _ignored, ...data } = this as unknown as AgentData & { knownSet: unknown };
    return data;
  }
}
