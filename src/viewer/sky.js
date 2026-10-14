// Day, night and season, as light and color. The world reports its own light (0 at
// midnight, 1 at noon) and season; the picture eases toward them so nothing jumps.

import * as THREE from "three";

/** The grid's color through the year. */
const SEASON_LINE = {
  growth: "#35f2c4",
  peak: "#ffcf4a",
  decline: "#ff8a3a",
  cold: "#a9dcff",
};

/** Sky (and fog) by day and by night: deep hazy blue, then almost black. */
const SKY_DAY = new THREE.Color("#0a1a30");
const SKY_NIGHT = new THREE.Color("#010205");
const GROUND_DAY = new THREE.Color("#050b14");
const GROUND_NIGHT = new THREE.Color("#010204");

export class Sky {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.light = 0.5;
    this.targetLight = 0.5;
    this.line = new THREE.Color(SEASON_LINE.growth);
    this.targetLine = new THREE.Color(SEASON_LINE.growth);
    this.background = new THREE.Color();
    scene.background = this.background;
    this.apply();
  }

  /** From /api/status. */
  setWorld({ light, season }) {
    if (typeof light === "number") this.targetLight = light;
    if (SEASON_LINE[season]) this.targetLine.set(SEASON_LINE[season]);
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
    u.uFog.value.copy(this.background);
    u.uBase.value.copy(GROUND_NIGHT).lerp(GROUND_DAY, L);
    u.uLine.value.copy(this.line);
    // The lights carry the night: lines glow a little brighter in the dark.
    u.uGlow.value = 1.15 - 0.3 * L;
    // Daylight haze closes in; night is clear and deep.
    u.uFogDensity.value = 0.0045 + 0.0025 * L;
  }
}
