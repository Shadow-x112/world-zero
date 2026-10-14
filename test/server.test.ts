import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

import { World } from "../src/core/world.ts";
import { Runner } from "../src/core/runner.ts";
import { Store, serializeWorld } from "../src/persist/store.ts";
import { WorldLock, LOCK_STALE_MS } from "../src/persist/lock.ts";
import { WorldServer, parseChunkList } from "../src/server/http.ts";
import { StreamHub } from "../src/server/stream.ts";
import { igniteAt } from "../src/world/fire.ts";
import { Desk } from "../src/creator/desk.ts";

const KEY = "a-test-creator-key-0123456789";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "world-zero-server-"));
}

interface Reply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function call(port: number, method: string, path: string, opts: { key?: string; body?: Buffer | string } = {}): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: opts.key ? { Authorization: `Bearer ${opts.key}` } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", fail);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Reads the first `events` server-sent events from the stream, then disconnects. */
function readStream(port: number, path: string, events: number): Promise<Array<{ event: string; data: any }>> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path }, (res) => {
      let buf = "";
      const out: Array<{ event: string; data: any }> = [];
      res.on("data", (c) => {
        buf += c.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = block.match(/^event: (.*)$/m)?.[1];
          const data = block.match(/^data: (.*)$/m)?.[1];
          if (ev && data) out.push({ event: ev, data: JSON.parse(data) });
          if (out.length >= events) {
            req.destroy();
            done(out);
            return;
          }
        }
      });
    });
    req.on("error", (err) => ((err as any).code === "ECONNRESET" ? undefined : fail(err)));
    req.end();
  });
}

async function serve(world: World, extra: Partial<ConstructorParameters<typeof WorldServer>[0]> = {}) {
  const runner = new Runner(world, 1);
  let saves = 0;
  const server = new WorldServer({
    key: KEY,
    save: async () => void saves++,
    backup: async () => "backup.json.gz",
    exportSave: async () => Buffer.from("gz"),
    adopt: async () => ({ worldId: "x", tick: 0 }),
    ...extra,
  });
  const port = await server.listen(0, "127.0.0.1");
  return { server, runner, port, saves: () => saves };
}

test("anyone may watch; the seed and the creator's doors need the key", async () => {
  const world = World.create({ seed: 301 });
  const { server, runner, port } = await serve(world);
  try {
    const waiting = JSON.parse((await call(port, "GET", "/health")).body);
    assert.equal(waiting.state, "waiting", "before a world is attached, the window says it is waiting");
    assert.equal((await call(port, "GET", "/api/status", { key: KEY })).status, 503, "no world yet");
    server.attach(runner);

    const health = JSON.parse((await call(port, "GET", "/health")).body);
    assert.equal(health.state, "running");
    assert.equal(health.tick, world.tick);
    assert.equal((await call(port, "GET", "/status")).status, 200, "the status page is public");
    assert.match((await call(port, "GET", "/")).body, /importmap/, "and the front door is the 3D world");

    const pub = JSON.parse((await call(port, "GET", "/api/status")).body);
    assert.equal(pub.worldId, world.meta.id, "anyone can see the world");
    assert.equal(pub.alive, world.population.count);
    assert.equal(pub.seed, undefined, "but not its seed, which foretells the land and the winters");
    const mine = JSON.parse((await call(port, "GET", "/api/status", { key: KEY })).body);
    assert.equal(mine.seed, world.meta.seed, "the creator sees it");
    assert.equal(JSON.parse((await call(port, "GET", `/api/status?key=${KEY}`)).body).seed, world.meta.seed, "the key also works in the address");
    assert.equal(JSON.parse((await call(port, "GET", "/api/status", { key: "wrong-key-wrong-key" })).body).seed, undefined, "a wrong key is just a watcher");

    for (const door of ["/api/materials", "/api/admin/save"]) {
      assert.equal((await call(port, "GET", door)).status, 401, door);
      assert.equal((await call(port, "GET", door, { key: KEY })).status, 200, door);
    }

    // How materials look is public; what they truly are is not.
    const looks = JSON.parse((await call(port, "GET", "/api/palette")).body).materials;
    assert.ok(looks.length > 5);
    assert.deepEqual(Object.keys(looks[0].looks).sort(), ["energy", "growth", "mass"]);
    assert.ok(!JSON.stringify(looks).includes("nourishment") && !JSON.stringify(looks).includes("reactivity"), "no hidden properties leak");
    const truth = JSON.parse((await call(port, "GET", "/api/palette", { key: KEY })).body).materials;
    assert.ok("nourishment" in truth[0].props, "the creator sees everything");
  } finally {
    await server.close();
  }
});

