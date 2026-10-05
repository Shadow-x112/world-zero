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

## Implementation notes (step 4a: placing material and shelter)

- Any material an AI doesn't eat can be built with. One block is about 0.8 units of mass of a single material (one stone, two sturdy poles, eight fibers). A block can be built up over several loads, and it fades with time. Soft things are gone within about a week (fiber about 8 days), sturdy grove growth lasts seasons, and stone lasts years. Adding the same material tops it up again.
- Two levels: a wall stands beside you on the ground, and a roof is held up above head height. Walls block walking, and diagonal squeezes between walls are not allowed, so a doorway is a gap in a side. A roof needs a wall within its reach: long sturdy poles reach 2 tiles, fibers and earth 1, and rigid stone can't span at all. When its last support crumbles, the roof falls.
- Shelter runs from 0 to 1. Cover overhead counts for half, and the 8 surrounding tiles count for the other half (the four sides 0.15 each, the corners 0.1 each). Denser, harder materials keep out more cold, and a worn block keeps out less. Natural features count too: a ridge beside you counts fully, a bank one level higher counts half, and a grove or boulder next to you counts a little.
- On cold nights the harm is multiplied by (1 − shelter), and huddling still halves what's left. A body can heal at night if less than 20% of the open-air chill reaches it. Sleep recovers up to 50% faster under full shelter.
- **The nesting instinct (the one built-in push):** harm from the cold is remembered. The memory fades slowly in the cold half of the year and faster in the warm half. While it's strong, the AI is drawn (most of all in the 4 hours before sunset) to fetch material it doesn't eat and add it around its nest. The nest is the place where it last slept, and it becomes the AI's home. Where each load goes starts out random among the open spots around the nest and the roof over it (once something can hold a roof up). Finishing a started block comes first.
- **Learning:** on waking at its nest, it compares how sheltered the place felt with the previous waking there, and leans toward whichever kind of placement (walls or roof) was followed by the bigger gain.
- No one is ever walled in. A wall is never placed where it would leave anyone nearby (or anyone's nest) without a way out, so every nest keeps a doorway. Sturdy things lying on the ground (groves, stones) have to be gone before a wall can stand there. Soft growth can be built over, and nothing regrows under a wall.
- **Choosing where to sleep:** at nightfall each AI weighs the places it knows by how warm a night there would be (shelter, and others close by). Those are its own nest (favored), covered places it has seen (it remembers up to 8), and someone already asleep nearby. Being farther away makes a place less appealing. Arriving, it picks the warmest free spot within 2 tiles. Two can share a tile, and someone else's nest is shared only while room is left for its owner.
- A nest left unused for 3 days, far from where the AI now sleeps, is given up, and its next sleeping place becomes the new nest. That way nests (and homes) drift toward where the warm, shared nights are.
- **Chronicle:** the first thing built, the first roof, the first true shelter (75% or more), the first AI to sleep under a cover someone else built, and the first night three or more slept side by side under shelter.
- AIs only seek company they can actually reach. Someone in sight across a ridge is not followed.

## Implementation notes (winter)

- Nights are harsher than in the first cut: an ordinary cold-season night in the open costs about half of an AI's health alone and unsheltered (shelter still cuts it in proportion, huddling halves what's left). Eased one notch after step 5a's multi-year runs showed ordinary winters pinning every village small; bitter winters keep their full menace through severity.
- Bodies burn energy half again as fast in the cold season, so food gathered in autumn matters.
- Every winter has its own severity, fixed from the world's seed and the year (0.8x for the mildest to 1.4x for the harshest). Most are ordinary, many are mild, about one in eleven is bitter; a bitter night in the open costs more health than a full day can restore even while huddled. The chronicle notes a mild, hard or bitter winter as it sets in, and `status` names the kind of winter while it lasts.

## Implementation notes (step 4b part 1: items and tinkering)

