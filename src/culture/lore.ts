// Lore: knowledge with a history. Every piece of know-how the AIs carry - how to
// raise flame, which herb loosens poison, that grove poles hold a roof up, the
// word for home - is a "way", and the world keeps its family tree: who found
// it, who passed it to whom (taught, watched, heard), how many hands and
// generations it has gone down, and who still knows it. When the last who knew
// a way dies with it, the way is lost; someone may find it again, or not.
//
// The AIs know nothing of this record. It is the world remembering for them.
//
// What counts as knowing a way is read straight off each AI's own memory
// (tried recipes, tasted things, building lessons, words), so the record can
// never drift from what they actually carry: an hourly pass catches every
// discovery and every forgetting; teaching, watching and hearing call in as
// they happen, so the passing-on is caught with the one it came from.

import type { World } from "../core/world.ts";
import type { Agent } from "../agents/agent.ts";
import { TICKS_PER_DAY } from "../core/constants.ts";
import { describe, harmPerUnit } from "../materials/registry.ts";
import { conceptLabel } from "../agents/language.ts";
import { phraseLesson, type Use } from "../agents/building-sense.ts";

export type WayKind = "craft" | "cure" | "food" | "build" | "word";

/** How a holder came by a way. "before": already known when the world began keeping count. */
export type How = "found" | "taught" | "watched" | "heard" | "before";

/** One AI's place in a way's family tree. */
export interface Holder {
  /** Hands it passed through to get here: 0 for whoever found it. */
  g: number;
  /** Whom it came from (null: found it, or from before the record). */
  from: number | null;
  how: How;
  at: number;
  /** When it stopped knowing it (died or forgot), or null while it still does. */
  gone: number | null;
  /** Died knowing it (rather than forgot). */
  died?: boolean;
}

export interface Way {
  key: string;
  kind: WayKind;
  /** Who first found it, and when (null: before the record). */
  by: number | null;
  at: number;
  /** Everyone who has known it. Words keep only the living (they churn). */
  holders: Record<number, Holder>;
  /** How many know it now. */
  known: number;
  /** Most who ever knew it at once. */
  peak: number;
  /** How many have ever known it. */
  ever: number;
  /** Times it has been passed from one to another. */
  passed: number;
  /** Longest chain of hands it has gone down. */
  hands: number;
  /** Most family generations it has been handed down from whoever found it. */
  gens: number;
  /** The family generation of whoever first found it. */
  og: number;
  /** When it was lost (no one left who knows it), or null while known. */
  lost: number | null;
  /** How many times it has been lost. */
  losses: number;
  /** Milestones already chronicled. */
  marks: string[];
}

export interface LoreData {
  ways: Way[];
  /** Lessons told but not yet sure enough to count as known: "learnerId|key" -> [from, tick]. */
  told?: Record<string, [number, number]>;
  /** Family generation of every AI the record has met (founders 0). */
  kin: Record<number, number>;
}

/** A lesson told that becomes known within this long is credited to whoever told it. */
export const TOLD_DAYS = 10;

/** Hourly pass: after the hour's teaching (2520), before the next. */
export const LORE_TICK = 3300;

/** A way has spread when this many know it - or this share of the living, if more. */
export const SPREAD_MIN = 6;
export const SPREAD_SHARE = 0.4;

/** A building lesson counts as known once it is this sure, either way - and stays known until it falls below KEPT_LESSON. */
export const SURE_LESSON = 0.3;
export const KEPT_LESSON = 0.2;

/** Losses and rediscoveries worth the chronicle, by how widely the way was ever known. */
const NOTABLE_PEAK: Record<WayKind, number> = { craft: 1, cure: 1, build: 5, food: 3, word: 10 };

const label = (id: number) => `#${String(id).padStart(2, "0")}`;

const CRAFT_NAMES: Record<string, string> = {
  fire: "how to raise flame from dry tinder",
  brick: "how to work wet earth and fibre into brick",
  weave: "how to weave fibres into something to carry things in",
  bind: "how to tie hard things together with fibre",
  haft: "how to bind a hard head onto a pole",
  knap: "how to strike stone to an edge",
  edge: "how to sharpen a dulled edge",
};

