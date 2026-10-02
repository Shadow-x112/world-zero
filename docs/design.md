# world-zero design

Decisions made while planning, before any agent code exists. Later steps build on these.

## The world

- One persistent world. It is never re-run; it resets only if the entire population dies out (each reset increases `generation`).
- An endless 3D grid, generated in chunks only where something goes.
- The start is a perfectly flat, empty plain with no era or time period. Further out, the land grows gradually wilder: elevation, water, and barrier ridges.
- The ground is flat-tiled, but structures can be built upward.
- One tile is roughly the size of one AI standing.

## Time

- 1 tick = 1 world second. At 1x, a world day lasts 6 real hours (4 world days per real day).
- Day and night, with soft dawn and dusk.
- 4 seasons of 10 world days each; a world year is 40 days (10 real days at 1x).
  - Growth: plenty, fast regrowth. Daylight 12h.
  - Peak: longest days, most abundance. Daylight 15h.
  - Decline: growth slows, days shorten. Daylight 12h.
  - Cold: long nights, little growth, needs drain faster. Daylight 8h.
- Speed control: pause, 1x, 2x, 5x, 10x, 25x, 50x, 100x.

## The AIs

- 20 identical AIs at the start, standing together in the middle of the plain.
- Look: a minimal humanoid body with simple limbs and a glowing core in the chest.
  - All identical and one neutral color at first.
  - Core glow dims as energy drops; core pulses or shifts with emotion; posture shows emotion.
  - Color slowly drifts as personality forms; crafted items they carry show specialization; size reflects age.
- Needs: energy (eat), rest (better when sheltered), social (mild), curiosity.
- Emotions (fast, temporary, event-triggered, fade over time): joy, fear, anger, sadness, contentment, loneliness, wonder. They influence decisions, can spread between nearby AIs, and repeated emotions slowly harden into personality.
- Personality (slow, lifelong): starts blank, shaped by experience.
- Specialization: whatever an AI does most, it gets better at.
- Decisions: utility AI (scored options), running free on the server. An optional local-model layer (Ollama on the home PC) may be added later for rare, meaningful moments.
- Lifespan: about 180 world days on average (about 1.5 real months), varying with health.

## Language

- Emergent. No words at the start; signals that lead to success strengthen and spread through social contact.
- Separated groups drift into dialects; contact can merge or borrow words.
- Words grow from needs and materials to actions, places, items, names, and feelings.
- The world's own name comes from whatever the AIs call it.

## Materials and crafting

- No traditional resources. Materials are abstract and defined only by properties:
  hardness, sharpness, flexibility, mass, energy, nourishment, growth, reactivity.
- Their 3D form and color reflect their properties.
- Abundance is realistic: nourishing and flexible materials are common, hard and sharp ones moderately common, high-energy and reactive ones rare.
- Crafting is property-based: combining items blends and transforms their properties; AIs judge results by usefulness.
- Knowledge is taught, never inherited. Undiscovered and untaught knowledge dies with its holder.

## Society

- Cooperation: share, help, teach, trade.
- Conflict: take, refuse, drive off, fight. Fights can be lethal.
- Natural dampeners: fighting risks injury even to the winner, fear discourages it, and early equality leaves little to gain.
- Injuries are lasting: slower movement and work, more rest needed; others can care for the injured. Severe untreated injuries can kill.
- Relationships (trust, affection), reputation (spread by observation), emergent ownership (norms, not rules), and groups.

## Death

- Causes: starvation, exhaustion, injury, exposure, old age.
- The core fades out; the body remains for a few world days and others can gather near it, move it, or place materials on it.
- Belongings drop where the AI fell. Its structures remain.
- Grief scaled by closeness; anger toward a killer.
- No automatic markers: graves or memorials exist only if the AIs build them.

## Population growth

- Bonding pairs: two mature AIs with very high mutual trust and affection, in good conditions (fed, rested, sheltered, rarely in the cold season), can bring a new AI into being. Spacing between arrivals; bonds can break.
- Maturity at roughly the first quarter of life.
- A new AI starts small and blank, inherits a slight blend of the pair's personality leanings plus randomness, and learns everything else from those around it.

## Chronicle

- Records important events only: world creation, first shelter, deaths, discoveries, first shared word, population milestones, and similar.

## Creator panel (private, invisible to the AIs)

