# world-zero

A persistent 3D world where 50 identical AIs start on an empty grid and build a city on their own.

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
| `status` | Current date, time, light, speed, population |
| `ais` | Every living AI, one line each |
| `ai <id>` | Everything about one AI, e.g. `ai 7`: needs, what it carries, what it has learned |
| `materials` | Every kind of material and its true properties |
| `shelters` | Everything built, and where each AI sleeps |
| `items` | Every made thing, held or lying in the world |
| `pause` / `resume` | Stop or restart time |
| `speed <n>` | 1, 2, 5, 10, 25, 50 or 100 |
| `save` | Save now (it also autosaves every minute) |
| `backup` | Write a backup snapshot (also every hour) |
| `chronicle [n]` | Last n important events |
| `quit` | Save and stop (Ctrl+C does the same) |

The world lives in `data/` (not in git). There is only ever one world: it is never restarted unless the whole population dies out. If that happens, the ended world is kept forever in `data/archive/` and a new one begins.

Important events (deaths, firsts, milestones) are printed as they happen, marked with ✦.

## Build order

1. **Simulation core: grid, time, save/load** ✅
2. **AI agents: needs, movement, death** ✅
3. **Materials: properties, placement, abundance** ✅
4. Crafting and building
   - 4a. **Placing material and shelter** ✅ (walls, roofs, the nesting instinct, sleeping where it's warmest)
   - 4b. Combining, tools, fire and usefulness
     - **Items, tinkering, bind + shape, tools that matter** ✅
     - **Mix: paste and bricks** ✅
     - **Fire: dangerous from day one** ✅
     - **Cooking and medicine** ✅
5. Society and learning
   - 5a. **Bonds, pairs, births, children** ✅
   - 5b. Emotions
   - 5c. Personality
   - 5d. Skill and teaching
   - 5e. Emergent language
   - 5f. Conflict
6. Server deployment (24/7)
7. 3D viewer, speed controls, AI inspector, chronicle
8. Creator panel

## Layout

```
src/core/      time, calendar, randomness, world, runner, chronicle, events
src/agents/    the AIs: bodies and needs, decisions, actions, foraging, building, pathfinding, population
src/materials/ material properties, placement in the world, regrowth
src/building/  structures: walls, roofs, shelter, weathering
src/items/     made things: the hidden crafting rules, wear, items on the ground
src/world/     endless chunked grid, world generation, grid upkeep
src/persist/   saving, loading, backups
src/inspect.ts text descriptions of AIs
src/main.ts    entry point
test/          tests
```
