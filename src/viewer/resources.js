// What lies on the land, in 3D: every material is shaped from how it looks (never from
// what it truly is), so a viewer sees only what an AI could see.
//
//   growing things  plants of dark glass (tufts of blades, broad leaves, stalks with a
//                   glowing seed-pod), lit along their midribs and margins, swaying
//   heavy things    clusters of glossy rock with bright cut edges
//   glowing things  six-sided crystals, lit from within, floating, turning and pulsing
//
// The shapes are made in Blender (tools/build_resources.py) in several variants, so a
// field never looks stamped out.
//
// A material that is a little of each borrows from each (a heavy growing thing has
// broad, stiff blades; a glowing stone floats low). Each tile shows one to four pieces
// at fixed spots, sized by how much is left, so a patch visibly shrinks as it is eaten
// and fills back as it grows. Only the near ground is drawn this way; beyond it, the
// ground shader shows each tile's material as a small point of light.

import * as THREE from "three";
import { CHUNK } from "./api.js";
import { LEVEL_H } from "./terrain.js";

import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import CustomShaderMaterial from "three-custom-shader-material/vanilla";
import { sharedEnvironment } from "./creatures.js";

const PLANT = 0, STONE = 1, CRYSTAL = 2;
/** The shapes made in Blender (tools/build_resources.py), by kind. */
const VARIANTS = [["plant0", "plant1", "plant2"], ["stone0", "stone1", "stone2"], ["crystal0", "crystal1"]];
const CAPACITY = [12000, 8000, 4000]; // per variant

/**
 * Lit edges for faceted shapes: each triangle gets barycentric coordinates, except that
 * an edge between two faces lying flat together (a face split into triangles) is hidden,
 * so only real cut edges glow.
 */
