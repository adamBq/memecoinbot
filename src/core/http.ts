/**
 * Minimal HTTP layer shared by every data client: timeout, retry with
 * backoff, a per-host token-bucket rate limiter, and a TTL cache.
 * All clients go through `getJson` so rate limits are enforced in one place.
 */
import { logger } from "./logger.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }

  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
      await sleep(Math.max(waitMs, 25));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
  }
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T = unknown> {
  private readonly map = new Map<string, CacheEntry<T>>();
  constructor(private readonly maxEntries = 5000) {}

  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (this.map.size >= this.maxEntries) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  clear(): void {
    this.map.clear();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface GetJsonOptions {
  limiter?: RateLimiter;
  cache?: TtlCache;
  cacheTtlMs?: number;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** Treat these statuses as a soft miss and return null instead of throwing. */
  nullOnStatus?: number[];
}

const limiters = new Map<string, RateLimiter>();

/** Shared limiter per host so two clients on the same API do not double-spend. */
export function limiterFor(host: string, capacity: number, refillPerSecond: number): RateLimiter {
  let l = limiters.get(host);
  if (!l) {
    l = new RateLimiter(capacity, refillPerSecond);
    limiters.set(host, l);
  }
  return l;
}

export async function getJson<T>(url: string, opts: GetJsonOptions = {}): Promise<T | null> {
  const { cache, cacheTtlMs = 0, timeoutMs = 10000, retries = 2, headers = {}, nullOnStatus = [404] } = opts;
  if (cache && cacheTtlMs > 0) {
    const hit = cache.get(url) as T | undefined;
    if (hit !== undefined) return hit;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.limiter) await opts.limiter.acquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "memecoinbot/0.1 (paper)", ...headers },
        signal: ctrl.signal,
      });
      if (nullOnStatus.includes(res.status)) return null;
      if (res.status === 429 || res.status >= 500) {
        const body = await res.text().catch(() => "");
        lastErr = new HttpError(res.status, url, body.slice(0, 200));
        const retryAfter = Number(res.headers.get("retry-after"));
        // 429s need real breathing room; 5xx can retry quickly.
        const base = res.status === 429 ? 3000 * 2 ** attempt : 500 * 2 ** attempt;
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 65_000) : base;
        logger.warn({ url: url.split("?")[0], status: res.status, attempt, backoff }, "http retryable error");
        if (attempt < retries) await sleep(backoff);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new HttpError(res.status, url, body.slice(0, 200));
      }
      const data = (await res.json()) as T;
      if (cache && cacheTtlMs > 0) cache.set(url, data, cacheTtlMs);
      return data;
    } catch (err) {
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      lastErr = err;
      logger.warn({ url: url.split("?")[0], attempt, err: String(err) }, "http request failed");
      if (attempt < retries) await sleep(300 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`request failed: ${url}`);
}
