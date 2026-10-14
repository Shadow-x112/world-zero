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
import { skillWords } from "../agents/skill.ts";

const r2 = (v: number) => Math.round(v * 100) / 100;

/** The few fields the viewer needs every frame to draw an AI moving. */
export interface AgentPose {
  id: number;
  x: number;
  y: number;
  /** Heading in radians. */
  h: number;
  /** Current action type ("sleep" while asleep, "" while deciding). */
  a: string;
}

export function agentPose(agent: Agent): AgentPose {
  return {
    id: agent.id,
    x: r2(agent.x),
    y: r2(agent.y),
    h: r2(agent.heading),
    a: agent.asleep ? "sleep" : (agent.action?.type ?? ""),
  };
}

export function samePose(a: AgentPose, b: AgentPose): boolean {
  return a.x === b.x && a.y === b.y && a.h === b.h && a.a === b.a;
}

/** One row per living AI: who it is and how it is doing. */
export function agentSummary(agent: Agent, world: World) {
  return {
    ...agentPose(agent),
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