test("the window shows the AIs, one AI, the chronicle and the reports", async () => {
  const world = World.create({ seed: 302 });
  for (let i = 0; i < 600; i++) world.step();
  const { server, runner, port } = await serve(world);
  server.attach(runner);
  try {
    const ais = JSON.parse((await call(port, "GET", "/api/ais", { key: KEY })).body);
    assert.equal(ais.ais.length, world.population.count);
    const first = world.population.list()[0];
    const row = ais.ais.find((a: any) => a.id === first.id);
    assert.equal(row.label, first.label);
    assert.ok(row.needs.energy >= 0 && row.needs.energy <= 1);

    const one = JSON.parse((await call(port, "GET", `/api/ai/${first.id}`, { key: KEY })).body);
    assert.equal(one.alive, true);
    assert.match(one.detail, new RegExp(first.label));
    assert.equal((await call(port, "GET", "/api/ai/99999", { key: KEY })).status, 404);

    const chron = JSON.parse((await call(port, "GET", "/api/chronicle?since=1", { key: KEY })).body);
    assert.ok(chron.entries.every((e: any) => e.id > 1), "only entries after the one asked for");
    assert.ok(chron.entries[0].when && chron.entries[0].line.includes(chron.entries[0].text));

    for (const report of ["words", "shelters", "items", "materials"]) {
      const r = await call(port, "GET", `/api/${report}`, { key: KEY });
      assert.equal(r.status, 200, report);
      assert.ok(r.body.length > 0, report);
    }
  } finally {
    await server.close();
  }
});

test("the creator's controls: pause, speed, save, backup; bad requests are refused", async () => {
  const world = World.create({ seed: 303 });
  const { server, runner, port, saves } = await serve(world);
  server.attach(runner);
  try {
    const post = (body: unknown) => call(port, "POST", "/api/control", { key: KEY, body: JSON.stringify(body) });
    assert.equal((await post({ action: "pause" })).status, 200);
    assert.equal(runner.speed, 0);
    await post({ action: "resume" });
    assert.equal(runner.speed, 1);
    await post({ action: "speed", speed: 10 });
    assert.equal(runner.speed, 10);
    assert.equal((await post({ action: "speed", speed: 7 })).status, 400, "only the known speeds");
    assert.equal(runner.speed, 10);
    await post({ action: "save" });
    assert.equal(saves(), 1);
    assert.equal(JSON.parse((await post({ action: "backup" })).body).backup, "backup.json.gz");
    assert.equal((await post({ action: "delete-everything" })).status, 400);
    assert.equal((await call(port, "POST", "/api/control", { body: JSON.stringify({ action: "pause" }) })).status, 401, "no key, no control");
    assert.equal(runner.speed, 10);
  } finally {
    await server.close();
  }
});

test("the live stream: a snapshot first, then only what changed", async () => {
  const world = World.create({ seed: 304 });
  const { server, runner, port } = await serve(world);
  server.attach(runner);
  try {
    const pending = readStream(port, `/api/stream`, 2);
    await new Promise((r) => setTimeout(r, 100));
    // Move the world on and let the hub notice.
    for (let i = 0; i < 400; i++) world.step();
    igniteAt(world, 5, 5, 50);
    await new Promise((r) => setTimeout(r, 300));
    server.frame();
    const [snap, changes] = await pending;
    assert.equal(snap.event, "snapshot");
    assert.equal(snap.data.worldId, world.meta.id);
    assert.equal(snap.data.agents.length, world.population.count);
    assert.equal(changes.event, "changes");
    assert.ok(changes.data.agents.length > 0, "someone moved");
    assert.ok(changes.data.fires.lit.some(([x, y]: number[]) => x === 5 && y === 5), "the new fire is reported");
    assert.equal(snap.data.boot.length > 0, true, "the snapshot names this server run");
    assert.ok(snap.data.chunks.length > 0, "and lists the chunks");
  } finally {
    await server.close();
  }
});

