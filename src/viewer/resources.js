// What lies on the land, in 3D: every material is shaped from how it looks (never from
// what it truly is), so a viewer sees only what an AI could see.
//
//   growing things  tall faceted stalks of dark glass with glowing veins, swaying
//   heavy things    low clusters of angular shards with bright cut edges
//   glowing things  floating crystals that turn slowly and pulse
//
// A material that is a little of each borrows from each (a heavy growing thing has
// broad, stiff blades; a glowing stone floats low). Each tile shows one to four pieces
// at fixed spots, sized by how much is left, so a patch visibly shrinks as it is eaten
// and fills back as it grows. Only the near ground is drawn this way; beyond it, the
// ground shader shows each tile's material as a small point of light.

import * as THREE from "three";
import { CHUNK } from "./api.js";
import { LEVEL_H } from "./terrain.js";

const PLANT = 0, STONE = 1, CRYSTAL = 2;
const CAPACITY = [24000, 16000, 6000];

/** Deterministic 0-1 noise for a tile and a slot, so pieces never jump around. */
function rand(x, y, k) {
  let h = (x * 374761393 + y * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ---------- Shapes (unit sized; non-indexed, with barycentrics for lit edges) ----------

/** Builds a geometry from triangles [[a, b, c], ...] of [x, y, z] points; h = height 0-1 at each vertex. */
function triangles(tris, height) {
  const pos = [], bary = [], hgt = [];
  const B = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (const t of tris) {
    for (let i = 0; i < 3; i++) {
      pos.push(...t[i]);
      bary.push(...B[i]);
      hgt.push(Math.max(0, Math.min(1, t[i][1] / height)));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aBary", new THREE.Float32BufferAttribute(bary, 3));
  g.setAttribute("aH", new THREE.Float32BufferAttribute(hgt, 1));
  g.computeBoundingSphere();
  return g;
}

/** A tapered spike: n-sided base of radius r at (bx, 0, bz), tip at (tx, h, tz). */
function spike(out, n, r, bx, bz, tx, h, tz, twist = 0) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = twist + (i / n) * Math.PI * 2;
    ring.push([bx + Math.cos(a) * r, 0, bz + Math.sin(a) * r]);
  }
  const tip = [tx, h, tz];
  for (let i = 0; i < n; i++) out.push([ring[i], tip, ring[(i + 1) % n]]);
}

/** An irregular gem resting on the ground: a ring of points, a top and a squashed base. */
function shard(out, r, h, cx, cz, seed) {
  const n = 5;
  const mid = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + seed;
    const rr = r * (0.75 + 0.5 * rand(i, 7, Math.floor(seed * 100)));
    mid.push([cx + Math.cos(a) * rr, h * (0.3 + 0.2 * rand(i, 3, Math.floor(seed * 50))), cz + Math.sin(a) * rr]);
  }
  const top = [cx + r * 0.25 * Math.cos(seed * 3), h, cz + r * 0.25 * Math.sin(seed * 3)];
  const base = [cx, 0, cz];
  for (let i = 0; i < n; i++) {
    const a = mid[i], b = mid[(i + 1) % n];
    out.push([a, top, b]);
    out.push([b, base, a]);
  }
}

/** A double-pointed crystal, centred at the origin. */
function bipyramid(out, n, r, h) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push([Math.cos(a) * r, 0, Math.sin(a) * r]);
  }
  const top = [0, h * 0.6, 0];
  const bottom = [0, -h * 0.4, 0];
  for (let i = 0; i < n; i++) {
    out.push([ring[i], top, ring[(i + 1) % n]]);
    out.push([ring[(i + 1) % n], bottom, ring[i]]);
  }
}

function plantShape() {
  const t = [];
  spike(t, 4, 0.045, 0, 0, 0.02, 1.0, 0.01, 0.3);
  spike(t, 4, 0.04, 0.09, 0.03, 0.2, 0.72, 0.06, 1.1);
  spike(t, 4, 0.04, -0.07, 0.07, -0.18, 0.62, 0.17, 0.5);
  spike(t, 4, 0.035, -0.02, -0.09, -0.04, 0.5, -0.24, 0.9);
  spike(t, 3, 0.03, 0.05, -0.06, 0.15, 0.38, -0.17, 0.2);
  return triangles(t, 1.0);
}

function stoneShape() {
  const t = [];
  shard(t, 0.2, 0.42, 0, 0, 0.4);
  shard(t, 0.12, 0.26, 0.2, 0.1, 1.7);
  shard(t, 0.1, 0.2, -0.14, 0.16, 2.9);
  return triangles(t, 0.42);
}

function crystalShape() {
  const t = [];
  bipyramid(t, 6, 0.11, 0.62);
  const g = triangles(t, 0.62);
  // Height runs from the lower tip (0) to the upper (1).
  const p = g.attributes.position, h = g.attributes.aH;
  for (let i = 0; i < p.count; i++) h.setX(i, (p.getY(i) + 0.62 * 0.4) / 0.62);
  return g;
}

// ---------- Look ----------

