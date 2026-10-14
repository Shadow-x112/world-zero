// The AIs' bodies, from the model made in Blender (tools/build_body.py): one smooth
// surface of dark glass on bird-like legs, a lens-shaped head floating over the
// shoulders, two tendrils for arms and three arching from the back, with a glowing orb
// in the chest. Lines of light run along the body in each one's own color, with a pulse
// travelling out from the chest; the tendrils end in points of light.
//
// Everything about how a body looks and moves comes from the life it has lived, as the
// world reports it (never invented here):
//
//   color     its own hue, from its quirks; children carry a blend of their parents'
//   courage   the fearless stand tall and straight; the timid hunch, tendrils held close
//   industry  the tireless are broad and heavy-legged; dreamers are slight
//   wander    seekers are long-legged, their tendrils long and never still
//   warmth    the warm-hearted reach toward whoever they are with
//   cheer     sunny natures glow brighter; somber ones dimmer
//   age       children are small with big heads; elders stoop and their light softens
//   skills    each skill truly learned shows as a ring of light on the body
//
// The orb shows how it is inside: steady when well, fluttering in fear, slow and dim in
// grief or loneliness, failing and flickering when hurt, sick or starving, a slow breath
// while asleep. Its light shows through the glass around it.
//
// Every body moves by turning its bones a little each frame (no recorded animation), so
// each one walks, gathers, eats, builds, talks, flees and sleeps in its own way.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import CustomShaderMaterial from "three-custom-shader-material/vanilla";

const clamp1 = (v) => Math.max(-1, Math.min(1, v));
const smooth = (a, b, v) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const WHITE = new THREE.Color(1, 1, 1);
/** Beyond this distance from the eye a body is shown only as its orb's light. */
const FAR = 75;
/** The model is made life-size (about 1.6 tall); in the world it stands a little smaller. */
const BASE = 0.82;

// ---------- The glass ----------

const vertexShader = /* glsl */ `
  attribute vec2 aAng;
  attribute vec2 aInfo;
  varying vec2 vAng;
  varying vec2 vInfo;
  varying vec3 vBind;
  varying vec3 vWorldN;
  varying vec3 vWorldP;
  void main() {
    vAng = vec2(aAng.x, 1.0 - aAng.y);    // (cos, sin) of the angle around the limb
    vInfo = vec2(aInfo.x, 1.0 - aInfo.y); // (distance from the chest, part + along)
    vBind = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldP = wp.xyz;
    vWorldN = normalize(mat3(modelMatrix) * normal);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uGlow;
  uniform float uOrb;
  uniform float uTime;
  uniform float uSeed;
  uniform vec4 uRings; // skill rings: distance from the chest of each, 0 = none
  varying vec2 vAng;
  varying vec2 vInfo;
  varying vec3 vBind;
  varying vec3 vWorldN;
  varying vec3 vWorldP;

  float lineAt(float d, float w) {
    return 1.0 - smoothstep(0.0, fwidth(d) * 1.2 + w, d);
  }

  void main() {
    float part = floor(vInfo.y + 0.001);
    float along = fract(vInfo.y + 0.001) / 0.98;
    float fromChest = vInfo.x;
    vec3 V = normalize(cameraPosition - vWorldP);
    float facing = abs(dot(normalize(vWorldN), V));
    float rim = pow(1.0 - facing, 3.0);

    float light = 0.0;
    if (part < 3.5) {
      // Lines of light running along the body: three around the body and legs, two
      // along each tendril.
      float a = atan(vAng.y, vAng.x) / 6.2831853;
      float n = part < 1.5 ? 3.0 : 2.0;
      float q = fract(a * n + 0.5) - 0.5;
      float l = lineAt(abs(q) / n, 0.0035);
      float pulse = 0.55 + 0.45 * sin(fromChest * 11.0 - uTime * 2.6 + uSeed);
      light += l * pulse * (part < 1.5 ? 0.9 : 1.1);
      // The tendrils brighten toward their tips, which end in a point of light.
      if (part > 1.5) light += smoothstep(0.86, 1.0, along) * 2.4 + along * 0.15;
      // Skill rings.
      for (int i = 0; i < 4; i++) {
        if (uRings[i] > 0.0 && part < 0.5) light += 1.3 * lineAt(abs(fromChest - uRings[i]), 0.004);
      }
    } else {
      // The head: a thin slit of light across the front of the lens.
      float visor = lineAt(abs(vBind.y - 1.598), 0.0015) * smoothstep(0.06, 0.13, vBind.z);
      light += 1.6 * visor;
    }

    // The orb's light, seen through the glass around the chest.
    float d = length(vBind - vec3(0.0, 1.3, 0.01));
    float inner = exp(-d * 15.0) * uOrb;

    csm_Emissive = uColor * (light * uGlow + rim * 0.18 * uGlow + inner * 0.55);
  }
`;

