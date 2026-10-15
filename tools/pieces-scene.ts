// Usage: node tools/pieces-scene.ts src/viewer/pieces-scene.json
// For the viewer test page (src/viewer/pieces-test.html): builds a few structures with the real engine and writes their pieces for the viewer test page.
import { writeFileSync } from "node:fs";
import { World } from "../src/core/world.ts";
import { addToBlock, blockAt, removeBlock, unitsPerBlock } from "../src/building/structures.ts";
import { unitsPerPiece, ROLE } from "../src/building/pieces.ts";
const world = World.create({ seed: 7 });
for (const a of world.population.all()) { a.x = -900; a.y = -900; }
const clear = (x: number, y: number, r: number) => { for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) for (const l of ["terrain", "height", "material", "amount"]) world.grid.set(l, x + ox, y + oy, 0); };
const M = (id: number) => world.materials.require(id);
const up = (lv: "wall" | "roof", x: number, y: number, mat: number, by: number, toward?: any, skill = 1, max = 60) => {
  let stale = 0;
  for (let i = 0; i < max && stale < 8 && (blockAt(world.grid, lv, x, y)?.hp ?? 0) < 1000; i++)
    stale = addToBlock(world, lv, x, y, M(mat), unitsPerPiece(M(mat)), by, toward, skill) === 0 ? 99 : 0;
};
const STONE = 4, GROVE = 3, FIBER = 2, BRICK = 10, FLINT = 5, HERB = 11;
clear(0, 0, 12);
// A: a hut. Stone ring (a doorway left), grove poles across, fibre over them. Three builders.
const hut = { x: 0, y: 0 };
const ring: [number, number, number, number][] = [[1, 0, STONE, 1], [-1, 0, STONE, 2], [0, 1, BRICK, 1], [1, 1, STONE, 3], [-1, 1, STONE, 2], [1, -1, FLINT, 3], [-1, -1, STONE, 1]];
for (const [dx, dy, m, by] of ring) up("wall", hut.x + dx, hut.y + dy, m, by, hut);
up("roof", hut.x, hut.y, GROVE, 2, undefined, 1, 14);
for (let i = 0; i < 6; i++) addToBlock(world, "roof", hut.x, hut.y, M(FIBER), unitsPerPiece(M(FIBER)), 3);
// B: a lean-to: one stone wall, grove poles leaned from it, herb bundles over.
const b = { x: 6, y: 0 };
up("wall", b.x + 1, b.y, STONE, 4, b);
up("roof", b.x, b.y, GROVE, 4, undefined, 1, 10);
for (let i = 0; i < 4; i++) addToBlock(world, "roof", b.x, b.y, M(HERB), unitsPerPiece(M(HERB)), 4);
// C: a palisade of grove poles, and a fibre screen beside it (a novice's work).
for (let i = 0; i < 3; i++) up("wall", -6 + i, 4, GROVE, 5, { x: -5, y: 6 });
up("wall", -2, 4, FIBER, 6, { x: -2, y: 6 }, 0.1);
// D: worn walls, freshest to nearly gone.
const worn = [1000, 700, 450, 200, 60];
worn.forEach((hp, i) => {
  up("wall", 4 + i * 2, 5, STONE, 7, { x: 4 + i * 2, y: 7 });
  for (const p of world.pieces.at(4 + i * 2, 5, ROLE.wall)) p.hp = hp;
});
const ground = (x: number, y: number) => world.grid.heightAt(Math.round(x), Math.round(y)) * 0.5;
const dump = () => [...world.pieces.all.values()].sort((a, b) => a.id - b.id).map((p) => ({
  id: p.id, f: p.form, m: p.material, r: p.role, x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +(p.z - ground(p.x, p.y)).toFixed(3),
  l: +p.len.toFixed(3), w: +p.wid.toFixed(3), t: +p.thk.toFixed(3), yaw: +p.yaw.toFixed(4), pitch: +p.pitch.toFixed(4), hp: p.hp, by: p.by,
}));
const before = dump();
// The collapse: the hut's east wall taken away (fire, say): its beams come down.
removeBlock(world, "wall", hut.x + 1, hut.y);
removeBlock(world, "wall", hut.x + 1, hut.y + 1);
const after = dump();
const mats: Record<number, any> = {};
for (const id of [STONE, GROVE, FIBER, BRICK, FLINT, HERB]) mats[id] = M(id).props;
writeFileSync(process.argv[2], JSON.stringify({ before, after, materials: mats }));
console.log(before.length, "pieces before,", after.length, "after;", after.filter((p) => p.r === 2).length, "rubble");
