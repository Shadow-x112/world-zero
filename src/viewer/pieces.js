// What the AIs have built, piece by piece: every pole, stone, slab and mat the world
// holds, drawn where it really lies, at its real size and angle.
//
//   Look       black glass in the shape of what it is made of: knotted six-sided poles,
//              roughly dressed stones, chipped slabs, woven mats. Lit along its cut edges
//              (and a mat along its weave) in the colour of its material, with a trace of
//              the colour of whoever set it there.
//   Wear       a worn piece comes apart into pixels: square holes eat into it, their rims
//              lit, more of it gone the more worn it is. A piece about to give way glitches.
//   Coming     a new piece assembles out of pixels, its outline first.
//   Falling    pieces that come down tumble to where they lie, throwing up a burst of
//              square dust; rubble darkens as it wears away.
//   Seeing in  a roof near the camera (or over the one being followed) thins to its
//              lit outline, so whoever sleeps beneath can be seen.
//
// The shapes are made in Blender (tools/build_pieces.py), each filling a unit box; the
// renderer stretches them to each piece's length, width and thickness.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import CustomShaderMaterial from "three-custom-shader-material/vanilla";

export const FORM = { pole: 0, stone: 1, slab: 2, mat: 3 };
export const ROLE = { wall: 0, roof: 1, rubble: 2 };
const VARIANTS = [["pole0", "pole1"], ["stone0", "stone1", "stone2"], ["slab0", "slab1"], ["mat0"]];
const CAPACITY = 6000; // per variant
/** Soundness below which a piece shows it is failing. */
const FAILING = 150;
/** How long a new piece takes to assemble, and a falling one to land (seconds). */
const REZ_SECONDS = 1.1;
const FALL_SECONDS = 0.75;

/** Lit edges: barycentric coordinates per triangle, hiding edges between flat-joined faces. */
function withEdges(geo, flat = 0.995) {
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
  const edges = new Map();
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
    for (const [t, k] of [[t1, k1], [t2, k2]]) for (let v = 0; v < 3; v++) bary[(t * 3 + v) * 3 + k] += 1;
  }
  g.setAttribute("aBary", new THREE.BufferAttribute(bary, 3));
  return g;
}

