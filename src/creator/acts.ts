// What the creator can do, one definition per act. Each act:
//   check     returns a reason it cannot be done right now (or null)
//   describe  says plainly what it will do, before it is done
//   apply     does it, between ticks, and returns a summary for the private log and,
//             if the act has a visible effect, what nature tells the public chronicle
// "grave" acts (that cost a life, or remake the land) are confirmed twice in the viewer.
//
// Acts are added part by part: 8b brings the first (heal); people, shaping and events
// follow in 8c-8e.

import type { World } from "../core/world.ts";
import type { Agent } from "../agents/agent.ts";
import { MATURITY_FRACTION } from "../agents/agent.ts";
import { killAgent } from "../agents/system.ts";
import { feel } from "../agents/emotions.ts";
import { CHUNK_SIZE, Terrain } from "../world/chunk.ts";

export interface ActResult {
  summary: string;
  nature?: string;
  data?: Record<string, unknown>;
}

export interface ActDef {
  title: string;
  grave: boolean;
  check: (world: World, params: Record<string, unknown>) => string | null;
  describe: (world: World, params: Record<string, unknown>) => string[];
  apply: (world: World, params: Record<string, unknown>) => ActResult;
}

const label = (id: number) => `#${String(id).padStart(2, "0")}`;
const labels = (ids: number[]) => ids.map(label).join(", ");

/** A whole-number tile from the params, or null. */
function tileParam(p: Record<string, unknown>): { x: number; y: number } | null {
  const x = Number(p.x), y = Number(p.y);
  return Number.isInteger(x) && Number.isInteger(y) ? { x, y } : null;
}

/** Ground someone could stand on, among chunks the world already has (never invents land). */
function standable(world: World, x: number, y: number): boolean {
  // Read without loading anything into the world: a preview must change nothing.
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  const chunk = world.grid.viewChunk(cx, cy);
  if (!chunk) return false;
  const i = (y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE);
  if (chunk.peekLayer("terrain")?.[i] !== Terrain.open) return false;
  if (chunk.peekLayer("wall")?.[i]) return false;
  if (chunk.peekLayer("fire")?.[i]) return false;
  return true;
}

/** Open tiles near a point, nearest first, for a group to stand on. */
function spotsNear(world: World, cx: number, cy: number, n: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let r = 0; r <= 8 && out.length < n; r++) {
    for (let dy = -r; dy <= r && out.length < n; dy++) {
      for (let dx = -r; dx <= r && out.length < n; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (standable(world, cx + dx, cy + dy)) out.push({ x: cx + dx, y: cy + dy });
      }
    }
  }
  return out;
}

/** A place at the edge of the known world: a known chunk beside unknown ground. */
function frontierPoint(world: World, need: number): { x: number; y: number } | null {
  const known = [...world.grid.knownChunks()];
  const frontier = known.filter(({ cx, cy }) =>
    [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !world.grid.hasChunk(cx + dx, cy + dy)),
  );
  if (frontier.length === 0) return null;
  // Deterministic: the world's own randomness picks (the act is part of the world's story).
  frontier.sort((a, b) => a.cx - b.cx || a.cy - b.cy);
  for (let tries = 0; tries < 24; tries++) {
    const c = frontier[world.rng.int(0, frontier.length - 1)];
    const p = { x: c.cx * CHUNK_SIZE + CHUNK_SIZE / 2, y: c.cy * CHUNK_SIZE + CHUNK_SIZE / 2 };
    if (spotsNear(world, p.x, p.y, need).length >= need) return p; // not under water or on a ridge
  }
  return null;
}

const AGES: Record<string, { words: string; fraction: (world: World) => number | undefined }> = {
  young: { words: "young adults, newly grown", fraction: (w) => MATURITY_FRACTION + 0.02 + w.rng.next() * 0.06 },
  adult: { words: "adults in the middle of life", fraction: (w) => 0.32 + w.rng.next() * 0.2 },
  mixed: { words: "of mixed ages, children among them", fraction: () => undefined }, // as the founders were
};
export const MAX_NEWCOMERS = 12;

function living(world: World, params: Record<string, unknown>): Agent | null {
  const id = Number(params.id);
  return Number.isInteger(id) ? (world.population.get(id) ?? null) : null;
}