test("the stream hub sends nothing when nothing changed, and reports the dead as gone", () => {
  const world = World.create({ seed: 305 });
  const hub = new StreamHub();
  // A fake watcher that just collects what is written.
  const written: string[] = [];
  const res: any = { writeHead() {}, write: (s: string) => written.push(s), on() {}, end() {} };
  hub.add(res, world);
  assert.equal(hub.diff(world), null, "a still world sends nothing");
  const victim = world.population.list()[0];
  world.population.remove(victim.id);
  const changes = hub.diff(world)!;
  assert.deepEqual(changes.gone, [victim.id]);
  assert.ok(written[written.length - 1].startsWith("event: snapshot"));
});

test("moving a world: a save can be adopted only into an empty folder, and arrives intact", async () => {
  const dir = await tempDir();
  try {
    const world = World.create({ seed: 306 });
    for (let i = 0; i < 2000; i++) world.step();
    const source = new Store(join(dir, "pc"));
    const gz = await source.exportSave(world, 1);

    const target = new Store(join(dir, "server"));
    await assert.rejects(target.adopt(Buffer.from("not a save")), /not a compressed world save/);
    const { world: arrived } = await target.adopt(gz);
    const same = (w: World) => JSON.stringify({ ...serializeWorld(w, 1), savedAt: "" });
    assert.equal(same(arrived), same(world), "exactly the same world");
    for (let i = 0; i < 1000; i++) {
      world.step();
      arrived.step();
    }
    assert.equal(JSON.stringify(arrived.population), JSON.stringify(world.population), "and it carries on identically");

    await assert.rejects(target.adopt(gz), /already holds a world/, "a living world is never overwritten");
    const loaded = await target.load();
    assert.equal(loaded?.world.meta.id, world.meta.id, "the adopted world is the one that loads next time");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the adopt endpoint only works while the window is waiting for a world", async () => {
  const world = World.create({ seed: 307 });
  let adopted = 0;
  const { server, runner, port } = await serve(world, { adopt: async () => (adopted++, { worldId: "w", tick: 1 }) });
  try {
    assert.equal((await call(port, "POST", "/api/admin/adopt", { body: "x" })).status, 401);
    assert.equal((await call(port, "POST", "/api/admin/adopt", { key: KEY, body: "x" })).status, 200);
    server.attach(runner);
    assert.equal((await call(port, "POST", "/api/admin/adopt", { key: KEY, body: "x" })).status, 409);
    assert.equal(adopted, 1);
  } finally {
    await server.close();
  }
});

test("one keeper per world: a second process waits until the first lets go", async () => {
  const dir = await tempDir();
  try {
    let clock = 1_000_000;
    const now = () => clock;
    const first = new WorldLock(dir, now);
    await first.acquire();
    const second = new WorldLock(dir, now);
    assert.ok(await second.heldByOther(), "the first keeper's lock is seen");

    let slept = 0;
    const waiting = second.acquire({ pollMs: 1, sleep: async () => void (slept++ === 2 && (await first.release())) });
    await waiting;
    assert.ok(slept >= 3, "it waited");
    assert.equal((await second.read())?.instance, second.instance, "then took over");
    await second.release();

    // A keeper that vanished without letting go (power cut) stops counting once stale.
    const crashed = new WorldLock(dir, now);
    await crashed.acquire();
    const next = new WorldLock(dir, now);
    assert.ok(await next.heldByOther());
    clock += LOCK_STALE_MS + 1;
    assert.equal(await next.heldByOther(), null, "a stale lock is ignored");
    await crashed.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the creator key must be long enough to mean something", () => {
  assert.throws(
    () => new WorldServer({ key: "short", save: async () => {}, backup: async () => "", exportSave: async () => Buffer.alloc(0), adopt: async () => ({ worldId: "", tick: 0 }) }),
    /at least 16/,
  );
});

test("the ground: every known chunk can be seen, packed small, without disturbing the world", async () => {
  // Two identical worlds; one is watched hard, one is not. They must stay identical.
  const watched = World.create({ seed: 310 });
  const quiet = World.create({ seed: 310 });
  for (let i = 0; i < 3000; i++) {
    watched.step();
    quiet.step();
  }
  // Force untouched far chunks out of memory (in both worlds alike) so the viewer must see unloaded ground too.
  const far = (cx: number, cy: number) => Math.abs(cx) > 1 || Math.abs(cy) > 1;
  watched.grid.unloadIdle((cx, cy) => !far(cx, cy));
  quiet.grid.unloadIdle((cx, cy) => !far(cx, cy));
  const unloadedBefore = watched.grid.knownChunkCount - watched.grid.chunkCount;
  const { server, runner, port } = await serve(watched);
  server.attach(runner);
  try {
    const index = JSON.parse((await call(port, "GET", "/api/chunks")).body);
    assert.equal(index.chunks.length, watched.grid.knownChunkCount, "every chunk the world has");
    const loadedBefore = watched.grid.chunkCount;
    const all: Array<[number, number, number]> = index.chunks;
    for (let i = 0; i < all.length; i += 64) {
      const c = all.slice(i, i + 64).map(([x, y]) => `${x},${y}`).join(";");
      const reply = JSON.parse((await call(port, "GET", `/api/chunkdata?c=${c}`)).body);
      assert.equal(reply.missing.length, 0);
      for (const ch of reply.chunks) {
        assert.equal(Buffer.from(ch.height, "base64").length, 32 * 32 * 2, "heights are 2 bytes per tile");
        assert.equal(Buffer.from(ch.terrain, "base64").length, 32 * 32, "the rest 1 byte per tile");
      }
    }
    // Ground that never existed is not invented for watchers.
    const never = JSON.parse((await call(port, "GET", "/api/chunkdata?c=9999,9999")).body);
    assert.deepEqual(never.missing, [[9999, 9999]]);
    assert.equal(watched.grid.chunkCount, loadedBefore, "looking loaded nothing into the world");
    assert.ok(unloadedBefore > 0, `some ground was unloaded and still seen (${unloadedBefore} chunks)`);

    for (let i = 0; i < 2000; i++) {
      watched.step();
      quiet.step();
    }
    // Everything but the two worlds' own names and birth times must match.
    const same = (w: World) => JSON.stringify({ ...serializeWorld(w, 1), savedAt: "", meta: { ...w.meta, id: "", createdAt: "" } });
    assert.ok(same(watched) === same(quiet), "a watched world unfolds exactly like an unwatched one");

    assert.equal((await call(port, "GET", "/api/chunkdata?c=1,2;oops")).status, 400, "malformed lists are refused");
    const tooMany = Array.from({ length: 65 }, (_, i) => `${i},0`).join(";");
    assert.equal((await call(port, "GET", `/api/chunkdata?c=${tooMany}`)).status, 400, "and so are greedy ones");
  } finally {
    await server.close();
  }
});

test("building something tells watchers which chunk to fetch again", async () => {
  const world = World.create({ seed: 311 });
  const hub = new StreamHub(() => 0, "boot-1");
  const res: any = { writeHead() {}, write() {}, on() {}, end() {} };
  hub.add(res, world);
  assert.equal(hub.diff(world), null);
  const before = world.grid.getChunk(0, 0).revision;
  world.grid.set("wall", 3, 4, 4);
  world.grid.set("wallHp", 3, 4, 1000);
  const changes = hub.diff(world)!;
  assert.ok(changes.chunks?.some(([cx, cy, rev]) => cx === 0 && cy === 0 && rev > before), "the built-on chunk is named");
  // Footsteps and amounts change all the time; they are not news.
  world.grid.set("wear", 5, 5, 9);
  world.grid.set("amount", 6, 6, 3);
  assert.equal(hub.diff(world)?.chunks, undefined, "quiet changes do not trigger refetches");
});

test("the window turns away watchers beyond its limit, but never the creator", async () => {
  const world = World.create({ seed: 312 });
  const { server, runner, port } = await serve(world, { maxWatchers: 1 });
  server.attach(runner);
  const open: any[] = [];
  const connect = (path: string) =>
    new Promise<number>((done) => {
      const req = request({ host: "127.0.0.1", port, path }, (res) => {
        done(res.statusCode ?? 0);
        if (res.statusCode !== 200) res.resume();
      });
      open.push(req);
      req.on("error", () => {});
      req.end();
    });
  try {
    assert.equal(await connect("/api/stream"), 200, "the first watcher is welcome");
    assert.equal(await connect("/api/stream"), 503, "the second must wait");
    assert.equal(await connect(`/api/stream?key=${KEY}`), 200, "the creator always gets in");
  } finally {
    for (const r of open) r.destroy();
    await server.close();
  }
});

test("one visitor cannot flood the window", async () => {
  const world = World.create({ seed: 313 });
  const { server, runner, port } = await serve(world, { rate: { perSecond: 1, burst: 3 } });
  server.attach(runner);
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await call(port, "GET", "/api/status")).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    assert.equal((await call(port, "GET", "/api/status", { key: KEY })).status, 200, "the creator is never slowed");
    assert.equal((await call(port, "GET", "/health")).status, 200, "the health check is never slowed");
  } finally {
    await server.close();
  }
});

