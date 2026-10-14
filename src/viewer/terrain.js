// The ground, drawn as a neon grid: one mesh per chunk, lit entirely by its own shader
// (no scene lights), so it reads clearly at night and costs little.
//
// World tile (x, y) is centred on integer coordinates and spans x-0.5..x+0.5. In the
// scene, world x -> scene X, world y -> scene Z, and height (whole levels) -> scene Y.

import * as THREE from "three";
import { CHUNK } from "./api.js";

/** Scene height of one ground level (a step an AI can climb). */
export const LEVEL_H = 0.5;
/** Unexplored ground is void: the known world's edges drop to this level. */
const VOID_LEVEL = -10;
const WALL_H = 1.6;
const ROOF_Y0 = 2.0;
const ROOF_Y1 = 2.14;
const INSET = 0.03;

const FACE_TOP = 0;
const FACE_SIDE = 1;
const FACE_BLOCK = 2;

const key = (cx, cy) => `${cx},${cy}`;
const floorDiv = (v) => Math.floor(v / CHUNK);
const mod = (v) => ((v % CHUNK) + CHUNK) % CHUNK;

const vertex = /* glsl */ `
  attribute vec4 aA; // face kind, terrain kind, material id, amount or soundness (0-1)
  attribute vec4 aB; // wear (0-1), top height (sides), u, v (blocks)
  varying vec3 vWorld;
  varying vec4 vA;
  varying vec4 vB;
  varying float vDepth;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vA = aA;
    vB = aB;
    vec4 mv = viewMatrix * wp;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const fragment = /* glsl */ `
  uniform vec3 uLine;
  uniform vec3 uBase;
  uniform vec3 uFog;
  uniform float uFogDensity;
  uniform float uGlow;
  uniform float uTime;
  uniform vec3 uWater;
  uniform vec3 uRidge;
  uniform sampler2D uPalette;
  uniform vec3 uPulseCenter;
  uniform float uPulseRadius;
  uniform vec3 uPulseColor;
  varying vec3 vWorld;
  varying vec4 vA;
  varying vec4 vB;
  varying float vDepth;

  // 1 on a tile edge, 0 elsewhere, antialiased; scale > 1 draws every Nth edge.
  float grid(vec2 p, float scale, float width) {
    vec2 q = p / scale;
    vec2 d = 0.5 - abs(fract(q) - 0.5);
    vec2 fw = fwidth(q) * width;
    vec2 l = 1.0 - smoothstep(vec2(0.0), fw, d);
    return max(l.x, l.y);
  }

  vec3 paletteColor(float id) {
    return texture2D(uPalette, vec2((id + 0.5) / 256.0, 0.5)).rgb;
  }

  void main() {
    float face = vA.x;
    float kind = vA.y;
    float mat = vA.z;
    float amt = vA.w;
    vec2 p = vWorld.xz + 0.5; // tile edges fall on whole numbers
    vec3 col = uBase;

    if (face < 0.5) {
      // Ground seen from above.
      float minor = grid(p, 1.0, 1.2);
      float major = grid(p, 8.0, 1.6);
      // Far away the fine grid would shimmer: let it fade into the coarse one.
      float far = smoothstep(60.0, 180.0, vDepth);
      if (kind > 1.5) {
        // Ridge: impassable. Hot edges, faint fill.
        col += uRidge * (0.02 + 0.8 * minor) * uGlow;
      } else if (kind > 0.5) {
        // Water: dark, with slow moving light.
        float w1 = sin(vWorld.x * 0.9 + uTime * 0.6 + sin(vWorld.z * 0.5 + uTime * 0.25) * 2.2);
        float w2 = sin(vWorld.z * 1.1 - uTime * 0.45 + sin(vWorld.x * 0.4) * 1.7);
        float wave = pow(0.5 + 0.25 * (w1 + w2), 6.0);
        col = uBase * 0.6 + uWater * (0.01 + 0.35 * wave + 0.06 * minor * (1.0 - far)) * uGlow;
      } else {
        // Fine lines are faint; every eighth line carries the season's color.
        col += uLine * (0.045 * minor * (1.0 - far) + 0.32 * major) * uGlow;
        // Worn paths: where feet go often, the tile's own lines burn brighter
        // (with only a whisper of fill), so trodden ground reads as traced light.
        col += uLine * vB.x * (0.006 + 0.42 * minor * (1.0 - far)) * uGlow;
        if (mat > 0.5) {
          // A small point of light at the tile's heart: what lies there, and how much.
          vec3 mc = paletteColor(mat);
          vec2 c = fract(p) - 0.5;
          float r = length(c);
          float px = fwidth(p.x);
          float node = 1.0 - smoothstep(0.06, 0.06 + px * 1.5, r);
          float halo = exp(-r * 14.0);
          float strength = 0.25 + 0.75 * amt;
          col += mc * (0.55 * node + 0.06 * halo) * strength * uGlow;
        }
      }
    } else if (face < 1.5) {
      // A drop between levels: dark wall, lit along its top edge.
      float below = max(vB.y - vWorld.y, 0.0);
      float edge = exp(-below * 14.0);
      vec3 lc = kind > 1.5 ? uRidge : (kind > 0.5 ? uWater : uLine);
      col = uBase * 0.5 + lc * (0.75 * edge + 0.006) * uGlow;
      // The far fall into the unknown fades out.
      col *= 1.0 - smoothstep(2.0, 5.0, below) * 0.85;
    } else {
      // Something built: a dark block with glowing edges, fading as it wears.
      vec2 uv = vB.zw;
      float e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
      float fw = fwidth(e) * 1.5;
      float edge = 1.0 - smoothstep(0.0, fw + 0.015, e);
      vec3 mc = mix(paletteColor(mat), vec3(1.0), 0.15);
      float sound = amt;
      float flicker = 1.0;
      if (sound < 0.3) {
        float n = fract(sin(floor(uTime * 9.0) * 12.9898 + vWorld.x * 78.233 + vWorld.z * 37.719) * 43758.5453);
        flicker = 0.55 + 0.45 * step(0.25, n);
      }
      col = vec3(0.002, 0.003, 0.006) + mc * (0.012 + edge * (0.3 + 0.8 * sound)) * uGlow * flicker;
    }

    // A season turning: a ring of the new color sweeps out over the land.
    if (uPulseRadius > 0.0) {
      float d = length(vWorld.xz - uPulseCenter.xz);
      float band = exp(-pow((d - uPulseRadius) / 3.0, 2.0)) + 0.35 * exp(-pow((d - uPulseRadius * 0.82) / 6.0, 2.0));
      float fade = 1.0 - smoothstep(150.0, 400.0, uPulseRadius);
      float lines = face < 0.5 ? (0.25 + grid(p, 1.0, 1.4) * 1.6) : 0.6;
      col += uPulseColor * band * fade * lines * 0.9;
    }

    float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
    gl_FragColor = vec4(mix(col, uFog, fog), 1.0);
  }