const vertexShader = /* glsl */ `
  attribute vec3 aBary;
  attribute vec4 aState;   // wear (0 sound - 1 gone), born (s), role, failing
  attribute vec4 aLook;    // form, hue mix, see-through, seed
  attribute vec3 aSize;    // length, thickness, width (to keep pixels square on stretched shapes)
  uniform float uTime;
  varying vec3 vBary;
  varying vec4 vState;
  varying vec4 vLook;
  varying vec3 vTint;
  varying vec2 vUv2;
  varying vec3 vLocal;
  varying vec3 vLocalN;
  varying vec3 vWorldN;
  varying vec3 vWorldP;
  varying float vDepth;
  void main() {
    vec3 p = position;
    // Failing: the whole piece shivers in steps, like a bad signal.
    if (aState.w > 0.5) {
      float t = floor(uTime * 14.0 + aLook.w * 9.0);
      float j = fract(sin(t * 12.9898 + aLook.w * 78.233) * 43758.5453);
      p += (vec3(j, fract(j * 7.13), fract(j * 3.71)) - 0.5) * 0.04 / max(aSize, vec3(0.05));
    }
    csm_Position = p;
    vBary = aBary;
    vState = aState;
    vLook = aLook;
    vUv2 = uv;
    vLocal = position * aSize; // in tiles, so pixels come out square
    vLocalN = normal / max(aSize, vec3(0.01));
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
  uniform float uGlow;
  uniform float uFogDensity;
  uniform float uPixel;
  varying vec3 vBary;
  varying vec4 vState;
  varying vec4 vLook;
  varying vec3 vTint;
  varying vec2 vUv2;
  varying vec3 vLocal;
  varying vec3 vLocalN;
  varying vec3 vWorldN;
  varying vec3 vWorldP;
  varying float vDepth;
  float hash3(vec3 c) { return fract(sin(dot(c, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  float lineAt(float d, float w) { return 1.0 - smoothstep(0.0, fwidth(d) * 1.2 + w, d); }
  void main() {
    float wear = vState.x;
    float age = uTime - vState.y;
    float rubble = step(1.5, vState.z);
    float failing = vState.w;
    float form = vLook.x;
    float seeThrough = vLook.z;

    // Pixels: a square grid laid on each face (across the two axes it faces least along),
    // fixed to the piece so its holes stay put as it moves.
    vec3 an = abs(vLocalN);
    vec2 face; float axis;
    if (an.x >= an.y && an.x >= an.z) { face = vLocal.yz; axis = 0.0; }
    else if (an.y >= an.z) { face = vLocal.xz; axis = 1.0; }
    else { face = vLocal.xy; axis = 2.0; }
    vec2 cellP = face / uPixel + vLook.w * 3.1;
    vec3 cell = vec3(floor(cellP), axis * 17.0 + sign(dot(vLocalN, vec3(1.0, 2.0, 4.0))));
    vec2 inCell = fract(cellP);
    float h = hash3(cell + vLook.w * 31.0);
    // How much of it is gone: nothing until it is well worn, then more and more.
    float gone = smoothstep(0.35, 1.0, wear) * 0.9;
    // Assembling: pixels arrive in a random order over the first moments.
    float rez = clamp(age / ${REZ_SECONDS.toFixed(2)}, 0.0, 1.0);
    // Failing: pixels drop out and come back, flickering.
    float glitch = failing * step(0.82, hash3(cell + floor(uTime * 12.0)));
    float threshold = max(gone, 1.0 - rez);
    if (h < threshold || glitch > 0.5) discard;
    // A cell close to going is lit along its square rim: the pixel edge of the decay.
    vec2 sq = min(inCell, 1.0 - inCell);
    float rimSq = 1.0 - smoothstep(0.0, 0.12, min(sq.x, sq.y));
    float fraying = (1.0 - smoothstep(threshold, threshold + 0.2, h)) * step(0.001, threshold);

    vec3 N = normalize(vWorldN);
    vec3 V = normalize(cameraPosition - vWorldP);
    float rim = pow(1.0 - abs(dot(N, V)), 3.0);
    float e = min(min(vBary.x, vBary.y), vBary.z);
    float edge = 1.0 - smoothstep(0.0, fwidth(e) * 1.3 + 0.008, e);

    float light = edge * 0.75 + rim * 0.12;
    if (form > 2.5) {
      // A mat: its weave, threads both ways.
      float warp = lineAt(abs(fract(vUv2.x * 14.0) - 0.5), 0.05);
      float weft = lineAt(abs(fract(vUv2.y * 9.0) - 0.5), 0.05);
      light = max(light, 0.35 * max(warp, weft));
    } else if (form < 0.5) {
      // A pole: rings of grain along it.
      light = max(light, 0.18 * lineAt(abs(fract(vUv2.x * 7.0) - 0.5), 0.02));
    }
    light += fraying * (0.35 + rimSq * 1.8);              // the lit rims of the decay
    light *= 1.0 + 0.6 * failing * step(0.5, fract(uTime * 3.0)); // and a failing piece pulses
    light *= mix(1.0, 0.35, rubble);              // rubble is dim
    if (seeThrough > 0.5) {
      // Seen through: only its lit lines remain.
      if (light < 0.25) discard;
    }
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
    csm_Emissive = vTint * light * uGlow * (1.0 - fog);
  }
`;

/** Turns a piece's place and pose into a matrix (x, y engine ground; z up from the ground). */
function poseMatrix(p, groundY, out) {
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw), cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
  // Engine axes: x east, y south, z up. Three: x, y up, z = engine y.
  const L = new THREE.Vector3(cy * cp, sp, sy * cp);        // along its length
  const W = new THREE.Vector3(-sy, 0, cy);                  // across its width (always level)
  const T = new THREE.Vector3().crossVectors(W, L);          // through its thickness
  // (A hair smaller than true, so faces of pieces pressed together never fight.)
  out.makeBasis(L.multiplyScalar(p.l * 0.985), T.multiplyScalar(p.t * 0.97), W.multiplyScalar(-p.w * 0.985));
  out.setPosition(p.x, groundY + p.z, p.y);
  return out;
}