/** The craft a tried-recipe key belongs to, or null. */
export function craftOf(recipeKey: string): string | null {
  if (recipeKey.startsWith("heat:")) return "fire";
  if (recipeKey.startsWith("mix:")) return "brick";
  if (recipeKey.startsWith("bundle:")) return "weave";
  if (recipeKey.startsWith("bind:")) return recipeKey.slice(5).split("~")[0].includes("+") ? "haft" : "bind";
  if (recipeKey.startsWith("shape:item<")) return "edge";
  if (recipeKey.startsWith("shape:")) return "knap";
  return null;
}

export function kindOf(key: string): WayKind {
  return key.slice(0, key.indexOf(":")) as WayKind;
}

/** Every way this AI knows right now, sorted. (`had`: what it was on record as knowing, for lessons on the edge.) */
export function waysHeld(agent: Agent, world: World, had?: Set<string>): string[] {
  const out = new Set<string>();
  for (const [key, t] of Object.entries(agent.tried)) {
    if (t.ok <= 0) continue;
    const craft = craftOf(key);
    if (craft) out.add(`craft:${craft}`);
  }
  for (const [id, k] of Object.entries(agent.knowledge)) {
    if (k.curative) out.add(`cure:${id}`);
    if (k.tasted && (k.props.nourishment ?? 0) >= 0.3) {
      const type = world.materials.get(Number(id));
      if (type && harmPerUnit(type) === 0) out.add(`food:${id}`);
    }
  }
  for (const [key, l] of Object.entries(agent.buildSense.lessons)) {
    if (l.n < 1 || l.v === 0) continue;
    const [use, id] = key.split(":");
    const way = `build:${use}${l.v > 0 ? "+" : "-"}:${id}`;
    if (Math.abs(l.v) >= (had?.has(way) ? KEPT_LESSON : SURE_LESSON)) out.add(way);
  }
  for (const [concept, lex] of Object.entries(agent.lexicon)) {
    if (concept.startsWith("person:")) continue; // names are each one's own business
    out.add(`word:${concept}=${lex.w}`);
  }
  return [...out].sort();
}

/** A way, put into words: "how to raise flame from dry tinder", "that ... loosens poison". */
export function wayName(world: World, key: string): string {
  const kind = kindOf(key);
  const rest = key.slice(kind.length + 1);
  const what = (id: string) => {
    const type = world.materials.get(Number(id));
    return type ? describe(type.props) : "a material";
  };
  switch (kind) {
    case "craft":
      return CRAFT_NAMES[rest] ?? rest;
    case "cure":
      return `that ${what(rest)} loosens poison`;
    case "food":
      return `that ${what(rest)} is good to eat`;
    case "build": {
      const [useSign, id] = rest.split(":");
      const use = useSign.slice(0, -1) as Use;
      return phraseLesson(use, what(id), useSign.endsWith("+") ? 1 : -1);
    }
    case "word": {
      const eq = rest.lastIndexOf("=");
      return `the word "${rest.slice(eq + 1)}" for ${conceptLabel(world, rest.slice(0, eq))}`;
    }
  }
}

export class Lore {
  readonly ways = new Map<string, Way>();
  /** Family generation of every AI met (founders 0). */
  readonly kin = new Map<number, number>();
  /** What each living AI is on record as knowing now. */
  private held = new Map<number, Set<string>>();
  /** Lessons told and not yet sure: "learnerId|key" -> [from, tick]. */
  private told = new Map<string, [number, number]>();

  // --- Reading -----------------------------------------------------------------

  get(key: string): Way | undefined {
    return this.ways.get(key);
  }

  /** The ways an AI knows now, on record. */
  of(agentId: number): string[] {
    return [...(this.held.get(agentId) ?? [])].sort();
  }

  /** The chain a way took to reach someone: [holder, from, from's from, ..., whoever found it]. */
  chain(key: string, agentId: number): number[] {
    const way = this.ways.get(key);
    const out: number[] = [];
    let id: number | null = agentId;
    while (id !== null && way && !out.includes(id)) {
      const h: Holder | undefined = way.holders[id];
      if (!h) break;
      out.push(id);
      id = h.from;
    }
    return out;
  }

  // --- Recording ---------------------------------------------------------------

