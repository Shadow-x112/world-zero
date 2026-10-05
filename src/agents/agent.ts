// An AI: one being in the world.
//
// Everything about an agent is plain data so it saves and loads exactly.
// Behavior lives in needs.ts (bodily state), brain.ts (choosing what to do)
// and actions.ts (doing it).

import { TICKS_PER_DAY } from "../core/constants.ts";
import type { Item } from "../items/item.ts";
import type { Emotions } from "./emotions.ts";
import type { Personality } from "./personality.ts";
import type { Skills } from "./skill.ts";

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

export type DeathCause = "starvation" | "exhaustion" | "exposure" | "old age" | "injury" | "poisoning" | "burns";

/** Health lost recently to each cause; used to say why an agent died. Decays over time. */
export type DamageLog = Record<DeathCause, number>;

export type ActionType =
  | "sleep"
  | "eat"
  | "seekFood"
  | "taste"
  | "inspect"
  | "gather"
  | "tinker"
  | "build"
  | "flee"
  | "treat"
  | "follow"
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
  /** Learned the hard way: eating this while sick with poison loosens the sickness. */
  curative?: boolean;
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
  /** Which stage of a multi-stage action it is in. */
  phase?: string;
  /** Going to bed: true when heading for a sheltered place rather than to company. */
  toShelter?: boolean;
}

/** The place an AI has chosen to sleep and build around. */
export interface Nest {
  x: number;
  y: number;
  /** When it last slept there. */
  lastSlept: number;
}

/** A remembered sheltered place (somewhere covered that it has seen). */
export interface ShelterSpot {
  x: number;
  y: number;
  value: number;
  tick: number;
}

/** Leaning toward each kind of placement, learned from how much warmer the result felt. */
export interface BuildLeaning {
  wall: number;
  roof: number;
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
  /** Coarse blocks of the world this agent has seen, as [key, lastSeenTick] pairs flattened.
   * Ground not seen again for a long while fades back to unknown (see KNOWN_FADE_DAYS). */
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
  /** Things it has made or picked up. Their mass counts against what it can carry. */
  items: Item[];
  /** What it has tried to make: combination key -> attempts and successes. Dies with it. */
  tried: Record<string, { n: number; ok: number }>;
  /** Items it set down on purpose lately (so it doesn't pick them right back up). */
  recentlyDropped: number[];
  /** Feelings toward others it knows, by their id. Capped to the closest few. */
  bonds: Record<string, Bond>;
  /** The one it is bonded to (a pair), or null. */
  mate: number | null;
  /** When the pair formed. */
  bondedTick: number;
  /** When it last brought a child into the world (0 = never). */
  lastBirthTick: number;
  /** Who it was born to, or null for the founders. */
  parents: [number, number] | null;
  /** Poison taken in and not yet worked through; it drains health over hours. */
  toxin: number;
  /** What poisoned it last (a material id; 0 = nothing). More of the same never cures. */
  toxinFrom: number;
  /** How much it has come to like each material as food (-1..1), shaped by what its life fed it. */
  tastes: Record<string, number>;
  /** How it feels right now (0-1 each); stirred by events, fading over hours. */
  emotions: Emotions;
  /** Everything felt since the day began (raw, uncapped); feeds personality, reset nightly. */
  felt: Emotions;
  /** Who it has become (-1..1 each trait); drifts daily toward the life it lives. */
  personality: Personality;
  /** Work total at the last personality settling (to measure a day's work). */
  prevWork: number;
  /** What its hands have learned by doing (0-1 each); never fades, dies with it. */
  skills: Skills;
  /** Harm remembered from cold nights; fades in warm seasons. Drives the urge to build. */
  coldMemory: number;
  /** Where it sleeps and builds, once it has started building. */
  nest: Nest | null;
  /** Where it last woke up. */
  lastSleep: { x: number; y: number } | null;
  buildLeaning: BuildLeaning;
  /** Placements made since it last woke at its nest (credited against the next night's warmth). */
  placedSinceWake: BuildLeaning;
  /** Shelter felt at the nest on the last waking there (-1 = never). */
  feltShelter: number;
  shelterSpots: ShelterSpot[];
  stats: { tilesWalked: number; daysAsleep: number; meals: number; blocksPlaced: number; crafted: number; cooked: number; children: number };
}

