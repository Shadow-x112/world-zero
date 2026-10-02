// Plain-text descriptions of agents for the command line (and later the viewer).

import type { Agent } from "./agents/agent.ts";
import { TICKS_PER_DAY } from "./core/constants.ts";
import type { World } from "./core/world.ts";

const ACTION_WORDS: Record<string, string> = {
  sleep: "sleeping",
  seekFood: "looking for food",
  explore: "exploring",
  socialize: "seeking company",
  idle: "idling",
};

const pct = (v: number) => `${Math.round(v * 100)}%`.padStart(4);

export function doing(agent: Agent): string {
  if (agent.asleep) return "sleeping";
  return agent.action ? ACTION_WORDS[agent.action.type] : "deciding";
}

/** One line per agent. */
export function agentLine(agent: Agent, world: World): string {
  const n = agent.needs;
  return [
    agent.label,
    doing(agent).padEnd(17),
    `energy ${pct(n.energy)}`,
    `rest ${pct(n.rest)}`,
    `social ${pct(n.social)}`,
    `curiosity ${pct(n.curiosity)}`,
    `health ${pct(agent.health)}`,
    `age ${Math.floor(agent.ageDays(world.tick))}d`,
    `at (${agent.tileX}, ${agent.tileY})`,
  ].join("  ");
}

/** Everything about one agent. */
export function agentDetail(agent: Agent, world: World): string {
  const n = agent.needs;
  const lines = [
    `${agent.label}: ${doing(agent)}`,
    `  needs     energy ${pct(n.energy)}  rest ${pct(n.rest)}  social ${pct(n.social)}  curiosity ${pct(n.curiosity)}`,
    `  health    ${pct(agent.health)}`,
    `  age       ${agent.ageDays(world.tick).toFixed(1)} of about ${(agent.lifespanTicks / TICKS_PER_DAY).toFixed(0)} days`,
    `  position  (${agent.x.toFixed(1)}, ${agent.y.toFixed(1)}), home (${agent.home.x}, ${agent.home.y})`,
    `  explored  ${agent.knownCount} areas, walked ${agent.stats.tilesWalked} tiles`,
  ];
  const harm = Object.entries(agent.damage).filter(([, v]) => v > 0.001);
  if (harm.length) lines.push(`  harmed by ${harm.map(([k, v]) => `${k} ${pct(v).trim()}`).join(", ")}`);
  return lines.join("\n");
}