export const ACTS: Record<string, ActDef> = {
  newcomers: {
    title: "Newcomers",
    grave: false,
    check: (world, p) => {
      const n = Number(p.count);
      if (!Number.isInteger(n) || n < 1 || n > MAX_NEWCOMERS) return `Bring between 1 and ${MAX_NEWCOMERS}`;
      if (!AGES[String(p.ages ?? "")]) return "Choose young, adult or mixed ages";
      const at = tileParam(p);
      if (at && spotsNear(world, at.x, at.y, n).length < n) return "Not enough open ground there for them all";
      if (!at && !world.grid.knownChunkCount) return "There is no known world for them to come to";
      return null;
    },
    describe: (world, p) => {
      const at = tileParam(p);
      return [
        `${p.count} stranger${Number(p.count) === 1 ? "" : "s"} arrive${Number(p.count) === 1 ? "s" : ""}, ${AGES[String(p.ages)].words}.`,
        at ? `They appear around (${at.x}, ${at.y}).` : "They appear together at the edge of the known world.",
        "They know nothing of this world: no words, no friends, no skills. They are warm only toward each other.",
        `The chronicle will say: strangers appeared${at ? "" : " at the edge of the world"}.`,
      ];
    },
    apply: (world, p) => {
      const n = Number(p.count);
      const center = tileParam(p) ?? frontierPoint(world, n);
      if (!center) return { summary: "No open ground could be found at the edge of the world; no one came." };
      const spots = spotsNear(world, center.x, center.y, n);
      const ages = AGES[String(p.ages)];
      const arrived: Agent[] = [];
      for (const s of spots) arrived.push(world.population.createFounder(world.rng, world.tick, s.x, s.y, ages.fraction(world)));
      // They came together: each is a little warm toward the others, and toward no one else.
      for (const a of arrived) for (const b of arrived) if (a !== b) a.bonds[b.id] = { trust: 0.2, affection: 0.2, lastNear: world.tick };
      for (const a of arrived) feel(a, "wonder", 0.6);
      const ids = arrived.map((a) => a.id);
      const where = tileParam(p) ? "" : " at the edge of the world";
      return {
        summary: `Brought ${n} newcomer${n === 1 ? "" : "s"} (${labels(ids)}, ${String(p.ages)} ages) to (${center.x}, ${center.y}).`,
        nature: n === 1 ? `A stranger appeared${where}: ${labels(ids)}. ${world.population.count} alive.` : `Strangers appeared${where}: ${labels(ids)}. ${world.population.count} alive.`,
        data: { ids, x: center.x, y: center.y },
      };
    },
  },

  calm: {
    title: "Calm",
    grave: false,
    check: (world, p) => (living(world, p) ? null : `No living AI #${p.id}`),
    describe: (world, p) => [
      `${label(living(world, p)!.id)} grows calm: fear and anger fall away, and grief softens by half.`,
      "Its memories and bonds are untouched. It will not know why.",
    ],
    apply: (world, p) => {
      const a = living(world, p)!;
      const was = `fear ${a.emotions.fear.toFixed(2)}, anger ${a.emotions.anger.toFixed(2)}, sadness ${a.emotions.sadness.toFixed(2)}`;
      a.emotions.fear = 0;
      a.emotions.anger = 0;
      a.emotions.sadness *= 0.5;
      return { summary: `Calmed ${label(a.id)} (was ${was}).` };
    },
  },

  inspire: {
    title: "Inspire",
    grave: false,
    check: (world, p) => (living(world, p) ? null : `No living AI #${p.id}`),
    describe: (world, p) => [
      `${label(living(world, p)!.id)} feels a restless wish to see and try new things, and a rush of wonder.`,
      "What it does with that is its own.",
    ],
    apply: (world, p) => {
      const a = living(world, p)!;
      a.needs.curiosity = Math.min(a.needs.curiosity, 0.1);
      feel(a, "wonder", 0.7);
      return { summary: `Inspired ${label(a.id)} (curiosity awakened, wonder).` };
    },
  },

  move: {
    title: "Move",
    grave: false,
    check: (world, p) => {
      if (!living(world, p)) return `No living AI #${p.id}`;
      const at = tileParam(p);
      if (!at) return "Choose where it should stand";
      if (!standable(world, at.x, at.y)) return "It cannot stand there (water, a ridge, a wall, fire, or ground no one has seen)";
      return null;
    },
    describe: (world, p) => {
      const a = living(world, p)!;
      const at = tileParam(p)!;
      return [
        `${label(a.id)} is lifted from (${a.tileX}, ${a.tileY}) and set down at (${at.x}, ${at.y}).`,
        a.asleep ? "It wakes there, unsure how it came to be there, and decides afresh what to do." : "It decides afresh what to do there.",
        "Its home stays where it was: it may walk back.",
      ];
    },
    apply: (world, p) => {
      const a = living(world, p)!;
      const at = tileParam(p)!;
      const from = `(${a.tileX}, ${a.tileY})`;
      a.x = at.x;
      a.y = at.y;
      a.path = [];
      a.pathIndex = 0;
      a.action = null;
      a.asleep = false;
      a.nextDecisionTick = world.tick + 1;
      return { summary: `Moved ${label(a.id)} from ${from} to (${at.x}, ${at.y}).` };
    },
  },

  remove: {
    title: "Remove",
    grave: true,
    check: (world, p) => (living(world, p) ? null : `No living AI #${p.id}`),
    describe: (world, p) => {
      const a = living(world, p)!;
      const mate = a.mate !== null && world.population.get(a.mate) ? ` Its mate ${label(a.mate)} will grieve.` : "";
      const first = world.population.deaths === 0 ? [`No one has died in this world yet: this would be its first death, and the chronicle will remember it as such.`] : [];
      return [
        `${label(a.id)} is taken from the world. This is a death.`,
        ...first,
        `What it carries falls where it stands. Everyone who loved it grieves.${mate}`,
        `The chronicle will say: ${a.label} was gone one day, and no one knew where.`,
      ];
    },
    apply: (world, p) => {
      const a = living(world, p)!;
      killAgent(world, a, "vanished");
      return { summary: `Removed ${label(a.id)} (aged ${Math.floor(a.ageDays(world.tick))} days).` };
    },
  },

  heal: {
    title: "Heal",
    grave: false,
    check: (world, p) => (living(world, p) ? null : `No living AI #${p.id}`),
    describe: (world, p) => {
      const a = living(world, p)!;
      return [
        `${label(a.id)} is made whole: health back to full, any poison gone, the damage it carries forgotten.`,
        `Hunger and tiredness stay as they are. It will not know anything happened.`,
      ];
    },
    apply: (world, p) => {
      const a = living(world, p)!;
      const before = a.health;
      a.health = 1;
      a.toxin = 0;
      for (const k of Object.keys(a.damage) as (keyof typeof a.damage)[]) a.damage[k] = 0;
      return { summary: `Healed ${label(a.id)} (health ${Math.round(before * 100)}% → 100%).` };
    },
  },
};
