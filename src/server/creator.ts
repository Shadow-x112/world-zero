// What only the creator sees: the world's hidden truths. Every function here only reads.
//
//   overview  the seed, the winters to come, materials as they truly are
//   web       who is bound to whom (affection, trust), mates, grudges
//   families  every life the chronicle knows of, with parents
//   words     the shared tongue: every concept, its rival words and who speaks them
//   history   the daily vital signs
//   ai        one AI's hidden numbers

import type { World } from "../core/world.ts";
import type { Agent } from "../agents/agent.ts";
import { TICKS_PER_DAY } from "../core/constants.ts";
import { describeWinter, winterSeverity } from "../world/weather.ts";
import { commonWord, conceptLabel, worldName } from "../agents/language.ts";
import { resentments } from "../agents/conflict.ts";
import { fullPalette } from "./terrain.ts";

const r2 = (v: number) => Math.round(v * 100) / 100;

export function overview(world: World) {
  const year = world.calendar.year;
  const winters = [];
  for (let y = year; y < year + 6; y++) {
    const s = winterSeverity(world.meta.seed, y);
    winters.push({ year: y, severity: r2(s), kind: describeWinter(s) });
  }
  return {
    seed: world.meta.seed,
    worldId: world.meta.id,
    generation: world.meta.generation,
    createdAt: world.meta.createdAt,
    tick: world.tick,
    day: Math.floor(world.tick / TICKS_PER_DAY),
    winters,
    materials: fullPalette(world.materials),
    explored: world.grid.knownChunkCount,
    firsts: [...world.firsts].sort(),
  };
}

/** Bonds strong enough to matter, each pair once (feelings averaged both ways). */
export const WEB_AFFECTION = 0.3;

export function web(world: World) {
  const living = world.population.list();
  const nodes = living.map((a) => ({ id: a.id, mate: a.mate, grown: a.grown(world.tick) }));
  const edges: Array<{ a: number; b: number; affection: number; trust: number }> = [];
  const byId = new Map(living.map((a) => [a.id, a]));
  for (const a of living) {
    for (const [key, bond] of Object.entries(a.bonds)) {
      const id = Number(key);
      if (id <= a.id) continue;
      const other = byId.get(id);
      if (!other) continue;
      const back = other.bonds[a.id];
      const affection = (bond.affection + (back?.affection ?? 0)) / 2;
      const trust = (bond.trust + (back?.trust ?? 0)) / 2;
      if (affection >= WEB_AFFECTION) edges.push({ a: a.id, b: id, affection: r2(affection), trust: r2(trust) });
    }
  }
  const grudges: Array<{ from: number; to: number; strength: number }> = [];
  for (const a of living) for (const r of resentments(a)) if (byId.has(r.id)) grudges.push({ from: a.id, to: r.id, strength: r2(r.grudge) });
  return { nodes, edges, grudges };
}

/** Everyone the world has known: the living, and the dead the chronicle remembers. */
export function families(world: World) {
  const people = new Map<number, { id: number; parents: [number, number] | null; alive: boolean; bornTick: number | null; diedTick: number | null; cause: string | null }>();
  const founders = world.chronicle.all().find((e) => e.kind === "founders");
  for (const id of (founders?.data?.ids as number[] | undefined) ?? []) {
    people.set(id, { id, parents: null, alive: false, bornTick: null, diedTick: null, cause: null });
  }
  for (const e of world.chronicle.all()) {
    const d = e.data ?? {};
    if (e.kind === "birth" && typeof d.child === "number") {
      people.set(d.child, { id: d.child, parents: (d.parents as [number, number]) ?? null, alive: false, bornTick: e.tick, diedTick: null, cause: null });
    }
    if (e.kind === "death" && typeof d.agentId === "number") {
      const p = people.get(d.agentId) ?? { id: d.agentId, parents: null, alive: false, bornTick: null, diedTick: null, cause: null };
      p.diedTick = e.tick;
      p.cause = typeof d.cause === "string" ? d.cause : null;
      people.set(d.agentId, p);
    }
  }
  for (const a of world.population.list()) {
    const p = people.get(a.id) ?? { id: a.id, parents: null, alive: true, bornTick: null, diedTick: null, cause: null };
    p.alive = true;
    p.parents = a.parents ?? p.parents;
    p.bornTick = a.bornTick;
    people.set(a.id, p);
  }
  return { people: [...people.values()].sort((a, b) => a.id - b.id) };
}

export function words(world: World) {
  const concepts = new Set<string>();
  const living = world.population.list();
  for (const a of living) for (const k of Object.keys(a.lexicon)) concepts.add(k);
  const out = [];
  for (const c of [...concepts].sort()) {
    const counts = new Map<string, number>();
    for (const a of living) {
      const w = a.lexicon[c]?.w;
      if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    const common = commonWord(world, c);
    out.push({
      concept: c,
      label: conceptLabel(world, c),
      words: ranked.map(([w, speakers]) => ({ w, speakers })),
      share: common ? r2(common.share) : 0,
    });
  }
  const forWorld = commonWord(world, "world");
  return { living: living.length, concepts: out, worldName: worldName(world), worldNameShare: forWorld ? r2(forWorld.share) : 0 };
}

export function history(world: World) {
  return { days: world.history };
}

/** One AI's hidden numbers (everything the inspector does not say in words). */
export function hiddenAi(world: World, agent: Agent) {
  const bonds = Object.entries(agent.bonds)
    .map(([id, b]) => ({ id: Number(id), affection: r2(b.affection), trust: r2(b.trust), alive: !!world.population.get(Number(id)) }))
    .sort((a, b) => b.affection - a.affection)
    .slice(0, 12);
  const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r2(v)]));
  const life = agent.lifeFraction(world.tick);
  return {
    id: agent.id,
    personality: round(agent.personality as unknown as Record<string, number>),
    emotions: round(agent.emotions as unknown as Record<string, number>),
    skills: round(agent.skills as unknown as Record<string, number>),
    lifeFraction: r2(life),
    daysLeft: Math.max(0, Math.round((agent.lifespanTicks * (1 - life)) / TICKS_PER_DAY)),
    toxin: r2(agent.toxin),
    bonds,
    grudges: resentments(agent).map((r) => ({ id: r.id, strength: r2(r.grudge) })),
    parents: agent.parents,
    knows: Object.keys(agent.knowledge).length,
    recipes: Object.entries(agent.tried).filter(([, t]) => t.ok > 0).map(([k]) => k),
    stats: agent.stats,
  };
}