test("chunk lists are read strictly", () => {
  assert.deepEqual(parseChunkList("0,0;-3,12"), [[0, 0], [-3, 12]]);
  assert.deepEqual(parseChunkList(""), []);
  assert.equal(parseChunkList("1,2,3"), null);
  assert.equal(parseChunkList("a,b"), null);
});

test("the viewer's files are served, and only them", async () => {
  const world = World.create({ seed: 314 });
  const { server, runner, port } = await serve(world);
  server.attach(runner);
  try {
    const page = await call(port, "GET", "/view");
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-type"]), /text\/html/);
    assert.match(page.body, /importmap/);
    assert.match(String(page.headers["content-security-policy"]), /cdn\.jsdelivr\.net/, "Three.js may come from its pinned CDN");
    assert.match(page.body, /three@\d+\.\d+\.\d+/, "and its version is pinned");
    for (const f of ["main.js", "terrain.js", "api.js", "sky.js", "quality.js", "figures.js", "ui.js", "atmosphere.js", "creator.js", "viewer.css"]) {
      const r = await call(port, "GET", `/viewer/${f}`);
      assert.equal(r.status, 200, f);
    }
    assert.match(String((await call(port, "GET", "/viewer/main.js")).headers["content-type"]), /javascript/);
    for (const bad of ["/viewer/../server/http.ts", "/viewer/%2e%2e%2fhttp.ts", "/viewer/.env", "/viewer/nope.js", "/viewer/"]) {
      assert.equal((await call(port, "GET", bad)).status, 404, bad);
    }
  } finally {
    await server.close();
  }
});