/** One AI's feelings toward another, grown only from lived history. */
export interface Bond {
  /** Reliance: they were there, they helped, nothing bad came of them (0-1). */
  trust: number;
  /** Warmth: nights side by side, seasons shared (0-1). */
  affection: number;
  /** When they were last near each other. */
  lastNear: number;
}

export const KNOWN_BLOCK_SIZE = 8;

/** Packs a coarse block coordinate into one number. */
export function knownBlockKey(bx: number, by: number): number {
  return (bx + 32768) * 65536 + (by + 32768);
}

export function blockOf(v: number): number {
  return Math.floor(v / KNOWN_BLOCK_SIZE);
}

/** Average natural lifespan: about 200 world days (about 7 weeks of real time at 1x). */
export const LIFESPAN_MEAN_DAYS = 200;
export const LIFESPAN_SD_DAYS = 28;
export const LIFESPAN_MIN_DAYS = 140;
export const LIFESPAN_MAX_DAYS = 260;

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
  items!: Item[];
  tried!: Record<string, { n: number; ok: number }>;
  recentlyDropped!: number[];
  bonds!: Record<string, Bond>;
  mate!: number | null;
  bondedTick!: number;
  lastBirthTick!: number;
  parents!: [number, number] | null;
  toxin!: number;
  toxinFrom!: number;
  tastes!: Record<string, number>;
  emotions!: Emotions;
  felt!: Emotions;
  personality!: Personality;
  prevWork!: number;
  skills!: Skills;
  coldMemory!: number;
  nest!: Nest | null;
  lastSleep!: { x: number; y: number } | null;
  buildLeaning!: BuildLeaning;
  placedSinceWake!: BuildLeaning;
  feltShelter!: number;
  shelterSpots!: ShelterSpot[];
  stats!: { tilesWalked: number; daysAsleep: number; meals: number; blocksPlaced: number; crafted: number; cooked: number; children: number };

  /** Fast lookup for `known` (key -> last seen tick); rebuilt from the array on load. */
  private knownMap = new Map<number, number>();

  constructor(data: AgentData) {
    Object.assign(this, structuredClone(data));
    for (let i = 0; i + 1 < this.known.length; i += 2) this.knownMap.set(this.known[i], this.known[i + 1]);
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

  /** 0 newborn to 1 full-grown (at the first quarter of life). */
  growth(tick: number): number {
    return Math.min(1, this.lifeFraction(tick) / MATURITY_FRACTION);
  }

  grown(tick: number): boolean {
    return this.lifeFraction(tick) >= MATURITY_FRACTION - 1e-6;
  }

  /** Its feelings toward another (zero history if they never met). */
  bondWith(id: number): Bond {
    return this.bonds[id] ?? { trust: 0, affection: 0, lastNear: 0 };
  }

  get tileX(): number {
    return Math.round(this.x);
  }

  get tileY(): number {
    return Math.round(this.y);
  }

  knows(bx: number, by: number): boolean {
    return this.knownMap.has(knownBlockKey(bx, by));
  }

  /** Records a block as seen now. Returns true if it was new (or had faded from memory). */
  learnBlock(bx: number, by: number, tick: number): boolean {
    const key = knownBlockKey(bx, by);
    const isNew = !this.knownMap.has(key);
    this.knownMap.set(key, tick);
    return isNew;
  }

  /** Forgets blocks not seen since `before`. Returns how many faded. */
  fadeKnown(before: number): number {
    let faded = 0;
    for (const [key, seen] of this.knownMap) {
      if (seen < before) {
        this.knownMap.delete(key);
        faded++;
      }
    }
    return faded;
  }

  get knownCount(): number {
    return this.knownMap.size;
  }

  clearPath(): void {
    this.path = [];
    this.pathIndex = 0;
  }

  hasPath(): boolean {
    return this.pathIndex < this.path.length;
  }

  toJSON(): AgentData {
    const { knownMap: _ignored, ...data } = this as unknown as AgentData & { knownMap: unknown };
    const known: number[] = [];
    for (const [key, tick] of this.knownMap) known.push(key, tick);
    return { ...data, known };
  }
}
