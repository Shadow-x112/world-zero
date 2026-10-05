// Language: words no one designed. An AI that lives with a thing long enough
// coins a sound for it - a couple of syllables out of nowhere - and uses it
// when others are close. Hearing a word pulls a listener toward it: the
// wordless adopt it, holders of a rival word lose confidence in their own and
// eventually switch (the old naming game, which converges), so every village
// drifts toward a shared tongue of its own. Children pick it all up just by
// being underfoot. A word that no living mouth carries is gone.
//
// Words are for the things of THEIR lives: the materials they eat and build
// with, fire, the cold, home, danger (screamed while fleeing, so it spreads
// in the worst moments and forewarns whoever understands it), each other -
// names! - and, for a few far-walked old souls, the world itself. When most
// living mouths agree on that last word, the world has a name. No one gave
// it one; it grew one.

import type { Rng } from "../core/rng.ts";
import type { World } from "../core/world.ts";
import type { Agent } from "./agent.ts";
import type { AgentContext } from "./movement.ts";
import { feel } from "./emotions.ts";
import { flamesNear } from "../world/fire.ts";
import { describe } from "../materials/registry.ts";

/** One AI's word for one concept, and how settled it is in the mouth. */
export interface Lexeme {
  w: string;
  /** Confidence: grows when the word is shared back, falls when a rival is heard. */
  n: number;
}

/** Confidence is capped so a village can still change its mind. */
export const LEXEME_CAP = 8;

/** How far a scream carries, in tiles. */
export const SHOUT_RADIUS = 10;

/** What it takes to muse about the world itself: a long life, far walked. */
export const WORLD_AGE_DAYS = 100;
export const WORLD_KNOWN_BLOCKS = 150;

/** The share of living mouths that must agree before the world counts as named. */
export const WORLD_NAME_SHARE = 0.6;

// Sounds that make up words: coined at random, meaning nothing until lived with.
const ONSETS = ["k", "t", "m", "n", "s", "r", "b", "d", "g", "p", "l", "sh", "th", "v", "z", "h", "f", "w"];
const VOWELS = ["a", "e", "i", "o", "u", "ai", "ei", "ou", "ia", "ua"];
const CODAS = ["", "", "", "n", "r", "s", "l", "m", "k", "t"];

/** A couple of syllables out of nowhere. */
export function makeWord(rng: Rng): string {
  const syllables = rng.chance(0.65) ? 2 : rng.chance(0.5) ? 3 : 1;
  let word = "";
  for (let i = 0; i < syllables; i++) {
    word += ONSETS[rng.int(0, ONSETS.length - 1)] + VOWELS[rng.int(0, VOWELS.length - 1)];
  }
  word += CODAS[rng.int(0, CODAS.length - 1)];
  return word;
}

/** What a concept key means, for the chronicle and the creator's reports. */
export function conceptLabel(world: World, concept: string): string {
  if (concept === "fire") return "fire";
  if (concept === "cold") return "the cold";
  if (concept === "home") return "home";
  if (concept === "danger") return "danger";
  if (concept === "world") return "the world";
  if (concept.startsWith("material:")) {
    const type = world.materials.get(Number(concept.slice(9)));
    return type ? `the ${describe(type.props).replace(/^an? /, "")}` : "a material";
  }
  if (concept.startsWith("person:")) return `#${String(Number(concept.slice(7))).padStart(2, "0")}`;
  return concept;
}

/** Speaks a word at a listener: adoption, reinforcement, or an eroding rival. */
export function hear(listener: Agent, concept: string, word: string, world: World): void {
  const mine = listener.lexicon[concept];
  if (!mine) {
    listener.lexicon[concept] = { w: word, n: 1 };
    if (world.isFirst("sharedWord")) {
      world.chronicle.add(
        world.tick,
        "language",
        `A sound passed from one mouth to another and kept its meaning: "${word}", for ${conceptLabel(world, concept)}. The first shared word.`,
        { word, concept },
      );
    }
    return;
  }
  if (mine.w === word) {
    mine.n = Math.min(LEXEME_CAP, mine.n + 1);
    return;
  }
  mine.n--;
  if (mine.n <= 0) listener.lexicon[concept] = { w: word, n: 1 };
}

