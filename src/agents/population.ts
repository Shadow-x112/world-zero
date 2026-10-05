// Everyone in the world, living and dead.

import { TICKS_PER_DAY } from "../core/constants.ts";
import type { Rng } from "../core/rng.ts";
import { blankEmotions } from "./emotions.ts";
import { blankPersonality } from "./personality.ts";
import {
  Agent,
  LIFESPAN_MAX_DAYS,
  LIFESPAN_MEAN_DAYS,
  LIFESPAN_MIN_DAYS,
  LIFESPAN_SD_DAYS,
  MATURITY_FRACTION,
  type AgentData,
  type DeathCause,
} from "./agent.ts";

/** What remains after an agent dies. It fades over a few world days. */
export interface Body {
  agentId: number;
  x: number;
  y: number;
  heading: number;
  diedTick: number;
  cause: DeathCause;
  ageDays: number;
}

/** How long a body remains before it is gone, in world days. */
export const BODY_DAYS = 3;

export const FOUNDER_COUNT = 50;

export interface PopulationData {
  nextId: number;
  agents: AgentData[];
  bodies: Body[];
  deaths: number;
  births: number;
}

export function sampleLifespanTicks(rng: Rng): number {
  const days = Math.min(LIFESPAN_MAX_DAYS, Math.max(LIFESPAN_MIN_DAYS, rng.normal(LIFESPAN_MEAN_DAYS, LIFESPAN_SD_DAYS)));
  return Math.round(days * TICKS_PER_DAY);
}

export class Population {
  private readonly agents = new Map<number, Agent>();
  bodies: Body[] = [];
  nextId = 1;
  deaths = 0;
  births = 0;

  get count(): number {
    return this.agents.size;
  }

  all(): IterableIterator<Agent> {
    return this.agents.values();
  }

  /** Living agents in id order (stable, so updates are deterministic). */
  list(): Agent[] {
    return [...this.agents.values()];
  }

  get(id: number): Agent | undefined {
    return this.agents.get(id);
  }

  add(agent: Agent): void {
    this.agents.set(agent.id, agent);
  }

  remove(id: number): Agent | undefined {
    const agent = this.agents.get(id);
    this.agents.delete(id);
    return agent;
  }

  /** A new adult agent, identical to every other founder apart from tiny quirks. */
  createFounder(rng: Rng, tick: number, x: number, y: number): Agent {
    const lifespanTicks = sampleLifespanTicks(rng);
    const quirk = Array.from({ length: 8 }, () => rng.range(-1, 1));
    const data: AgentData = {
      id: this.nextId++,
      x,
      y,
      heading: rng.range(0, Math.PI * 2),
      home: { x, y },
      bornTick: tick - Math.round(lifespanTicks * MATURITY_FRACTION),
      lifespanTicks,
      needs: { energy: 1, rest: 1, social: 1, curiosity: 0.7 },
      health: 1,
      damage: { starvation: 0, exhaustion: 0, exposure: 0, "old age": 0, injury: 0, poisoning: 0, burns: 0 },
      asleep: false,
      action: null,
      nextDecisionTick: tick + rng.int(0, 30),
      path: [],
      pathIndex: 0,
      known: [],
      lastSeenOther: null,
      quirk,
      knowledge: {},
      carrying: [],
      foodSpots: [],
      items: [],
      tried: {},
      recentlyDropped: [],
      bonds: {},
      mate: null,
      bondedTick: 0,
      lastBirthTick: 0,
      parents: null,
      toxin: 0,
      toxinFrom: 0,
      tastes: {},
      emotions: blankEmotions(),
      felt: blankEmotions(),
      personality: blankPersonality(quirk),
      prevWork: 0,
      coldMemory: 0,
      nest: null,
      lastSleep: null,
      buildLeaning: { wall: 1, roof: 1 },
      placedSinceWake: { wall: 0, roof: 0 },
      feltShelter: -1,
      shelterSpots: [],
      stats: { tilesWalked: 0, daysAsleep: 0, meals: 0, blocksPlaced: 0, crafted: 0, cooked: 0, children: 0 },
    };
    const agent = new Agent(data);
    this.add(agent);
    return agent;
  }

