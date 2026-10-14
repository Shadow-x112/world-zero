// Entry point: loads (or creates) the world and runs it until stopped.
//
//   node src/main.ts                 run the world in ./data
//   node src/main.ts --speed 10      run at 10x
//   node src/main.ts --data <dir>    use a different data folder (e.g. for testing)
//   node src/main.ts --seed 1234     seed for a brand-new world (ignored if one exists)
//   node src/main.ts --port 8080     also open the world's window (web server) on this port
//
// Server settings can also come from the environment (as on Railway):
//   PORT            open the window on this port
//   HOST            address to listen on (default 0.0.0.0 on Railway, else 127.0.0.1)
//   DATA_DIR        data folder (same as --data)
//   CREATOR_KEY     the key for the window (else one is made and kept in <data>/creator-key.txt)
//   WAIT_FOR_WORLD  "1": if the data folder is empty, do not create a world; wait for one
//                   to be brought here through the window (moving a world between machines)
//
// While running, type a command and press Enter (type "help" for the list).

import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

import { Chronicle } from "./core/chronicle.ts";
import { SPEEDS } from "./core/constants.ts";
import { Runner, isSpeed, type Speed } from "./core/runner.ts";
import { World } from "./core/world.ts";
import { agentDetail, agentLine, itemsReport, materialsTable, sheltersReport } from "./inspect.ts";
import { Store } from "./persist/store.ts";
import { WorldLock } from "./persist/lock.ts";
import { lexiconReport } from "./agents/language.ts";
import { statusLine } from "./status.ts";
import { WorldServer } from "./server/http.ts";

const AUTOSAVE_SECONDS = 60;
const BACKUP_SECONDS = 60 * 60;
const STATUS_SECONDS = 60;

const HELP = `Commands:
  status            date, time, light, speed, population
  ais               every living AI, one line each
  ai <id>           everything about one AI (e.g. "ai 7")
  materials         every kind of material and its true properties
  shelters          everything built, and where each AI sleeps
  items             every made thing, held or lying in the world
  words             the village tongue: every word, its meaning and its speakers
  chronicle [n]     the last n important events (default 10)
  pause / resume    stop or restart time
  speed <n>         ${SPEEDS.filter((s) => s > 0).join(", ")}
  save              save now (also automatic every minute)
  backup            write a backup snapshot (also automatic every hour)
  quit              save and stop (Ctrl+C does the same)`;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[arg.slice(2)] = next;
        i++;
      } else out[arg.slice(2)] = "true";
    }
  }
  return out;
}

const log = (line: string) => console.log(line);

