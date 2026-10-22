/**
 * DexScreener client. Pair-shaped endpoints share one limiter (300/min);
 * boosts and profiles are a separate, stricter bucket (60/min).
 * Pair snapshots are cached for 30s inside `getJson`.
 *
 * Shapes verified live 2026-10-22, see tests/fixtures/dexscreener_*.json.
 */
import { getJson, limiterFor, TtlCache } from "../core/http.js";
import { logger } from "../core/logger.js";
import type { PairSnapshot, Social } from "../core/types.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const BASE = "https://api.dexscreener.com";
const PAIR_CACHE_TTL_MS = 30_000;
const TOKENS_PER_BATCH = 30;

const pairsLimiter = limiterFor("api.dexscreener.com", 300, 5);
const boostsLimiter = limiterFor("api.dexscreener.com:boosts", 60, 1);
const pairCache = new TtlCache();

const PREFERRED_QUOTES = new Set([WSOL_MINT, USDC_MINT]);

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse a number that DexScreener may send as a string, a number, or omit. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function buysSells(v: unknown): { buys: number; sells: number } {
  const r = isRec(v) ? v : {};
  return { buys: num(r.buys) ?? 0, sells: num(r.sells) ?? 0 };
}

function window4(v: unknown): { m5: number; h1: number; h6: number; h24: number } {
  const r = isRec(v) ? v : {};
  return { m5: num(r.m5) ?? 0, h1: num(r.h1) ?? 0, h6: num(r.h6) ?? 0, h24: num(r.h24) ?? 0 };
}

/** Normalise one raw DexScreener pair. Returns null when not solana or malformed. */
export function normalizePair(raw: unknown): PairSnapshot | null {
  if (!isRec(raw)) return null;
  if (raw.chainId !== "solana") return null;
  const pairAddress = str(raw.pairAddress);
  const base = isRec(raw.baseToken) ? raw.baseToken : null;
  const quote = isRec(raw.quoteToken) ? raw.quoteToken : null;
  const mint = base ? str(base.address) : null;
  if (!pairAddress || !mint) return null;
  // Dead or unpriced pairs omit priceUsd; a snapshot without a price is useless downstream.
  const priceUsd = num(raw.priceUsd);
  if (priceUsd === null) return null;

  const liquidity = isRec(raw.liquidity) ? raw.liquidity : {};
  const txns = isRec(raw.txns) ? raw.txns : {};
  const info = isRec(raw.info) ? raw.info : {};
  const boosts = isRec(raw.boosts) ? raw.boosts : {};

  const socials: Social[] = Array.isArray(info.socials)
    ? info.socials.flatMap((s: unknown) => {
        if (!isRec(s)) return [];
        const url = str(s.url);
        const type = str(s.type);
        return url && type ? [{ type, url }] : [];
      })
    : [];
  const websites: string[] = Array.isArray(info.websites)
    ? info.websites.flatMap((w: unknown) => (isRec(w) && str(w.url) ? [w.url as string] : []))
    : [];
  const labels: string[] = Array.isArray(raw.labels) ? raw.labels.filter((l): l is string => typeof l === "string") : [];

  return {
    pairAddress,
    dexId: str(raw.dexId) ?? "unknown",
    chainId: "solana",
    mint,
    symbol: str(base?.symbol) ?? "",
    name: str(base?.name) ?? "",
    quoteMint: str(quote?.address) ?? "",
    quoteSymbol: str(quote?.symbol) ?? "",
    priceUsd,
    priceNative: num(raw.priceNative) ?? 0,
    liquidityUsd: num(liquidity.usd) ?? 0,
    fdvUsd: num(raw.fdv),
    marketCapUsd: num(raw.marketCap),
    volumeUsd: window4(raw.volume),
    txns: {
      m5: buysSells(txns.m5),
      h1: buysSells(txns.h1),
      h6: buysSells(txns.h6),
      h24: buysSells(txns.h24),
    },
    priceChangePct: window4(raw.priceChange),
    pairCreatedAt: num(raw.pairCreatedAt),
    boostsActive: num(boosts.active) ?? 0,
    socials,
    websites,
    labels,
    fetchedAt: Date.now(),
  };
}

