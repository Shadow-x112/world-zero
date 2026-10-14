// Day, night and season, as light and color. The world reports its own light (0 at
// midnight, 1 at noon) and season; the picture eases toward them so nothing jumps.
//
// The sky is almost black, with one thin band of light along the horizon. The glass
// floor reflects that band, so the land shines at a low angle and stays dark from above.

import * as THREE from "three";

/** The season's accent: it tints the seams of light and the horizon. */
const SEASON_LINE = {
  growth: "#35f2c4",
  peak: "#ffcf4a",
  decline: "#ff8a3a",
  cold: "#a9dcff",
};
/** The seams' own color; the season only tints it. */
const CYAN = new THREE.Color("#2ee6ff");
const SEASON_TINT = 0.35;
const tint = new THREE.Color();

const SKY_DAY = new THREE.Color("#030912");
const SKY_NIGHT = new THREE.Color("#000103");
const FOG_DAY = new THREE.Color("#04101c");
const FOG_NIGHT = new THREE.Color("#01040a");
const GROUND_DAY = new THREE.Color("#02050a");
const GROUND_NIGHT = new THREE.Color("#000103");
const HORIZON_DAY = new THREE.Color("#145a80");
const HORIZON_NIGHT = new THREE.Color("#082c44");

function makeDome(scene) {
  const geo = new THREE.SphereGeometry(1500, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color() },
      uFog: { value: new THREE.Color() },
      uBand: { value: new THREE.Color() },
      uAccent: { value: new THREE.Color() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // always at the far plane
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uFog;
      uniform vec3 uBand;
      uniform vec3 uAccent;
      varying vec3 vDir;
      void main() {
        float y = vDir.y;
        // From the haze at the horizon up into the black.
        vec3 col = mix(uFog, uTop, smoothstep(0.0, 0.35, y));
        // One thin line of light where land would meet sky, with a soft glow around it.
        float line = exp(-pow(y / 0.0035, 2.0));
        float glow = exp(-abs(y) / 0.05);
        col += uBand * (0.2 * glow) + mix(uBand, uAccent, 0.3) * line * 0.9;
        // Below the horizon: fog, darkening.
        if (y < 0.0) col = mix(col, uFog * 0.6, smoothstep(0.0, -0.2, y));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.frustumCulled = false;
  dome.renderOrder = -2;
  dome.name = "sky";
  scene.add(dome);
  return dome;
}

export class Sky {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.light = 0.5;
    this.targetLight = 0.5;
    this.line = new THREE.Color(SEASON_LINE.growth);
    this.targetLine = new THREE.Color(SEASON_LINE.growth);
    this.known = false;
    this.background = new THREE.Color();
    scene.background = this.background;
    this.dome = makeDome(scene);
    this.apply();
  }

  /** From /api/status. */
  setWorld({ light, season }) {
    if (typeof light === "number") this.targetLight = light;
    if (SEASON_LINE[season]) this.targetLine.set(SEASON_LINE[season]);
    if (!this.known) {
      // The first time, start where the world is (no slow fade from a guess).
      this.known = true;
      this.light = this.targetLight;
      this.line.copy(this.targetLine);
      this.apply();
    }
  }

  /** Eases toward the world's light and season; dt in seconds. */
  update(dt) {
    const k = 1 - Math.exp(-dt * 0.6);
    this.light += (this.targetLight - this.light) * k;
    this.line.lerp(this.targetLine, 1 - Math.exp(-dt * 0.3));
    this.apply();
  }

  apply() {
    const L = this.light;
    const u = this.terrain.material.uniforms;
    this.background.copy(SKY_NIGHT).lerp(SKY_DAY, L);
    u.uFog.value.copy(FOG_NIGHT).lerp(FOG_DAY, L);
    u.uBase.value.copy(GROUND_NIGHT).lerp(GROUND_DAY, L);
    u.uLine.value.copy(this.line);
    u.uSeam.value.copy(CYAN).lerp(this.line, SEASON_TINT);
    u.uHorizon.value.copy(HORIZON_NIGHT).lerp(HORIZON_DAY, L);
    // The season only tints the horizon (it is dark; a plain mix would let a bright accent take it over).
    tint.copy(this.line).multiplyScalar(0.012);
    u.uHorizon.value.add(tint);
    // The lights carry the night: lines glow a little brighter in the dark.
    u.uGlow.value = 1.15 - 0.3 * L;
    // Daylight haze closes in; night is clear and deep.
    u.uFogDensity.value = 0.0042 + 0.0022 * L;
    const d = this.dome.material.uniforms;
    d.uTop.value.copy(this.background);
    d.uFog.value.copy(u.uFog.value);
    d.uBand.value.copy(u.uHorizon.value).multiplyScalar(1.2);
    d.uAccent.value.copy(this.line);
  }
}
