// Rendering quality that looks after itself: full glow on strong machines, lighter on
// phones, and a step down whenever frames get slow. It never steps back up on its own
// within a visit (flip-flopping is worse than a steady, slightly plainer picture).

export const TIERS = [
  { name: "high", pixelRatio: 2, bloom: true, bloomScale: 1, near: 1, lights: 24 },
  { name: "medium", pixelRatio: 1.5, bloom: true, bloomScale: 0.5, near: 0.7, lights: 16 },
  { name: "low", pixelRatio: 1, bloom: false, bloomScale: 0, near: 0.5, lights: 8 },
];

export class Quality {
  constructor(onChange) {
    this.onChange = onChange;
    const coarse = matchMedia("(pointer: coarse)").matches;
    const small = Math.min(screen.width, screen.height) < 700;
    this.index = coarse || small ? 1 : 0;
    this.frames = 0;
    this.time = 0;
    this.grace = 4; // seconds to settle (loading spikes) before judging
  }

  get tier() {
    return TIERS[this.index];
  }

  /** Call once per frame with the frame's duration in seconds; `busy` while still building the world. */
  sample(dt, busy = false) {
    if (busy) {
      // Building meshes makes frames slow for reasons that pass: judge only a settled picture.
      this.grace = Math.max(this.grace, 2);
      this.frames = 0;
      this.time = 0;
      return;
    }
    if (this.grace > 0) {
      this.grace -= dt;
      return;
    }
    this.frames++;
    this.time += dt;
    if (this.time < 3) return;
    const fps = this.frames / this.time;
    this.frames = 0;
    this.time = 0;
    if (fps < 40 && this.index < TIERS.length - 1) {
      this.index++;
      this.grace = 3;
      this.onChange(this.tier, fps);
    }
  }
}
