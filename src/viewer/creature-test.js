// A line-up of bodies in different states, for checking how they look (not part of the viewer).
import * as THREE from "three";
import { EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, ChromaticAberrationEffect, VignetteEffect } from "postprocessing";
import { Creatures } from "./creatures.js";

const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(1);
const scene = new THREE.Scene();
scene.background = new THREE.Color("#010307");
const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 200);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
  vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`,
  fragmentShader: `varying vec3 vW; void main(){ vec2 q = vW.xz + 0.5; vec2 d = 0.5 - abs(fract(q) - 0.5); vec2 l = 1.0 - smoothstep(vec2(0.0), fwidth(q)*1.1, d);
    float seam = max(l.x, l.y); vec3 col = vec3(0.002,0.004,0.008) + vec3(0.18,0.85,1.0) * seam * 0.05 * (1.0 - smoothstep(6.0, 25.0, length(vW.xz)));
    gl_FragColor = vec4(col, 1.0); }`,
}));
scene.add(floor);
const creatures = new Creatures(scene, renderer);
const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new EffectPass(camera, new SMAAEffect()));
composer.addPass(new EffectPass(camera, new BloomEffect({ mipmapBlur: true, intensity: 1.15, luminanceThreshold: 0.32, luminanceSmoothing: 0.25, radius: 0.72 }), new VignetteEffect({ offset: 0.32, darkness: 0.55 })));
composer.addPass(new EffectPass(camera, new ChromaticAberrationEffect({ offset: new THREE.Vector2(0.0006, 0.0004), radialModulation: true, modulationOffset: 0.35 })));
function size() {
  renderer.setSize(innerWidth, innerHeight, false);
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
size();

const p = (courage = 0, cheer = 0, wander = 0, industry = 0, warmth = 0) => [courage, cheer, wander, industry, warmth];
// [label, x, action, walking, look, child, carrying]
const CAST = [
  ["walking", -4.2, "explore", true, { hue: 0.52, shown: p(0.2, 0.3, 0.9), sk: [0.6, 0, 0, 0, 0], em: [0, 0, 0, 0.3], ageDays: 60 }],
  ["gathering", -2.5, "gather", false, { hue: 0.33, shown: p(0, 0, 0, 0.8), sk: [0, 0, 0, 0.7, 0], em: [0, 0, 0, 0], ageDays: 80 }],
  ["eating", -0.85, "eat", false, { hue: 0.08, shown: p(0, 0.5, 0, 0, 0.4), em: [0, 0, 0, 0.5], ageDays: 50 }],
  ["timid", 0.8, "idle", false, { hue: 0.75, shown: p(-0.9, -0.4, -0.5, 0, -0.3), em: [0.6, 0, 0, 0], ageDays: 40 }],
  ["talking", 2.3, "socialize", false, { hue: 0.12, shown: p(0.3, 0.3, 0, 0.2, 0.9), em: [0, 0, 0, 0.4], ageDays: 90 }],
  ["child", 3.2, "follow", false, { hue: 0.1, shown: p(0, 0.2, 0.3), em: [0, 0, 0, 0], ageDays: 15 }, 1],
  ["asleep", 4.6, "sleep", false, { hue: 0.95, shown: p(0, 0, 0), em: [0, 0, 0, 0], ageDays: 120 }],
];
const item = new THREE.Mesh(new THREE.OctahedronGeometry(0.06, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.3, 1.15, 0.8), toneMapped: false }));
scene.add(item);
const item2 = item.clone();
item2.scale.setScalar(0.66);
scene.add(item2);
const ws = CAST.map(([, x, a, walking, look, k], i) => ({ id: i + 1, a, look, k: k ?? 0, c: a === "explore" ? 1 : 0, speed: walking ? 1.2 : 0, phase: 0, health: 1, x, walking }));

window.draw = (t, view = "front") => {
  const now = t * 1000;
  creatures.begin(now, camera);
  for (const w of ws) {
    w.phase = t * (2 + w.speed * 5);
    // Several frames' worth of easing when jumping straight to a moment.
    let hands;
    for (let k = 0; k < (window.warm ? 1 : 40); k++) hands = creatures.draw(w, { x: w.x, z: 0, gy: 0, yaw: window.yaw ?? (w.a === "socialize" ? 0.9 : w.a === "follow" ? -1.0 : 0.25), scale: 1, walking: w.walking, asleep: w.a === "sleep", bob: 0, far: 0 }, now, 1 / 12);
    if (w.c || w.a === "eat") (w.a === "eat" ? item2 : item).position.copy(hands);
  }
  window.warm = true;
  creatures.end();
  if (view === "front") {
    camera.position.set(0.2, 1.7, 9.6);
    camera.lookAt(0.2, 0.7, 0);
  } else if (view.startsWith("s")) {
    // From its side.
    const x = CAST[Number(view.slice(1))][1];
    camera.position.set(x + 3.4, 1.1, 0.9);
    camera.lookAt(x, 0.75, 0);
  } else {
    const x = CAST[Number(view)][1];
    camera.position.set(x + 0.9, 1.45, 3.3);
    camera.lookAt(x, 0.75, 0);
  }
  composer.render();
};
window.ready = () => !!creatures.template;