- An item is a single made thing: a bundle of parts and the properties that follow from them, plus wear (about 250 uses, then it breaks). No item has a name or a declared purpose.
- Hidden rules, never shown to the AIs: BIND (flexible stuff ties parts into one thing; the hard part does the work, a long sturdy part adds reach), BUNDLE (enough fibers woven into themselves make a carrier that raises what can be hauled, by up to double), SHAPE (striking a hard thing with something hard and heavy knocks mass off and can raise an edge; chancy, and failures eat the piece). MIX and HEAT arrive with parts 2 and 3.
- Usefulness is discovered, not stated: working a material loose takes longer the harder it is, a sharp edge speeds cutting soft and fibrous things, something hard AND heavy speeds breaking hard things, and a carrier raises capacity. The tool that helps wears a little with each use, and its help is counted on it.
- The tinker action drives discovery: a restless AI tries what it carries against each other (fetching a missing part first if something nearby would do). Most attempts fail and waste material. Each AI remembers what it has tried; new combinations beckon, failures tire, and making a second of something it already holds bores it - but it will gladly re-make a broken tool it misses. That memory dies with its holder.
- Tinkering is the second outlet for curiosity (with exploring), so settled groups turn inventive; and ground not seen for about 12 days fades back to unknown, so exploring never fully starves either.
- Belongings fall where an AI dies. Anyone walking over a dropped item picks it up if there is room and it holds nothing of the kind, so a dead maker's tool can outlive them in a stranger's hands.
- The founders now number 50 (was 20).

## Implementation notes (step 4b part 2: mix - paste and bricks)

- The MIX rule: shapeable, chemically lively earth (the wet earth by the water) worked together with fibers makes a wet paste. Left for about six world hours - carried, or set down anywhere - it dries into bricks (base material 10), a hard building material the world never produces on its own. Fire will hurry the drying, later.
- Bricks build walls that keep out all the cold a wall can (quality 1.0), stand for about 200 days (between grove poles and stone), and cannot span as roofs: too rigid. Brick walls do not burn, which will matter once fire exists.
- A batch is heavy: two units of earth make two bricks, a full armload without a woven carrier. Earth lives by the water, so brick-making pulls people toward the water's edge and carriers become worth their weight.
- Nothing points at any of this: an AI discovers mixing by being restless near the water with fibers in hand, and bricks only spread because walls of them outlast everything their makers can otherwise afford.

## Implementation notes (step 4b part 3: fire)

- The HEAT rule: striking hard things together over dry tinder (anything organic with stored energy: fibers, grove wood) can raise a flame - about a 1-in-8 chance per bout of trying, so fire is found, not given. The flame takes the tinder as its first fuel.
- A fire lives on a tile and eats fuel by the hour (a unit of grove wood burns about 3 hours; a cold-season night costs an armload). Anyone standing within two tiles of a burning-low fire tosses on burnable stuff they carry, generously toward nightfall.
- Warmth: within 3 tiles, up to three quarters of the night chill never reaches the body, and a warm body can heal. Light: within 5 tiles the night is bright enough to work, so evenings happen around fires. Nearby wet earth bakes hard into brick, and drying paste hurries along.
- Danger, from day one: fire spreads to anything burnable beside it - the growth on the ground (fiercest in the dry decline season), fiber and wood walls, and the roof above it, which falls in flames and feeds it. Brick and stone do not burn, and a wall that cannot burn shields what stands behind it. Standing in flames kills in under an hour; the one built-in reflex is to run, even out of sleep. Burned groves are gone for good; burned grass keeps its roots.
- Fear of fire is NOT built in: respect for it must wait for emotions (step 5), so early fires will cost huts and lives. That is intended. (It arrived in 5b: fear is learned from burns, and the freshly burned keep their distance.)

## Implementation notes (step 4b part 4: cooking and medicine)

- Poison lingers: a bad mouthful is mostly hours of sickness (toxin draining health at about 0.03 an hour) rather than an instant blow, and a sick body cannot heal. That leaves a window to act.
- Cures: chemically lively but energy-dead matter eaten by a poisoned body binds the toxin instead of adding to it - the wet earth (clay-eating), and the bitter herb (new base material 11), which is far stronger for its weight but mildly harmful to a well body. An AI that feels the sickness loosen remembers that material as a cure forever; nothing else teaches it. The desperate road is deliberate: a sick AI with no known cure will put strange and even known-bitter things back in its mouth.
- The herb grows thinly almost everywhere, but only on ground first seen from material placement version 2 on; the permanent world will have it from birth.
- Cooking: a meal eaten beside a fire is held to it. It feeds about a third better - unless attention slips (about 1 in 7) and it chars. Poison does not cook away.
- Tastes are personal and lifelong: fondness grows for foods eaten warm and foods that ended real hunger, and sours for what charred or poisoned. Tastes steer what each AI chooses to eat, and feed step 5 (contentment, and the cook whose meals everyone wants).

