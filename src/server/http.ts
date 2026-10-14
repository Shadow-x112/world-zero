// The world's window: a small web server living in the same process as the world.
// Built only on node:http. Everything except /health and the status page needs the
// creator key, sent as "Authorization: Bearer <key>" or "?key=<key>" (the live
// stream cannot send headers from a browser, so it uses the query form).
//
//   GET  /health                 alive? (public; for the host's health check)
//   GET  /                       status page (asks for the key, then shows the world live)
//   GET  /api/status             date, population, speed, performance
//   GET  /api/chronicle?since=&limit=   history entries after an id
//   GET  /api/ais                every living AI, one summary each
//   GET  /api/ai/<id>            everything about one AI (or how it died)
//   GET  /api/words | shelters | items | materials    the console reports, as text
//   GET  /api/stream             live changes (Server-Sent Events)
//   POST /api/control            {"action":"pause"|"resume"|"speed"|"save"|"backup", "speed"?: n}
//   GET  /api/admin/save         download the world as it is this moment (.json.gz)
//   POST /api/admin/adopt        upload a save to bring a world here (only while waiting for one)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";

import type { Runner } from "../core/runner.ts";
import { statusData } from "../status.ts";
import { agentView, agentSummary, chronicleSince } from "./views.ts";
import { StreamHub } from "./stream.ts";
import { STATUS_PAGE } from "./page.ts";
import { itemsReport, materialsTable, sheltersReport } from "../inspect.ts";
import { lexiconReport } from "../agents/language.ts";

/** Largest save the adopt endpoint accepts (compressed). */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

export type ServerState = "waiting" | "running" | "stopping";

export interface WorldServerOptions {
  key: string;
  /** Saves now. */
  save: () => Promise<void>;
  /** Writes a backup now; returns where. */
  backup: () => Promise<string>;
  /** The whole world as a compressed save, this moment. */
  exportSave: () => Promise<Buffer>;
  /** Takes in an uploaded save while no world is here yet. */
  adopt: (gz: Buffer) => Promise<{ worldId: string; tick: number }>;
  log?: (line: string) => void;
}

export class WorldServer {
  readonly hub = new StreamHub();
  runner: Runner | null = null;
  state: ServerState = "waiting";
  private server: Server | null = null;
  private readonly keyHash: Buffer;
  private readonly opts: WorldServerOptions;

  constructor(opts: WorldServerOptions) {
    if (!opts.key || opts.key.length < 16) throw new Error("The creator key must be at least 16 characters");
    this.opts = opts;
    this.keyHash = hash(opts.key);
  }

  /** The world is here and running: start serving it. */
  attach(runner: Runner): void {
    this.runner = runner;
    this.state = "running";
  }

  /** Called on each runner frame. */
  frame(): void {
    if (this.runner) this.hub.frame(this.runner.world);
  }

  listen(port: number, host: string): Promise<number> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.opts.log?.(`Server error on ${req.method} ${req.url}: ${(err as Error).message}`);
        if (!res.headersSent) json(res, 500, { error: "internal error" });
        else res.end();
      });
    });
    this.server.keepAliveTimeout = 65_000; // longer than common proxy idle timeouts
    return new Promise((resolveListen, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => {
        const addr = this.server!.address();
        resolveListen(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  async close(): Promise<void> {
    this.state = "stopping";
    this.hub.closeAll();
    await new Promise<void>((done) => (this.server ? this.server.close(() => done()) : done()));
    this.server?.closeAllConnections?.();
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization;
    const given = header?.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("key");
    if (!given) return false;
    return timingSafeEqual(hash(given), this.keyHash);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (path === "/health") {
      const w = this.runner?.world;
      json(res, 200, { ok: true, state: this.state, tick: w?.tick ?? null, generation: w?.meta.generation ?? null });
      return;
    }
    if (path === "/" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      });
      res.end(STATUS_PAGE);
      return;
    }
    if (!path.startsWith("/api/")) return json(res, 404, { error: "not found" });
    if (!this.authorized(req, url)) return json(res, 401, { error: "creator key required" });

    if (path === "/api/admin/adopt" && method === "POST") return this.adopt(req, res);

    const runner = this.runner;
    if (!runner) return json(res, 503, { error: "no world here yet", state: this.state });
    const w = runner.world;

    if (method === "GET") {
      switch (path) {
        case "/api/status":
          return json(res, 200, statusData(runner));
        case "/api/chronicle": {
          const since = Number(url.searchParams.get("since") ?? 0) || 0;
          const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
          return json(res, 200, { entries: chronicleSince(w, since, limit), size: w.chronicle.size });
        }
        case "/api/ais":
          return json(res, 200, { tick: w.tick, ais: w.population.list().map((a) => agentSummary(a, w)) });
        case "/api/words":
          return text(res, lexiconReport(w));
        case "/api/shelters":
          return text(res, sheltersReport(w));
        case "/api/items":
          return text(res, itemsReport(w));
        case "/api/materials":
          return text(res, materialsTable(w));
        case "/api/stream":
          this.hub.add(res, w);
          return;
        case "/api/admin/save": {
          const gz = await this.opts.exportSave();
          res.writeHead(200, {
            "Content-Type": "application/gzip",
            "Content-Disposition": `attachment; filename="world-g${w.meta.generation}-${w.meta.id}-t${w.tick}.json.gz"`,
            "Content-Length": gz.length,
          });
          res.end(gz);
          return;
        }
      }
      const m = path.match(/^\/api\/ai\/#?(\d+)$/);
      if (m) {
        const id = Number(m[1]);
        const agent = w.population.get(id);
        if (agent) return json(res, 200, { alive: true, ...agentView(agent, w) });
        const body = w.population.bodies.find((b) => b.agentId === id);
        if (body) return json(res, 200, { alive: false, id, cause: body.cause, ageDays: body.ageDays });
        return json(res, 404, { error: `no AI #${id}` });
      }
    }

    if (path === "/api/control" && method === "POST") {
      const body = await readJson(req, 4096);
      const action = String(body?.action ?? "");
      switch (action) {
        case "pause":
          runner.setSpeed(0);
          break;
        case "resume":
          if (runner.speed === 0) runner.setSpeed(1);
          break;
        case "speed":
          try {
            runner.setSpeed(Number(body.speed));
          } catch (err) {
            return json(res, 400, { error: (err as Error).message });
          }
          break;
        case "save":
          await this.opts.save();
          break;
        case "backup":
          return json(res, 200, { ok: true, backup: await this.opts.backup() });
        default:
          return json(res, 400, { error: `unknown action "${action}"` });
      }
      this.opts.log?.(`Creator: ${action}${action === "speed" ? ` ${runner.speed}x` : ""}`);
      return json(res, 200, { ok: true, speed: runner.speed });
    }

    json(res, 404, { error: "not found" });
  }

  private async adopt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.state !== "waiting") {
      // The living world is never replaced through the window.
      return json(res, 409, { error: "a world is already living here; adopting is only possible while waiting for one" });
    }
    const gz = await readBody(req, MAX_UPLOAD_BYTES);
    try {
      const result = await this.opts.adopt(gz);
      this.opts.log?.(`Adopted world ${result.worldId} at tick ${result.tick}.`);
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    }
  }
}

function hash(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function text(res: ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        fail(new Error("upload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => done(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

async function readJson(req: IncomingMessage, max: number): Promise<any> {
  const raw = await readBody(req, max);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return {};
  }
}
