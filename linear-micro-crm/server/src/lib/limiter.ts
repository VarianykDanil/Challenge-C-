/**
 * In-memory failure counters behind the login and second-factor limiters: `maxFailures` inside a rolling window
 * per key, then `429` until the window passes. The map is bounded — past `maxKeys` the least recently touched key
 * is evicted — and expired entries are swept on an unref'd interval, so the hot path never scans the whole map
 * and a flood of distinct keys (rotating emails, rotating addresses) cannot grow memory without limit.
 */
import { tooManyRequests } from './errors.ts';

interface Failures {
  count: number;
  /** start of the current window (ms since epoch) */
  first: number;
}

export class FailureLimiter {
  private readonly map = new Map<string, Failures>();
  readonly maxFailures: number;
  readonly windowMs: number;
  readonly maxKeys: number;

  constructor(maxFailures: number, windowMs: number, maxKeys = 10_000, pruneEveryMs = 5 * 60_000) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    if (pruneEveryMs > 0) setInterval(() => this.prune(), pruneEveryMs).unref();
  }

  /** Throws `429 Too many attempts, try again in N minutes` when `key` has used up its attempts inside the window. */
  assertAllowed(key: string, now = Date.now()): void {
    const f = this.map.get(key);
    if (!f) return;
    if (now - f.first >= this.windowMs) {
      this.map.delete(key);
      return;
    }
    if (f.count >= this.maxFailures) {
      const minutes = Math.max(1, Math.ceil((f.first + this.windowMs - now) / 60_000));
      throw tooManyRequests(`Too many attempts, try again in ${minutes} minute${minutes === 1 ? '' : 's'}`);
    }
  }

  /** Counts one failure for `key` (a fresh window when the previous one has expired). */
  record(key: string, now = Date.now()): void {
    const f = this.map.get(key);
    this.map.delete(key); // re-insert so Map order == least recently touched first
    if (f && now - f.first < this.windowMs) {
      f.count += 1;
      this.map.set(key, f);
      return;
    }
    while (this.map.size >= this.maxKeys) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.map.set(key, { count: 1, first: now });
  }

  /** Failures counted for `key` inside the current window (0 when none or expired). */
  count(key: string, now = Date.now()): number {
    const f = this.map.get(key);
    return f && now - f.first < this.windowMs ? f.count : 0;
  }

  clear(key: string): void {
    this.map.delete(key);
  }

  /** Drops every expired entry; returns how many were removed. Runs on the interval, never on the request path. */
  prune(now = Date.now()): number {
    let removed = 0;
    for (const [k, f] of this.map) {
      if (now - f.first >= this.windowMs) {
        this.map.delete(k);
        removed++;
      }
    }
    return removed;
  }

  /** Test hook: forget everything. */
  reset(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
