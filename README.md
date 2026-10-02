# world-zero

A persistent 3D world where 20 identical AIs start on an empty grid and build a city on their own.

Nothing is scripted: needs, emotions, personalities, specializations, crafting, language, relationships, and the city itself all emerge from their behavior. The project has no real name yet; it will take whatever name the AIs give their world.

The full design is in [docs/design.md](docs/design.md).

## Running it

Requires Node.js 22.18 or newer (TypeScript runs directly, no build step, no dependencies).

```
node src/main.ts                run the world (creates it on first start)
node src/main.ts --speed 10     run at 10x
node src/main.ts --data <dir>   use a different data folder, e.g. for experiments
node --test "test/**/*.test.ts" run the tests
```

While it runs, type a command and press Enter:

| Command | What it does |
| --- | --- |
| `status` | Current date, time, light, speed |
| `pause` / `resume` | Stop or restart time |
| `speed <n>` | 1, 2, 5, 10, 25, 50 or 100 |
| `save` | Save now (it also autosaves every minute) |
| `backup` | Write a backup snapshot (also every hour) |
| `chronicle [n]` | Last n important events |
| `quit` | Save and stop (Ctrl+C does the same) |

The world lives in `data/` (not in git). There is only ever one world: it is never restarted unless the whole population dies out.

## Build order

1. **Simulation core: grid, time, save/load** ✅
2. AI agents: needs, movement, death
3. Materials: properties, placement, abundance
4. Crafting and building
5. Learning: specialization, personality, teaching, emergent language
6. Server deployment (24/7)
7. 3D viewer, speed controls, AI inspector, chronicle
8. Creator panel

## Layout

```
src/core/      time, calendar, randomness, world, runner, chronicle, events
src/world/     endless chunked grid and world generation
src/persist/   saving, loading, backups
src/main.ts    entry point
test/          tests
```
