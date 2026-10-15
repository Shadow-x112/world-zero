// The 3D viewer: a neon grid of the one world, live.

import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, SMAAPreset, ChromaticAberrationEffect, VignetteEffect } from "postprocessing";

import { api, follow, CHUNK } from "./api.js";
import { Terrain } from "./terrain.js";
import { Resources } from "./resources.js";
import { Sky } from "./sky.js";
import { Quality } from "./quality.js";
import { Walkers } from "./figures.js";
import { Ui } from "./ui.js";
import { Fires, Snow, SeasonPulse } from "./atmosphere.js";
import { Creator } from "./creator.js";

const $ = (id) => document.getElementById(id);
let fpsFrames = 0, fpsTime = 0, fpsShown = 0;
const canvas = $("world");

// ---------- Renderer, scene, camera ----------

let renderer;
try {
  // Edges are smoothed in post-processing (SMAA), so the canvas itself needs none.
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, stencil: false, depth: true, powerPreference: "high-performance" });
} catch {
  $("loadLabel").textContent = "This device cannot draw the world (WebGL is unavailable).";
  throw new Error("no WebGL");
}
renderer.setClearColor(0x010307, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
camera.position.set(0, 70, 70);

const controls = new MapControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false;
controls.minDistance = 6;
controls.maxDistance = 420;
controls.maxPolarAngle = 1.32;
controls.zoomToCursor = true;
controls.target.set(0, 0, 0);

const terrain = new Terrain(scene);
const sky = new Sky(scene, terrain);
const resources = new Resources(scene, terrain, renderer);
const walkers = new Walkers(scene, terrain, renderer);
walkers.camera = camera;
const ui = new Ui({ camera, controls, walkers, terrain, api, canvas });
const fires = new Fires(scene, terrain);
const snow = new Snow(scene);
const pulse = new SeasonPulse(terrain.material);

// Post-processing: only what is bright glows (the dark ground stays dark), edges are
// smoothed, and at the very edge of the picture light splits faintly as through glass.
const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
composer.addPass(new RenderPass(scene, camera));
const bloom = new BloomEffect({ mipmapBlur: true, intensity: 1.15, luminanceThreshold: 0.32, luminanceSmoothing: 0.25, radius: 0.72 });
const smaa = new SMAAEffect({ preset: SMAAPreset.HIGH });
const aberration = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0.0006, 0.0004), radialModulation: true, modulationOffset: 0.35 });
const vignette = new VignetteEffect({ offset: 0.32, darkness: 0.55 });
// (Edge smoothing first; the glass split blurs, so it needs a pass of its own.)
const passes = {
  smooth: new EffectPass(camera, smaa),
  glow: new EffectPass(camera, bloom, vignette),
  plain: new EffectPass(camera, vignette),
  split: new EffectPass(camera, aberration),
};
let active = [];
function setEffects(full) {
  for (const p of active) composer.removePass(p); // (not disposed: they are reused)
  active = full ? [passes.smooth, passes.glow, passes.split] : [passes.smooth, passes.plain];
  for (const p of active) composer.addPass(p);
}

const quality = new Quality((tier, fps) => {
  applyQuality();
  console.info(`[world-zero] ${fps.toFixed(0)} fps: rendering at ${tier.name} quality`);
});

function applyQuality() {
  const t = quality.tier;
  setEffects(t.bloom);
  walkers.setGlow(t.bloom);
  walkers.bodies.setGlass(t.name !== "low");
  showQuality();
  resize();
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const pr = Math.min(window.devicePixelRatio || 1, quality.tier.pixelRatio);
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (typeof ui !== "undefined") ui.applyViewShift();
}
window.addEventListener("resize", resize);
applyQuality();

// ---------- Keyboard (WASD to move, QE to turn, RF to zoom) ----------

const keys = new Set();
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  keys.add(e.key.toLowerCase());
  hideHint();
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => keys.clear());

const tmp = new THREE.Vector3();
function keyboard(dt) {
  if (keys.size === 0) return;
  const dist = camera.position.distanceTo(controls.target);
  const speed = dist * 0.9 * dt;
  const forward = tmp.subVectors(controls.target, camera.position).setY(0).normalize();
  const right = new THREE.Vector3(-forward.z, 0, forward.x);
  const move = new THREE.Vector3();
  if (keys.has("w") || keys.has("arrowup")) move.add(forward);
  if (keys.has("s") || keys.has("arrowdown")) move.sub(forward);
  if (keys.has("d") || keys.has("arrowright")) move.add(right);
  if (keys.has("a") || keys.has("arrowleft")) move.sub(right);
  if (move.lengthSq() > 0) {
    move.normalize().multiplyScalar(speed);
    camera.position.add(move);
    controls.target.add(move);
  }
  const turn = (keys.has("q") ? 1 : 0) - (keys.has("e") ? 1 : 0);
  if (turn) {
    const off = camera.position.clone().sub(controls.target);
    off.applyAxisAngle(THREE.Object3D.DEFAULT_UP, turn * 1.4 * dt);
    camera.position.copy(controls.target).add(off);
  }
  const zoom = (keys.has("f") ? 1 : 0) - (keys.has("r") ? 1 : 0);
  if (zoom) {
    const off = camera.position.clone().sub(controls.target);
    const len = THREE.MathUtils.clamp(off.length() * Math.exp(zoom * 1.2 * dt), controls.minDistance, controls.maxDistance);
    camera.position.copy(controls.target).add(off.setLength(len));
  }
}

