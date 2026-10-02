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
