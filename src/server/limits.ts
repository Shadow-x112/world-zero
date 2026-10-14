// A simple per-visitor rate limit (token bucket), so one busy or unfriendly visitor
// cannot crowd out everyone else or run up the server's bill.

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private lastSweep = 0;
  private readonly now: () => number;
  readonly perSecond: number;
  readonly burst: number;

  constructor(perSecond: number, burst: number, now: () => number = () => Date.now()) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.now = now;
  }

  /** Spends one token for this visitor; false if they have none left. */
  allow(visitor: string): boolean {
    const now = this.now();
    let b = this.buckets.get(visitor);
    if (!b) {
      b = { tokens: this.burst, at: now };
      this.buckets.set(visitor, b);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.perSecond);
      b.at = now;
    }
    if (now - this.lastSweep > 60_000) this.sweep(now);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Forgets visitors whose buckets have refilled (keeps memory flat). */
  private sweep(now: number): void {
    this.lastSweep = now;
    const full = (this.burst / this.perSecond) * 1000;
    for (const [k, b] of this.buckets) if (now - b.at > full) this.buckets.delete(k);
  }

  get tracked(): number {
    return this.buckets.size;
  }
}
