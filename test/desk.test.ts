import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { World } from "../src/core/world.ts";
import { Store, serializeWorld } from "../src/persist/store.ts";
import { Desk, UNDO_WINDOW_MS, ActError } from "../src/creator/desk.ts";
import { ACTS } from "../src/creator/acts.ts";

async function setup(seed: number) {
  const dir = await mkdtemp(join(tmpdir(), "world-zero-desk-"));
  const store = new Store(dir);
  await store.ensureDirs();
  const holder = { world: World.create({ seed }), speed: 1 };
  for (let i = 0; i < 2000; i++) holder.world.step();
  let clock = 1_000_000;
  const desk = new Desk({
    store,
    world: () => holder.world,
    speed: () => holder.speed,
    replaceWorld: (w, s) => {
      holder.world = w;
      holder.speed = s;
    },
    save: () => store.save(holder.world, holder.speed),
    now: () => clock,
  });
  await desk.load();
  return { dir, store, holder, desk, tick: (ms: number) => (clock += ms) };
}

const plain = (w: World) => JSON.stringify({ ...serializeWorld(w, 1), savedAt: "" });

test("a preview says what an act will do and changes nothing", async () => {
  const { dir, holder, desk } = await setup(501);
  try {
    const a = holder.world.population.list()[0];
    a.health = 0.4;
    const before = plain(holder.world);
    const p = desk.preview("heal", { id: a.id });
    assert.equal(p.title, "Heal");
    assert.ok(p.lines.length > 0 && p.lines[0].includes(a.label));
    assert.equal(plain(holder.world), before, "nothing happened");
    assert.throws(() => desk.preview("heal", { id: 99999 }), /No living AI/);
    assert.throws(() => desk.preview("smite", {}), /No such act/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an act is snapshotted, applied, saved and logged (privately, outside the world)", async () => {
  const { dir, store, holder, desk } = await setup(502);
  try {
    const a = holder.world.population.list()[0];
    a.health = 0.3;
    a.toxin = 0.5;
    const entry = await desk.perform("heal", { id: a.id });
    assert.equal(a.health, 1);
    assert.equal(a.toxin, 0);
    assert.match(entry.summary, /Healed/);
    assert.ok(entry.snapshot && entry.snapshot.includes("acts"), "a snapshot was kept");
    const saved = await store.load();
    assert.equal(saved!.world.population.get(a.id)!.health, 1, "saved at once");
    const log = await readFile(join(dir, "creator-log.jsonl"), "utf8");
    assert.match(log, /"kind":"heal"/);
    assert.ok(!holder.world.chronicle.all().some((e) => /heal/i.test(e.text)), "healing leaves no trace in the public chronicle");
    // The log survives a restart.
    const again = new Desk({ store, world: () => holder.world, speed: () => 1, replaceWorld: () => {}, save: async () => {} });
    await again.load();
    assert.equal(again.log()[0].id, entry.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("undo puts back the moment before the last act, once, and only for a while", async () => {
  const { dir, holder, desk, tick } = await setup(503);
  try {
    const [a, b] = holder.world.population.list();
    a.health = 0.5;
    const tickBefore = holder.world.tick;
    const first = await desk.perform("heal", { id: a.id });
    b.health = 0.6;
    const second = await desk.perform("heal", { id: b.id });
    for (let i = 0; i < 300; i++) holder.world.step();
    assert.throws(() => desk.undoPreview(first.id), /most recent/, "only the last act");
    const cost = desk.undoPreview(second.id);
    assert.equal(cost.lostMinutes, 5, "the creator is told how much world time is lost");
    await desk.undo(second.id);
    assert.equal(holder.world.population.get(b.id)!.health, 0.6, "back as it was");
    assert.equal(holder.world.population.get(a.id)!.health, 1, "the earlier act stands");
    assert.ok(holder.world.tick >= tickBefore);
    await assert.rejects(desk.undo(second.id), /most recent|undone/, "an undo cannot be undone twice");
    await assert.rejects(desk.undo(first.id), ActError, "and undo is one step only");
    // A new act, then too late to undo.
    const third = await desk.perform("heal", { id: a.id });
    tick(UNDO_WINDOW_MS + 1);
    assert.throws(() => desk.undoPreview(third.id), /Too late/);
    const log = desk.log();
    assert.equal(log[0].id, third.id);
    assert.ok(log.some((e) => e.kind === "undo" && e.undid === second.id));
    assert.ok(log.some((e) => e.id === second.id && e.undone));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an act's visible effect is told in nature's voice; the act itself never is", async () => {
  const { dir, holder, desk } = await setup(504);
  ACTS.__test = {
    title: "Test",
    grave: true,
    check: () => null,
    describe: () => ["A test."],
    apply: () => ({ summary: "Tested.", nature: "A strange stillness fell over the land." }),
  };
  try {
    const entry = await desk.perform("__test", {});
    const told = holder.world.chronicle.all().at(-1)!;
    assert.equal(told.kind, "nature");
    assert.equal(told.text, "A strange stillness fell over the land.");
    assert.ok(!/creator/i.test(told.text));
    assert.equal(entry.grave, true);
  } finally {
    delete ACTS.__test;
    await rm(dir, { recursive: true, force: true });
  }
});
