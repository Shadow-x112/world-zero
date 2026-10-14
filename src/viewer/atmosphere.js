// Atmosphere: the warm, chaotic things in a cool, orderly world.
//  - Fire: flickering shards of flame rising from each burning tile, and a warm glow
//    on the ground around it (fires are streamed tile by tile as they light and die).
//  - Snow: in the cold season, falling around wherever you are looking; heavier in a
//    hard or bitter winter. (The world has no rain, so neither does the picture.)
//  - The turn of a season: a ring of light sweeps out across the land in the new
//    season's color.

import * as THREE from "three";

const MAX_FIRES = 512;
const SHARDS = 9; // flame shards per burning tile

export class Fires {
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.tiles = new Map(); // "x,y" -> { x, y, seed, born }
    const shard = new THREE.ConeGeometry(0.07, 0.7, 4, 1, true);
    shard.translate(0, 0.35, 0);
    this.flames = new THREE.InstancedMesh(
      shard,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
      MAX_FIRES * SHARDS,
    );
    this.flames.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flames.setColorAt(0, new THREE.Color());
    this.flames.count = 0;
    this.flames.frustumCulled = false;
    this.flames.name = "flames";
    scene.add(this.flames);

    // A warm pool of light on the ground (the world's glow reaches about five tiles).
    const disc = new THREE.CircleGeometry(5, 40);
    disc.rotateX(-Math.PI / 2);
    this.glow = new THREE.InstancedMesh(
      disc,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: /* glsl */ `
          varying vec2 vLocal;
          varying float vSeed;
          void main() {
            vLocal = position.xz / 5.0;
            vSeed = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.71;
            gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          varying vec2 vLocal;
          varying float vSeed;
          void main() {
            float r = length(vLocal);
            float flicker = 0.85 + 0.15 * sin(uTime * 13.0 + vSeed) * sin(uTime * 7.3 + vSeed * 2.0);
            // Neighbouring fires overlap, so each adds only a little warmth.
            float a = pow(max(0.0, 1.0 - r), 2.6) * 0.09 * flicker;
            gl_FragColor = vec4(vec3(1.0, 0.32, 0.06) * a, 1.0);
          }
        `,
        uniforms: { uTime: { value: 0 } },
      }),
      MAX_FIRES,
    );
    this.glow.count = 0;
    this.glow.frustumCulled = false;
    this.glow.name = "fireglow";
    scene.add(this.glow);
    this.o = new THREE.Object3D();
    this.c = new THREE.Color();
  }

  set(list) {
    this.tiles.clear();
    for (const [x, y] of list) this.light(x, y);
  }

  light(x, y) {
    const k = `${x},${y}`;
    if (!this.tiles.has(k)) this.tiles.set(k, { x, y, seed: Math.random() * 100, born: performance.now() });
  }

  out(x, y) {
    this.tiles.delete(`${x},${y}`);
  }

  changes(f) {
    if (!f) return;
    for (const [x, y] of f.lit) this.light(x, y);
    for (const [x, y] of f.out) this.out(x, y);
  }

  get count() {
    return this.tiles.size;
  }

  update(time) {
    const o = this.o;
    let n = 0;
    let g = 0;
    for (const f of this.tiles.values()) {
      if (g >= MAX_FIRES) break;
      const gy = this.terrain.groundY(f.x, f.y);
      const grow = Math.min(1, (performance.now() - f.born) / 1500);
      o.rotation.set(0, 0, 0);
      o.position.set(f.x, gy + 0.02, f.y);
      o.scale.setScalar(0.6 + 0.4 * grow);
      o.updateMatrix();
      this.glow.setMatrixAt(g++, o.matrix);
      for (let i = 0; i < SHARDS; i++) {
        // Each shard rises, sways and dies, then is born again at the base.
        const s = f.seed + i * 7.13;
        const life = 0.9 + 0.5 * frac(Math.sin(s) * 43758.5);
        const t = frac((time + s) / life);
        const ox = Math.sin(s * 3.1) * 0.32 + Math.sin(time * 3 + s) * 0.05;
        const oz = Math.cos(s * 2.3) * 0.32 + Math.cos(time * 2.6 + s) * 0.05;
        const h = (0.5 + 0.9 * frac(Math.sin(s * 1.7) * 9123.1)) * grow;
        o.position.set(f.x + ox * (1 - t * 0.5), gy + t * 0.9 * h, f.y + oz * (1 - t * 0.5));
        o.rotation.set(Math.sin(time * 4 + s) * 0.25, s, Math.cos(time * 3.3 + s) * 0.25);
        const size = (1 - t) * (0.7 + 0.6 * h);
        o.scale.set(size, size * (1.2 + h), size);
        o.updateMatrix();
        this.flames.setMatrixAt(n, o.matrix);
        // White-yellow at the root, orange, then a deep red as it fades.
        const heat = 1 - t;
        this.c.setRGB(1.25 * heat + 0.3, 0.42 * heat * heat + 0.04, 0.06 * heat * heat * heat + 0.01);
        this.flames.setColorAt(n, this.c);
        n++;
      }
    }
    this.flames.count = n;
    this.glow.count = g;
    this.flames.instanceMatrix.needsUpdate = true;
    this.flames.instanceColor.needsUpdate = true;
    this.glow.instanceMatrix.needsUpdate = true;
    this.glow.material.uniforms.uTime.value = time;
  }
}

