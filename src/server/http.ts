// The world's window: a small web server living in the same process as the world.
// Built only on node:http.
//
// Anyone may watch. Changing anything, or seeing what is hidden (the world's seed, the
// true nature of materials), needs the creator key, sent as "Authorization: Bearer <key>"
// or "?key=<key>" (a browser's live stream cannot send headers, so it uses the query form).
//
// Public (read-only):
//   GET  /health                         alive? (for the host's health check)
//   GET  /  (or /view)                   the 3D viewer (files under /viewer/)
//   GET  /status                         plain status page with the creator's controls
//   GET  /api/status                     date, population, speed, performance
//   GET  /api/chronicle?since=&limit=    history entries after an id
//   GET  /api/ais                        every living AI, one summary each
//   GET  /api/ai/<id>                    everything about one AI (or how it died)
//   GET  /api/words | shelters | items   the console reports, as text
//   GET  /api/palette                    how each material looks
//   GET  /api/chunks                     every chunk the world has: [cx, cy, revision]
//   GET  /api/chunkdata?c=cx,cy;cx,cy    the ground of up to 64 chunks
//   GET  /api/stream                     live changes (Server-Sent Events), limited watchers
// Creator only:
//   GET  /api/creator/overview | web | families | words | history | ai/<id>   hidden truths
//   GET  /api/creator/log                the private record of every act
//   POST /api/creator/act                {"kind", "params", "confirm"?}: without confirm, a preview
//   POST /api/creator/undo               {"id", "confirm"?}: put back the moment before the last act
//   GET  /api/materials                  every material's true properties (also in /api/palette)
//   POST /api/control                    {"action":"pause"|"resume"|"speed"|"save"|"backup", "speed"?: n}
//   GET  /api/admin/save                 download the world as it is this moment (.json.gz)
//   POST /api/admin/adopt                bring a world here (only while waiting for one)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import type { Runner } from "../core/runner.ts";
import { statusData } from "../status.ts";
import { agentView, agentSummary, chronicleSince } from "./views.ts";
import { StreamHub } from "./stream.ts";
import { STATUS_PAGE } from "./page.ts";
import { itemsReport, materialsTable, sheltersReport } from "../inspect.ts";
import { lexiconReport } from "../agents/language.ts";
import { chunkIndex, encodeChunk, fullPalette, publicPalette } from "./terrain.ts";
import { RateLimiter } from "./limits.ts";
import { ViewerFiles } from "./static.ts";
import * as creatorViews from "./creator.ts";
import { ActError, type Desk } from "../creator/desk.ts";

/** Largest save the adopt endpoint accepts (compressed). */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
/** Default most people watching the live stream at once (the creator is never turned away). */
export const DEFAULT_MAX_WATCHERS = 25;
/** Most chunks one /api/chunkdata request may ask for. */
export const MAX_CHUNKS_PER_REQUEST = 64;
/** The viewer may load Three.js (pinned) from the CDN; everything else is ours. */
const VIEWER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
].join("; ");
/** Responses larger than this are compressed for clients that accept it. */
const GZIP_OVER_BYTES = 1024;

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
  /** Most public watchers of the live stream at once. */
  maxWatchers?: number;
  /** The creator's desk (acts, undo, the private log). */
  desk?: Desk;
  /** Requests per second (and burst) allowed to one visitor without the key. */
  rate?: { perSecond: number; burst: number };
}

export class WorldServer {
  readonly hub = new StreamHub();
  runner: Runner | null = null;
  state: ServerState = "waiting";
  private server: Server | null = null;
  private readonly keyHash: Buffer;
  private readonly opts: WorldServerOptions;
  private readonly limiter: RateLimiter;
  private readonly viewer = new ViewerFiles();
  readonly maxWatchers: number;

  constructor(opts: WorldServerOptions) {
    this.desk = opts.desk;
    if (!opts.key || opts.key.length < 16) throw new Error("The creator key must be at least 16 characters");
    this.opts = opts;
    this.keyHash = hash(opts.key);
    this.maxWatchers = opts.maxWatchers ?? DEFAULT_MAX_WATCHERS;
    this.limiter = new RateLimiter(opts.rate?.perSecond ?? 20, opts.rate?.burst ?? 200);
  }

