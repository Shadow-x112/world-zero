// The hidden rules of making things. The AIs never see these; they only see
// what comes out when they try things against each other.
//
// Part 1 rules:
// - BIND: something flexible ties parts into one thing. The parts keep their
//   working properties; a long sturdy part gives the whole thing reach.
// - BUNDLE: enough flexible stuff woven into itself becomes a carrier.
// - SHAPE: striking a hard thing with something hard and heavy knocks mass
//   off and can raise an edge. Chancy; the target can be ruined.
// (MIX and HEAT arrive with parts 2 and 3 of this step.)

import type { Rng } from "../core/rng.ts";
import type { World } from "../core/world.ts";
import type { MaterialType } from "../materials/registry.ts";
import type { Agent } from "../agents/agent.ts";
import { breakPower, carryBonus, cutPower, emptyProps, nextItemId, type Item } from "./item.ts";

/** Flexibility at or above this can bind. */
export const BINDER_FLEXIBILITY = 0.6;
/** Mass of binder a binding needs. */
export const BINDER_MASS = 0.2;
/** Hardness at or above this makes a worthwhile working part. */
export const PART_HARDNESS = 0.5;
/** A long sturdy part (firm but springy): gives reach. */
export function polelike(type: MaterialType): boolean {
  return type.props.hardness >= 0.4 && type.props.flexibility >= 0.15 && type.props.mass >= 0.4;
}
/** Units of binder that weave into a carrier. */
export const BUNDLE_UNITS = 6;
/** What it takes to strike: hard and heavy enough. */
export const STRIKER_HARDNESS = 0.6;
export const STRIKER_MASS = 0.25;
/** Only hard things take an edge. */
export const SHAPEABLE_HARDNESS = 0.5;
/** Chance that one bout of shaping succeeds. */
export const SHAPE_CHANCE = 0.45;
/** Chance that shaping an existing item ruins it. */
export const SHAPE_RUIN_CHANCE = 0.2;
/** World seconds one attempt takes. */
export const TINKER_TICKS = 1500;

export type Verb = "bind" | "bundle" | "shape";

export interface Attempt {
  /** Stable key for the agent's memory of what it has tried. */
  key: string;
  verb: Verb;
  /** Raw materials consumed on success: material id -> units. */
  consumes: Record<string, number>;
  /** An existing carried item used as the head or target (consumed into the result or at risk). */
  usesItem?: Item;
  /** Carries out the attempt. Returns the new/changed item, or null on failure. */
  resolve(world: World, agent: Agent, rng: Rng): Item | null;
}

function unitsOf(agent: Agent, material: number): number {
  return agent.carrying.find((c) => c.material === material)?.units ?? 0;
}

export function removeUnits(agent: Agent, material: number, units: number): boolean {
  const entry = agent.carrying.find((c) => c.material === material);
  if (!entry || entry.units < units) return false;
  entry.units -= units;
  if (entry.units === 0) agent.carrying = agent.carrying.filter((c) => c !== entry);
  return true;
}

function consume(agent: Agent, consumes: Record<string, number>): boolean {
  for (const [id, units] of Object.entries(consumes)) if (unitsOf(agent, Number(id)) < units) return false;
  for (const [id, units] of Object.entries(consumes)) removeUnits(agent, Number(id), units);
  return true;
}

function newItem(world: World, agent: Agent, parts: Record<string, number>): Item {
  return {
    id: nextItemId(world),
    parts,
    props: emptyProps(),
    wear: 1,
    madeBy: agent.id,
    madeTick: world.tick,
    uses: 0,
  };
}

/** What a bound thing comes out as: the head does the work, the pole gives reach. */
function bindResult(world: World, agent: Agent, binderId: number, binderUnits: number, headId: number, poleId: number | null): Item {
  const materials = world.materials;
  const binder = materials.require(binderId);
  const head = materials.require(headId);
  const pole = poleId === null ? null : materials.require(poleId);
  const parts: Record<string, number> = { [binderId]: binderUnits, [headId]: 1 };
  if (poleId !== null) parts[poleId] = (parts[poleId] ?? 0) + 1;
  const item = newItem(world, agent, parts);
  const p = item.props;
  p.hardness = head.props.hardness;
  p.sharpness = head.props.sharpness;
  p.flexibility = binder.props.flexibility * 0.2;
  p.mass = head.props.mass + (pole?.props.mass ?? 0) + binder.props.mass * binderUnits;
  p.energy = head.props.energy * 0.5;
  p.reactivity = head.props.reactivity * 0.5;
  p.reach = pole ? 1 : 0;
  return item;
}

function bundleResult(world: World, agent: Agent, binderId: number, units: number): Item {
  const binder = world.materials.require(binderId);
  const item = newItem(world, agent, { [binderId]: units });
  const p = item.props;
  p.flexibility = binder.props.flexibility;
  p.mass = binder.props.mass * units;
  p.growth = binder.props.growth * 0.3;
  return item;
}

/** Striking raises an edge: more sharpness, less mass. */
function sharpen(props: Item["props"], rng: Rng): void {
  props.sharpness = Math.min(0.9, Math.max(props.sharpness, 0.15) + 0.2 + rng.next() * 0.25);
  props.mass *= 0.8;
}

