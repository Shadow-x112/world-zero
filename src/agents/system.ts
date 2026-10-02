// Runs every living agent each tick: body, then behavior. Handles deaths,
// fading bodies, and noticing when no one is left.

import { TICKS_PER_DAY } from "../core/constants.ts";
import type { System, World } from "../core/world.ts";
import type { Agent, DeathCause } from "./agent.ts";
import { act } from "./brain.ts";
import { RATES, updateBody } from "./needs.ts";
import { BODY_DAYS } from "./population.ts";
import { SpatialIndex, learnAround } from "./senses.ts";

const DEATH_WORDS: Record<DeathCause, string> = {
  starvation: "starved",
  exhaustion: "collapsed from exhaustion and never woke",
  exposure: "died of cold in the open night",
  "old age": "died of old age",
  injury: "died of injuries",
};

export class AgentSystem implements System {
  readonly name = "agents";
  readonly index = new SpatialIndex(8);

  init(world: World): void {
    // Agents see their surroundings from the first moment.
    for (const agent of world.population.all()) learnAround(agent, world);
  }

  update(world: World): void {
    const population = world.population;
    const agents = population.list();
    this.index.rebuild(agents);
    const ctx = { world, population, index: this.index };

    for (const agent of agents) {
      const hasCompany = this.index.any(agent.x, agent.y, RATES.companyRadius, agent);
      const cause = updateBody(agent, world, { hasCompany, sheltered: false });
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