function material(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute vec3 aBary;
      attribute float aH;
      attribute vec4 aInst; // phase, kind, fullness, fade
      uniform float uTime;
      varying vec3 vBary;
      varying float vH;
      varying vec3 vWorld;
      varying vec3 vC;
      varying vec4 vI;
      varying float vDepth;
      void main() {
        vec3 p = position;
        float kind = aInst.y;
        if (kind > 1.5) {
          // Floating crystals turn slowly and bob.
          float a = uTime * 0.5 + aInst.x;
          float c = cos(a), s = sin(a);
          p.xz = mat2(c, -s, s, c) * p.xz;
          p.y += sin(uTime * 1.1 + aInst.x * 2.0) * 0.05;
        } else if (kind < 0.5) {
          // Stalks sway a little, more at the tip.
          float sway = sin(uTime * 0.9 + aInst.x) * 0.05 + sin(uTime * 2.3 + aInst.x * 3.0) * 0.012;
          p.x += aH * aH * sway;
          p.z += aH * aH * sway * 0.6;
        }
        vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        vBary = aBary;
        vH = aH;
        vC = instanceColor;
        vI = aInst;
        vec4 mv = viewMatrix * wp;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uGlow;
      uniform vec3 uFog;
      uniform float uFogDensity;
      uniform vec3 uHorizon;
      uniform float uCold;
      varying vec3 vBary;
      varying float vH;
      varying vec3 vWorld;
      varying vec3 vC;
      varying vec4 vI;
      varying float vDepth;
      void main() {
        float kind = vI.y;
        float full = vI.z;
        // Faceted: each face is flat, so its normal comes from the surface itself.
        vec3 N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
        vec3 V = normalize(cameraPosition - vWorld);
        float fr = pow(1.0 - abs(dot(N, V)), 2.5);
        float e = min(min(vBary.x, vBary.y), vBary.z);
        float edge = 1.0 - smoothstep(0.0, fwidth(e) * 1.4 + 0.004, e);
        vec3 col = vec3(0.002, 0.003, 0.005) + uHorizon * fr * 0.12;
        float bright;
        if (kind < 0.5) {
          // Stalks: veins brighten toward the tip; the cold dims what grows.
          float vein = 0.2 + 0.9 * vH * vH;
          bright = (0.015 + 0.12 * fr) * vein + edge * (0.12 + 0.6 * vH * vH);
          bright *= 1.0 - 0.55 * uCold;
        } else if (kind < 1.5) {
          // Stone: dark faces, sharp bright cuts.
          bright = 0.01 + 0.08 * fr + edge * 0.55;
        } else {
          // Glowing crystals: bright through and through, pulsing.
          float pulse = 0.7 + 0.3 * sin(uTime * 2.0 + vI.x * 5.0);
          bright = (0.06 + 0.25 * fr + edge * 0.8) * pulse;
        }
        col += vC * bright * (0.55 + 0.45 * full) * uGlow;
        float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
        gl_FragColor = vec4(mix(col, uFog, fog), 1.0);
      }
    `,
  });
}

// ---------- Placement ----------

/** Which shape a material takes, and its proportions, from how it looks. */
function shapeOf(looks) {
  const growth = looks.growth ?? 0, mass = looks.mass ?? 0, energy = looks.energy ?? 0;
  if (energy >= 0.5) return { kind: CRYSTAL, height: 0.7 + 0.5 * energy, width: 0.8 + 0.8 * mass, lift: 0.35 + 0.5 * (1 - mass) };
  if (growth >= 0.15) return { kind: PLANT, height: 0.35 + 0.75 * growth, width: 0.8 + 1.4 * mass, lift: 0 };
  return { kind: STONE, height: 0.5 + 0.8 * mass, width: 0.6 + 0.9 * mass, lift: 0 };
}

export class Resources {
  /** uniforms: shared with the ground (time, glow, fog, horizon). */
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.uniforms = {
      uTime: terrain.material.uniforms.uTime,
      uGlow: terrain.material.uniforms.uGlow,
      uFog: terrain.material.uniforms.uFog,
      uFogDensity: terrain.material.uniforms.uFogDensity,
      uHorizon: terrain.material.uniforms.uHorizon,
      uCold: { value: 0 },
    };
    const mat = material(this.uniforms);
    this.meshes = [plantShape(), stoneShape(), crystalShape()].map((geo, kind) => {
      const m = new THREE.InstancedMesh(geo, mat, CAPACITY[kind]);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, new THREE.Color());
      const inst = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY[kind] * 4), 4);
      inst.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("aInst", inst);
      m.count = 0;
      m.frustumCulled = false;
      m.name = ["plants", "stones", "crystals"][kind];
      scene.add(m);
      return m;
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

  setSeason(season) {
    this.uniforms.uCold.value = season === "cold" ? 1 : season === "decline" ? 0.3 : 0;
  }

  setEnabled(on) {
    this.enabled = on;
    for (const m of this.meshes) m.visible = on;
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
    const counts = [0, 0, 0];
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
            const mesh = this.meshes[s.kind];
            for (let k = 0; k < pieces; k++) {
              const n = counts[s.kind];
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
              counts[s.kind] = n + 1;
            }
          }
        }
      }
    }
    for (let k = 0; k < 3; k++) {
      const m = this.meshes[k];
      m.count = counts[k];
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.geometry.attributes.aInst.needsUpdate = true;
    }
    this.counts = counts;
  }
}
