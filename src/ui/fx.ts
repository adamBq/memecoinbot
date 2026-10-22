/**
 * USD -> AUD rate for the dashboard's display currency. One hourly fetch,
 * cached in memory; on failure the last good rate is returned (however old),
 * and null only when nothing has ever been fetched. Never throws.
 *
 * Primary: open.er-api.com (verified 2026-10-22, tests/fixtures/fx_erapi_usd.json).
 * Fallback: api.frankfurter.dev (the old api.frankfurter.app host 301s here,
 * verified 2026-10-22, tests/fixtures/fx_frankfurter_usd_aud.json).
 */
import { getJson, limiterFor } from "../core/http.js";
import { logger } from "../core/logger.js";

export interface FxRate {
  audPerUsd: number;
  /** When the source published the rate, ms. */
  asOf: number;
  /** Host the rate came from. */
  source: string;
}

export type GetFx = () => Promise<FxRate | null>;

export const FX_CACHE_TTL_MS = 60 * 60_000;
export const ERAPI_URL = "https://open.er-api.com/v6/latest/USD";
export const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest?from=USD&to=AUD";

// Both services publish daily; a handful of calls per hour is more than enough.
const erapiLimiter = limiterFor("open.er-api.com", 5, 0.05);
const frankfurterLimiter = limiterFor("api.frankfurter.dev", 5, 0.05);

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function positive(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** `{ result: "success", rates: { AUD }, time_last_update_unix }`. */
export function parseErapi(raw: unknown, now: number): FxRate | null {
  if (!isRec(raw) || raw.result !== "success" || !isRec(raw.rates)) return null;
  const audPerUsd = positive(raw.rates.AUD);
  if (audPerUsd === null) return null;
  const unix = positive(raw.time_last_update_unix);
  return { audPerUsd, asOf: unix === null ? now : unix * 1000, source: "open.er-api.com" };
}

/** `{ base: "USD", date: "YYYY-MM-DD", rates: { AUD } }`; `date` is the ECB reference day. */
export function parseFrankfurter(raw: unknown, now: number): FxRate | null {
  if (!isRec(raw) || !isRec(raw.rates)) return null;
  if (raw.base !== undefined && raw.base !== "USD") return null;
  const audPerUsd = positive(raw.rates.AUD);
  if (audPerUsd === null) return null;
  const parsed = typeof raw.date === "string" ? Date.parse(`${raw.date}T00:00:00Z`) : Number.NaN;
  return { audPerUsd, asOf: Number.isFinite(parsed) ? parsed : now, source: "api.frankfurter.dev" };
}

let cached: { rate: FxRate; fetchedAt: number } | null = null;
let inflight: Promise<FxRate | null> | null = null;

async function fetchOnce(now: number): Promise<FxRate | null> {
  const sources: Array<{ url: string; parse: (raw: unknown, now: number) => FxRate | null; limiter: ReturnType<typeof limiterFor> }> = [
    { url: ERAPI_URL, parse: parseErapi, limiter: erapiLimiter },
    { url: FRANKFURTER_URL, parse: parseFrankfurter, limiter: frankfurterLimiter },
  ];
  for (const src of sources) {
    try {
      const raw = await getJson<unknown>(src.url, { limiter: src.limiter, timeoutMs: 8000, retries: 1 });
      const rate = src.parse(raw, now);
      if (rate !== null) return rate;
      logger.warn({ url: src.url }, "fx: unexpected response shape");
    } catch (err) {
      logger.warn({ url: src.url, err: String(err) }, "fx: fetch failed");
    }
  }
  return null;
}

/**
 * AUD per USD, cached for one hour. Concurrent callers share one fetch. When
 * every source fails the last cached rate is returned (stale but usable), or
 * null if there has never been one.
 */
export async function getAudPerUsd(now: number = Date.now()): Promise<FxRate | null> {
  if (cached !== null && now - cached.fetchedAt < FX_CACHE_TTL_MS) return cached.rate;
  if (inflight === null) {
    inflight = fetchOnce(now)
      .then((rate) => {
        if (rate !== null) cached = { rate, fetchedAt: now };
        else if (cached !== null) logger.warn({ asOf: cached.rate.asOf }, "fx: all sources failed, serving the last cached rate");
        return cached?.rate ?? null;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