function withEdges(geo, flat = 0.999) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position;
  const n = pos.count / 3;
  const key = (i) => `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
  const normals = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < n; t++) {
    a.fromBufferAttribute(pos, t * 3);
    b.fromBufferAttribute(pos, t * 3 + 1);
    c.fromBufferAttribute(pos, t * 3 + 2);
    normals.push(new THREE.Vector3().subVectors(b, a).cross(c.sub(a)).normalize());
  }
  const edges = new Map(); // "p|q" -> [triangle, corner opposite]
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const p = key(t * 3 + ((k + 1) % 3)), q = key(t * 3 + ((k + 2) % 3));
      const e = p < q ? `${p}|${q}` : `${q}|${p}`;
      if (!edges.has(e)) edges.set(e, []);
      edges.get(e).push([t, k]);
    }
  }
  const bary = new Float32Array(pos.count * 3);
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) bary[(t * 3 + k) * 3 + k] = 1;
  for (const list of edges.values()) {
    if (list.length !== 2) continue;
    const [[t1, k1], [t2, k2]] = list;
    if (normals[t1].dot(normals[t2]) < flat) continue;
    // Coplanar: hide this edge on both triangles.
    for (const [t, k] of [[t1, k1], [t2, k2]]) for (let v = 0; v < 3; v++) bary[(t * 3 + v) * 3 + k] += 1;
  }
  g.setAttribute("aBary", new THREE.BufferAttribute(bary, 3));
  return g;
}

/** Deterministic 0-1 noise for a tile and a slot, so pieces never jump around. */
function rand(x, y, k) {
  let h = (x * 374761393 + y * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ---------- Look: dark glass, lit along its edges and veins ----------

const vertexShader = /* glsl */ `
  attribute vec4 aInst; // phase, kind, fullness, fade
  #ifdef HAS_EDGES
  attribute vec3 aBary;
  #endif
  varying vec3 vBary;
  uniform float uTime;
  uniform float uKind;
  varying vec2 vUv2;
  varying vec3 vTint;
  varying vec4 vI;
  varying vec3 vWorldN;
  varying vec3 vWorldP;
  varying float vDepth;
  void main() {
    vec2 uvf = vec2(uv.x, 1.0 - uv.y); // (across, height)
    float h = uvf.y;
    vec3 p = position;
    if (uKind > 1.5) {
      // Floating crystals turn slowly and bob.
      float a = uTime * 0.45 + aInst.x;
      float c = cos(a), s = sin(a);
      p.xz = mat2(c, -s, s, c) * p.xz;
      p.y += sin(uTime * 1.1 + aInst.x * 2.0) * 0.05;
    } else if (uKind < 0.5) {
      // Blades sway, more toward their tips, each plant in its own time.
      float sway = sin(uTime * 0.9 + aInst.x) * 0.06 + sin(uTime * 2.3 + aInst.x * 3.0) * 0.015;
      p.x += h * h * sway;
      p.z += h * h * sway * 0.6;
    }
    csm_Position = p;
    vUv2 = uvf;
    #ifdef HAS_EDGES
    vBary = aBary;
    #else
    vBary = vec3(1.0);
    #endif
    vI = aInst;
    #ifdef USE_INSTANCING_COLOR
      vTint = instanceColor;
    #else
      vTint = vec3(1.0);
    #endif
    mat4 m = modelMatrix * instanceMatrix;
    vec4 wp = m * vec4(p, 1.0);
    vWorldP = wp.xyz;
    vWorldN = normalize(mat3(m) * normal);
    vDepth = -(viewMatrix * wp).z;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uKind;
  uniform float uGlow;
  uniform float uCold;
  uniform float uFogDensity;
  varying vec2 vUv2;
  varying vec3 vTint;
  varying vec4 vI;
  varying vec3 vWorldN;
  varying vec3 vWorldP;
  varying float vDepth;
  varying vec3 vBary;
  float lineAt(float d, float w) { return 1.0 - smoothstep(0.0, fwidth(d) * 1.2 + w, d); }
  void main() {
    float full = vI.z;
    vec3 N = normalize(vWorldN);
    vec3 V = normalize(cameraPosition - vWorldP);
    float rim = pow(1.0 - abs(dot(N, V)), 3.0);
    // Cut edges: near a triangle's side (sides between flat-joined faces are hidden).
    float e = min(min(vBary.x, vBary.y), vBary.z);
    float edge = 1.0 - smoothstep(0.0, fwidth(e) * 1.3 + 0.006, e);
    float h = vUv2.y;
    float light;
    if (uKind < 0.5) {
      if (vUv2.x > 1.5) {
        // A seed-pod: it glows.
        light = 1.6 + 0.4 * sin(uTime * 1.7 + vI.x);
      } else {
        // A midrib and margins of light, brighter toward the tip; dimmer in the cold.
        float rib = lineAt(abs(vUv2.x - 0.5), 0.03);
        float margin = lineAt(min(vUv2.x, 1.0 - vUv2.x), 0.02);
        light = (0.9 * rib + 0.5 * margin) * (0.25 + 1.1 * h * h) + 0.25 * rim;
      }
      light *= 1.0 - 0.55 * uCold;
    } else if (uKind < 1.5) {
      // Stone: dark glossy faces, bright cuts.
      light = edge * 0.6 + rim * 0.14;
    } else {
      // Crystals: lit from within, edges blazing, pulsing.
      float pulse = 0.7 + 0.3 * sin(uTime * 2.0 + vI.x * 5.0);
      // (Lit evenly from root to tip, so a cluster never reads as a dark shape.)
      light = (0.22 + 0.25 * h + edge * 1.1 + rim * 0.35) * pulse;
    }
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
    csm_Emissive = vTint * light * (0.5 + 0.5 * full) * uGlow * (1.0 - fog);
  }
`;

// ---------- Placement ----------// ---------- Placement ----------

/** Which shape a material takes, and its proportions, from how it looks. */
function shapeOf(looks) {
  const growth = looks.growth ?? 0, mass = looks.mass ?? 0, energy = looks.energy ?? 0;
  const base = { growth, mass, energy };
  if (energy >= 0.5) return { ...base, kind: CRYSTAL, height: 0.42 + 0.3 * energy, width: 0.6 + 0.6 * mass, lift: 0.2 + 0.35 * (1 - mass) };
  if (growth >= 0.15) return { ...base, kind: PLANT, height: 0.3 + 0.55 * growth, width: 0.8 + 1.4 * mass, lift: 0 };
  return { ...base, kind: STONE, height: 0.5 + 0.8 * mass, width: 0.6 + 0.9 * mass, lift: 0 };
}

export class Resources {
  /** uniforms: shared with the ground (time, glow, fog). */
  constructor(scene, terrain, renderer) {
    this.terrain = terrain;
    this.uniforms = {
      uTime: terrain.material.uniforms.uTime,
      uGlow: terrain.material.uniforms.uGlow,
      uFog: terrain.material.uniforms.uFog,
      uFogDensity: terrain.material.uniforms.uFogDensity,
      uHorizon: terrain.material.uniforms.uHorizon,
      uCold: { value: 0 },
    };
    this.meshes = [[], [], []]; // by kind, then variant
    this.scene = scene;
    this.envMap = sharedEnvironment(renderer);
    new GLTFLoader().load("/viewer/resources.glb", (gltf) => {
      const geos = {};
      gltf.scene.traverse((o) => {
        if (o.isMesh) geos[o.name] = o.geometry;
      });
      VARIANTS.forEach((names, kind) => {
        const mat = this.material(kind);
        for (const name of names) {
          let geo = geos[name];
          if (!geo) continue;
          if (kind !== PLANT) geo = withEdges(geo, kind === STONE ? 0.93 : 0.999);
          const m = new THREE.InstancedMesh(geo, mat, CAPACITY[kind]);
          m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          m.setColorAt(0, new THREE.Color());
          const inst = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY[kind] * 4), 4);
          inst.setUsage(THREE.DynamicDrawUsage);
          geo.setAttribute("aInst", inst);
          m.count = 0;
          m.frustumCulled = false;
          m.name = name;
          m.visible = this.enabled;
          scene.add(m);
          this.meshes[kind].push(m);
        }
      });
      this.range = 0; // draw now
    });
    this.focus = new THREE.Vector3(Infinity, 0, Infinity);
    this.range = 0;
    this.seen = new Map(); // chunk key -> data object last drawn
    this.paletteVersion = -1;
    this.shapes = new Map();
    this.wait = 0;
    this.o = new THREE.Object3D();
    this.c = new THREE.Color();
    this.enabled = true;
  }

  material(kind) {
    return new CustomShaderMaterial({
      baseMaterial: THREE.MeshStandardMaterial,
      vertexShader,
      fragmentShader,
      uniforms: { ...this.uniforms, uKind: { value: kind } },
      defines: kind === PLANT ? {} : { HAS_EDGES: "" },
      color: new THREE.Color(kind === CRYSTAL ? "#0d1420" : "#06090d"),
      roughness: kind === STONE ? 0.22 : 0.12,
      metalness: 0,
      envMap: this.envMap,
      envMapIntensity: kind === PLANT ? 0.6 : 0.85,
      side: kind === PLANT ? THREE.DoubleSide : THREE.FrontSide,
    });
  }

  setSeason(season) {
    this.uniforms.uCold.value = season === "cold" ? 1 : season === "decline" ? 0.3 : 0;
  }

  setEnabled(on) {
    this.enabled = on;
    for (const m of this.meshes.flat()) m.visible = on;
    if (!on) this.terrain.material.uniforms.uResRange.value = 0;
    else this.range = 0; // redraw
  }

  /** How far from the focus the near ground is drawn in 3D (wider when looking from higher up). */
  static rangeFor(camDist, scale = 1) {
    return THREE.MathUtils.clamp(camDist * 0.95, 38, 95) * scale;
  }

  /** Call every frame; redraws when the view moved enough or the ground near it changed. */
  update(dt, focus, camDist, scale = 1) {
    if (!this.enabled) return;
    this.wait -= dt;
    if (this.wait > 0) return;
    this.wait = 0.4;
    const range = Resources.rangeFor(camDist, scale);
    const moved = Math.hypot(focus.x - this.focus.x, focus.z - this.focus.z);
    let changed = moved > range * 0.12 || Math.abs(range - this.range) > this.range * 0.15 || this.paletteVersion !== this.terrain.paletteVersion;
    if (!changed) {
      // Has any chunk in reach been refreshed?
      for (const [k, data] of this.seen) {
        const [cx, cy] = k.split(",").map(Number);
        if (this.terrain.chunk(cx, cy) !== data) {
          changed = true;
          break;
        }
      }
      if (!changed) changed = this.newInReach(focus, range);
    }
    if (!changed) return;
    this.focus.set(focus.x, 0, focus.z);
    this.range = range;
    this.rebuild();
  }

  newInReach(focus, range) {
    const r = Math.ceil(range / CHUNK) + 1;
    const fcx = Math.floor(focus.x / CHUNK), fcy = Math.floor(focus.z / CHUNK);
    for (let cy = fcy - r; cy <= fcy + r; cy++) {
      for (let cx = fcx - r; cx <= fcx + r; cx++) {
        if (!this.seen.has(`${cx},${cy}`) && this.terrain.chunk(cx, cy)) return true;
      }
    }
    return false;
  }

  shapeFor(mat) {
    if (this.paletteVersion !== this.terrain.paletteVersion) {
      this.shapes.clear();
      this.paletteVersion = this.terrain.paletteVersion;
    }
    let s = this.shapes.get(mat);
    if (!s) {
      const looks = this.terrain.looks.get(mat);
      if (!looks) return null;
      const color = new THREE.Color();
      const i = mat * 4;
      const pd = this.terrain.paletteData;
      color.setRGB(pd[i] / 255, pd[i + 1] / 255, pd[i + 2] / 255);
      s = { ...shapeOf(looks), color };
      this.shapes.set(mat, s);
    }
    return s;
  }

  rebuild() {
    const t = this.terrain;
    const { focus, range } = this;
    t.material.uniforms.uResFocus.value.copy(focus);
    t.material.uniforms.uResRange.value = range;
    if (!this.meshes[0].length) return;
    const counts = this.meshes.map((v) => v.map(() => 0));
    const o = this.o;
    this.seen.clear();
    const r = Math.ceil(range / CHUNK) + 1;
    const fcx = Math.floor(focus.x / CHUNK), fcy = Math.floor(focus.z / CHUNK);
    const r2 = range * range;
    for (let cy = fcy - r; cy <= fcy + r; cy++) {
      for (let cx = fcx - r; cx <= fcx + r; cx++) {
        const d = t.chunk(cx, cy);
        if (!d) continue;
        this.seen.set(`${cx},${cy}`, d);
        for (let ly = 0; ly < CHUNK; ly++) {
          for (let lx = 0; lx < CHUNK; lx++) {
            const i = ly * CHUNK + lx;
            const mat = d.material[i];
            if (!mat || d.terrain[i] !== 0) continue;
            if (d.wall && d.wall[i]) continue;
            const x = cx * CHUNK + lx, y = cy * CHUNK + ly;
            const dd = (x - focus.x) ** 2 + (y - focus.z) ** 2;
            if (dd > r2) continue;
            const s = this.shapeFor(mat);
            if (!s) continue;
            const full = t.fullness(mat, d.amount[i]);
            if (full <= 0) continue;
            // Fade in at the edge of the near ground, where the points of light take over.
            const dist = Math.sqrt(dd);
            const fade = 1 - THREE.MathUtils.smoothstep(dist, range * 0.78, range);
            if (fade <= 0.02) continue;
            const pieces = s.kind === CRYSTAL ? 1 : 1 + (full > 0.55 ? 1 : 0) + (s.kind === PLANT && full > 0.9 ? 1 : 0);
            const gy = d.height[i] * LEVEL_H;
            for (let k = 0; k < pieces; k++) {
              const vi = this.variantOf(s, x, y, k);
              const mesh = this.meshes[s.kind][vi];
              const n = counts[s.kind][vi];
              if (n >= CAPACITY[s.kind]) break;
              const r1 = rand(x, y, k * 3 + 1), r2b = rand(x, y, k * 3 + 2), r3 = rand(x, y, k * 3 + 3);
              const spread = pieces === 1 ? 0.12 : 0.32;
              const px = x + (r1 - 0.5) * 2 * spread;
              const pz = y + (r2b - 0.5) * 2 * spread;
              const size = (0.35 + 0.65 * full) * (0.8 + 0.4 * r3) * fade;
              const h = s.height * size;
              const w = s.width * size;
              o.position.set(px, gy + (s.kind === CRYSTAL ? s.lift + 0.25 * h : 0), pz);
              o.rotation.set(0, r3 * Math.PI * 2, 0);
              o.scale.set(w, h, w);
              o.updateMatrix();
              mesh.setMatrixAt(n, o.matrix);
              this.c.copy(s.color).multiplyScalar(s.kind === CRYSTAL ? 1.5 : 1.25);
              mesh.setColorAt(n, this.c);
              mesh.geometry.attributes.aInst.setXYZW(n, r1 * 6.283 + k, s.kind, full, fade);
              counts[s.kind][vi] = n + 1;
            }
          }
        }
      }
    }
    for (const [k, list] of this.meshes.entries()) for (const [vi, m] of list.entries()) {
      m.count = counts[k][vi];
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.geometry.attributes.aInst.needsUpdate = true;
    }
    this.counts = counts.map((c) => c.reduce((a, b) => a + b, 0));
  }

  /** Which shape a piece takes: leafy plants for heavier growing things, seed-pods for the
   *  most alive; otherwise a fixed mix by place, so neighbours differ. */
  variantOf(s, x, y, k) {
    const r = rand(x, y, 40 + k);
    const n = this.meshes[s.kind].length;
    if (s.kind === PLANT && n === 3) {
      const leafy = Math.min(0.75, 0.15 + s.mass * 1.2);
      const pod = s.growth > 0.6 ? 0.3 : 0.12;
      return r < leafy ? 1 : r < leafy + pod ? 2 : 0;
    }
    return Math.min(n - 1, Math.floor(r * n));
  }
}
