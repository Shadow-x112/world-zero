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

function living(world: World, params: Record<string, unknown>): Agent | null {
  const id = Number(params.id);
  return Number.isInteger(id) ? (world.population.get(id) ?? null) : null;
}

export const ACTS: Record<string, ActDef> = {
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
