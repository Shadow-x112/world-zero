// The live stream: a few times a second, everyone watching is told what changed.
// It uses Server-Sent Events (plain HTTP, one direction: world -> watcher), which needs
// no libraries and passes through any proxy. A watcher that connects gets a full
// snapshot first, then only changes.

import type { ServerResponse } from "node:http";
import type { World } from "../core/world.ts";
import { agentPose, chronicleView, firePositions, samePose, type AgentPose } from "./views.ts";

/** Real milliseconds between change messages. */
export const STREAM_INTERVAL_MS = 250;
/** Real milliseconds between keep-alive comments (stops proxies closing idle streams). */
export const KEEPALIVE_MS = 15_000;

export interface StreamClient {
  res: ServerResponse;
}

export interface Snapshot {
  worldId: string;
  generation: number;
  tick: number;
  agents: AgentPose[];
  fires: Array<[number, number]>;
  chronicleSize: number;
}

export interface Changes {
  tick: number;
  /** Agents that are new or have moved/changed action. */
  agents: AgentPose[];
  /** Ids of agents that are no longer alive. */
  gone: number[];
  fires?: { lit: Array<[number, number]>; out: Array<[number, number]> };
  chronicle: ReturnType<typeof chronicleView>[];
}

export class StreamHub {
  private clients = new Set<StreamClient>();
  private lastSent = 0;
  private lastKeepAlive = 0;
  private worldId = "";
  private poses = new Map<number, AgentPose>();
  private fires = new Set<string>();
  private chronicleSize = 0;
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  get size(): number {
    return this.clients.size;
  }

  /** Adds a watcher and sends it the whole present moment. */
  add(res: ServerResponse, world: World | null): StreamClient {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const client: StreamClient = { res };
    this.clients.add(client);
    res.on("close", () => this.clients.delete(client));
    if (world) {
      if (this.clients.size === 1 || world.meta.id !== this.worldId) this.resetBaseline(world);
      send(client, "snapshot", this.snapshot(world));
    }
    return client;
  }

  /** Called every runner frame; sends changes when it is time. */
  frame(world: World): void {
    if (this.clients.size === 0) return;
    const now = this.now();
    if (world.meta.id !== this.worldId) {
      // A new world began (after an extinction): everyone starts over from a snapshot.
      this.resetBaseline(world);
      this.broadcast("snapshot", this.snapshot(world));
      this.lastSent = now;
      return;
    }
    if (now - this.lastSent >= STREAM_INTERVAL_MS) {
      this.lastSent = now;
      const changes = this.diff(world);
      if (changes) this.broadcast("changes", changes);
    }
    if (now - this.lastKeepAlive >= KEEPALIVE_MS) {
      this.lastKeepAlive = now;
      for (const c of this.clients) c.res.write(": keep-alive\n\n");
    }
  }

  /** Sends a named event with data to every watcher. */
  broadcast(event: string, data: unknown): void {
    const payload = format(event, data);
    for (const c of this.clients) c.res.write(payload);
  }

  closeAll(): void {
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }

  snapshot(world: World): Snapshot {
    return {
      worldId: world.meta.id,
      generation: world.meta.generation,
      tick: world.tick,
      agents: world.population.list().map(agentPose),
      fires: firePositions(world),
      chronicleSize: world.chronicle.size,
    };
  }

  private resetBaseline(world: World): void {
    this.worldId = world.meta.id;
    this.poses = new Map(world.population.list().map((a) => [a.id, agentPose(a)]));
    this.fires = new Set(firePositions(world).map(([x, y]) => `${x},${y}`));
    this.chronicleSize = world.chronicle.size;
  }

  /** What changed since the last message, or null if nothing did. */
  diff(world: World): Changes | null {
    const agents: AgentPose[] = [];
    const seen = new Set<number>();
    for (const agent of world.population.list()) {
      seen.add(agent.id);
      const pose = agentPose(agent);
      const before = this.poses.get(agent.id);
      if (!before || !samePose(before, pose)) {
        agents.push(pose);
        this.poses.set(agent.id, pose);
      }
    }
    const gone: number[] = [];
    for (const id of this.poses.keys()) {
      if (!seen.has(id)) {
        gone.push(id);
        this.poses.delete(id);
      }
    }

    const nowFires = new Set(firePositions(world).map(([x, y]) => `${x},${y}`));
    const lit: Array<[number, number]> = [];
    const out: Array<[number, number]> = [];
    for (const k of nowFires) if (!this.fires.has(k)) lit.push(parseKey(k));
    for (const k of this.fires) if (!nowFires.has(k)) out.push(parseKey(k));
    this.fires = nowFires;

    const entries = world.chronicle.all();
    const chronicle = entries.slice(this.chronicleSize).map(chronicleView);
    this.chronicleSize = entries.length;

    if (agents.length === 0 && gone.length === 0 && lit.length === 0 && out.length === 0 && chronicle.length === 0) {
      return null;
    }
    const changes: Changes = { tick: world.tick, agents, gone, chronicle };
    if (lit.length || out.length) changes.fires = { lit, out };
    return changes;
  }
}

function parseKey(k: string): [number, number] {
  const [x, y] = k.split(",").map(Number);
  return [x, y];
}

function format(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function send(client: StreamClient, event: string, data: unknown): void {
  client.res.write(format(event, data));
}