## Implementation notes (step 5a: bonds and births)

- Feelings grow only from lived history. An hour awake in company adds a little; a night asleep side by side adds more (half again under real shelter); food put into your hands adds trust at once. Absence past 3 days fades feeling slowly; family never fades below a floor. Each heart keeps its closest ~24 people.
- The loop that makes it work: AIs prefer to bed down beside those they already hold dear, and shared nights deepen exactly those bonds. Attachments pick themselves.
- A pair: two grown AIs with mutual affection and trust past thresholds who are actually in each other's lives right now. Pairs dissolve after ~15 days apart. Never within a family.
- A birth takes everything going right: bonded 10+ days, both fed, rested, healthy and unpoisoned, neither in the last part of life, a nest sheltered past 50% with both living around it, a kind season (never cold), and 25+ days since the pair's last child. The child arrives beside the nest.
- Children are born small and blank: slower legs, weaker arms, more open to the cold, unable to build, full-grown at the first quarter of life. Quirks are a blend of the parents' plus chance. Family love starts full in both directions. A child keeps within reach of its parents, sleeps by their nest, and a parent (or anyone who holds you dear) puts food into hungry hands - the first giving in the world.
- Chronicle: first pair, pairs and partings, every birth, the first gift, and the people passing 60, 75, 100...
- This is what lets the one world live past its founders: the founders age together, and their children carry the world.
- What five-year test runs taught, and the shape that came out of it: the founders are not strangers (they opened their eyes together, so each begins mildly warm toward all the others); a pair makes ONE home of the better of their two nests and goes back to it together at night - but a home only pulls as hard as it is worth, so a bare patch never draws a couple out of the warm winter pile; lifespans vary more widely (sd 28 days) so the founders' deaths spread over years instead of one terrible winter; old age starts at 90% of lifespan and falls fast; and children sleep in the middle of the pile, so the cold reaches them barely more than adults. With all of that, a good world grows past its founding number, and even a brutal one dips to about twenty through the founders' die-off and climbs back on its second generation.

## Implementation notes (step 5b: emotions)

- Seven feelings, 0-1 each: joy, fear, anger, sadness, contentment, loneliness, wonder. Plain data on the agent; saved exactly (format 9).
- Nothing is scripted onto anyone: every feeling comes from an event in that one life. Grief at a death scales with the bond (a mate hardest, then family, then friends; strangers feel nothing). Burns and fleeing teach fear; a pairing or a birth or a first-ever creation is joy; new ground and first makings are wonder; a warm cooked meal, a fire on a cold night, giving and receiving food are contentment; a broken tool and wasted material are anger; days alone become loneliness.
- Feelings fade on their own clocks: wonder passes in an afternoon, fear in half a day, grief over days - and sorrow fades notably faster in company (shared grief softens).
- Feelings tilt decisions but never override survival: grief drains the will for play and wandering (a grieving AI sits), wonder sharpens the appetite for the new, loneliness and fear pull toward others, contentment settles a body where it is. Eating, sleeping and warmth-seeking are untouched.
- Fear of fire arrives here, learned rather than built in: fresh fear (a recent burn) widens the flee reflex to two tiles, so the burned keep their distance before it hurts. It fades within hours, so a hearth stays livable.
- Feeling spreads: an hour spent close passes fear, joy and sorrow a little way between people, upward only - a frightened camp is a real thing.
- Chronicle: the first grief. `inspect` shows a feelings line ("feels grieving, uneasy").
- Repeated feelings will harden into personality in step 5c.

## Implementation notes (step 5c: personality)

