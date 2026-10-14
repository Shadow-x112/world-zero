// The AIs: identical slim figures, dark inside with a glowing rim, all one color (they
// began the same; what tells them apart is what they do). A ring of light at the feet
// takes the color of what each is doing. Updates arrive twice a second; each figure
// glides between them, walks with a bob when moving, lies down to sleep, leans into
// a run when fleeing, and holds a small light overhead when carrying something.

import * as THREE from "three";

const GLIDE_MS = 550;
const MAX = 2048;
const CHILD_SCALE = 0.66;

/** Accent colors for what an AI is doing (linear values; above 1 glows). */
const ACCENT = {
  eat: [0.3, 1.6, 0.5],
  gather: [0.3, 1.6, 0.5],
  seekFood: [0.25, 1.1, 0.4],
  build: [1.8, 1.0, 0.2],
  tinker: [1.2, 0.4, 1.8],
  taste: [1.2, 0.4, 1.8],
  inspect: [1.2, 0.4, 1.8],
  flee: [2.4, 0.6, 0.1],
  take: [2.0, 0.15, 0.25],
  treat: [1.6, 0.6, 1.0],
  socialize: [0.5, 1.2, 2.0],
  follow: [0.5, 1.2, 2.0],
  explore: [0.4, 0.9, 1.4],
  idle: [0.25, 0.45, 0.6],
  sleep: [0.08, 0.14, 0.22],
  "": [0.25, 0.45, 0.6],
};
/** The accent of an action as a CSS color (for the interface). */
export function accentCss(action) {
  const a = ACCENT[action] ?? ACCENT[""];
  const m = Math.max(a[0], a[1], a[2], 1e-6);
  const c = (v) => Math.round(Math.min(1, (v / m) * 0.95 + 0.05) * 255);
  return `rgb(${c(a[0])}, ${c(a[1])}, ${c(a[2])})`;
}

const RIM = new THREE.Color(0.55, 1.5, 1.9);
const RIM_ASLEEP = new THREE.Color(0.1, 0.22, 0.32);
const CARRY = new THREE.Color(1.3, 1.15, 0.8);