test("the creator's view: hidden truths behind the key, and only reading", async () => {
  const world = World.create({ seed: 315 });
  for (let i = 0; i < 2 * 86400; i++) world.step();
  const [a, b] = world.population.list();
  a.bonds[b.id] = { trust: 0.6, affection: 0.7, lastNear: world.tick };
  b.bonds[a.id] = { trust: 0.5, affection: 0.6, lastNear: world.tick };
  a.grudges[b.id] = 0.4;
  const before = JSON.stringify({ ...serializeWorld(world, 1), savedAt: "" });
  const { server, runner, port } = await serve(world);
  server.attach(runner);
  try {
    for (const what of ["overview", "web", "families", "words", "history", `ai/${a.id}`]) {
      assert.equal((await call(port, "GET", `/api/creator/${what}`)).status, 401, `${what} needs the key`);
    }
    const get = async (what: string) => JSON.parse((await call(port, "GET", `/api/creator/${what}`, { key: KEY })).body);
    const o = await get("overview");
    assert.equal(o.seed, world.meta.seed);
    assert.equal(o.winters.length, 6, "the winters to come, foretold");
    assert.ok("nourishment" in o.materials[0].props);
    const webData = await get("web");
    assert.ok(webData.edges.some((e: any) => e.a === Math.min(a.id, b.id) && e.b === Math.max(a.id, b.id) && e.affection === 0.65));
    assert.ok(webData.grudges.some((g: any) => g.from === a.id && g.to === b.id));
    const fam = await get("families");
    assert.equal(fam.people.filter((p: any) => p.alive).length, world.population.count);
    const words = await get("words");
    assert.equal(words.living, world.population.count);
    const hist = await get("history");
    assert.equal(hist.days.length, world.history.length);
    const hidden = await get(`ai/${a.id}`);
    assert.ok("courage" in hidden.personality && hidden.daysLeft > 0);
    assert.equal((await call(port, "GET", "/api/creator/ai/99999", { key: KEY })).status, 404);
    assert.equal(JSON.stringify({ ...serializeWorld(world, 1), savedAt: "" }), before, "looking changed nothing");
  } finally {
    await server.close();
  }
});

