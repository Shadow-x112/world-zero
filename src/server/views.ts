// What the server shows of the world: plain data shapes for the API and the live stream.
// Nothing here changes the world; every function only reads it.

import type { Agent } from "../agents/agent.ts";
import type { World } from "../core/world.ts";
import type { ChronicleEntry } from "../core/chronicle.ts";
import { Chronicle } from "../core/chronicle.ts";
import { formatCalendar, getCalendar } from "../core/time.ts";
import { agentDetail, doing } from "../inspect.ts";
import { feelingWords } from "../agents/emotions.ts";
import { natureWords } from "../agents/personality.ts";
import { skillWords, SKILL_KINDS } from "../agents/skill.ts";
import { TRAIT_KINDS } from "../agents/personality.ts";

const r2 = (v: number) => Math.round(v * 100) / 100;
/** Positions to a tenth of a tile: plenty for a viewer that glides between updates. */
const r1 = (v: number) => Math.round(v * 10) / 10;

/** The few fields the viewer needs every frame to draw an AI moving. */
export interface AgentPose {
  id: number;
  x: number;
  y: number;
  /** Heading in radians. */
  h: number;
  /** Current action type ("sleep" while asleep, "" while deciding). */
  a: string;
  /** 1 if it has something in hand (gathered stuff or a made thing). */
  c: 0 | 1;
  /** 1 while still a child. */
  k: 0 | 1;
}

export function agentPose(agent: Agent, tick: number): AgentPose {
  return {
    id: agent.id,
    x: r1(agent.x),
    y: r1(agent.y),
    h: r2(agent.heading),
    a: agent.asleep ? "sleep" : (agent.action?.type ?? ""),
    c: agent.carrying.length > 0 || agent.items.length > 0 ? 1 : 0,
    k: agent.grown(tick) ? 0 : 1,
  };
}

export function samePose(a: AgentPose, b: AgentPose): boolean {
  return a.x === b.x && a.y === b.y && a.h === b.h && a.a === b.a && a.c === b.c && a.k === b.k;
}

/** One row per living AI: who it is and how it is doing. */
export function agentSummary(agent: Agent, world: World) {
  return {
    ...agentPose(agent, world.tick),
    label: agent.label,
    doing: doing(agent),
    asleep: agent.asleep,
    ageDays: r2(agent.ageDays(world.tick)),
    grown: agent.grown(world.tick),
    health: r2(agent.health),
    needs: {
      energy: r2(agent.needs.energy),
      rest: r2(agent.needs.rest),
      social: r2(agent.needs.social),
      curiosity: r2(agent.needs.curiosity),
    },
    mate: agent.mate,
    feelings: feelingWords(agent),
    nature: natureWords(agent),
    skills: skillWords(agent),
    look: agentLook(agent),
  };
}

/**
 * How an AI looks, for the viewer to draw it: only what anyone watching could see.
 *   hue  its own color of light, from its quirks (a child's quirks are its parents'
 *        blended, so families share related colors)
 *   p    its nature (courage, cheer, wander, industry, warmth; -1..1)
 *   sk   what its hands have learned (gathering, crafting, firecraft, building, cooking; 0-1)
 *   em   how it feels right now (fear, sadness, loneliness, joy; 0-1)
 *   tx   1 while poisoned
 */
export function agentLook(agent: Agent) {
  const q = agent.quirk;
  const qx = q[6 % q.length] ?? 0, qy = q[7 % q.length] ?? 0;
  const hue = ((Math.atan2(qy, qx) / (2 * Math.PI)) + 1) % 1;
  return {
    hue: Math.round(hue * 1000) / 1000,
    p: TRAIT_KINDS.map((k) => r2(agent.personality[k])),
    sk: SKILL_KINDS.map((k) => r2(agent.skills[k])),
    em: [r2(agent.emotions.fear), r2(agent.emotions.sadness), r2(agent.emotions.loneliness), r2(agent.emotions.joy)],
    tx: agent.toxin > 0.01 ? 1 : 0,
  };
}

/** Everything about one AI: the summary plus the full written description. */
export function agentView(agent: Agent, world: World) {
  return { ...agentSummary(agent, world), detail: agentDetail(agent, world) };
}

export interface ChronicleView extends ChronicleEntry {
  /** The world date of the entry. */
  when: string;
  /** The entry with its date, as the console prints it. */
  line: string;
}

export function chronicleView(entry: ChronicleEntry): ChronicleView {
  return { ...entry, when: formatCalendar(getCalendar(entry.tick)), line: Chronicle.describe(entry) };
}

/** Chronicle entries after a given id (for catching up), newest last, at most `limit`. */
export function chronicleSince(world: World, sinceId: number, limit: number): ChronicleView[] {
  const all = world.chronicle.all();
  const out: ChronicleView[] = [];
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
    if (all[i].id <= sinceId) break;
    out.push(chronicleView(all[i]));
  }
  return out.reverse();
}

export function firePositions(world: World): Array<[number, number]> {
  return [...world.fireTiles.values()].map((f) => [f.x, f.y]);
}
