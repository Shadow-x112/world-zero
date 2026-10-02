// Entry point: loads (or creates) the world and runs it until stopped.
//
//   node src/main.ts                 run the world in ./data
//   node src/main.ts --speed 10      run at 10x
//   node src/main.ts --data <dir>    use a different data folder (e.g. for testing)
//   node src/main.ts --seed 1234     seed for a brand-new world (ignored if one exists)
//
// While running, type a command and press Enter: help, status, pause, resume,
// speed <n>, save, backup, chronicle [n], quit.

import { createInterface } from "node:readline";
import { resolve } from "node:path";

import { Chronicle } from "./core/chronicle.ts";
import { SPEEDS } from "./core/constants.ts";
import { Runner, isSpeed, type Speed } from "./core/runner.ts";
import { formatCalendar } from "./core/time.ts";
import { World } from "./core/world.ts";
import { Store } from "./persist/store.ts";

const AUTOSAVE_SECONDS = 60;
const BACKUP_SECONDS = 60 * 60;
const STATUS_SECONDS = 60;

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

function status(runner: Runner): string {
  const w = runner.world;
  const c = w.calendar;
  const speed = runner.speed === 0 ? "paused" : `${runner.speed}x`;
  const parts = [
    formatCalendar(c),
    `light ${Math.round(c.light * 100)}%`,
    `speed ${speed}`,
    `tick ${w.tick}`,
    `${w.grid.chunkCount} chunks`,
  ];
  if (runner.measuredTps > 0) parts.push(`${runner.measuredTps.toFixed(1)} ticks/s`);
  if (runner.lagging || runner.droppedTicks > 0) parts.push(`LAGGING (${runner.droppedTicks} ticks dropped)`);
  return parts.join(" · ");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = new Store(resolve(args.data ?? "data"));
  await store.ensureDirs();

  let world: World;
  let speed: Speed = 1;
  const loaded = await store.load();
  if (loaded) {
    world = loaded.world;
    if (isSpeed(loaded.speed)) speed = loaded.speed;
    console.log(`Loaded world ${world.meta.id} from ${loaded.source}`);
  } else {
    const seed = args.seed !== undefined ? Number(args.seed) : undefined;
    world = World.create({ seed });
    console.log(`Created new world ${world.meta.id} (seed ${world.meta.seed})`);
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

  const doSave = async (label: string) => {
    await store.save(world, runner.speed);
    if (label) console.log(`Saved (${label}).`);
  };
  const doBackup = async () => {
    const path = await store.backup(world, runner.speed);
    console.log(`Backup written: ${path}`);
  };

  const runner = new Runner(world, speed, {
    onFrame: (r) => {
      const now = Date.now();
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
        console.log(status(r));
      }
    },
  });

  await doSave("");
  console.log(status(runner));
  console.log('Running. Type "help" for commands.');
  runner.start();

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
    process.exit();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const [cmd, arg] = line.trim().split(/\s+/);
    try {
      switch (cmd?.toLowerCase()) {
        case "":
        case undefined:
          break;
        case "help":
          console.log("Commands: status, pause, resume, speed <" + SPEEDS.filter((s) => s > 0).join("|") + ">, save, backup, chronicle [n], quit");
          break;
        case "status":
          console.log(status(runner));
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
          for (const entry of world.chronicle.recent(count)) console.log(Chronicle.describe(entry));
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
