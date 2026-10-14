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
import { WorldServer } from "../src/server/http.ts";
import { StreamHub } from "../src/server/stream.ts";
import { igniteAt } from "../src/world/fire.ts";

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

test("the window: health is public, everything else needs the creator key", async () => {
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
    assert.equal((await call(port, "GET", "/")).status, 200, "the status page itself is public (it asks for the key)");
    assert.equal((await call(port, "GET", "/api/status")).status, 401, "no key, no view");
    assert.equal((await call(port, "GET", "/api/status", { key: "wrong-key-wrong-key" })).status, 401, "wrong key, no view");
    assert.equal((await call(port, "GET", `/api/status?key=${KEY}`)).status, 200, "the key also works in the address (for the stream)");

    const status = JSON.parse((await call(port, "GET", "/api/status", { key: KEY })).body);
    assert.equal(status.worldId, world.meta.id);
    assert.equal(status.alive, world.population.count);
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
    const pending = readStream(port, `/api/stream?key=${KEY}`, 2);
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
    assert.equal((await call(port, "GET", "/api/stream")).status, 401, "the stream needs the key too");
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