test("the creator's desk over the wire: preview, act, undo; never without the key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "world-zero-deskhttp-"));
  const world = World.create({ seed: 316 });
  const runner = new Runner(world, 1);
  const store = new Store(dir);
  await store.ensureDirs();
  const desk = new Desk({
    store,
    world: () => runner.world,
    speed: () => runner.speed,
    replaceWorld: (w) => {
      runner.setWorld(w);
      server.hub.resync(w);
    },
    save: () => store.save(runner.world, runner.speed),
  });
  const server = new WorldServer({
    key: KEY, desk,
    save: async () => {}, backup: async () => "", exportSave: async () => Buffer.alloc(0), adopt: async () => ({ worldId: "", tick: 0 }),
  });
  const port = await server.listen(0, "127.0.0.1");
  server.attach(runner);
  try {
    const a = world.population.list()[0];
    a.health = 0.25;
    const post = (path: string, body: unknown, key?: string) => call(port, "POST", path, { key, body: JSON.stringify(body) });
    assert.equal((await post("/api/creator/act", { kind: "heal", params: { id: a.id }, confirm: true })).status, 401, "no key, no act");
    assert.equal(a.health, 0.25);
    const preview = JSON.parse((await post("/api/creator/act", { kind: "heal", params: { id: a.id } }, KEY)).body).preview;
    assert.equal(preview.title, "Heal");
    assert.equal(a.health, 0.25, "a preview changes nothing");
    const done = JSON.parse((await post("/api/creator/act", { kind: "heal", params: { id: a.id }, confirm: true }, KEY)).body);
    assert.equal(done.ok, true);
    assert.equal(runner.world.population.get(a.id)!.health, 1);
    const log = JSON.parse((await call(port, "GET", "/api/creator/log", { key: KEY })).body).entries;
    assert.equal(log[0].kind, "heal");
    assert.ok(log[0].undoableFor > 0);
    assert.equal((await call(port, "GET", "/api/creator/log")).status, 401);
    const bootBefore = server.hub.boot;
    const undone = JSON.parse((await post("/api/creator/undo", { id: done.entry.id, confirm: true }, KEY)).body);
    assert.equal(undone.ok, true);
    assert.equal(runner.world.population.get(a.id)!.health, 0.25, "put back as it was");
    assert.notEqual(server.hub.boot, bootBefore, "watchers are told to start over");
    assert.equal((await post("/api/creator/act", { kind: "smite", params: {} }, KEY)).status, 400);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
