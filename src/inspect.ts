// Plain-text descriptions of agents for the command line (and later the viewer).

import type { Agent } from "./agents/agent.ts";
import { TICKS_PER_DAY } from "./core/constants.ts";
import type { World } from "./core/world.ts";
import { PROPERTIES, describe } from "./materials/registry.ts";
import { FULL_HP, allBlocks, blockAt, shelterAt } from "./building/structures.ts";
import { buildUrge } from "./agents/building.ts";
import { describeItem } from "./items/item.ts";
import { feelingWords } from "./agents/emotions.ts";
import { natureWords } from "./agents/personality.ts";
import { skillWords } from "./agents/skill.ts";
import { conceptLabel } from "./agents/language.ts";
import { resentments } from "./agents/conflict.ts";

const ACTION_WORDS: Record<string, string> = {
  sleep: "going to sleep",
  eat: "eating",
  treat: "treating its sickness",
  seekFood: "looking for food",
  taste: "tasting something new",
  inspect: "examining something new",
  gather: "gathering food",
  tinker: "trying things together",
  build: "building",
  flee: "fleeing the fire",
  take: "taking what another holds",
  explore: "exploring",
  socialize: "seeking company",
  idle: "idling",
  follow: "keeping close to family",
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
  if (agent.items.length) {
    const held = agent.items.map((i) => `${describeItem(i)} (${Math.round(i.wear * 100)}%, used ${i.uses}×)`);
    lines.push(`  holds     ${held.join("; ")}`);
  }
  if (agent.stats.crafted > 0 || Object.keys(agent.tried).length > 0) {
    const tries = Object.values(agent.tried);
    lines.push(`  tinkering ${agent.stats.crafted} things made, ${tries.reduce((s, t) => s + t.n, 0)} attempts on ${tries.length} combinations`);
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
  const shelterHere = shelterAt(world, agent.tileX, agent.tileY);
  if (agent.nest || agent.coldMemory > 0.001 || shelterHere > 0) {
    const nest = agent.nest
      ? `sleeps at (${agent.nest.x}, ${agent.nest.y}), shelter there ${pct(shelterAt(world, agent.nest.x, agent.nest.y)).trim()}`
      : "no sleeping place of its own";
    lines.push(`  shelter   ${nest}; here ${pct(shelterHere).trim()}`);
    lines.push(
      `  building  urge ${pct(buildUrge(agent, world)).trim()} (cold remembered ${agent.coldMemory.toFixed(2)}), ` +
        `${agent.stats.blocksPlaced} loads placed, leans walls ${agent.buildLeaning.wall.toFixed(2)} / roofs ${agent.buildLeaning.roof.toFixed(2)}`,
    );
  }
  const family: string[] = [];
  if (agent.parents) family.push(`child of ${agent.parents.map((p) => `#${String(p).padStart(2, "0")}`).join(" and ")}`);
  if (!agent.grown(world.tick)) family.push(`still growing (${Math.round(agent.growth(world.tick) * 100)}%)`);
  if (agent.mate !== null) family.push(`paired with #${String(agent.mate).padStart(2, "0")}`);
  if (agent.stats.children > 0) family.push(`${agent.stats.children} children`);
  if (family.length) lines.push(`  family    ${family.join("; ")}`);
  const closest = Object.entries(agent.bonds)
    .map(([id, b]) => ({ id: Number(id), score: b.trust + b.affection, b }))
    .sort((x, y) => y.score - x.score)
    .slice(0, 3)
    .filter((e) => e.score > 0.2);
  if (closest.length) {
    lines.push(
      `  close to  ${closest.map((e) => `#${String(e.id).padStart(2, "0")} (trust ${e.b.trust.toFixed(2)}, affection ${e.b.affection.toFixed(2)})`).join(", ")}`,
    );
  }
  const held = resentments(agent).slice(0, 3);
  if (held.length) {
    lines.push(`  resents   ${held.map((e) => `#${String(e.id).padStart(2, "0")} (${e.grudge.toFixed(2)})`).join(", ")}`);
  }
  const wordCount = Object.keys(agent.lexicon).length;
  if (wordCount > 0) {
    const sample = Object.entries(agent.lexicon)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 3)
      .map(([concept, lex]) => `"${lex.w}" (${conceptLabel(world, concept)})`);
    lines.push(`  speaks    ${wordCount} word${wordCount === 1 ? "" : "s"}: ${sample.join(", ")}${wordCount > 3 ? ", ..." : ""}`);
  }
  const skilled = skillWords(agent);
  if (skilled.length) lines.push(`  skilled   ${skilled.join(", ")}`);
  const nature = natureWords(agent);
  if (nature.length) lines.push(`  nature    ${nature.join(", ")}`);
  const feelings = feelingWords(agent);
  if (feelings.length) lines.push(`  feels     ${feelings.join(", ")}`);
  if (agent.toxin >= 0.01) lines.push(`  sick      poison in the body: ${agent.toxin.toFixed(2)} (drains health until it has worked through)`);
  const liked = Object.entries(agent.tastes)
    .filter(([, v]) => v >= 0.15)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
  if (liked.length) {
    const names = liked.map(([id, v]) => `${describe(world.materials.get(Number(id))?.props ?? {})} (${(v as number).toFixed(2)})`);
    lines.push(`  fond of   ${names.join(", ")}`);
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

/** Everything built, and each AI's sleeping place (creator's view). */
export function sheltersReport(world: World): string {
  const blocks = allBlocks(world.grid);
  if (blocks.length === 0) return "Nothing has been built yet.";
  const walls = blocks.filter((b) => b.level === "wall").length;
  const lines = [`${walls} walls and ${blocks.length - walls} roofs standing.`];
  const what = (material: number) => {
    const type = world.materials.get(material);
    return type ? describe(type.props).replace(/^a /, "").replace(/ material$/, "") : "?";
  };
  const who = (id: number) => `#${String(id).padStart(2, "0")}`;
  for (const a of world.population.list()) {
    const n = a.nest;
    if (!n) continue;
    const around: string[] = [];
    const builders = new Set<string>();
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const b = blockAt(world.grid, "wall", n.x + ox, n.y + oy);
        if (b) {
          around.push(what(b.material));
          builders.add(who(b.by));
        }
      }
    }
    const roof = blockAt(world.grid, "roof", n.x, n.y);
    if (roof) builders.add(who(roof.by));
    const kinds = [...new Set(around)].join("; ");
    const parts = [
      around.length ? `${around.length} of 8 sides walled (${kinds})` : "no walls",
      roof ? `covered by ${what(roof.material)} (${Math.round((roof.hp / FULL_HP) * 100)}%)` : "open overhead",
    ];
    const by = builders.size ? `, built by ${[...builders].join(" ")}` : "";
    lines.push(`  ${a.label} sleeps at (${n.x}, ${n.y}), shelter ${pct(shelterAt(world, n.x, n.y)).trim()}: ${parts.join(", ")}${by}`);
  }
  return lines.join("\n");
}

/** Every made thing in the world, held or lying about (creator's view). */
export function itemsReport(world: World): string {
  const lines: string[] = [];
  for (const agent of world.population.list()) {
    for (const item of agent.items) {
      lines.push(`  ${describeItem(item)} - held by ${agent.label}, ${Math.round(item.wear * 100)}%, used ${item.uses}x, made by #${String(item.madeBy).padStart(2, "0")}`);
    }
  }
  for (const g of world.groundItems.all()) {
    lines.push(`  ${describeItem(g.item)} - lying at (${g.x}, ${g.y}), ${Math.round(g.item.wear * 100)}%, made by #${String(g.item.madeBy).padStart(2, "0")}`);
  }
  return lines.length ? [`${lines.length} made things exist.`, ...lines].join("\n") : "Nothing has been made yet.";
}