function variantOf(p) {
  const list = VARIANTS[p.f] ?? VARIANTS[1];
  return list[(p.id * 2654435761 >>> 0) % list.length];
}

export class Pieces {
  /**
   * scene: where to draw; renderer: for the environment map.
   * opts.env: an environment texture (reflections); opts.colorOf(materialId) -> THREE.Color;
   * opts.hueOf(agentId) -> THREE.Color or null; opts.groundY(x, y) -> height of the ground;
   * opts.uniforms: { uTime, uGlow, uFogDensity } shared with the rest of the scene.
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts;
    this.uniforms = { ...opts.uniforms, uPixel: { value: 0.06 } };
    this.meshes = new Map(); // variant -> InstancedMesh
    this.shown = new Map(); // id -> { p, from, born, landAt, fallFrom }
    this.dust = new Dust(scene, this.uniforms);
    this.pending = null;
    // (opts.glb: the shapes already in hand, as an ArrayBuffer; otherwise fetched.)
    const loader = new GLTFLoader();
    const shapes = opts.glb ? loader.parseAsync(opts.glb, "") : loader.loadAsync(opts.url ?? "/viewer/pieces.glb");
    this.ready = shapes.then((gltf) => this.build(gltf));
    this.followed = null; // {x, y}: a roof over this is seen through
    this.tints = new Map(); // material and builder -> line colour (forgotten on each gather)
    this.spot = new THREE.Vector3();
  }

  build(gltf) {
    for (const list of VARIANTS) {
      for (const name of list) {
        const src = gltf.scene.getObjectByName(name);
        if (!src) continue;
        const geo = withEdges(src.geometry.clone(), name.startsWith("mat") ? 0.9 : name.startsWith("stone") ? 0.97 : 0.995);
        const mat = new CustomShaderMaterial({
          baseMaterial: THREE.MeshStandardMaterial,
          vertexShader,
          fragmentShader,
          uniforms: this.uniforms,
          color: new THREE.Color("#05080c"),
          roughness: 0.16,
          metalness: 0.35,
          envMap: this.opts.env ?? null,
          envMapIntensity: this.opts.envIntensity ?? 0.9,
          side: name.startsWith("mat") ? THREE.DoubleSide : THREE.FrontSide,
        });
        const mesh = new THREE.InstancedMesh(geo, mat, CAPACITY);
        mesh.count = 0;
        mesh.frustumCulled = false;
        for (const [attr, size] of [["aState", 4], ["aLook", 4], ["aSize", 3]]) {
          geo.setAttribute(attr, new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * size), size));
        }
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
        this.scene.add(mesh);
        this.meshes.set(name, mesh);
      }
    }
    if (this.pending) this.set(this.pending.list, this.pending.now);
  }

  /** Line colour of a piece: its material's colour, with a trace of its builder's. */
  tint(p) {
    const key = p.m * 100003 + p.by;
    let c = this.tints.get(key);
    if (c) return c;
    c = (this.opts.colorOf?.(p.m) ?? new THREE.Color("#7fdfff")).clone();
    const hue = this.opts.hueOf?.(p.by);
    if (hue) c.lerp(hue, 0.3);
    c.multiplyScalar(1.25);
    this.tints.set(key, c);
    return c;
  }