  /** Brings one AI's record in line with what it actually knows. Returns its new ways. */
  sync(agent: Agent, world: World): string[] {
    this.meet(agent);
    const before = this.held.get(agent.id) ?? new Set<string>();
    const now = new Set(waysHeld(agent, world, before));
    const fresh: string[] = [];
    for (const key of now) if (!before.has(key)) fresh.push(key);
    for (const key of [...before].sort()) {
      if (!now.has(key)) this.drop(world, key, agent.id, false);
    }
    this.held.set(agent.id, now);
    for (const key of fresh) {
      const told = this.told.get(`${agent.id}|${key}`);
      this.told.delete(`${agent.id}|${key}`);
      const from = told && world.tick - told[1] <= TOLD_DAYS * TICKS_PER_DAY ? told[0] : null;
      // Told by one who still knows it, or knew it when telling: it came from them, sinking in slowly.
      if (from !== null && this.ways.get(key)?.holders[from]) this.add(world, key, agent, null, "taught", from);
      else this.add(world, key, agent, null, "found");
    }
    return fresh;
  }

  /**
   * Someone has just learned from another (taught, watched, heard): whatever
   * it knows now and didn't, and the other knows, came from the other.
   */
  learned(world: World, learner: Agent, from: Agent, how: How, about?: string): void {
    this.sync(from, world);
    this.meet(learner);
    const before = this.held.get(learner.id) ?? new Set<string>();
    const now = new Set(waysHeld(learner, world, before));
    const theirs = this.held.get(from.id)!;
    for (const key of [...before].sort()) if (!now.has(key)) this.drop(world, key, learner.id, false);
    this.held.set(learner.id, now);
    for (const key of now) {
      if (before.has(key)) continue;
      if (theirs.has(key)) this.add(world, key, learner, from, how);
      else this.add(world, key, learner, null, "found");
    }
    // A lesson told that hasn't sunk in yet: remembered, so whoever told it gets the credit when it does.
    if (about && theirs.has(about) && !now.has(about)) this.told.set(`${learner.id}|${about}`, [from.id, world.tick]);
  }

  /** A word heard and taken up: the one quick path, called often. */
  heardWord(world: World, listener: Agent, speaker: Agent, concept: string): void {
    if (concept.startsWith("person:")) return;
    const lex = listener.lexicon[concept];
    if (!lex) return;
    const key = `word:${concept}=${lex.w}`;
    const mine = this.held.get(listener.id);
    if (mine?.has(key)) return;
    this.learned(world, listener, speaker, "heard");
  }

  /** A death: everything it knew goes with it, and whatever no one else knew is lost. */
  died(world: World, agent: Agent): void {
    const keys = [...(this.held.get(agent.id) ?? [])].sort();
    this.held.delete(agent.id);
    for (const key of keys) this.drop(world, key, agent.id, true);
    for (const t of [...this.told.keys()]) if (t.startsWith(`${agent.id}|`)) this.told.delete(t);
  }

  /** The hourly pass over everyone alive. */
  update(world: World): void {
    if (world.tick % 3600 !== LORE_TICK) return;
    for (const agent of world.population.list()) this.sync(agent, world);
    if (world.tick % TICKS_PER_DAY === LORE_TICK) {
      for (const [t, [, at]] of [...this.told.entries()]) if (world.tick - at > TOLD_DAYS * TICKS_PER_DAY) this.told.delete(t);
    }
    // Anyone on record who is gone without the death being caught (e.g. removed by the creator).
    for (const id of [...this.held.keys()].sort((a, b) => a - b)) {
      if (!world.population.get(id)) {
        const keys = [...this.held.get(id)!].sort();
        this.held.delete(id);
        for (const key of keys) this.drop(world, key, id, true);
      }
    }
  }

  private meet(agent: Agent): void {
    if (this.kin.has(agent.id)) return;
    const parents = agent.parents;
    this.kin.set(agent.id, parents ? 1 + Math.max(this.kin.get(parents[0]) ?? 0, this.kin.get(parents[1]) ?? 0) : 0);
  }