/** Using your own word settles it a little deeper. */
function reinforce(speaker: Agent, concept: string): void {
  const mine = speaker.lexicon[concept];
  if (mine) mine.n = Math.min(LEXEME_CAP, mine.n + 1);
}

/** Coins a word for a concept this AI has none for, and the chronicle marks the world's first. */
function coin(agent: Agent, concept: string, world: World): void {
  const word = makeWord(world.rng);
  agent.lexicon[concept] = { w: word, n: 2 }; // its own coinage sits a little firmer
  feel(agent, "joy", 0.1);
  if (world.isFirst("word")) {
    world.chronicle.add(
      world.tick,
      "language",
      `${agent.label} began to make the same sound whenever it meant ${conceptLabel(world, concept)}: "${word}". The first word.`,
      { agentId: agent.id, word, concept },
    );
  } else if (concept === "world" && world.isFirst("worldWord")) {
    world.chronicle.add(
      world.tick,
      "language",
      `${agent.label}, grown old and far-walked, began to use a sound for everything there is: "${word}".`,
      { agentId: agent.id, word },
    );
  }
}

/** The concepts alive in this AI's moment right now, nearest the heart first. */
function relevantConcepts(agent: Agent, other: Agent | null, ctx: AgentContext): string[] {
  const world = ctx.world;
  const out: string[] = [];
  if (world.fireTiles.size > 0 && flamesNear(world, agent.tileX, agent.tileY, 4)) out.push("fire");
  if (world.calendar.season === "cold") out.push("cold");
  for (const c of agent.carrying) {
    const k = agent.knowledge[c.material];
    if (k?.tasted) {
      out.push(`material:${c.material}`);
      break; // one thing in hand is topic enough
    }
  }
  if (other) out.push(`person:${other.id}`);
  if (agent.nest && Math.hypot(agent.nest.x - agent.x, agent.nest.y - agent.y) <= 3) out.push("home");
  if (agent.lexicon["world"]) out.push("world"); // the old stories get told
  return out;
}

/**
 * The hourly life of the tongue, for one AI: maybe coin a word for something
 * it lives with and has no sound for yet.
 */
export function coinWords(agent: Agent, ctx: AgentContext): void {
  const world = ctx.world;
  if (!world.rng.chance(0.06)) return; // words come rarely; most hours pass in silence
  // Something it lives with and has no sound for, nearest the heart first.
  const candidates: string[] = [];
  if (world.fireTiles.size > 0 && flamesNear(world, agent.tileX, agent.tileY, 4)) candidates.push("fire", "danger");
  if (world.calendar.season === "cold") candidates.push("cold");
  for (const [id, k] of Object.entries(agent.knowledge)) {
    if (k.tasted && k.timesEaten >= 3) candidates.push(`material:${id}`);
  }
  if (agent.nest) candidates.push("home");
  for (const [id, bond] of Object.entries(agent.bonds)) {
    if (bond.affection >= 0.5 && ctx.population.get(Number(id))) candidates.push(`person:${id}`);
  }
  if (agent.ageDays(world.tick) >= WORLD_AGE_DAYS && agent.knownCount >= WORLD_KNOWN_BLOCKS) candidates.push("world");
  for (const concept of candidates) {
    if (!agent.lexicon[concept]) {
      coin(agent, concept, world);
      return; // one new word at a time
    }
  }
}

/**
 * An hour spent close: each speaks of what is present - the fire beside them,
 * the cold, the thing in hand, each other - and the words do what words do.
 */