/** The creator key: from the environment, or made once and kept in the data folder. */
async function creatorKey(dataDir: string): Promise<string> {
  const fromEnv = process.env.CREATOR_KEY?.trim();
  if (fromEnv) return fromEnv;
  const path = join(dataDir, "creator-key.txt");
  if (existsSync(path)) return (await readFile(path, "utf8")).trim();
  const key = randomBytes(24).toString("base64url");
  await writeFile(path, key + "\n", { mode: 0o600 });
  log(`A creator key was made and kept in ${path}`);
  return key;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const dataDir = resolve(args.data ?? env.DATA_DIR ?? "data");
  const portSetting = args.port ?? env.PORT;
  const host = args.host ?? env.HOST ?? (env.RAILWAY_ENVIRONMENT ? "0.0.0.0" : "127.0.0.1");
  const waitForWorld = args["wait-for-world"] === "true" || env.WAIT_FOR_WORLD === "1";
  const store = new Store(dataDir);
  await store.ensureDirs();

  // The window opens first, so the host can see the process is alive even while it waits.
  let server: WorldServer | null = null;
  let acceptingAdoption = false;
  let adopted: ((r: { world: World; speed: number }) => void) | null = null;
  const adoption = new Promise<{ world: World; speed: number }>((r) => (adopted = r));
  // Filled in once the world runs (the window's controls need them).
  let saveNow: () => Promise<void> = async () => {};
  let backupNow: () => Promise<string> = async () => "";
  let exportNow: () => Promise<Buffer> = async () => Buffer.alloc(0);
  if (portSetting !== undefined) {
    server = new WorldServer({
      key: await creatorKey(dataDir),
      save: () => saveNow(),
      backup: () => backupNow(),
      exportSave: () => exportNow(),
      adopt: async (gz) => {
        if (!acceptingAdoption) throw new Error("Not waiting for a world");
        const result = await store.adopt(gz);
        acceptingAdoption = false;
        adopted!(result);
        return { worldId: result.world.meta.id, tick: result.world.tick };
      },
      log,
    });
    const port = await server.listen(Number(portSetting), host);
    log(`The world's window is open on http://${host}:${port}`);
  }

  // One keeper per world: wait if another process still holds this folder.
  const lock = new WorldLock(dataDir);
  // Until the world runs there is nothing to save: just let go and leave.
  const earlyExit = () => {
    void Promise.all([server?.close(), lock.release()]).finally(() => process.exit());
  };
  process.on("SIGINT", earlyExit);
  process.on("SIGTERM", earlyExit);
  await lock.acquire({ log });

  let world: World;
  let speed: Speed = 1;
  const loaded = await store.load();
  if (loaded) {
    world = loaded.world;
    if (isSpeed(loaded.speed)) speed = loaded.speed;
    log(`Loaded world ${world.meta.id} from ${loaded.source}`);
  } else if (waitForWorld) {
    if (!server) throw new Error("WAIT_FOR_WORLD needs the window open (set PORT or --port)");
    acceptingAdoption = true;
    log("No world here yet. Waiting for one to be brought here (POST /api/admin/adopt)...");
    const r = await adoption;
    world = r.world;
    if (isSpeed(r.speed)) speed = r.speed;
    log(`World ${world.meta.id} has arrived (generation ${world.meta.generation}, tick ${world.tick}).`);
  } else {
    const seed = args.seed !== undefined ? Number(args.seed) : undefined;
    world = World.create({ seed });
    log(`Created new world ${world.meta.id} (seed ${world.meta.seed})`);
  }
  if (args.speed !== undefined) {
    const requested = Number(args.speed);
    if (!isSpeed(requested)) throw new Error(`--speed must be one of ${SPEEDS.join(", ")}`);
    speed = requested;
  }

  let lastSave = Date.now();
  let lastBackup = 0;
  let lastStatus = Date.now();
  let busy = false;
  let printedChronicle = world.chronicle.size;

  saveNow = () => doSave("creator");
  backupNow = () => doBackup();
  exportNow = () => store.exportSave(runner.world, runner.speed);

  const doSave = async (label: string) => {
    await store.save(runner.world, runner.speed);
    if (label) console.log(`Saved (${label}).`);
  };
  const doBackup = async () => {
    const path = await store.backup(runner.world, runner.speed);
    console.log(`Backup written: ${path}`);
    return path;
  };

  /** When everyone has died: keep the old world forever, then begin a new one. */
  const handleExtinction = async () => {
    busy = true;
    runner.stop();
    const ended = runner.world;
    try {
      const path = await store.archive(ended, runner.speed);
      console.log(`World ${ended.meta.generation} has ended. Archived at ${path}`);
      const next = World.create({ generation: ended.meta.generation + 1 });
      runner.setWorld(next);
      printedChronicle = 0;
      await store.save(next, runner.speed);
      console.log(`World ${next.meta.generation} begins (seed ${next.meta.seed}).`);
    } finally {
      busy = false;
      runner.start();
    }
  };

  const runner = new Runner(world, speed, {
    onFrame: (r) => {
      server?.frame();
      const now = Date.now();
      const w = r.world;

      // Echo new chronicle entries as they happen.
      const entries = w.chronicle.all();
      for (; printedChronicle < entries.length; printedChronicle++) {
        console.log(`  ✦ ${Chronicle.describe(entries[printedChronicle])}`);
      }

      if (w.extinctTick !== null && !busy) {
        handleExtinction().catch((err) => console.error("Could not start a new world:", err));
        return;
      }
      if (!busy && now - lastSave >= AUTOSAVE_SECONDS * 1000) {
        busy = true;
        lastSave = now;
        doSave("")
          .catch((err) => console.error("Autosave failed:", err))
          .finally(() => (busy = false));
      } else if (!busy && now - lastBackup >= BACKUP_SECONDS * 1000) {
        busy = true;
        lastBackup = now;
        doBackup()
          .catch((err) => console.error("Backup failed:", err))
          .finally(() => (busy = false));
      }
      if (now - lastStatus >= STATUS_SECONDS * 1000) {
        lastStatus = now;
        console.log(statusLine(r));
      }
    },
  });

  await doSave("");
  console.log(statusLine(runner));
  console.log('Running. Type "help" for commands.');
  runner.start();
  server?.attach(runner);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    runner.stop();
    console.log("Stopping and saving...");
    try {
      await doSave("shutdown");
    } catch (err) {
      console.error("Final save failed:", err);
      process.exitCode = 1;
    }
    await server?.close().catch(() => {});
    await lock.release().catch(() => {});
    process.exit();
  };
  process.off("SIGINT", earlyExit);
  process.off("SIGTERM", earlyExit);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const [cmd, arg] = line.trim().split(/\s+/);
    const w = runner.world;
    try {
      switch (cmd?.toLowerCase()) {
        case "":
        case undefined:
          break;
        case "help":
          console.log(HELP);
          break;
        case "status":
          console.log(statusLine(runner));
          break;
        case "ais":
          if (w.population.count === 0) console.log("No one is alive.");
          for (const agent of w.population.list()) console.log(agentLine(agent, w));
          break;
        case "ai": {
          const id = Number(String(arg ?? "").replace("#", ""));
          const agent = w.population.get(id);
          if (agent) console.log(agentDetail(agent, w));
          else {
            const body = w.population.bodies.find((b) => b.agentId === id);
            console.log(body ? `#${String(id).padStart(2, "0")} died of ${body.cause} at ${Math.floor(body.ageDays)} days.` : `No AI #${arg}.`);
          }
          break;
        }
        case "materials":
          console.log(materialsTable(w));
          break;
        case "shelters":
          console.log(sheltersReport(w));
          break;
        case "items":
          console.log(itemsReport(w));
          break;
        case "words":
          console.log(lexiconReport(w));
          break;
        case "pause":
          runner.setSpeed(0);
          console.log("Paused.");
          break;
        case "resume":
          if (runner.speed === 0) runner.setSpeed(1);
          console.log(`Running at ${runner.speed}x.`);
          break;
        case "speed":
          runner.setSpeed(Number(arg));
          console.log(runner.speed === 0 ? "Paused." : `Speed set to ${runner.speed}x.`);
          break;
        case "save":
          await doSave("manual");
          break;
        case "backup":
          await doBackup();
          break;
        case "chronicle": {
          const count = arg ? Number(arg) : 10;
          for (const entry of w.chronicle.recent(count)) console.log(Chronicle.describe(entry));
          break;
        }
        case "quit":
        case "exit":
          await shutdown();
          break;
        default:
          console.log(`Unknown command "${cmd}". Type "help".`);
      }
    } catch (err) {
      console.log((err as Error).message);
    }
  });
  rl.on("close", () => {
    // stdin closed (e.g. running under a service manager): keep running, no commands.
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