/** Everything the agent could try right now with what it carries. */
export function possibleAttempts(agent: Agent, world: World): Attempt[] {
  const materials = world.materials;
  const out: Attempt[] = [];

  const binders: { id: number; units: number }[] = [];
  const heads: number[] = [];
  const poles: number[] = [];
  const shapeables: number[] = [];
  const strikers: number[] = [];
  for (const c of agent.carrying) {
    const type = materials.get(c.material);
    if (!type) continue;
    if (type.props.flexibility >= BINDER_FLEXIBILITY) {
      const need = Math.ceil(BINDER_MASS / Math.max(0.01, type.props.mass));
      if (c.units >= need) binders.push({ id: c.material, units: need });
    }
    if (type.props.hardness >= PART_HARDNESS) heads.push(c.material);
    if (polelike(type)) poles.push(c.material);
    if (type.props.hardness >= SHAPEABLE_HARDNESS) shapeables.push(c.material);
    if (type.props.hardness >= STRIKER_HARDNESS && type.props.mass >= STRIKER_MASS) strikers.push(c.material);
  }

  for (const binder of binders) {
    // Weave the binder into itself.
    if (unitsOf(agent, binder.id) >= BUNDLE_UNITS) {
      out.push({
        key: `bundle:${binder.id}`,
        verb: "bundle",
        consumes: { [binder.id]: BUNDLE_UNITS },
        resolve: (world, agent) => bundleResult(world, agent, binder.id, BUNDLE_UNITS),
      });
    }
    // Bind a hard part, with or without a pole.
    for (const head of heads) {
      const options: (number | null)[] = [null];
      for (const pole of poles) if (pole !== head) options.push(pole);
      for (const pole of options) {
        const consumes: Record<string, number> = { [binder.id]: binder.units };
        consumes[head] = (consumes[head] ?? 0) + 1;
        if (pole !== null) consumes[pole] = (consumes[pole] ?? 0) + 1;
        let possible = true;
        for (const [id, units] of Object.entries(consumes)) if (unitsOf(agent, Number(id)) < units) possible = false;
        if (!possible) continue;
        out.push({
          key: `bind:${[head, pole].filter((v) => v !== null).sort().join("+")}~${binder.id}`,
          verb: "bind",
          consumes,
          resolve: (world, agent) => bindResult(world, agent, binder.id, binder.units, head, pole),
        });
      }
    }
  }

  // Strike one hard thing with another (either way around).
  for (const striker of strikers) {
    for (const target of shapeables) {
      if (striker === target && unitsOf(agent, target) < 2) continue;
      out.push({
        key: `shape:${target}<${striker}`,
        verb: "shape",
        consumes: { [target]: 1 },
        resolve: (world, agent, rng) => {
          if (!rng.chance(SHAPE_CHANCE)) return null; // the piece crumbled
          const type = world.materials.require(target);
          const item = newItem(world, agent, { [target]: 1 });
          const p = item.props;
          for (const key of ["hardness", "sharpness", "flexibility", "mass", "energy", "reactivity"] as const) p[key] = type.props[key];
          sharpen(p, rng);
          return item;
        },
      });
    }
    // Re-work an item it carries into a better edge (risks ruining it).
    for (const item of agent.items) {
      if (item.props.hardness < SHAPEABLE_HARDNESS || item.props.sharpness >= 0.85) continue;
      out.push({
        key: `shape:item<${striker}`,
        verb: "shape",
        consumes: {},
        usesItem: item,
        resolve: (world, agent, rng) => {
          if (rng.chance(SHAPE_RUIN_CHANCE)) {
            agent.items = agent.items.filter((i) => i !== item);
            return null; // it broke in its hands
          }
          if (!rng.chance(SHAPE_CHANCE)) return null;
          sharpen(item.props, rng);
          return item;
        },
      });
    }
  }
  return out;
}

/** The broad kind of work an item is good for, to avoid making a second of the same. */
export function itemClass(item: Item): string {
  const classes: string[] = [];
  if (cutPower(item) > 0) classes.push("cut");
  if (breakPower(item) > 0) classes.push("break");
  if (carryBonus(item) > 0) classes.push("carry");
  return classes.join("+") || "none";
}

/**
 * How much this attempt interests the agent: new combinations most, failures
 * less each time, successes only when it no longer has such a thing.
 */
export function interestIn(agent: Agent, attempt: Attempt, probe: Item | null): number {
  const memory = agent.tried[attempt.key];
  if (!memory) return 1;
  if (memory.ok > 0) {
    if (!probe) return 0.6;
    const have = agent.items.some((i) => i !== attempt.usesItem && itemClass(i) === itemClass(probe));
    return have ? 0.02 : 0.8;
  }
  return 1 / (1 + memory.n);
}

/** A dry run of what the attempt would make, for judging interest (not applied). */
export function probeResult(attempt: Attempt, world: World, agent: Agent): Item | null {
  if (attempt.verb === "shape") return null; // outcome uncertain by nature
  const saved = world.itemSeq;
  const probe = attempt.resolve(world, agent, { chance: () => true, next: () => 0.5 } as unknown as Rng);
  world.itemSeq = saved;
  return probe;
}

/** Spends the attempt: consumes parts, rolls the outcome, records the memory. */
export function performAttempt(attempt: Attempt, world: World, agent: Agent): Item | null {
  if (!consume(agent, attempt.consumes)) return null;
  const memory = (agent.tried[attempt.key] ??= { n: 0, ok: 0 });
  memory.n++;
  const result = attempt.resolve(world, agent, world.rng);
  if (result) {
    memory.ok++;
    if (!agent.items.includes(result)) agent.items.push(result);
    agent.stats.crafted++;
  }
  return result;
}
