// Plain-text descriptions of agents for the command line (and later the viewer).

import type { Agent } from "./agents/agent.ts";
import { TICKS_PER_DAY } from "./core/constants.ts";
import type { World } from "./core/world.ts";
import { PROPERTIES, describe } from "./materials/registry.ts";

const ACTION_WORDS: Record<string, string> = {
  sleep: "going to sleep",
  eat: "eating",
  seekFood: "looking for food",
  taste: "tasting something new",
  inspect: "examining something new",
  gather: "gathering food",
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
    doing(agent).padEnd(22),
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
  if (agent.carrying.length) {
    const items = agent.carrying.map((c) => {
      const type = world.materials.get(c.material);
      return `${c.units} × ${type ? describe(agent.knowledge[c.material]?.props ?? {}) : "?"} (#m${c.material})`;
    });
    lines.push(`  carrying  ${items.join(", ")}`);
  }
  const known = Object.entries(agent.knowledge);
  if (known.length) {
    lines.push(`  knows     ${known.length} kinds of material:`);
    for (const [id, k] of known.sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const how = k.tasted ? "tasted" : k.handled ? "handled" : "seen";
      const verdict = k.tasted ? ((k.props.nourishment ?? 0) >= 0.3 ? ", food" : ", not food") : "";
      lines.push(`    m${id}: ${describe(k.props)} (${how}${verdict}${k.timesEaten ? `, eaten ${k.timesEaten}×` : ""})`);
    }
  }
  const harm = Object.entries(agent.damage).filter(([, v]) => v > 0.001);
  if (harm.length) lines.push(`  harmed by ${harm.map(([k, v]) => `${k} ${pct(v).trim()}`).join(", ")}`);
  return lines.join("\n");
}

/** The world's materials with their true properties (creator's view). */
export function materialsTable(world: World): string {
  const head = "id   " + PROPERTIES.map((p) => p.slice(0, 5).padStart(6)).join("") + "   max  description";
  const rows = world.materials.all().map((t) => {
    const vals = PROPERTIES.map((p) => t.props[p].toFixed(2).padStart(6)).join("");
    const ripe = t.ripeIn ? ` (ripe in ${t.ripeIn.join(", ")})` : "";
    return `m${String(t.id).padEnd(3)} ${vals} ${String(t.maxAmount).padStart(5)}  ${describe(t.props)}${ripe}${t.custom ? " [added]" : ""}`;
  });
  return [head, ...rows].join("\n");
}
