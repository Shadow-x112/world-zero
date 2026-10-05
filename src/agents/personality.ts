// Personality: who an AI becomes. Nothing is assigned - repeated feelings and
// a lived life slowly harden into nature. Every day, each trait drifts a small
// step toward what this one actually felt and did that day: a life of scares
// makes a timid soul, a life of wonders makes a seeker, seasons of work make
// the industrious, company makes the warm, and joy or grief tip the balance
// between sunny and somber. Children are shaped twice as fast - the early
// years leave the deepest marks. The founders begin all but identical (their
// tiny quirks seed a whisper of a leaning); their lives do the rest.

import type { Agent } from "./agent.ts";
import { blankEmotions } from "./emotions.ts";
import type { AgentContext } from "./movement.ts";

export type TraitKind = "courage" | "cheer" | "wander" | "industry" | "warmth";

export const TRAIT_KINDS: TraitKind[] = ["courage", "cheer", "wander", "industry", "warmth"];

/** -1 .. 1 each: timid-fearless, somber-sunny, homebound-seeker, dreamy-industrious, solitary-gregarious. */
export type Personality = Record<TraitKind, number>;

/** How far a trait steps toward the day's signal (a season leaves a mark, a year shapes you). */
export const TRAIT_DRIFT_PER_DAY = 0.03;
/** Childhood shapes twice as fast. */
export const CHILD_DRIFT_FACTOR = 2;
/** Quirks seed only a whisper of a leaning; life does the rest. */
export const QUIRK_SEED = 0.08;
/** A trait past this is who they are now (chronicled once per world, per nature). */
export const SETTLED = 0.5;

/** What each settled nature is called, by trait and direction. */
const NATURES: Record<TraitKind, [string, string]> = {
  courage: ["timid", "fearless"],
  cheer: ["somber", "sunny"],
  wander: ["homebound", "a seeker"],
  industry: ["dreamy", "tireless"],
  warmth: ["solitary", "warm-hearted"],
};

export function blankPersonality(quirk?: number[]): Personality {
  const p = { courage: 0, cheer: 0, wander: 0, industry: 0, warmth: 0 };
  if (quirk && quirk.length > 0) {
    TRAIT_KINDS.forEach((k, i) => {
      p[k] = quirk[i % quirk.length] * QUIRK_SEED;
    });
  }
  return p;
}

const clamp = (v: number, lo = -1, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

/**
 * The day's signals: what this life said about itself today, each in -1..1.
 * Feelings come from the day's accumulated `felt`; work from what was made
 * and placed; company from how socially full the day left them.
 */
export function daySignals(agent: Agent): Personality {
  const f = agent.felt;
  const work = agent.stats.blocksPlaced + agent.stats.crafted + agent.stats.cooked;
  return {
    // A day with real fear in it bends toward caution; a safe day builds a little nerve.
    courage: f.fear > 0.1 ? -clamp(f.fear, 0, 1) : 0.3,
    cheer: clamp(f.joy + f.contentment - 1.5 * f.sadness),
    // Routine ground doesn't count for much: only a day genuinely full of the
    // new reads as seeking, and an ordinary one drifts gently toward home.
    wander: clamp(f.wonder * 1.5 - 0.3),
    industry: clamp((work - agent.prevWork) * 0.4 - 0.1),
    // Village life is the norm, not a nature: only the notably company-rich
    // read as warm, and the often-alone drift solitary.
    warmth: clamp((agent.needs.social - 0.8) * 2),
  };
}

/** The daily settling: every heart drifts a step toward the life it is living. */
export function dailyPersonality(ctx: AgentContext): void {
  const world = ctx.world;
  for (const agent of ctx.population.list()) {
    const signals = daySignals(agent);
    const rate = TRAIT_DRIFT_PER_DAY * (agent.grown(world.tick) ? 1 : CHILD_DRIFT_FACTOR);
    for (const kind of TRAIT_KINDS) {
      const before = agent.personality[kind];
      const after = clamp(before + rate * (signals[kind] - before));
      agent.personality[kind] = after;
      // The world's first of each settled nature is history worth keeping.
      if (Math.abs(after) >= SETTLED && Math.abs(before) < SETTLED) {
        const nature = NATURES[kind][after > 0 ? 1 : 0];
        if (world.isFirst(`nature:${nature}`)) {
          world.chronicle.add(
            world.tick,
            "nature",
            `Something has settled in ${agent.label}: ${nature} now, the first of them.`,
            { agentId: agent.id, trait: kind, value: after },
          );
        }
      }
    }
    agent.prevWork = agent.stats.blocksPlaced + agent.stats.crafted + agent.stats.cooked;
    agent.felt = blankEmotions(); // tomorrow accumulates fresh
  }
}

/** Words for who an AI has become, strongest leanings first (empty while still unformed). */
export function natureWords(agent: Agent): string[] {
  return TRAIT_KINDS.map((k) => ({ k, v: agent.personality[k] }))
    .filter(({ v }) => Math.abs(v) >= 0.25)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .map(({ k, v }) => NATURES[k][v > 0 ? 1 : 0]);
}