/** Dark core, bright rim: the figure is drawn by its outline of light. */
function rimMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vC;
      void main() {
        mat4 m = modelMatrix * instanceMatrix;
        vec4 wp = m * vec4(position, 1.0);
        vec4 mv = viewMatrix * wp;
        vN = normalize(mat3(viewMatrix) * mat3(m) * normal);
        vV = normalize(-mv.xyz);
        vC = instanceColor;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vC;
      void main() {
        float f = 1.0 - max(dot(normalize(vN), normalize(vV)), 0.0);
        float rim = pow(f, 2.2);
        vec3 col = vec3(0.004, 0.008, 0.014) + vC * (0.06 + 1.25 * rim);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

function glowMaterial() {
  return new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
}

function instanced(geo, mat, name) {
  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, new THREE.Color());
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.name = name;
  return mesh;
}

export class Walkers {
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.list = new Map(); // id -> state
    this.size = 1;
    this.mates = new Map(); // id -> mate id

    // One smooth silhouette from feet to neck, turned like a figure on a lathe.
    const profile = [
      [0.0, 0.0], [0.085, 0.0], [0.1, 0.06], [0.09, 0.42], [0.13, 0.55], [0.155, 0.62],
      [0.135, 0.76], [0.155, 0.9], [0.195, 1.06], [0.205, 1.13], [0.15, 1.2], [0.07, 1.24], [0.065, 1.29], [0.0, 1.3],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const body = new THREE.LatheGeometry(profile, 18);
    body.computeVertexNormals();
    const head = new THREE.SphereGeometry(0.13, 16, 12);
    const ring = new THREE.RingGeometry(0.3, 0.38, 32);
    ring.rotateX(-Math.PI / 2);
    const carry = new THREE.OctahedronGeometry(0.075, 0);

    const rim = rimMaterial();
    this.body = instanced(body, rim, "bodies");
    this.head = instanced(head, rim, "heads");
    this.ring = instanced(ring, glowMaterial(), "rings");
    this.carry = instanced(carry, glowMaterial(), "carried");
    for (const m of [this.body, this.head, this.ring, this.carry]) scene.add(m);

    this.trails = new Trails(scene, terrain);
    this.links = new Links(scene);
    this.effects = new Effects(scene);

    this.o = new THREE.Object3D();
    this.o.rotation.order = "YXZ";
    this.q = new THREE.Quaternion();
    this.v = new THREE.Vector3();
    this.c = new THREE.Color();
    this.last = performance.now();
  }

  /** Without the glow effect, figures need a little more size to read. */
  setGlow(on) {
    this.size = on ? 1 : 1.25;
  }

  setMates(ais) {
    this.mates.clear();
    for (const a of ais) if (a.mate !== null) this.mates.set(a.id, a.mate);
  }

  fresh(a, now) {
    return { id: a.id, fx: a.x, fy: a.y, tx: a.x, ty: a.y, t0: now, a: a.a, c: a.c, k: a.k, h: a.h, yaw: yawOf(a.h), px: a.x, py: a.y, phase: Math.random() * 6, speed: 0, lean: 0, lie: a.a === "sleep" ? 1 : 0 };
  }

  snapshot(agents) {
    const now = performance.now();
    this.list.clear();
    this.trails.clear();
    for (const a of agents) this.list.set(a.id, this.fresh(a, now));
  }

  changes(c) {
    const now = performance.now();
    for (const a of c.agents) {
      const w = this.list.get(a.id);
      if (!w) {
        this.list.set(a.id, this.fresh(a, now));
        if (a.k) this.effects.birth(a.x, this.terrain.groundY(a.x, a.y), a.y);
        continue;
      }
      const [x, y] = this.at(w, now);
      Object.assign(w, { fx: x, fy: y, tx: a.x, ty: a.y, t0: now, a: a.a, c: a.c, k: a.k, h: a.h });
    }
    for (const id of c.gone) {
      const w = this.list.get(id);
      if (w) {
        const [x, y] = this.at(w, now);
        this.effects.death(x, this.terrain.groundY(x, y), y);
      }
      this.list.delete(id);
      this.trails.forget(id);
    }
  }

  at(w, now) {
    const k = Math.min(1, (now - w.t0) / GLIDE_MS);
    const e = k * k * (3 - 2 * k);
    return [w.fx + (w.tx - w.fx) * e, w.fy + (w.ty - w.fy) * e];
  }

  centroid() {
    let x = 0, z = 0, n = 0;
    for (const w of this.list.values()) {
      x += w.tx;
      z += w.ty;
      n++;
    }
    return n ? { x: x / n, z: z / n } : { x: 0, z: 0 };
  }

  /** Where a figure is drawn right now (for the camera and links). */
  position(id) {
    const w = this.list.get(id);
    return w ? { x: w.dx ?? w.tx, y: w.dy ?? w.ty, ground: w.gy ?? 0 } : null;
  }

  /** zoom: how far the camera is, as a size boost so figures stay findable from high up. */
  update(now, zoom = 1) {
    this.zoom = zoom;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const o = this.o;
    let i = 0;
    for (const w of this.list.values()) {
      if (i >= MAX) break;
      const [x, y] = this.at(w, now);
      // How fast it is going (smoothed), for the walk.
      const mx = x - w.px;
      const my = y - w.py;
      const moved = Math.hypot(mx, my);
      w.px = x;
      w.py = y;
      w.speed += ((dt > 0 ? moved / dt : 0) - w.speed) * Math.min(1, dt * 6);
      const asleep = w.a === "sleep";
      w.lie += ((asleep ? 1 : 0) - w.lie) * Math.min(1, dt * 2.5);
      const fleeing = w.a === "flee";
      w.lean += ((fleeing ? 0.35 : w.speed > 0.3 ? 0.08 : 0) - w.lean) * Math.min(1, dt * 4);
      // Face the way it is heading, turning smoothly.
      const target = moved > 0.002 ? Math.atan2(mx, my) : yawOf(w.h);
      w.yaw = turnToward(w.yaw, target, dt * 6);
      w.dx = x;
      w.dy = y;

      const gy = this.terrain.groundY(x, y);
      w.gy = gy;
      const s = this.size * zoom * (w.k ? CHILD_SCALE : 1);
      w.phase += dt * (2 + w.speed * 7);
      const walking = w.speed > 0.25 && !asleep;
      const bob = walking ? Math.abs(Math.sin(w.phase)) * 0.07 * s : Math.sin(w.phase * 0.5) * 0.006 * s;
      const building = w.a === "build" || w.a === "gather" || w.a === "tinker";
      const work = building && !walking ? Math.max(0, Math.sin(w.phase * 2.2)) * 0.05 * s : 0;

      // Body: upright, leaning into a run, or lying down (pivoting at the feet, then
      // shifted back so a sleeper lies where it stood).
      const tilt = w.lean + w.lie * (Math.PI / 2 - w.lean) + work;
      o.rotation.set(tilt, w.yaw, 0);
      this.q.setFromEuler(o.rotation);
      const fx = Math.sin(w.yaw), fz = Math.cos(w.yaw);
      const back = 0.68 * s * w.lie;
      const footY = gy + bob + 0.13 * s * w.lie;
      o.position.set(x - fx * back, footY, y - fz * back);
      o.scale.setScalar(s);
      o.updateMatrix();
      this.body.setMatrixAt(i, o.matrix);
      const fpx = o.position.x, fpz = o.position.z;

      // Head sits on the neck, wherever the body points.
      this.v.set(0, 1.42 * s, 0).applyQuaternion(this.q);
      o.position.set(fpx + this.v.x, footY + this.v.y, fpz + this.v.z);
      o.updateMatrix();
      this.head.setMatrixAt(i, o.matrix);
      const cy = footY;

      const rim = asleep ? this.c.copy(RIM_ASLEEP).lerp(RIM, 0.08 + 0.06 * Math.sin(now / 1400 + w.id)) : RIM;
      this.body.setColorAt(i, rim);
      this.head.setColorAt(i, rim);

      // The ring at its feet says what it is doing.
      const acc = ACCENT[w.a] ?? ACCENT[""];
      const pulse = w.a === "flee" ? 0.7 + 0.3 * Math.sin(now / 90) : asleep ? 0.6 + 0.4 * Math.sin(now / 1400 + w.id) : 1;
      o.rotation.set(0, 0, 0);
      o.position.set(x, gy + 0.03, y);
      o.scale.setScalar(s * (building ? 1 + 0.08 * Math.sin(w.phase * 2.2) : 1));
      o.updateMatrix();
      this.ring.setMatrixAt(i, o.matrix);
      this.ring.setColorAt(i, this.c.setRGB(acc[0] * pulse, acc[1] * pulse, acc[2] * pulse));

      // Something in hand: a small light overhead.
      if (w.c && !asleep) {
        o.position.set(fpx + this.v.x, cy + this.v.y + 0.34 * s + Math.sin(now / 400 + w.id) * 0.03, fpz + this.v.z);
        o.rotation.set(0, now / 900 + w.id, 0);
        o.scale.setScalar(s);
      } else {
        o.scale.setScalar(0);
      }
      o.updateMatrix();
      this.carry.setMatrixAt(i, o.matrix);
      this.carry.setColorAt(i, CARRY);

      this.trails.sample(w.id, x, gy, y, now, walking);
      i++;
    }
    for (const m of [this.body, this.head, this.ring, this.carry]) {
      m.count = i;
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.needsUpdate = true;
    }
    this.trails.update(now);
    this.links.update(this, now);
    this.effects.update(now);
  }
}

/** The world's heading (radians, x/y plane) as a turn about the scene's vertical axis. */
function yawOf(h) {
  return Math.atan2(Math.cos(h), Math.sin(h));
}

function turnToward(a, b, step) {
  let d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + Math.max(-step, Math.min(step, d));
}

/** Short fading trails behind moving figures: where everyone has been heading. */
class Trails {
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.points = new Map(); // id -> [{x, y, z, t}]
    this.maxPoints = 18;
    this.life = 6000;
    const segs = MAX * this.maxPoints;
    this.pos = new Float32Array(segs * 2 * 3);
    this.col = new Float32Array(segs * 2 * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.lines.frustumCulled = false;
    this.lines.name = "trails";
    scene.add(this.lines);
  }

  clear() {
    this.points.clear();
  }

  forget(id) {
    this.points.delete(id);
  }

  sample(id, x, gy, y, now, moving) {
    let list = this.points.get(id);
    if (!list) this.points.set(id, (list = []));
    const last = list[list.length - 1];
    if (moving && (!last || now - last.t > 300) && (!last || Math.hypot(x - last.x, y - last.z) > 0.15)) {
      list.push({ x, y: gy + 0.06, z: y, t: now });
      if (list.length > this.maxPoints) list.shift();
    }
    while (list.length && now - list[0].t > this.life) list.shift();
  }

  update(now) {
    let n = 0;
    const p = this.pos, c = this.col;
    for (const list of this.points.values()) {
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1], b = list[i];
        const fa = Math.pow(1 - (now - a.t) / this.life, 2) * 0.9;
        const fb = Math.pow(1 - (now - b.t) / this.life, 2) * 0.9;
        p.set([a.x, a.y, a.z, b.x, b.y, b.z], n * 6);
        c.set([0.3 * fa, 0.85 * fa, 1.0 * fa, 0.3 * fb, 0.85 * fb, 1.0 * fb], n * 6);
        n++;
      }
    }
    const g = this.lines.geometry;
    g.setDrawRange(0, n * 2);
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }
}