`;

/** How a material looks, from what the eye can tell: growing things green, glowing things violet, heavy things blue. */
function lookColor(looks) {
  const growth = looks.growth ?? 0;
  const energy = looks.energy ?? 0;
  const mass = looks.mass ?? 0;
  const c = new THREE.Color();
  if (energy > 0.7) c.setHSL(0.83, 1.0, 0.62);
  else if (growth > 0.55) c.setHSL(0.36 - growth * 0.06, 0.95, 0.55);
  else if (growth > 0.15) c.setHSL(0.24, 0.9, 0.55);
  else if (mass > 0.7) c.setHSL(0.6, 0.85, 0.62);
  else if (mass > 0.45) c.setHSL(0.08, 0.9, 0.58);
  else c.setHSL(0.52, 0.6, 0.65);
  return c;
}

/**
 * Far below the known world: a faint grid, one line per chunk, stretching away. The
 * unexplored is not empty; it simply has not been made yet.
 */
function makeVoid(scene, uniforms) {
  const geo = new THREE.PlaneGeometry(6000, 6000);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying float vDepth;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mv = viewMatrix * wp;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uLine;
      uniform vec3 uFog;
      uniform float uGlow;
      uniform vec3 uCenter;
      varying vec3 vWorld;
      varying float vDepth;
      void main() {
        vec2 q = (vWorld.xz + 0.5) / ${CHUNK.toFixed(1)};
        vec2 d = 0.5 - abs(fract(q) - 0.5);
        vec2 l = 1.0 - smoothstep(vec2(0.0), fwidth(q) * 1.6, d);
        float line = max(l.x, l.y);
        float reach = 1.0 - smoothstep(200.0, 1100.0, length(vWorld.xz - uCenter.xz));
        float a = line * 0.2 * uGlow * reach;
        gl_FragColor = vec4(uLine * 0.45, a);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = VOID_LEVEL * LEVEL_H - 0.01;
  mesh.renderOrder = -1;
  mesh.name = "void";
  scene.add(mesh);
  return mesh;
}

export class Terrain {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = "terrain";
    scene.add(this.group);
    this.chunks = new Map(); // key -> { data, mesh }
    this.dirty = new Set();
    this.paletteData = new Uint8Array(256 * 4);
    this.palette = new THREE.DataTexture(this.paletteData, 256, 1, THREE.RGBAFormat);
    this.palette.colorSpace = THREE.NoColorSpace;
    this.palette.magFilter = THREE.NearestFilter;
    this.palette.minFilter = THREE.NearestFilter;
    this.palette.needsUpdate = true;
    this.bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, any: false };
    this.material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uLine: { value: new THREE.Color("#2ee6ff") },
        uBase: { value: new THREE.Color("#04080e") },
        uFog: { value: new THREE.Color("#03060b") },
        uFogDensity: { value: 0.006 },
        uGlow: { value: 1 },
        uTime: { value: 0 },
        uWater: { value: new THREE.Color("#3f7bff") },
        uRidge: { value: new THREE.Color("#ff3d7f") },
        uPalette: { value: this.palette },
        uCenter: { value: new THREE.Vector3() },
        uPulseCenter: { value: new THREE.Vector3() },
        uPulseRadius: { value: -1 },
        uPulseColor: { value: new THREE.Color() },
      },
    });
    this.void = makeVoid(scene, this.material.uniforms);
  }

  /** Material looks from /api/palette. Colors go into the texture in linear space. */
  setPalette(materials) {
    for (const m of materials) {
      const c = lookColor(m.looks ?? m.props ?? {});
      const i = m.id * 4;
      this.paletteData[i] = Math.round(Math.min(1, c.r) * 255);
      this.paletteData[i + 1] = Math.round(Math.min(1, c.g) * 255);
      this.paletteData[i + 2] = Math.round(Math.min(1, c.b) * 255);
      this.paletteData[i + 3] = 255;
    }
    this.palette.needsUpdate = true;
  }

  /** A chunk arrived (new or changed): store it and redraw it and its neighbours' edges. */
  set(data) {
    const k = key(data.cx, data.cy);
    const had = this.chunks.get(k);
    if (had) had.data = data;
    else this.chunks.set(k, { data, mesh: null });
    this.dirty.add(k);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = key(data.cx + dx, data.cy + dy);
      if (this.chunks.has(n)) this.dirty.add(n);
    }
    const x0 = data.cx * CHUNK - 0.5;
    const z0 = data.cy * CHUNK - 0.5;
    const b = this.bounds;
    if (!b.any) Object.assign(b, { minX: x0, maxX: x0 + CHUNK, minZ: z0, maxZ: z0 + CHUNK, any: true });
    else {
      b.minX = Math.min(b.minX, x0);
      b.maxX = Math.max(b.maxX, x0 + CHUNK);
      b.minZ = Math.min(b.minZ, z0);
      b.maxZ = Math.max(b.maxZ, z0 + CHUNK);
    }
    this.material.uniforms.uCenter.value.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
  }

  revision(cx, cy) {
    return this.chunks.get(key(cx, cy))?.data.rev ?? -1;
  }

  has(cx, cy) {
    return this.chunks.has(key(cx, cy));
  }

  clear() {
    for (const { mesh } of this.chunks.values()) if (mesh) this.dispose(mesh);
    this.chunks.clear();
    this.dirty.clear();
    this.bounds.any = false;
  }

  /** Ground level of a tile, or null if no one has ever been near it. */
  levelAt(x, y) {
    const c = this.chunks.get(key(floorDiv(x), floorDiv(y)));
    if (!c) return null;
    return c.data.height[mod(y) * CHUNK + mod(x)];
  }

  /** Scene height of the ground under a point (for placing things on it). */
  groundY(x, y) {
    const l = this.levelAt(Math.round(x), Math.round(y));
    return (l ?? 0) * LEVEL_H;
  }

  blockAt(layer, x, y) {
    const c = this.chunks.get(key(floorDiv(x), floorDiv(y)));
    const a = c?.data[layer];
    return a ? a[mod(y) * CHUNK + mod(x)] : 0;
  }

  /** Rebuilds a few dirty chunks per frame so a big arrival never stalls the picture. */
  update(budget = 6) {
    let n = 0;
    for (const k of this.dirty) {
      this.dirty.delete(k);
      const c = this.chunks.get(k);
      if (!c) continue;
      const geom = this.build(c.data);
      if (c.mesh) {
        c.mesh.geometry.dispose();
        c.mesh.geometry = geom;
      } else {
        c.mesh = new THREE.Mesh(geom, this.material);
        c.mesh.matrixAutoUpdate = false;
        this.group.add(c.mesh);
      }
      if (++n >= budget) break;
    }
    return this.dirty.size;
  }

  dispose(mesh) {
    mesh.geometry.dispose();
    this.group.remove(mesh);
  }

  build(d) {
    const pos = [];
    const A = [];
    const B = [];
    const idx = [];
    const quad = (p0, p1, p2, p3, a, b0, b1, b2, b3) => {
      const base = pos.length / 3;
      pos.push(...p0, ...p1, ...p2, ...p3);
      for (let i = 0; i < 4; i++) A.push(...a);
      B.push(...b0, ...b1, ...b2, ...b3);
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    };
    const bx = d.cx * CHUNK;
    const by = d.cy * CHUNK;
    for (let ly = 0; ly < CHUNK; ly++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const i = ly * CHUNK + lx;
        const x = bx + lx;
        const y = by + ly;
        const level = d.height[i];
        const kind = d.terrain[i];
        const top = level * LEVEL_H;
        const x0 = x - 0.5, x1 = x + 0.5, z0 = y - 0.5, z1 = y + 0.5;
        const wear = Math.min(1, d.wear[i] / 60);
        const mat = d.material[i];
        const amount = mat ? Math.min(1, d.amount[i] / 20) : 0;
        // Top face (counter-clockwise seen from above).
        const bTop = [wear, top, 0, 0];
        quad([x0, top, z0], [x1, top, z0], [x1, top, z1], [x0, top, z1], [FACE_TOP, kind, mat, amount], bTop, bTop, bTop, bTop);

        // Drops toward lower neighbours (or into the void at the edge of the known world).
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          let nl = this.levelAt(x + dx, y + dy);
          if (nl === null) nl = VOID_LEVEL;
          if (nl >= level) continue;
          const bottom = nl * LEVEL_H;
          const s = [FACE_SIDE, kind, 0, 0];
          const bt = [0, top, 0, 0];
          if (dx === 1) quad([x1, top, z1], [x1, top, z0], [x1, bottom, z0], [x1, bottom, z1], s, bt, bt, bt, bt);
          else if (dx === -1) quad([x0, top, z0], [x0, top, z1], [x0, bottom, z1], [x0, bottom, z0], s, bt, bt, bt, bt);
          else if (dy === 1) quad([x0, top, z1], [x1, top, z1], [x1, bottom, z1], [x0, bottom, z1], s, bt, bt, bt, bt);
          else quad([x1, top, z0], [x0, top, z0], [x0, bottom, z0], [x1, bottom, z0], s, bt, bt, bt, bt);
        }

        // What has been built here.
        if (d.wall && d.wall[i]) {
          this.block(quad, x, y, top + 0.001, top + WALL_H, d.wall[i], d.wallHp[i] / 255, "wall");
        }
        if (d.roof && d.roof[i]) {
          this.block(quad, x, y, top + ROOF_Y0, top + ROOF_Y1, d.roof[i], d.roofHp[i] / 255, "roof");
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aA", new THREE.Float32BufferAttribute(A, 4));
    g.setAttribute("aB", new THREE.Float32BufferAttribute(B, 4));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }

  /** A box on a tile, leaving out faces shared with a neighbouring block of the same kind. */
  block(quad, x, y, y0, y1, mat, sound, layer) {
    const x0 = x - 0.5 + INSET, x1 = x + 0.5 - INSET, z0 = y - 0.5 + INSET, z1 = y + 0.5 - INSET;
    const a = [FACE_BLOCK, 0, mat, sound];
    const uv = (u, v) => [0, 0, u, v];
    const joined = (dx, dy) => this.blockAt(layer, x + dx, y + dy) !== 0;
    quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], a, uv(0, 0), uv(1, 0), uv(1, 1), uv(0, 1));
    if (layer === "roof") quad([x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0], a, uv(0, 0), uv(1, 0), uv(1, 1), uv(0, 1));
    if (!joined(1, 0)) quad([x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1], a, uv(0, 1), uv(1, 1), uv(1, 0), uv(0, 0));
    if (!joined(-1, 0)) quad([x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0], a, uv(0, 1), uv(1, 1), uv(1, 0), uv(0, 0));
    if (!joined(0, 1)) quad([x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1], a, uv(0, 1), uv(1, 1), uv(1, 0), uv(0, 0));
    if (!joined(0, -1)) quad([x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0], a, uv(0, 1), uv(1, 1), uv(1, 0), uv(0, 0));
  }
}