export function converse(a: Agent, b: Agent, ctx: AgentContext): void {
  const world = ctx.world;
  const hour = Math.floor(world.tick / 3600);
  for (const [speaker, listener] of [[a, b], [b, a]] as [Agent, Agent][]) {
    const topics = relevantConcepts(speaker, listener, ctx);
    if (topics.length === 0) continue;
    // Rotate through the topics over the hours, so even the old stories get airtime.
    const start = (hour + speaker.id) % topics.length;
    let spoken = 0;
    for (let i = 0; i < topics.length && spoken < 2; i++) {
      const concept = topics[(start + i) % topics.length];
      const mine = speaker.lexicon[concept];
      if (!mine) continue;
      hear(listener, concept, mine.w, world);
      reinforce(speaker, concept);
      spoken++;
    }
  }
}

/**
 * A scream while fleeing: the danger word carries far. Whoever already shares
 * it understands at once and feels the fear before seeing the flames; whoever
 * doesn't still catches the sound, bound forever to a terrible moment.
 */
export function shoutDanger(agent: Agent, ctx: AgentContext): void {
  const world = ctx.world;
  const mine = agent.lexicon["danger"];
  if (!mine) return;
  reinforce(agent, "danger");
  for (const { agent: hearer } of ctx.index.near(agent.x, agent.y, SHOUT_RADIUS, agent)) {
    const understood = hearer.lexicon["danger"]?.w === mine.w;
    hear(hearer, "danger", mine.w, world);
    if (understood) feel(hearer, "fear", 0.35); // forewarned: fear before the flames arrive
  }
}

/** The word most living mouths use for a concept, with its share of speakers. */
export function commonWord(world: World, concept: string): { word: string; share: number; speakers: number } | null {
  const counts = new Map<string, number>();
  let alive = 0;
  for (const agent of world.population.all()) {
    alive++;
    const lex = agent.lexicon[concept];
    if (lex) counts.set(lex.w, (counts.get(lex.w) ?? 0) + 1);
  }
  if (alive === 0 || counts.size === 0) return null;
  let best: { word: string; speakers: number } | null = null;
  for (const [word, speakers] of [...counts.entries()].sort((x, y) => x[0] < y[0] ? -1 : 1)) {
    if (!best || speakers > best.speakers) best = { word, speakers };
  }
  return best && { word: best.word, speakers: best.speakers, share: best.speakers / alive };
}

/** The world's name, if most living mouths agree on one - or null while it has none. */
export function worldName(world: World): string | null {
  const common = commonWord(world, "world");
  return common && common.share >= WORLD_NAME_SHARE ? common.word : null;
}

/** Once a day: has the world come to carry a name? (Chronicled once, ever.) */
export function noticeWorldName(world: World): void {
  if (world.firsts.has("worldNamed")) return;
  const name = worldName(world);
  if (!name) return;
  world.isFirst("worldNamed");
  world.chronicle.add(
    world.tick,
    "milestone",
    `Most of them now use one sound for everything there is. The world has a name: ${name[0].toUpperCase() + name.slice(1)}.`,
    { name },
  );
}

/** The village tongue, concept by concept (the creator's view). */
export function lexiconReport(world: World): string {
  const concepts = new Set<string>();
  for (const agent of world.population.all()) for (const key of Object.keys(agent.lexicon)) concepts.add(key);
  if (concepts.size === 0) return "No words yet. The world is still silent.";
  const lines: string[] = [];
  const name = worldName(world);
  if (name) lines.push(`The world is called ${name[0].toUpperCase() + name.slice(1)}.`);
  const sorted = [...concepts].sort();
  for (const concept of sorted) {
    const common = commonWord(world, concept);
    if (!common) continue;
    lines.push(
      `  "${common.word}"`.padEnd(14) +
        ` ${conceptLabel(world, concept)} (${common.speakers} speaker${common.speakers === 1 ? "" : "s"}, ${Math.round(common.share * 100)}%)`,
    );
  }
  return lines.join("\n");
}
