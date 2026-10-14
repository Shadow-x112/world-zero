// The AIs, for now as simple points of light gliding over the ground (their figures
// come in step 7c). Updates arrive twice a second; each AI eases from where it is
// drawn toward where it now stands, so movement stays smooth.

import * as THREE from "three";

const GLIDE_MS = 550;
const MAX = 2048;

export class Walkers {
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.list = new Map(); // id -> { fx, fy, tx, ty, t0, a }
    const geo = new THREE.SphereGeometry(0.28, 12, 8);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 2.2, 2.4), toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = "walkers";
    scene.add(this.mesh);
    this.m = new THREE.Matrix4();
    this.dim = new THREE.Color(0.35, 0.5, 0.6);
    this.bright = new THREE.Color(1, 1, 1);
    this.size = 1;
  }

  /** Without the glow effect, points of light need to be bigger to be seen. */
  setGlow(on) {
    this.size = on ? 1 : 1.7;
  }

  snapshot(agents) {
    this.list.clear();
    const now = performance.now();
    for (const a of agents) this.list.set(a.id, { fx: a.x, fy: a.y, tx: a.x, ty: a.y, t0: now, a: a.a });
  }

  changes(c) {
    const now = performance.now();
    for (const a of c.agents) {
      const w = this.list.get(a.id);
      if (!w) {
        this.list.set(a.id, { fx: a.x, fy: a.y, tx: a.x, ty: a.y, t0: now, a: a.a });
        continue;
      }
      const [x, y] = this.at(w, now);
      Object.assign(w, { fx: x, fy: y, tx: a.x, ty: a.y, t0: now, a: a.a });
    }
    for (const id of c.gone) this.list.delete(id);
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

  update(now) {
    let i = 0;
    for (const w of this.list.values()) {
      if (i >= MAX) break;
      const [x, y] = this.at(w, now);
      const gy = this.terrain.groundY(x, y);
      const asleep = w.a === "sleep";
      const s = this.size;
      this.m.makeScale(s, (asleep ? 0.6 : 1) * s, s).setPosition(x, gy + (asleep ? 0.2 : 0.55) * s, y);
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, asleep ? this.dim : this.bright);
      i++;
    }
    this.mesh.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