  /**
   * The pieces now standing or lying (as the world sends them). New ones assemble; those
   * that became rubble fall from where they stood; those gone simply go.
   * now: seconds (the shader clock).
   */
  set(list, now) {
    if (this.meshes.size === 0) {
      this.pending = { list, now };
      return;
    }
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      const old = this.shown.get(p.id);
      if (!old) {
        // First sight of it: newly built, it assembles; merely newly in view, it is simply there.
        this.shown.set(p.id, { p, born: this.loaded && !p.fresh ? now : -100 });
      } else {
        if (old.p.r !== ROLE.rubble && p.r === ROLE.rubble) {
          old.fallFrom = old.p;
          old.fallAt = now;
        }
        old.p = p;
      }
    }
    for (const id of [...this.shown.keys()]) if (!seen.has(id)) this.shown.delete(id);
    this.loaded = true;
    this.layout(now);
  }

  layout(now) {
    const counts = new Map();
    for (const m of this.meshes.values()) counts.set(m, 0);
    const mtx = new THREE.Matrix4();
    const a = new THREE.Matrix4(), b = new THREE.Matrix4();
    const pa = new THREE.Vector3(), pb = new THREE.Vector3(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), s = new THREE.Vector3();
    this.falling = false;
    const cam = this.camera;
    for (const [id, item] of this.shown) {
      const p = item.p;
      const mesh = this.meshes.get(variantOf(p));
      if (!mesh) continue;
      const i = counts.get(mesh);
      if (i >= CAPACITY) continue;
      counts.set(mesh, i + 1);
      const g = this.opts.groundY?.(p.x, p.y) ?? 0;
      poseMatrix(p, g, mtx);
      if (item.fallFrom) {
        // Tumbling from where it stood to where it lies: gravity's ease, a little spin.
        const t = Math.min(1, (now - item.fallAt) / FALL_SECONDS);
        if (t < 1) {
          this.falling = true;
          poseMatrix(item.fallFrom, this.opts.groundY?.(item.fallFrom.x, item.fallFrom.y) ?? 0, a);
          b.copy(mtx);
          a.decompose(pa, qa, s);
          b.decompose(pb, qb, s);
          const k = t * t;
          pa.lerp(pb, k);
          qa.slerp(qb, Math.min(1, k * 1.15));
          mtx.compose(pa, qa, s);
        } else {
          if (!item.landed) {
            item.landed = true;
            this.dust.burst(new THREE.Vector3(p.x, g + 0.05, p.y), this.tint(p), now, p.l);
          }
        }
      }
      mesh.setMatrixAt(i, mtx);
      const wear = 1 - Math.max(0, Math.min(1000, p.hp)) / 1000;
      // A roof thins to its outline when the camera is close, or over the one followed.
      let see = 0;
      if (p.r === ROLE.roof) {
        if (this.followed && Math.abs(p.x - this.followed.x) < 1.2 && Math.abs(p.y - this.followed.y) < 1.2) see = 1;
        if (cam && cam.position.distanceTo(this.spot.set(p.x, g + p.z, p.y)) < (this.seeWithin ?? 9)) see = 1;
      }
      mesh.geometry.attributes.aState.setXYZW(i, wear, item.born, p.r, p.hp < FAILING && p.r !== ROLE.rubble ? 1 : 0);
      mesh.geometry.attributes.aLook.setXYZW(i, p.f, 0, see, (id % 997) / 997);
      mesh.geometry.attributes.aSize.setXYZ(i, p.l, p.t, p.w);
      mesh.setColorAt(i, this.tint(p));
    }
    for (const [mesh, n] of counts) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      for (const name of ["aState", "aLook", "aSize"]) mesh.geometry.attributes[name].needsUpdate = true;
    }
  }

  /** Each frame: carry on any falls, and keep see-through roofs to where the camera is. */
  update(now, camera) {
    this.camera = camera;
    this.dust.update(now);
    const moved = (this.seeWithin ?? 9) > 0 && (!this.lastCam || camera.position.distanceToSquared(this.lastCam) > 1);
    if (this.falling || moved || this.dirty) {
      this.layout(now);
      this.lastCam = camera.position.clone();
      this.dirty = false;
    }
  }

  /**
   * Gathers the pieces of every chunk within reach of the focus (call a few times a
   * second). A chunk newly in reach shows its pieces at once; one that changed while in
   * reach shows what came, fell or went.
   */
  gather(terrain, focus, range, now) {
    const size = 32;
    const r = Math.ceil(range / size) + 1;
    const fcx = Math.floor(focus.x / size), fcy = Math.floor(focus.z / size);
    const seen = new Map();
    let changed = false;
    const list = [];
    for (let cy = fcy - r; cy <= fcy + r; cy++) {
      for (let cx = fcx - r; cx <= fcx + r; cx++) {
        const d = terrain.chunk(cx, cy);
        if (!d || !d.pieces) continue;
        const k = `${cx},${cy}`;
        seen.set(k, d);
        const prev = this.seenChunks?.get(k);
        if (prev !== d) changed = true;
        for (const p of d.pieces) {
          p.fresh = !prev;
          list.push(p);
        }
      }
    }
    if (!changed && seen.size === (this.seenChunks?.size ?? 0)) return;
    this.seenChunks = seen;
    this.tints.clear();
    this.set(list, now);
  }

  follow(spot) {
    this.followed = spot;
    this.dirty = true;
  }

  setQuality(tier) {
    this.dust.enabled = tier !== "low";
    this.seeWithin = tier === "low" ? 0 : 9;
    this.dirty = true;
  }
}