/** A small world for the glass to reflect: black, with a band of light along the horizon. */
function makeEnvironment(renderer) {
  const env = new THREE.Scene();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(10, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        varying vec3 vD;
        void main() {
          float y = vD.y;
          vec3 col = vec3(0.004, 0.01, 0.018) * (1.0 - smoothstep(0.0, 0.6, y));
          col += vec3(0.25, 0.75, 1.0) * exp(-pow(y / 0.035, 2.0)) * 1.4;   // the horizon line
          col += vec3(0.1, 0.35, 0.55) * exp(-abs(y) / 0.12) * 0.35;       // its glow
          col += vec3(0.6, 0.85, 1.0) * smoothstep(0.92, 1.0, y) * 0.25;   // a soft light from above
          gl_FragColor = vec4(col, 1.0);
        }`,
    }),
  );
  env.add(sky);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(env, 0.02).texture;
  pm.dispose();
  return tex;
}

// ---------- Moving bones in the body's own frame ----------

const qd = new THREE.Quaternion();
const qe = new THREE.Euler();
/**
 * Turns a bone from its rest pose by angles about the body's own axes (x: pitch, so
 * negative swings a hanging limb forward; y: turn; z: roll to the side), carried along
 * with whatever its parents are doing.
 */
function pose(b, x, y = 0, z = 0) {
  qe.set(x, y, z, "XYZ");
  qd.setFromEuler(qe);
  // local = rest * (restWorld^-1 * delta * restWorld)
  b.bone.quaternion.copy(b.restWorldInv).multiply(qd).multiply(b.restWorld).premultiply(b.rest);
}

// ---------- One creature ----------

class Creature {
  constructor(template, material, envMap) {
    this.root = SkeletonUtils.clone(template);
    this.mesh = null;
    this.root.traverse((o) => {
      if (o.isSkinnedMesh) this.mesh = o;
    });
    this.mesh.material = material;
    this.mesh.frustumCulled = false;
    this.material = material;
    this.bones = {};
    this.mesh.skeleton.bones.forEach((bone) => {
      bone.updateMatrixWorld(true);
    });
    this.root.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const m = new THREE.Matrix4();
    for (const bone of this.mesh.skeleton.bones) {
      m.copy(rootInv).multiply(bone.matrixWorld);
      const restWorld = new THREE.Quaternion().setFromRotationMatrix(m);
      this.bones[bone.name] = {
        bone,
        rest: bone.quaternion.clone(),
        restPos: bone.position.clone(),
        restWorld,
        restWorldInv: restWorld.clone().invert(),
      };
    }
    const chain = (name, n) => Array.from({ length: n }, (_, i) => this.bones[`${name}${i}`]).filter(Boolean);
    this.spine = chain("spine", 5);
    this.legs = [chain("legL", 4), chain("legR", 4)];
    this.arms = [chain("armL", 10), chain("armR", 10)];
    this.backs = [chain("backL", 11), chain("backR", 11), chain("backC", 11)];
    this.head = this.bones.head;
    // The orb, inside the chest.
    const chest = this.bones.spine3.bone;
    this.orb = new THREE.Mesh(ORB_GEO, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
    this.orb.position.set(0, 0.0, 0.0);
    chest.add(this.orb);
    this.halo = new THREE.Mesh(ORB_GEO, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.halo.renderOrder = 5;
    chest.add(this.halo);
    // Pose, eased frame to frame.
    this.crouch = 0;
    this.work = 0;
    this.hold = 0;
    this.eat = 0;
    this.talk = 0;
    this.lie = 0;
    this.lean = 0;
    this.look = 0;
    this.lookKey = "";
    this.build = null;
    this.tips = [new THREE.Vector3(), new THREE.Vector3()];
    this.foot0 = new THREE.Vector3();
    this.foot1 = new THREE.Vector3();
  }
}

const ORB_GEO = new THREE.IcosahedronGeometry(1, 2);

/** Body measurements and manner, from how the world sees this one. */
function measure(look, ageDays, child) {
  const p = look?.shown ?? look?.p ?? [0, 0, 0, 0, 0];
  const [courage, cheer, wander, industry, warmth] = p.map(clamp1);
  const g = child ? Math.min(1, Math.max(0, ageDays / 50)) : 1;
  const elder = smooth(150, 225, ageDays);
  const rings = [0, 0, 0, 0];
  const sk = look?.sk ?? [];
  // Where each skill's ring sits on the body, by distance from the chest.
  const AT = [0.42, 0.3, 0.12, 0.22, 0.05];
  let n = 0;
  if (!child) for (let k = 0; k < sk.length && n < 4; k++) if (sk[k] >= 0.5) rings[n++] = AT[k];
  return {
    size: (child ? 0.5 + 0.4 * g : 1) * (1 + 0.06 * courage) * (1 - 0.04 * elder),
    head: child ? 1.5 - 0.5 * g : 1,
    legs: (1 + 0.12 * wander) * (child ? 0.85 + 0.15 * g : 1),
    broad: 1 + 0.22 * industry + (child ? 0.1 : 0),
    thick: (1 + 0.28 * industry) * (1 - 0.15 * elder),
    hunch: 0.32 * Math.max(0, -courage) + 0.3 * elder,
    restless: Math.max(0, wander) + 0.3 * (child ? 1 : 0),
    curl: Math.max(0, -courage) * 0.8 + Math.max(0, -warmth) * 0.4,
    reach: Math.max(0, warmth),
    tendril: 1 + 0.25 * Math.max(0, wander) - 0.1 * elder,
    glow: (1 + 0.25 * cheer) * (1 - 0.3 * elder),
    cheer,
    rings,
  };
}

function hueColor(look, out) {
  return out.setHSL(look?.hue ?? 0.53, 0.85, 0.6);
}

export class Creatures {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.list = new Map(); // id -> Creature
    this.template = null;
    this.time = { value: 0 };
    this.envMap = makeEnvironment(renderer);
    this.glass = true; // see-through glass (off on the lightest quality)
    this.v = new THREE.Vector3();
    this.c = new THREE.Color();
    this.camera = null;
    new GLTFLoader().load("/viewer/body.glb", (gltf) => {
      const root = gltf.scene;
      root.traverse((o) => {
        if (o.isSkinnedMesh) {
          const g = o.geometry;
          g.setAttribute("aAng", g.attributes.uv);
          g.setAttribute("aInfo", g.attributes.uv1);
          g.deleteAttribute("uv");
          g.deleteAttribute("uv1");
        }
      });
      this.template = root;
    });
  }

  setGlass(on) {
    this.glass = on;
    for (const c of this.list.values()) {
      c.material.transmission = on ? 0.85 : 0;
    }
  }

  material() {
    return new CustomShaderMaterial({
      baseMaterial: THREE.MeshPhysicalMaterial,
      vertexShader,
      fragmentShader,
      uniforms: {
        uColor: { value: new THREE.Color() },
        uGlow: { value: 1 },
        uOrb: { value: 1 },
        uTime: this.time,
        uSeed: { value: 0 },
        uRings: { value: new THREE.Vector4() },
      },
      color: new THREE.Color("#0a1016"),
      roughness: 0.12,
      metalness: 0.0,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      iridescence: 0.55,
      iridescenceIOR: 1.6,
      transmission: this.glass ? 0.85 : 0,
      thickness: 0.15,
      ior: 1.45,
      attenuationColor: new THREE.Color("#0b2a3a"),
      attenuationDistance: 0.35,
      envMap: this.envMap,
      envMapIntensity: 0.9,
    });
  }

  forget(id) {
    const c = this.list.get(id);
    if (!c) return;
    this.scene.remove(c.root);
    c.material.dispose();
    this.list.delete(id);
  }

  begin(now, camera) {
    this.time.value = now / 1000;
    this.camera = camera;
    this.seen = new Set();
  }

  /** Poses and places one body; returns where its arm-tendrils hold things. */
  draw(w, f, now, dt) {
    this.seen.add(w.id);
    if (!this.template) return this.v.set(f.x, f.gy + 0.9 * f.scale, f.z);
    let c = this.list.get(w.id);
    if (!c) {
      c = new Creature(this.template, this.material(), this.envMap);
      c.material.uniforms.uSeed.value = (w.id * 2.399) % 6.283;
      this.list.set(w.id, c);
      this.scene.add(c.root);
    }
    const look = w.look;
    const ageDays = look?.ageDays ?? (w.k ? 20 : 60);
    const key = `${look?.shown?.join(",")}|${look?.sk?.join(",")}|${w.k}|${Math.round(ageDays)}`;
    if (key !== c.lookKey) {
      c.build = measure(look, ageDays, w.k);
      c.lookKey = key;
      this.shape(c);
    }
    const b = c.build;
    const t = now / 1000;
    const seed = w.id * 1.618;

    // Far away, only the orb's light shows.
    const far = this.camera ? this.camera.position.distanceTo(this.v.set(f.x, f.gy, f.z)) > FAR : false;
    c.mesh.visible = !far;

    // What it is doing, eased.
    const a = w.a;
    const ease = (cur, target, rate) => cur + (target - cur) * Math.min(1, dt * rate);
    const still = !f.walking;
    c.crouch = ease(c.crouch, still && (a === "gather" || a === "taste" || a === "inspect" || a === "treat") ? 1 : 0, 3);
    c.eat = ease(c.eat, still && a === "eat" ? 1 : 0, 3);
    c.work = ease(c.work, still && (a === "build" || a === "tinker") ? 1 : 0, 3);
    c.talk = ease(c.talk, still && (a === "socialize" || a === "follow") ? 1 : 0, 2);
    c.hold = ease(c.hold, w.c && !f.asleep && c.work < 0.5 && c.eat < 0.5 ? 1 : 0, 3);
    c.lie = ease(c.lie, f.asleep ? 1 : 0, 1.5);
    c.lean = ease(c.lean, a === "flee" ? 0.4 : f.walking ? 0.1 : 0, 3);
    const amp = f.asleep ? 0 : Math.min(a === "flee" ? 1 : 0.75, w.speed * 0.55) * (1 - c.crouch);
    const ph = w.phase;
    const lie = c.lie, cr = c.crouch;

    // ---- Legs: a high-stepping stride on its toes; folded under it to rest ----
    for (let i = 0; i < 2; i++) {
      const L = c.legs[i];
      const p = ph + i * Math.PI;
      const swing = Math.sin(p);
      const lift = Math.max(0, Math.sin(p + 0.6));
      const thigh = -0.42 * amp * swing - 0.35 * amp * lift - 0.85 * cr - 1.3 * lie;
      const shin = 0.65 * amp * lift + 1.25 * cr + 2.55 * lie;
      const meta = -0.45 * amp * lift - 0.5 * cr - 1.45 * lie + 0.15 * amp * swing;
      const toe = 0.35 * amp * lift + 0.2 * cr + 0.5 * lie;
      pose(L[0], thigh, 0, (i ? -1 : 1) * 0.03);
      pose(L[1], shin);
      pose(L[2], meta);
      pose(L[3], toe);
    }
    // (How high the body stands is found from where its feet are; see below.)
    const sp0 = c.spine[0];
    sp0.bone.position.copy(sp0.restPos);
    // Hips sway with each step.
    const sway = amp * 0.06 * Math.sin(ph);
    pose(sp0, 0, sway * 2, sway);

    // ---- Spine: hunch, lean, the bend of work; breath ----
    const breath = Math.sin(t * (f.asleep ? 1.0 : 1.6) + seed);
    const bend = b.hunch + c.lean + 0.42 * cr + 0.22 * c.eat + 0.18 * c.work + 0.4 * lie;
    pose(c.spine[1], bend * 0.35 + breath * 0.01, -sway * 1.5, -sway * 0.8);
    pose(c.spine[2], bend * 0.35 + breath * 0.012);
    pose(c.spine[3], bend * 0.3);
    // The head looks about when still, ahead when moving, toward whoever it talks to.
    const glance = Math.sin(t * 0.37 + seed) * Math.sin(t * 0.23 + seed * 2);
    c.look = ease(c.look, (f.walking ? 0 : glance * 0.7 * (1 - c.eat)) + 0.3 * c.eat, 1.5);
    pose(c.head, -bend * 0.6 + 0.2 * c.eat + 0.05 * c.hold + 0.05 * Math.sin(t * 0.6 + seed) + 0.5 * lie, c.look, 0.08 * Math.sin(t * 0.5 + seed));

    // ---- Arm-tendrils ----
    const speed = 1 + 0.9 * b.restless;
    const sway2 = (1 + 1.1 * b.restless) * (1 - 0.6 * Math.min(1, b.curl));
    for (let i = 0; i < 2; i++) {
      const A = c.arms[i];
      const side = i ? -1 : 1; // +1: its left
      const n = A.length;
      for (let k = 0; k < n; k++) {
        const wave = Math.sin(t * 1.4 * speed - k * 0.5 + i * 2.1 + seed);
        const wave2 = Math.sin(t * 1.0 * speed - k * 0.37 + i + seed);
        let x = 0.035 * wave * sway2;
        let z = 0.03 * wave2 * sway2 * side;
        if (k === 0) {
          // The root: swings with the stride, opposite the leg on its side.
          x = -0.35 * amp * Math.sin(ph + (i ? 0 : Math.PI)) - 0.1 * amp;
          z = side * (0.08 - 0.12 * b.curl);
          // Reaching down to gather, both together, fingering the ground.
          x += cr * (-0.9 + 0.15 * Math.sin(t * 3 + i));
          // Eating: one coils up to the face, bringing food to it in small lifts.
          if (i === 0) x += c.eat * (-1.05 + 0.12 * Math.sin(t * 3.4 + seed));
          if (i === 0) z += c.eat * -0.32;
          // Building: one strikes, again and again; the other steadies.
          if (i === 0) x += c.work * (-1.5 + 0.7 * Math.sin(ph * 2.2));
          else x += c.work * -0.7;
          // Holding something: one tendril curls it close against the chest; the other
          // swings free.
          if (i === 0) {
            x += c.hold * -0.12;
            z += c.hold * -0.42;
          }
          // Talking: one reaches out, warm ones more.
          if (i === 1) x += c.talk * (-0.5 - 0.45 * b.reach + 0.2 * Math.sin(t * 1.3 + seed));
          // Asleep: drawn in around itself.
          x += lie * -0.55;
          z += lie * -side * 0.25;
        } else {
          // Further along: curl, by nature and by what it is doing.
          x += 0.05 * b.curl;
          if (i === 0) {
            // Coiling: each part bends a little more, so the tendril rolls up from its tip.
            const coil = (k / n) * 0.5 + 0.75;
            x += c.eat * -0.3 * coil;
            x += c.hold * -0.27 * coil;
            z += (c.eat + c.hold) * -0.04;
          }
          x += cr * -0.05;
          x += c.work * (i === 0 ? -0.06 : -0.12);
          // Reaching out to talk, the tendril curls gently upward along its length.
          if (i === 1) x += c.talk * -0.06;
          x += lie * -0.12;
          z += lie * -side * 0.1;
        }
        pose(A[k], x, 0, z);
      }
      // Where it holds things: in the curl near the end of the tendril.
      A[n - 2].bone.getWorldPosition(c.tips[i]);
    }

    // ---- Back tendrils: arching, always moving; drawn around itself in sleep ----
    for (let j = 0; j < 3; j++) {
      const B = c.backs[j];
      const side = j === 0 ? 1 : j === 1 ? -1 : 0;
      for (let k = 0; k < B.length; k++) {
        const wave = Math.sin(t * 1.3 * speed - k * 0.55 + j * 1.9 + seed);
        const wave2 = Math.sin(t * 0.9 * speed - k * 0.4 + j * 0.8 + seed);
        let x = 0.05 * wave * sway2 + 0.06 * b.curl - 0.02 * (b.tendril - 1);
        let z = 0.04 * wave2 * sway2;
        if (k === 0) {
          x = 0.25 * b.curl + 0.15 * c.lean + 0.05 * amp * Math.sin(ph * 2);
          z = side * (0.05 - 0.12 * b.curl);
          // Asleep: laid back and down over itself.
          x += lie * -0.75;
          z += lie * side * 0.35;
        } else {
          x += lie * -0.07;
        }
        pose(B[k], x, 0, z);
      }
    }

    // ---- Place the whole body ----
    const r = c.root;
    r.position.set(f.x, f.gy, f.z);
    r.rotation.set(0, f.yaw, 0);
    r.scale.setScalar(BASE * f.scale * b.size);
    r.updateMatrixWorld(true);
    // Stand on the ground: whatever the legs are doing, the lower foot rests on it.
    const s = BASE * f.scale * b.size;
    c.legs[0][3].bone.getWorldPosition(c.foot0);
    c.legs[1][3].bone.getWorldPosition(c.foot1);
    const lowest = Math.min(c.foot0.y, c.foot1.y);
    const bob = f.walking ? 0 : 0.006 * s * Math.sin(t * 1.4 + seed);
    r.position.y += f.gy + 0.03 * s - lowest + bob;
    r.updateMatrixWorld(true);

    // ---- Its light ----
    hueColor(look, this.c);
    const glow = b.glow * (f.asleep ? 0.5 : 1) * (0.55 + 0.45 * (w.health ?? 1));
    const u = c.material.uniforms;
    u.uColor.value.copy(this.c).multiplyScalar(1.15);
    u.uGlow.value = glow;
    u.uRings.value.fromArray(b.rings);

    const em = look?.em ?? [0, 0, 0, 0];
    const [fear, sad, lonely, joy] = em;
    const health = w.health ?? 1;
    let I = 1.2 + 0.35 * b.cheer + 0.4 * joy;
    if (fear > 0.25) I *= 0.82 + 0.25 * Math.sin(t * 17 + seed) * Math.min(1, fear * 2);
    const grief = Math.max(sad, lonely);
    if (grief > 0.2) I *= (1 - 0.45 * grief) * (0.85 + 0.15 * Math.sin(t * 1.4 + seed));
    I *= 0.3 + 0.7 * health;
    if (health < 0.35 || look?.tx) {
      const nn = Math.sin(Math.floor(t * 11) * 12.9898 + seed * 78.233) * 43758.5453;
      if (nn - Math.floor(nn) < 0.25) I *= 0.25;
    }
    if (f.asleep) I *= 0.35 * (0.75 + 0.25 * breath);
    u.uOrb.value = I;
    const orbR = 0.042 * (1 + 0.08 * (I - 1));
    c.orb.scale.setScalar(orbR);
    c.orb.material.color.copy(this.c).lerp(WHITE, 0.3).multiplyScalar(I * 1.6);
    const haloR = orbR * (2 + (far ? 6 + 4 * f.far : 5 * f.far));
    c.halo.scale.setScalar(haloR);
    c.halo.material.color.copy(this.c).multiplyScalar(I * (0.07 + (far ? 0.25 : 0.12 * f.far)));

    return this.v.copy(c.tips[0]);
  }

  /** Sets the body's build from its measurements (bone lengths and thickness). */
  shape(c) {
    const b = c.build;
    // Long or short legs: move each joint along its bone.
    for (const L of c.legs) {
      for (let k = 1; k < L.length; k++) L[k].bone.position.copy(L[k].restPos).multiplyScalar(b.legs);
      L[0].bone.scale.set(b.thick, 1, b.thick);
      for (let k = 1; k < L.length; k++) L[k].bone.scale.set(1, 1, 1);
    }
    // Broad or slight: widen the body (not its tendrils or head).
    c.spine[1].bone.scale.set(b.broad, 1, 0.92 + 0.08 * b.broad);
    c.spine[2].bone.scale.set(1 / b.broad, 1, 1 / (0.92 + 0.08 * b.broad));
    c.spine[3].bone.scale.set(b.broad, 1, 0.92 + 0.08 * b.broad);
    c.spine[4].bone.scale.set(1 / b.broad, 1, 1 / (0.92 + 0.08 * b.broad));
    // A child's head is larger.
    c.head.bone.scale.setScalar(b.head);
    // Long-tendrilled seekers.
    for (const T of [...c.arms, ...c.backs]) for (let k = 1; k < T.length; k++) T[k].bone.position.copy(T[k].restPos).multiplyScalar(b.tendril);
  }

  end() {
    for (const id of [...this.list.keys()]) if (!this.seen.has(id)) this.forget(id);
  }
}