  /** A newborn: small, blank, and a blend of its parents' leanings plus chance. */
  createChild(rng: Rng, tick: number, x: number, y: number, a: Agent, b: Agent): Agent {
    const lifespanTicks = sampleLifespanTicks(rng);
    const quirk = a.quirk.map((qa, i) => {
      const mixed = (qa + b.quirk[i % b.quirk.length]) / 2 + rng.normal(0, 0.35);
      return Math.max(-1, Math.min(1, mixed));
    });
    const child = new Agent({
      id: this.nextId++,
      x,
      y,
      heading: rng.range(0, Math.PI * 2),
      home: { x, y },
      bornTick: tick,
      lifespanTicks,
      needs: { energy: 0.8, rest: 1, social: 1, curiosity: 0.9 },
      health: 1,
      damage: { starvation: 0, exhaustion: 0, exposure: 0, "old age": 0, injury: 0, poisoning: 0, burns: 0 },
      asleep: false,
      action: null,
      nextDecisionTick: tick + rng.int(0, 30),
      path: [],
      pathIndex: 0,
      known: [],
      lastSeenOther: { x: a.x, y: a.y, tick },
      quirk,
      knowledge: {},
      carrying: [],
      foodSpots: [],
      items: [],
      tried: {},
      recentlyDropped: [],
      bonds: {},
      mate: null,
      bondedTick: 0,
      lastBirthTick: 0,
      parents: [a.id, b.id],
      toxin: 0,
      toxinFrom: 0,
      tastes: {},
      emotions: blankEmotions(),
      felt: blankEmotions(),
      personality: blankPersonality(quirk),
      prevWork: 0,
      coldMemory: 0,
      nest: null,
      lastSleep: null,
      buildLeaning: { wall: 1, roof: 1 },
      placedSinceWake: { wall: 0, roof: 0 },
      feltShelter: -1,
      shelterSpots: [],
      stats: { tilesWalked: 0, daysAsleep: 0, meals: 0, blocksPlaced: 0, crafted: 0, cooked: 0, children: 0 },
    });
    // Family love is the one bond that begins full, in both directions.
    const love = { trust: 0.75, affection: 0.8, lastNear: tick };
    child.bonds[a.id] = { ...love };
    child.bonds[b.id] = { ...love };
    a.bonds[child.id] = { ...love };
    b.bonds[child.id] = { ...love };
    a.stats.children++;
    b.stats.children++;
    this.add(child);
    this.births++;
    return child;
  }

  /** The 20 founders, standing together near the middle of the plain. */
  spawnFounders(rng: Rng, tick: number): Agent[] {
    const founders: Agent[] = [];
    const taken = new Set<string>();
    for (let i = 0; i < FOUNDER_COUNT; i++) {
      let x = 0;
      let y = 0;
      do {
        const angle = rng.range(0, Math.PI * 2);
        const r = Math.sqrt(rng.next()) * 7;
        x = Math.round(Math.cos(angle) * r) || 0; // `|| 0` turns -0 into 0
        y = Math.round(Math.sin(angle) * r) || 0;
      } while (taken.has(`${x},${y}`));
      taken.add(`${x},${y}`);
      founders.push(this.createFounder(rng, tick, x, y));
    }
    // They opened their eyes together: each begins warm toward all the others.
    for (const a of founders) {
      for (const b of founders) {
        if (a !== b) a.bonds[b.id] = { trust: 0.2, affection: 0.2, lastNear: tick };
      }
    }
    return founders;
  }

  toJSON(): PopulationData {
    return {
      nextId: this.nextId,
      agents: this.list().map((a) => a.toJSON()),
      bodies: this.bodies,
      deaths: this.deaths,
      births: this.births,
    };
  }

  static fromJSON(data: PopulationData): Population {
    const population = new Population();
    population.nextId = data.nextId;
    population.deaths = data.deaths;
    population.births = data.births;
    population.bodies = structuredClone(data.bodies);
    for (const a of data.agents) population.add(new Agent(a));
    return population;
  }
}