/** A faint line of light between mates who are near each other. */
class Links {
  constructor(scene) {
    const max = MAX;
    this.pos = new Float32Array(max * 2 * 3);
    this.col = new Float32Array(max * 2 * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.lines.frustumCulled = false;
    this.lines.name = "bonds";
    scene.add(this.lines);
  }

  update(figures, now) {
    let n = 0;
    for (const [id, mateId] of figures.mates) {
      if (mateId < id) continue; // each pair once
      const a = figures.list.get(id);
      const b = figures.list.get(mateId);
      if (!a || !b || a.dx === undefined || b.dx === undefined) continue;
      const d = Math.hypot(a.dx - b.dx, a.dy - b.dy);
      if (d > 30 || d < 0.3) continue;
      const near = 1 - d / 30;
      const asleep = a.a === "sleep" && b.a === "sleep";
      const pulse = (asleep ? 0.18 : 0.35) * near * (0.75 + 0.25 * Math.sin(now / 700 + id));
      const ha = asleep ? 0.25 : 1.0, hb = ha;
      this.pos.set([a.dx, a.gy + ha, a.dy, b.dx, b.gy + hb, b.dy], n * 6);
      this.col.set([1.4 * pulse, 0.45 * pulse, 1.0 * pulse, 1.4 * pulse, 0.45 * pulse, 1.0 * pulse], n * 6);
      n++;
    }
    const g = this.lines.geometry;
    g.setDrawRange(0, n * 2);
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }
}

/** A birth: a ring of light spreading out. A death: a column of light rising and fading. */
class Effects {
  constructor(scene) {
    this.list = [];
    this.scene = scene;
    this.ringGeo = new THREE.RingGeometry(0.4, 0.5, 48);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.beamGeo = new THREE.CylinderGeometry(0.12, 0.3, 1, 16, 1, true);
    this.beamGeo.translate(0, 0.5, 0);
  }

  add(mesh, kind, life) {
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.list.push({ mesh, kind, born: performance.now(), life });
  }

  birth(x, gy, y) {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.8, 1.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    m.position.set(x, gy + 0.05, y);
    this.add(m, "birth", 3500);
  }

  death(x, gy, y) {
    const m = new THREE.Mesh(this.beamGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 1.5, 1.9), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    m.position.set(x, gy, y);
    this.add(m, "death", 5000);
  }

  update(now) {
    this.list = this.list.filter((e) => {
      const k = (now - e.born) / e.life;
      if (k >= 1) {
        this.scene.remove(e.mesh);
        e.mesh.material.dispose();
        return false;
      }
      if (e.kind === "birth") {
        e.mesh.scale.setScalar(1 + k * 5);
        e.mesh.material.opacity = 1 - k;
      } else {
        e.mesh.scale.set(1 - k * 0.6, 2 + k * 14, 1 - k * 0.6);
        e.mesh.material.opacity = (1 - k) * (1 - k);
      }
      return true;
    });
  }
}