function frac(v) {
  return v - Math.floor(v);
}

/** Snow, falling in a box that travels with the camera's focus. */
export class Snow {
  constructor(scene) {
    this.max = 6000;
    this.box = 140;
    this.height = 60;
    const pos = new Float32Array(this.max * 3);
    const seed = new Float32Array(this.max);
    for (let i = 0; i < this.max; i++) {
      pos[i * 3] = Math.random() * this.box;
      pos[i * 3 + 1] = Math.random() * this.height;
      pos[i * 3 + 2] = Math.random() * this.box;
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uOrigin: { value: new THREE.Vector3() },
        uBox: { value: this.box },
        uHeight: { value: this.height },
        uAmount: { value: 0 },
        uPixel: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        uniform vec3 uOrigin;
        uniform float uBox;
        uniform float uHeight;
        uniform float uAmount;
        uniform float uPixel;
        varying float vAlpha;
        void main() {
          // Falls slowly, drifts sideways, wraps around the box centred on the focus.
          vec3 p = position;
          p.y = mod(p.y - uTime * (1.2 + aSeed * 1.1), uHeight);
          p.x += sin(uTime * 0.6 + aSeed * 40.0) * 1.2 + uTime * 0.4;
          p.z += cos(uTime * 0.5 + aSeed * 30.0) * 1.2;
          vec3 base = uOrigin - vec3(uBox * 0.5, 4.0, uBox * 0.5);
          p.xz = mod(p.xz - base.xz, uBox) + base.xz;
          p.y += base.y;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min(uPixel * 5.0, uPixel * (1.4 + aSeed * 1.8) * 60.0 / max(-mv.z, 1.0));
          // Only part of the flakes show in a mild winter; all of them in a bitter one.
          vAlpha = step(aSeed, uAmount) * smoothstep(uHeight, uHeight * 0.7, p.y - base.y) * smoothstep(160.0, 40.0, -mv.z);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          float a = smoothstep(0.5, 0.0, d) * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(0.7, 0.85, 1.0) * a * 0.55, 1.0);
        }
      `,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.name = "snow";
    scene.add(this.points);
    this.amount = 0;
    this.target = 0;
  }

  /** How much snow: 0 out of the cold season; more the harsher the winter. */
  setWinter(season, winter) {
    if (season !== "cold") this.target = 0;
    else this.target = { mild: 0.25, ordinary: 0.45, hard: 0.7, bitter: 1 }[winter] ?? 0.45;
  }

  update(time, dt, focus, pixelRatio) {
    this.amount += (this.target - this.amount) * Math.min(1, dt * 0.15);
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uOrigin.value.copy(focus);
    u.uAmount.value = this.amount;
    u.uPixel.value = pixelRatio;
    this.points.visible = this.amount > 0.005;
  }
}

/** A ring of light sweeping out across the land when a season turns. */
export class SeasonPulse {
  constructor(terrainMaterial) {
    this.u = terrainMaterial.uniforms; // uPulseCenter / uPulseRadius / uPulseColor live in the ground shader
    this.start = -1;
  }

  fire(center, color) {
    this.u.uPulseCenter.value.copy(center);
    this.u.uPulseColor.value.copy(color);
    this.start = performance.now();
  }

  update(now) {
    if (this.start < 0) return;
    const t = (now - this.start) / 1000;
    if (t > 9) {
      this.start = -1;
      this.u.uPulseRadius.value = -1;
      return;
    }
    this.u.uPulseRadius.value = t * 45;
  }
}