/** Highest-liquidity pair, preferring a WSOL or USDC quote when one exists. */
export function pickPrimaryPair(pairs: PairSnapshot[]): PairSnapshot | null {
  if (pairs.length === 0) return null;
  const preferred = pairs.filter((p) => PREFERRED_QUOTES.has(p.quoteMint));
  const pool = preferred.length > 0 ? preferred : pairs;
  let best: PairSnapshot | null = null;
  for (const p of pool) {
    if (!best || p.liquidityUsd > best.liquidityUsd) best = p;
  }
  return best;
}

function normalizeMany(raw: unknown): PairSnapshot[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) => {
    const n = normalizePair(p);
    return n ? [n] : [];
  });
}

/** GET /tokens/v1/solana/{csv}: bare array of pairs, batched 30 mints per call. */
export async function getPairsByTokens(mints: string[]): Promise<PairSnapshot[]> {
  const unique = [...new Set(mints.filter((m) => typeof m === "string" && m.length > 0))];
  const out: PairSnapshot[] = [];
  for (let i = 0; i < unique.length; i += TOKENS_PER_BATCH) {
    const batch = unique.slice(i, i + TOKENS_PER_BATCH);
    const url = `${BASE}/tokens/v1/solana/${batch.join(",")}`;
    const raw = await getJson<unknown>(url, { limiter: pairsLimiter, cache: pairCache, cacheTtlMs: PAIR_CACHE_TTL_MS });
    out.push(...normalizeMany(raw));
  }
  return out;
}

/** GET /latest/dex/pairs/solana/{addr}: {schemaVersion, pairs:[...], pair:{...}}. */
export async function getPairByAddress(pairAddress: string): Promise<PairSnapshot | null> {
  const url = `${BASE}/latest/dex/pairs/solana/${encodeURIComponent(pairAddress)}`;
  const raw = await getJson<unknown>(url, { limiter: pairsLimiter, cache: pairCache, cacheTtlMs: PAIR_CACHE_TTL_MS });
  if (!isRec(raw)) return null;
  const direct = normalizePair(raw.pair);
  if (direct) return direct;
  const list = normalizeMany(raw.pairs);
  return list[0] ?? null;
}

/** GET /token-boosts/top/v1 filtered to solana. */
export async function getTopBoosts(): Promise<Array<{ mint: string; totalAmount: number }>> {
  const raw = await getJson<unknown>(`${BASE}/token-boosts/top/v1`, { limiter: boostsLimiter });
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((b) => {
    if (!isRec(b) || b.chainId !== "solana") return [];
    const mint = str(b.tokenAddress);
    if (!mint) return [];
    return [{ mint, totalAmount: num(b.totalAmount) ?? num(b.amount) ?? 0 }];
  });
}

/** GET /token-profiles/latest/v1 filtered to solana. */
export async function getLatestProfiles(): Promise<Array<{ mint: string; description: string | null }>> {
  const raw = await getJson<unknown>(`${BASE}/token-profiles/latest/v1`, { limiter: boostsLimiter });
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) => {
    if (!isRec(p) || p.chainId !== "solana") return [];
    const mint = str(p.tokenAddress);
    if (!mint) return [];
    return [{ mint, description: str(p.description) }];
  });
}

/** GET /latest/dex/search?q=: solana pairs only. */
export async function searchPairs(q: string): Promise<PairSnapshot[]> {
  const url = `${BASE}/latest/dex/search?q=${encodeURIComponent(q)}`;
  const raw = await getJson<unknown>(url, { limiter: pairsLimiter, cache: pairCache, cacheTtlMs: PAIR_CACHE_TTL_MS });
  if (!isRec(raw)) return [];
  const pairs = normalizeMany(raw.pairs);
  logger.debug({ q, count: pairs.length }, "dexscreener search");
  return pairs;
}