let hintTimer = setTimeout(hideHint, 12000);
function hideHint() {
  clearTimeout(hintTimer);
  $("hint").classList.add("faded");
}
canvas.addEventListener("pointerdown", () => setTimeout(hideHint, 3000), { once: true });

/** Keeps the camera's focus over the known world. */
function clampTarget() {
  const b = terrain.bounds;
  if (!b.any) return;
  const t = controls.target;
  const cx = THREE.MathUtils.clamp(t.x, b.minX, b.maxX);
  const cz = THREE.MathUtils.clamp(t.z, b.minZ, b.maxZ);
  if (cx !== t.x || cz !== t.z) {
    camera.position.x += cx - t.x;
    camera.position.z += cz - t.z;
    t.x = cx;
    t.z = cz;
  }
  // Rest the focus on the ground so turning feels anchored.
  const gy = terrain.groundY(t.x, t.z);
  t.y += (gy - t.y) * 0.1;
}

// ---------- The ground: fetch what we lack, nearest first ----------

let boot = null;
const wanted = new Map(); // "cx,cy" -> revision to fetch
let fetching = false;
let loadTotal = 0;
let loadDone = 0;
let firstFocus = false;

function want(list, focus) {
  for (const [cx, cy, rev] of list) {
    if (terrain.revision(cx, cy) === rev) continue;
    wanted.set(`${cx},${cy}`, rev);
  }
  loadTotal = loadDone + wanted.size;
  pump(focus);
}

async function pump(focus) {
  if (fetching || wanted.size === 0) return;
  fetching = true;
  try {
    while (wanted.size > 0) {
      const f = focus ?? { x: controls.target.x, z: controls.target.z };
      const list = [...wanted.keys()].map((k) => k.split(",").map(Number));
      list.sort((a, b) => dist2(a, f) - dist2(b, f));
      const batch = list.slice(0, 64);
      for (const [cx, cy] of batch) wanted.delete(`${cx},${cy}`);
      await api.chunks(batch, (chunks) => {
        for (const c of chunks) terrain.set(c);
        loadDone += chunks.length;
        showLoad();
      });
    }
  } catch (err) {
    console.warn("[world-zero] could not fetch ground:", err);
    setTimeout(() => {
      fetching = false;
      pump();
    }, 5000);
    return;
  }
  fetching = false;
}

function dist2([cx, cy], f) {
  const x = cx * CHUNK + CHUNK / 2 - f.x;
  const z = cy * CHUNK + CHUNK / 2 - f.z;
  return x * x + z * z;
}

function showLoad() {
  const total = Math.max(loadTotal, 1);
  $("loadBar").style.width = `${Math.round((loadDone / total) * 100)}%`;
  $("loadLabel").textContent = loadDone < total ? `Mapping the world · ${loadDone} / ${total}` : "";
  if (loadDone >= total) $("loading").classList.add("done");
}

// ---------- The world's clock ----------

/** The corner note: quality tier and how smoothly it runs (useful when trying a new device). */
function showQuality() {
  $("quality").textContent = fpsShown ? `${quality.tier.name} · ${fpsShown} fps` : quality.tier.name;
}

const SEASON_NAMES = { growth: "THE GROWING SEASON", peak: "HIGH SUMMER", decline: "THE WANING SEASON", cold: "THE COLD SEASON" };
let lastSeason = null;
function seasonTurned(s) {
  document.documentElement.style.setProperty("--season", `#${sky.targetLine.getHexString()}`);
  // The ring starts where you are looking, so you see it pass.
  pulse.fire(controls.target, sky.targetLine);
  $("seasonTitle").textContent = SEASON_NAMES[s.season] ?? s.season.toUpperCase();
  $("seasonSub").textContent = s.season === "cold" && s.winter ? `a ${s.winter} winter · year ${s.year}` : `year ${s.year}`;
  const card = $("seasonCard");
  card.classList.add("show");
  setTimeout(() => card.classList.remove("show"), 6500);
}