- World shaping: add materials, add features (elevation, water, barriers), adjust abundance.
- Events: harsh seasons, droughts, blooms, rare disasters.
- People: add newcomers from the edges; influence or remove an individual.
- Observation: follow any AI, relationship web, dictionary, family trees, history, stats over time, hidden values.
- Safety: automatic backups (for crashes and bugs, never for re-runs).

## Running

- The engine runs headless; a separate 3D viewer (Three.js) connects to watch.
- For now it runs on the home PC. Later it moves to a 24/7 server (Railway) without a rewrite.

## Implementation notes (step 2)

How the plan above was turned into numbers. All of these are tunable.

- Walking: 1.2 tiles per world second (a tile is about a metre), slower when hurt or exhausted. Steps may climb or drop one level.
- Energy: full to empty in about 3 days (less while asleep, more in the cold season). At zero, health fails over about 2 days.
- Rest: about 20 hours awake empties it; about 7 hours of sleep restores it. At zero the AI collapses asleep and health slowly suffers.
- Social (mild): about 2 days alone empties it; a few hours of company restores it. It never harms health.
- Curiosity: grows restless over about 12 hours; each newly seen area satisfies some of it.
- Exposure: cold-season nights in the open cost health. Shelter (later) prevents it.
- Health recovers over about 2 days when fed and rested. From 80% of the lifespan the most health an AI can have declines, reaching zero at the end of its natural life.
- Founders start at a quarter of their lifespan (grown, young), each on its own tile near the centre, with eight tiny fixed "quirks" so identical beings still choose slightly differently.
- Decisions: utility scores for sleep, seeking food, exploring, seeking company and idling, re-evaluated every world minute, with a little noise and a bonus for continuing the current action. Darkness pulls strongly toward sleep; sleepers stay down until they are rested and it is light, unless hunger wakes them.
- Home: each AI has a home spot (its starting tile for now). Exploration prefers unknown ground but is discouraged in proportion to distance from home, so the known area grows outward gradually. A restless (low curiosity) mind tolerates straying farther.
- Long trips are walked in legs of up to 32 tiles; companions are only followed while in sight.
- Footpaths: every step adds wear to a tile; wear fades by 7% a day, so a single pass vanishes within a day while regularly used routes build up. These become paths and roads later.
- Ground storage: only ground that differs from what generation produces is kept and saved. Untouched ground is unloaded when no one is within about 100 tiles and regenerated exactly from the seed and generator version. Generator versions are never changed once used.
- Death: the body stays where it fell for 3 world days. The chronicle records every death while the population is small. If no one is left, the world is archived and a new one begins (its generation number increases).

## Implementation notes (step 3)

- Nine base materials, each only eight property values (see `src/materials/registry.ts`): a soft nourishing growth; flexible fibers; a sturdy, burnable growth in groves; hard heavy stone-like material; hard sharp shards; shapeable earth by the water that reacts to energy; a rare glowing high-energy material; rare dense reactive deposits along ridges; and a rich nourishment that ripens only in the warm seasons. Ids are frozen; the creator can add more, stored in the world's save.
- Abundance on the starting plain: about 11% of tiles hold the soft growth, 3% fibers, 1% rich nourishment, under 1% sturdy groves, a few stones and shards. Earth appears from the plain's edge by the water; glowing and reactive materials only far out.
- Placement, like terrain, depends only on seed and position, has frozen versions, and untouched ground regenerates with identical materials.
- Growing materials regrow on harvested tiles: soft growth recovers in about two days in the growth season, more slowly in peak and decline, not at all in the cold. Non-growing materials are gone once used up.
- AIs learn only through their senses. Looking reveals size, growth and glow; handling reveals hardness, sharpness, flexibility and weight; tasting reveals nourishment and reactivity. Volatile materials harm when eaten (the "poisoning" cause of death).
- New actions: eat (from hand or at known food), taste something new, examine something new, gather food to carry. Each AI remembers up to 24 places it saw food. Carrying is limited by weight (about 12 units of soft growth, or one stone).
- Eating: one unit of a material with nourishment 1 restores 10% energy; a bite takes 90 world seconds.
- Togetherness: at nightfall an AI alone walks to someone already settled for the night (within 60 tiles), or else home. Home drifts toward where it sleeps among others, so a group carries its home with it as it moves.
- Cold: health cannot recover while freezing, and sleeping close to others halves the harm. Without shelter, the cold season kills those caught alone.
- The chronicle records the first taste of each kind of material and the first meal.