  private add(world: World, key: string, agent: Agent, fromAgent: Agent | null, how: How, fromId?: number): void {
    const tick = world.tick;
    const from = fromAgent ? { id: fromAgent.id } : fromId !== undefined ? { id: fromId } : null;
    let way = this.ways.get(key);
    const myGen = this.kin.get(agent.id) ?? 0;
    if (!way) {
      way = {
        key, kind: kindOf(key), by: agent.id, at: tick, holders: {}, known: 0, peak: 0, ever: 0,
        passed: 0, hands: 0, gens: 0, og: myGen, lost: null, losses: 0, marks: [],
      };
      if (from) way.by = null; // (learned from one the record never saw find it)
      this.ways.set(key, way);
    }
    const source = from ? way.holders[from.id] : undefined;
    const g = from ? (source ? source.g + 1 : 1) : 0;
    const wasLost = way.lost;
    const prior = way.holders[agent.id];
    way.holders[agent.id] = { g, from: from ? from.id : null, how, at: tick, gone: null };
    way.known++;
    if (!prior) way.ever++;
    way.peak = Math.max(way.peak, way.known);
    if (from) {
      way.passed++;
      way.hands = Math.max(way.hands, g);
      if (way.by !== null) way.gens = Math.max(way.gens, myGen - way.og);
    }
    if (wasLost !== null) {
      way.lost = null;
      const told = way.marks.indexOf("lost");
      if (told >= 0) way.marks.splice(told, 1);
      if (told >= 0 && tick - wasLost >= TICKS_PER_DAY) {
        const days = Math.max(1, Math.round((tick - wasLost) / TICKS_PER_DAY));
        world.chronicle.add(
          tick,
          "lore",
          `${agent.label} found ${wayName(world, key)} again, ${days} day${days === 1 ? "" : "s"} after the last who knew it was gone.`,
          { key, agentId: agent.id, refound: true },
        );
      }
    }
    this.milestones(world, way, agent);
  }

  private drop(world: World, key: string, agentId: number, died: boolean): void {
    const way = this.ways.get(key);
    const h = way?.holders[agentId];
    if (!way || !h || h.gone !== null) return;
    if (way.kind === "word") delete way.holders[agentId];
    else {
      h.gone = world.tick;
      if (died) h.died = true;
    }
    way.known--;
    if (way.known > 0) return;
    way.lost = world.tick;
    way.losses++;
    if (!notable(way)) return;
    if (way.kind === "build" && !died) return; // a builder changing its mind is no loss to the world
    way.marks.push("lost");
    const name = wayName(world, key);
    const origin = way.by === null ? "" : way.by === agentId ? `, which it had found itself,` : `, first found by ${label(way.by)},`;
    const text = died
      ? `When ${label(agentId)} died, ${name}${origin} died with it: no one living knows it any more.`
      : `No one living knows ${name} any more.`;
    world.chronicle.add(world.tick, "lore", text, { key, agentId, lost: true });
  }

  /** Spread wide, gone down a long chain of hands, handed down the generations. */
  private milestones(world: World, way: Way, agent: Agent): void {
    if (way.kind === "word") return; // the tongue has its own history (shared words, the world's name)
    const name = wayName(world, way.key);
    const origin = way.by === null ? "known since before anyone kept count" : `first found by ${label(way.by)}`;
    const alive = world.population.count;
    if (!way.marks.includes("spread") && way.kind !== "food" && way.known >= Math.max(SPREAD_MIN, Math.ceil(SPREAD_SHARE * alive))) {
      way.marks.push("spread");
      world.chronicle.add(world.tick, "lore", `Knowing ${name} has spread: ${origin}, it is now known by ${way.known} of the ${alive} living.`, {
        key: way.key, known: way.known,
      });
    }
    const h = way.holders[agent.id];
    if (!way.marks.includes("hands") && h && h.g >= 3) {
      const chain = this.chain(way.key, agent.id);
      const found = way.holders[chain[chain.length - 1]];
      if (chain.length >= 4 && found?.how === "found") {
        way.marks.push("hands");
        const links = chain.slice(1).map((id, i) => (i === chain.length - 2 ? `${label(id)}, who found it` : `${label(id)}, who had it from`));
        world.chronicle.add(
          world.tick,
          "lore",
          `${agent.label} learned ${name} from ${links.join(" ")}.`,
          { key: way.key, chain },
        );
      }
    }
    const mark = `gens${way.gens}`;
    if (way.gens >= 2 && way.by !== null && !way.marks.includes(mark)) {
      way.marks.push(mark);
      world.chronicle.add(
        world.tick,
        "lore",
        `Knowing ${name} has now been handed down ${way.gens} generations since ${label(way.by)} found it.`,
        { key: way.key, gens: way.gens },
      );
    }
  }