/** Square dust: a burst where something lands, drifting and fading. */
class Dust {
  constructor(scene, uniforms) {
    this.max = 1500;
    this.enabled = true;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.col = new Float32Array(this.max * 3);
    this.born = new Float32Array(this.max).fill(-1e9);
    this.floor = new Float32Array(this.max);
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute("aBorn", new THREE.BufferAttribute(this.born, 1));
    this.points = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        uniforms: { uTime: uniforms.uTime, uGlow: uniforms.uGlow },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexColors: true,
        vertexShader: /* glsl */ `
          attribute float aBorn;
          uniform float uTime;
          varying vec3 vC;
          varying float vA;
          void main() {
            float age = uTime - aBorn;
            vA = clamp(1.0 - age / 1.6, 0.0, 1.0);
            vC = color;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = (vA > 0.0 ? 34.0 : 0.0) / -mv.z * (0.6 + 0.4 * vA);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uGlow;
          varying vec3 vC;
          varying float vA;
          void main() {
            // Square, with a brighter rim: dust as pixels.
            vec2 q = abs(gl_PointCoord - 0.5);
            float rim = step(0.36, max(q.x, q.y));
            gl_FragColor = vec4(vC * (0.5 + rim) * vA * uGlow, vA);
          }`,
      }),
    );
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.next = 0;
    this.last = 0;
  }

  burst(at, color, now, size = 1) {
    if (!this.enabled) return;
    const n = Math.round(40 + 40 * Math.min(2, size));
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      const a = Math.random() * Math.PI * 2, r = Math.random();
      this.pos.set([at.x + Math.cos(a) * r * 0.3 * size, at.y, at.z + Math.sin(a) * r * 0.3 * size], i * 3);
      this.vel.set([Math.cos(a) * (0.4 + r), 0.6 + Math.random() * 1.4, Math.sin(a) * (0.4 + r)], i * 3);
      this.col.set([color.r, color.g, color.b], i * 3);
      this.born[i] = now;
      this.floor[i] = at.y - 0.04;
    }
    const g = this.points.geometry;
    g.attributes.color.needsUpdate = true;
    g.attributes.aBorn.needsUpdate = true;
  }

  update(now) {
    const dt = Math.min(0.05, Math.max(0, now - this.last));
    this.last = now;
    let live = false;
    for (let i = 0; i < this.max; i++) {
      if (now - this.born[i] > 1.6) continue;
      live = true;
      this.vel[i * 3 + 1] -= 2.4 * dt;
      for (let k = 0; k < 3; k++) {
        this.vel[i * 3 + k] *= 1 - 1.8 * dt;
        this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
      }
      if (this.pos[i * 3 + 1] < this.floor[i]) this.pos[i * 3 + 1] = this.floor[i];
    }
    if (live) this.points.geometry.attributes.position.needsUpdate = true;
  }
}
