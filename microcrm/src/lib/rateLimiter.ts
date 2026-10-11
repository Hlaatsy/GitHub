/**
 * In-process sliding-window limiter keyed per tenant+customer. It caps how many
 * inbound events a single sender can turn into paid replies per window.
 * Per-instance only: run behind a shared store (e.g. Redis) when scaling out.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    this.sweeper = setInterval(() => this.sweep(Date.now()), windowMs);
    this.sweeper.unref();
  }

  allow(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  stop(): void {
    clearInterval(this.sweeper);
  }

  private sweep(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.hits) {
      if (times.every((at) => at <= cutoff)) this.hits.delete(key);
    }
  }
}