  // --- Saving ------------------------------------------------------------------

  toJSON(): LoreData {
    const kin: Record<number, number> = {};
    for (const [id, g] of [...this.kin.entries()].sort((a, b) => a[0] - b[0])) kin[id] = g;
    const told: Record<string, [number, number]> = {};
    for (const [t, v] of this.told) told[t] = v;
    return { ways: [...this.ways.values()], kin, told };
  }

  static fromJSON(data: LoreData): Lore {
    const lore = new Lore();
    for (const [id, g] of Object.entries(data.kin)) lore.kin.set(Number(id), g);
    for (const [t, v] of Object.entries(data.told ?? {})) lore.told.set(t, v);
    for (const way of data.ways) {
      lore.ways.set(way.key, way);
      for (const [id, h] of Object.entries(way.holders)) {
        if (h.gone !== null) continue;
        let set = lore.held.get(Number(id));
        if (!set) lore.held.set(Number(id), (set = new Set()));
        set.add(way.key);
      }
    }
    return lore;
  }

  /**
   * The record begun in a world already living: everyone's knowledge now, and
   * whoever the chronicle says found it first. Milestones already passed stay quiet.
   */
  static seed(world: World): Lore {
    const lore = new Lore();
    const origins = originsFromChronicle(world);
    const agents = world.population.list();
    for (const agent of agents) lore.meet(agent);
    for (const agent of agents) {
      const keys = waysHeld(agent, world);
      lore.held.set(agent.id, new Set(keys));
      for (const key of keys) {
        let way = lore.ways.get(key);
        if (!way) {
          const o = origins.get(key);
          way = {
            key, kind: kindOf(key), by: o?.by ?? null, at: o?.at ?? world.tick, holders: {}, known: 0, peak: 0, ever: 0,
            passed: 0, hands: 0, gens: 0, og: o ? lore.kin.get(o.by) ?? 0 : 0, lost: null, losses: 0, marks: [],
          };
          lore.ways.set(key, way);
        }
        const finder = way.by === agent.id;
        way.holders[agent.id] = { g: finder ? 0 : way.by === null ? 0 : 1, from: null, how: finder ? "found" : "before", at: world.tick, gone: null };
        way.known++;
        way.ever++;
        way.peak = way.known;
        if (!finder && way.by !== null) way.hands = 1;
      }
    }
    const alive = world.population.count;
    for (const way of lore.ways.values()) {
      if (way.kind !== "food" && way.kind !== "word" && way.known >= Math.max(SPREAD_MIN, Math.ceil(SPREAD_SHARE * alive))) way.marks.push("spread");
    }
    return lore;
  }
}

function notable(way: Way): boolean {
  return way.peak >= NOTABLE_PEAK[way.kind];
}

/** Who the chronicle says found what, as far as its words tell. */
function originsFromChronicle(world: World): Map<string, { by: number; at: number }> {
  const out = new Map<string, { by: number; at: number }>();
  const set = (key: string, by: unknown, at: number) => {
    if (typeof by === "number" && !out.has(key)) out.set(key, { by, at });
  };
  for (const e of world.chronicle.all()) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.kind === "language" && typeof d.word === "string" && typeof d.concept === "string") set(`word:${d.concept}=${d.word}`, d.agentId, e.tick);
    else if (e.kind === "fire" && /struck sparks/.test(e.text)) set("craft:fire", d.agentId, e.tick);
    else if (e.kind === "crafting") {
      if (/wove fibers/.test(e.text)) set("craft:weave", d.agentId, e.tick);
      else if (/wet earth and fibers/.test(e.text)) set("craft:brick", d.agentId, e.tick);
      else if (/ tied /.test(e.text)) set("craft:bind", d.agentId, e.tick);
    } else if (e.kind === "discovery" && typeof d.material === "number") {
      if (d.toxinBefore !== undefined) set(`cure:${d.material}`, d.agentId, e.tick);
      else if (/It was nourishing/.test(e.text)) set(`food:${d.material}`, d.agentId, e.tick);
    }
  }
  return out;
}