  /** The creator's desk, once the world is here. */
  desk?: Desk;

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
    if (path === "/status" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      });
      res.end(STATUS_PAGE);
      return;
    }
    if ((path === "/" || path === "/view" || path.startsWith("/viewer/")) && method === "GET") {
      const file = this.viewer.get(path === "/" || path === "/view" ? "index.html" : path.slice("/viewer/".length));
      if (!file) return json(res, 404, { error: "not found" });
      res.writeHead(200, {
        "Content-Type": file.type,
        "Content-Length": file.body.length,
        "Cache-Control": file.name === "index.html" ? "no-cache" : "public, max-age=300",
        "Content-Security-Policy": VIEWER_CSP,
      });
      res.end(file.body);
      return;
    }
    if (!path.startsWith("/api/")) return json(res, 404, { error: "not found" });

    const creator = this.authorized(req, url);
    if (!creator && !this.limiter.allow(visitorOf(req))) {
      res.setHeader("Retry-After", "5");
      return json(res, 429, { error: "too many requests; slow down" });
    }
    const send = (status: number, data: unknown) => jsonMaybeGzip(req, res, status, data);
    const needKey = () => json(res, 401, { error: "creator key required" });

    if (path === "/api/admin/adopt" && method === "POST") return creator ? this.adopt(req, res) : needKey();

    const runner = this.runner;
    if (!runner) return json(res, 503, { error: "no world here yet", state: this.state });
    const w = runner.world;

    if (method === "GET" && path.startsWith("/api/creator/")) {
      if (!creator) return needKey();
      const what = path.slice("/api/creator/".length);
      switch (what) {
        case "overview":
          return send(200, creatorViews.overview(w));
        case "web":
          return send(200, creatorViews.web(w));
        case "families":
          return send(200, creatorViews.families(w));
        case "words":
          return send(200, creatorViews.words(w));
        case "history":
          return send(200, creatorViews.history(w));
        case "log":
          return send(200, { entries: this.desk?.log() ?? [] });
      }
      const m = what.match(/^ai\/(\d+)$/);
      if (m) {
        const agent = w.population.get(Number(m[1]));
        return agent ? send(200, creatorViews.hiddenAi(w, agent)) : json(res, 404, { error: `no living AI #${m[1]}` });
      }
      return json(res, 404, { error: "not found" });
    }

    if (method === "GET") {
      switch (path) {
        case "/api/status": {
          const s = statusData(runner);
          if (!creator) delete (s as Partial<typeof s>).seed; // the seed foretells the land and the winters
          return send(200, s);
        }
        case "/api/chronicle": {
          const since = Number(url.searchParams.get("since") ?? 0) || 0;
          const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
          return send(200, { entries: chronicleSince(w, since, limit), size: w.chronicle.size });
        }
        case "/api/ais":
          return send(200, { tick: w.tick, ais: w.population.list().map((a) => agentSummary(a, w)) });
        case "/api/words":
          return text(res, lexiconReport(w));
        case "/api/shelters":
          return text(res, sheltersReport(w));
        case "/api/items":
          return text(res, itemsReport(w));
        case "/api/palette":
          return send(200, { materials: creator ? fullPalette(w.materials) : publicPalette(w.materials) });
        case "/api/chunks":
          return send(200, { boot: this.hub.boot, size: 32, chunks: chunkIndex(w.grid) });
        case "/api/chunkdata": {
          const wanted = parseChunkList(url.searchParams.get("c") ?? "");
          if (wanted === null) return json(res, 400, { error: "c must be a list like 0,0;1,-2" });
          if (wanted.length > MAX_CHUNKS_PER_REQUEST) return json(res, 400, { error: `at most ${MAX_CHUNKS_PER_REQUEST} chunks per request` });
          const chunks = [];
          const missing: Array<[number, number]> = [];
          for (const [cx, cy] of wanted) {
            const chunk = w.grid.viewChunk(cx, cy); // never loads anything into the world
            if (chunk) chunks.push(encodeChunk(chunk, w));
            else missing.push([cx, cy]);
          }
          return send(200, { boot: this.hub.boot, chunks, missing });
        }
        case "/api/stream":
          if (!creator && this.hub.publicSize >= this.maxWatchers) {
            res.setHeader("Retry-After", "60");
            return json(res, 503, { error: "the world has as many watchers as it can take right now; try again soon" });
          }
          this.hub.add(res, w, creator);
          return;
        case "/api/materials":
          return creator ? text(res, materialsTable(w)) : needKey();
        case "/api/admin/save": {
          if (!creator) return needKey();
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
        if (agent) return send(200, { alive: true, ...agentView(agent, w) });
        const body = w.population.bodies.find((b) => b.agentId === id);
        if (body) return send(200, { alive: false, id, cause: body.cause, ageDays: body.ageDays });
        return json(res, 404, { error: `no AI #${id}` });
      }
    }

    if (path.startsWith("/api/creator/") && method === "POST") {
      if (!creator) return needKey();
      const desk = this.desk;
      if (!desk) return json(res, 503, { error: "the creator's desk is not open" });
      const body = await readJson(req, 16384);
      try {
        if (path === "/api/creator/act") {
          const kind = String(body?.kind ?? "");
          const params = (body?.params && typeof body.params === "object" ? body.params : {}) as Record<string, unknown>;
          if (body?.confirm !== true) return json(res, 200, { preview: desk.preview(kind, params) });
          const entry = await desk.perform(kind, params);
          this.opts.log?.(`Creator act #${entry.id}: ${entry.summary}`);
          return json(res, 200, { ok: true, entry });
        }
        if (path === "/api/creator/undo") {
          const id = Number(body?.id);
          if (body?.confirm !== true) return json(res, 200, { preview: desk.undoPreview(id) });
          const entry = await desk.undo(id);
          this.opts.log?.(`Creator: ${entry.summary}`);
          return json(res, 200, { ok: true, entry });
        }
      } catch (err) {
        if (err instanceof ActError) return json(res, err.status, { error: err.message });
        throw err;
      }
      return json(res, 404, { error: "not found" });
    }

    if (path === "/api/control" && method === "POST") {
      if (!creator) return needKey();
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

/** Who is asking: the first address in X-Forwarded-For (set by the host's proxy), else the socket. */
function visitorOf(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

/** Parses "cx,cy;cx,cy" into pairs, or null if malformed. */
export function parseChunkList(raw: string): Array<[number, number]> | null {
  if (raw.trim() === "") return [];
  const out: Array<[number, number]> = [];
  for (const part of raw.split(";")) {
    const m = part.trim().match(/^(-?\d{1,7}),(-?\d{1,7})$/);
    if (!m) return null;
    out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}

function jsonMaybeGzip(req: IncomingMessage, res: ServerResponse, status: number, data: unknown): void {
  const body = Buffer.from(JSON.stringify(data));
  const accepts = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: "Accept-Encoding",
  };
  if (accepts && body.length > GZIP_OVER_BYTES) {
    const gz = gzipSync(body, { level: 6 });
    res.writeHead(status, { ...headers, "Content-Encoding": "gzip", "Content-Length": gz.length });
    res.end(gz);
    return;
  }
  res.writeHead(status, { ...headers, "Content-Length": body.length });
  res.end(body);
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