- Five traits, -1..1 each: courage (timid-fearless), cheer (somber-sunny), wander (homebound-seeker), industry (dreamy-tireless), warmth (solitary-gregarious). Plain data; saved exactly (format 10).
- Nothing is assigned. Every day at midnight each trait drifts a small step (3% of the gap) toward what that AI actually felt and did that day: the day's accumulated feelings (a raw `felt` ledger that every feel() call adds to), the work it banked (blocks, crafts, cooking), and how socially full the day left it. A safe day builds a little nerve; a day with real fear in it bends toward caution.
- A season leaves a mark; a year of consistent life shapes about 70% of a nature. Children drift twice as fast - the early years cut deepest.
- The founders begin all but identical: quirks seed only a whisper of a leaning (±0.08). Their lives do the rest, so identical AIs diverge into different people purely through what happens to them.
- Nature tilts decisions a lasting way, on top of the moment's emotions: seekers roam and taste and tinker more, the tireless build and gather more, the warm seek company, the dreamy and the somber sit longer, and the timid are spooked by fire at less fright while the fearless need more. Nature never touches eating, sleeping or warmth: it bends the day, it never starves anyone.
- The chronicle marks the world's first of each settled nature (past 0.5): "Something has settled in #12: the first of them to grow truly timid." `inspect` shows a nature line.
- Personality feeds forward: 5d (skill and teaching) will let natures pick teachers and students; 5f (conflict) will lean on temper and warmth.

## Implementation notes (step 5d: skill and teaching)

- Five skills, 0-1 each, invisible to their owners: gathering, crafting, firecraft, building, cooking. Plain data; saved exactly (format 11). No menus, no levels - skill shows only in the work.
- Hands learn by doing: every attempt teaches (a success more than a failure), with diminishing returns, scaled to how often that work comes - gathering in crumbs, fire in leaps. The first raised flame IS most of the knack (it replaces the old one-time knack flag with a curve: 12% bare-handed up to ~60% in mastered hands). Skill never fades.
- Effects: gathering and building go faster; shaping succeeds more and ruins fewer tools; tinkering sits shorter; cooked meals char less and nourish a touch more.
- Specialization emerges on its own: success breeds practice breeds skill, and nature biases who does what.
- Watching: whoever SEES a craft or fire succeed learns a little (capped at 0.3 - your own hands take you further) and can catch the recipe itself, the tried-combination memory that otherwise dies with its holder. A village that loses its firemaker keeps fire if anyone watched.
- Teaching: once an hour, an idle grown AI beside someone it holds dear (the same hearts that would feed them) may stop and show them something it knows and they lack - the herb that loosens poison first, then the knack of its best craft (with the recipe), then which things are good to eat. The warm-hearted teach most readily. A lesson lifts the learner to at most 0.5, warms the bond both ways, and the first lesson in the world is history.
- Chronicle: the first lesson, and the world's first master of each craft. `inspect` shows a skilled line.
- Deliberately absent: any skill for fighting - that waits for 5f so it lands with anger and rivalry.

## Implementation notes (step 5e: emergent language)

- Words no one designed: an AI that lives with a thing coins a sound for it (two or three random syllables) and uses it when others are close. Save format 12. Concepts are the things of THEIR lives: each material eaten enough to matter, fire, the cold, home, danger, each dear person (names!), and - for old, far-walked souls only - the world itself.
- Spread is the classic naming game, which provably converges: hearing a word makes the wordless adopt it, reinforces an agreeing listener (confidence capped at 8 so a village can still change its mind), and erodes a rival word until its holder switches. Both sides of an hour in company speak of what is present - the fire beside them, the cold, the thing in hand, each other - topics rotating by the hour so even the old stories get airtime. Children pick it all up by being underfoot. A word no living mouth carries is gone.
- Danger is screamed: an AI fleeing flames shouts its danger word across 10 tiles. Whoever shares the word understands at once and feels fear before seeing fire (the forewarned keep their distance - language literally saves lives); whoever doesn't still catches the sound, bound to a terrible moment. Screams are how the danger word spreads fastest.
- The world's name: when 60% of living mouths use one word for everything there is, the chronicle marks it once - "The world has a name: ..." - and `worldName()` exposes the current majority word (the name can still drift over generations). This is the name the project itself has been waiting for.
- Chronicle: the first word, the first shared word, the first word for the world, the world named. `words` command prints the village tongue; `inspect` shows what one AI speaks.
- v1 keeps meaning grounded: words attach to concepts the system already has. Compositional talk (warnings about PLACES, asking for things) can come later, on this base.
