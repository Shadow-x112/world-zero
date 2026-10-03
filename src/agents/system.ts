// Runs every living agent each tick: body, then behavior. Handles deaths,
// fading bodies, and noticing when no one is left.

import { TICKS_PER_DAY } from "../core/constants.ts";
import type { System, World } from "../core/world.ts";
import type { Agent, DeathCause } from "./agent.ts";
import { act } from "./brain.ts";
import { RATES, updateBody } from "./needs.ts";
import { BODY_DAYS } from "./population.ts";
import { SpatialIndex, learnAround } from "./senses.ts";
import { shelterAt } from "../building/structures.ts";
import { dropEverything } from "./foraging.ts";
import { fireDanger, warmthAt } from "../world/fire.ts";

/** Days after which unseen ground fades from an AI's memory of the world. */
export const KNOWN_FADE_DAYS = 12;

const DEATH_WORDS: Record<DeathCause, string> = {
  burns: "burned to death",
  starvation: "starved",
  exhaustion: "collapsed from exhaustion and never woke",
  exposure: "died of cold in the open night",
  "old age": "died of old age",
  injury: "died of injuries",
  poisoning: "was poisoned by something it ate",
};

export class AgentSystem implements System {
  readonly name = "agents";
  readonly index = new SpatialIndex(8);

  private unsubscribe: (() => void) | null = null;

  init(world: World): void {
    // Agents see their surroundings from the first moment. (Only ones who have
    // never seen anything: on a load this must not touch when-blocks-were-seen.)
    for (const agent of world.population.all()) if (agent.knownCount === 0) learnAround(agent, world);
    // Ground not seen in a long while fades back to unknown, so old territory
    // can feel new again and exploring never fully starves.
    this.unsubscribe = world.events.on("newDay", () => {
      const before = world.tick - KNOWN_FADE_DAYS * TICKS_PER_DAY;
      for (const agent of world.population.all()) agent.fadeKnown(before);
    });
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  update(world: World): void {
    const population = world.population;
    const agents = population.list();
    this.index.rebuild(agents);
    const ctx = { world, population, index: this.index };
    const cal = world.calendar;
    const chilly = cal.season === "cold" && cal.light < RATES.exposureLightThreshold;

    for (const agent of agents) {
      const hasCompany = this.index.any(agent.x, agent.y, RATES.companyRadius, agent);
      // Shelter only matters to a sleeper or on a cold night, so it is only measured then.
      const shelter = agent.asleep || chilly ? shelterAt(world, agent.tileX, agent.tileY) : 0;
      const fire = fireDanger(world, agent.tileX, agent.tileY);
      const warmth = chilly || agent.asleep ? warmthAt(world, agent.tileX, agent.tileY) : 0;
      const cause = updateBody(agent, world, { hasCompany, shelter, warmth, fire });
      if (cause) {
        this.kill(world, agent, cause);
        continue;
      }
      act(agent, ctx);
    }

    // Bodies fade away after a few days.
    if (population.bodies.length > 0) {
      const limit = world.tick - BODY_DAYS * TICKS_PER_DAY;
      population.bodies = population.bodies.filter((b) => b.diedTick > limit);
    }

    if (population.count === 0 && world.extinctTick === null) {
      world.extinctTick = world.tick;
      world.chronicle.add(world.tick, "extinction", "The last of them is gone. The world is silent.");
      world.events.emit("extinction", { tick: world.tick });
    }
  }

  kill(world: World, agent: Agent, cause: DeathCause): void {
    dropEverything(agent, world); // its belongings fall where it fell
    const population = world.population;
    population.remove(agent.id);
    population.deaths++;
    const ageDays = agent.ageDays(world.tick);
    population.bodies.push({
      agentId: agent.id,
      x: agent.x,
      y: agent.y,
      heading: agent.heading,
      diedTick: world.tick,
      cause,
      ageDays,
    });
    const first = population.deaths === 1 ? "The first death: " : "";
    world.chronicle.add(
      world.tick,
      "death",
      `${first}${agent.label} ${DEATH_WORDS[cause]}, aged ${Math.floor(ageDays)} days. ${population.count} remain.`,
      { agentId: agent.id, cause, x: agent.x, y: agent.y, ageDays },
    );
    world.events.emit("agentDied", { agentId: agent.id, cause });
  }
}