async function refreshStatus() {
  try {
    const s = await api.status();
    sky.setWorld(s);
    document.documentElement.style.setProperty("--season", `#${sky.targetLine.getHexString()}`);
    snow.setWinter(s.season, s.winter);
    resources.setSeason(s.season);
    if (lastSeason !== null && lastSeason !== s.season) seasonTurned(s);
    lastSeason = s.season;
    $("clock").textContent = s.date.replace(/\s*\((day|night)\)$/, "");
    const parts = [`${s.alive} alive`];
    if (s.name) parts.unshift(s.name[0].toUpperCase() + s.name.slice(1));
    if (s.generation > 1) parts.push(`world ${s.generation}`);
    if (s.walls + s.roofs > 0) parts.push(`${s.walls + s.roofs} blocks built`);
    if (s.paused) parts.push("time paused");
    else if (s.speed > 1) parts.push(`${s.speed}× speed`);
    $("meta").textContent = parts.join(" · ");
    api.ais().then((r) => {
      walkers.setMates(r.ais);
      ui.setPeople(r.ais);
    }).catch(() => {});
  } catch (err) {
    if (err.status === 503) $("clock").textContent = "waiting for the world…";
  }
}

// ---------- Live ----------

const stream = follow({
  onSnapshot(s) {
    if (boot !== s.boot) {
      // A new server run (or the first visit): chunk revisions restarted, so ask again.
      if (boot !== null) terrain.clear();
      boot = s.boot;
    }
    walkers.snapshot(s.agents);
    fires.set(s.fires);
    if (!firstFocus && s.agents.length) {
      firstFocus = true;
      const c = walkers.centroid();
      controls.target.set(c.x, 0, c.z);
      camera.position.set(c.x + 40, 62, c.z + 58);
    }
    want(s.chunks, { x: controls.target.x, z: controls.target.z });
  },
  onChanges(c) {
    walkers.changes(c);
    fires.changes(c.fires);
    if (c.chronicle.length) ui.addChronicle(c.chronicle, true);
    if (c.chunks) want(c.chunks);
  },
  onState(state) {
    if (state !== "live" && !boot) $("loadLabel").textContent = "Waiting for room to watch…";
  },
});

api.palette().then((p) => terrain.setPalette(p.materials)).catch(() => {});
refreshStatus();
setInterval(refreshStatus, 15000);
ui.loadChronicle();
const creator = new Creator({ scene, walkers, ui, stream, camera, terrain, canvas });
ui.creator = creator;

// ---------- Light on the ground: the AIs nearest the eye ----------

const lightPoints = [];
function groundLights() {
  lightPoints.length = 0;
  const t = controls.target;
  for (const w of walkers.list.values()) {
    if (w.dx === undefined) continue;
    const d = (w.dx - t.x) ** 2 + (w.dy - t.z) ** 2;
    lightPoints.push({ x: w.dx, z: w.dy, w: w.a === "sleep" ? 0.3 : w.k ? 0.6 : 1, d });
  }
  lightPoints.sort((a, b) => a.d - b.d);
  lightPoints.length = Math.min(lightPoints.length, quality.tier.lights);
  terrain.setLights(lightPoints);
}

// ---------- Near ground, refreshed now and then ----------
// How much is left on a tile changes quietly (it does not mark the chunk as changed),
// so the ground near the eye is fetched again every so often to keep it true.

setInterval(async () => {
  if (document.hidden || fetching || !boot) return;
  const r = Math.ceil(Resources.rangeFor(camera.position.distanceTo(controls.target), quality.tier.near) / CHUNK);
  const fcx = Math.floor(controls.target.x / CHUNK), fcy = Math.floor(controls.target.z / CHUNK);
  const list = [];
  for (let cy = fcy - r; cy <= fcy + r; cy++) for (let cx = fcx - r; cx <= fcx + r; cx++) if (terrain.has(cx, cy)) list.push([cx, cy]);
  list.sort((a, b) => dist2(a, { x: controls.target.x, z: controls.target.z }) - dist2(b, { x: controls.target.x, z: controls.target.z }));
  try {
    await api.chunks(list.slice(0, 64), (chunks) => {
      for (const c of chunks) terrain.set(c);
    });
  } catch {}
}, 45_000);

// ---------- Frame loop ----------

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  keyboard(dt);
  const steering = ui.update(performance.now());
  controls.update();
  if (!steering) clampTarget();
  const building = terrain.update() > 0 || wanted.size > 0 || fetching;
  sky.update(dt);
  sky.dome.position.copy(camera.position);
  // Far away, figures grow a little so they stay findable (up to 3x at the widest view).
  const camDist = camera.position.distanceTo(controls.target);
  walkers.update(performance.now(), THREE.MathUtils.clamp(camDist / 45, 1, 3), camDist);
  resources.update(dt, controls.target, camDist, quality.tier.near);
  groundLights();
  terrain.material.uniforms.uTime.value += dt;
  const t = terrain.material.uniforms.uTime.value;
  fires.update(t);
  snow.update(t, dt, controls.target, renderer.getPixelRatio());
  pulse.update(performance.now());
  creator.update();
  composer.render();
  quality.sample(dt, building);
  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 2) {
    fpsShown = Math.round(fpsFrames / fpsTime);
    fpsFrames = 0;
    fpsTime = 0;
    showQuality();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// For poking at in the browser console.
window.worldZero = { scene, camera, controls, terrain, resources, sky, walkers, quality, ui, fires, snow, pulse, seasonTurned, creator };
