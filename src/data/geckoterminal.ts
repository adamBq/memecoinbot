/**
 * GeckoTerminal client for Solana pools: trending, new, and OHLCV.
 * Single limiter at 30/min. OHLCV is cached for one candle period so a
 * screening loop never refetches the same unchanged series.
 *
 * Shapes verified live 2026-10-22, see tests/fixtures/gecko_*.json.
 */
import { getJson, limiterFor, TtlCache } from "../core/http.js";
import type { Candle } from "../core/types.js";

const BASE = "https://api.geckoterminal.com/api/v2/networks/solana";
const limiter = limiterFor("api.geckoterminal.com", 2, 0.12);
const ohlcvCache = new TtlCache();

export type OhlcvTimeframe = "minute" | "hour" | "day";

const TIMEFRAME_SECONDS: Record<OhlcvTimeframe, number> = { minute: 60, hour: 3600, day: 86400 };

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Strip the "solana_" network prefix from a GeckoTerminal id. */
function stripNetwork(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const bare = id.startsWith("solana_") ? id.slice("solana_".length) : id;
  return bare.length > 0 ? bare : null;
}

interface RawPool {
  pairAddress: string;
  mint: string;
  createdAt: number | null;
}

function parsePool(entry: unknown): RawPool | null {
  if (!isRec(entry)) return null;
  const attrs = isRec(entry.attributes) ? entry.attributes : {};
  const rel = isRec(entry.relationships) ? entry.relationships : {};
  const baseTok = isRec(rel.base_token) ? rel.base_token : {};
  const baseData = isRec(baseTok.data) ? baseTok.data : {};
  const pairAddress = (typeof attrs.address === "string" && attrs.address) || stripNetwork(entry.id);
  const mint = stripNetwork(baseData.id);
  if (!pairAddress || !mint) return null;
  const created = typeof attrs.pool_created_at === "string" ? Date.parse(attrs.pool_created_at) : NaN;
  return { pairAddress, mint, createdAt: Number.isFinite(created) ? created : null };
}

async function fetchPools(path: "trending_pools" | "new_pools", pages: number): Promise<RawPool[]> {
  const out: RawPool[] = [];
  const n = Math.max(1, Math.floor(pages));
  for (let page = 1; page <= n; page++) {
    const raw = await getJson<unknown>(`${BASE}/${path}?page=${page}`, { limiter });
    if (!isRec(raw) || !Array.isArray(raw.data)) break;
    const parsed = raw.data.flatMap((e) => {
      const p = parsePool(e);
      return p ? [p] : [];
    });
    out.push(...parsed);
    if (raw.data.length === 0) break;
  }
  return out;
}

/** GET /trending_pools?page=N. Rank is 1-based across all requested pages. */
export async function getTrendingPools(pages = 1): Promise<Array<{ pairAddress: string; mint: string; rank: number }>> {
  const pools = await fetchPools("trending_pools", pages);
  return pools.map((p, i) => ({ pairAddress: p.pairAddress, mint: p.mint, rank: i + 1 }));
}

/** GET /new_pools?page=N. createdAt is ms since epoch (0 when the API omits it). */
export async function getNewPools(pages = 1): Promise<Array<{ pairAddress: string; mint: string; createdAt: number }>> {
  const pools = await fetchPools("new_pools", pages);
  return pools.map((p) => ({ pairAddress: p.pairAddress, mint: p.mint, createdAt: p.createdAt ?? 0 }));
}

/** Parse an ohlcv_list payload ([tSec,o,h,l,c,vUsd] rows, newest first) into ascending candles. */
export function normalizeOhlcv(raw: unknown): Candle[] {
  if (!isRec(raw)) return [];
  const data = isRec(raw.data) ? raw.data : {};
  const attrs = isRec(data.attributes) ? data.attributes : {};
  const list = Array.isArray(attrs.ohlcv_list) ? attrs.ohlcv_list : [];
  const candles: Candle[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const t = num(row[0]);
    const o = num(row[1]);
    const h = num(row[2]);
    const l = num(row[3]);
    const c = num(row[4]);
    if (t === null || o === null || h === null || l === null || c === null) continue;
    candles.push({ t, o, h, l, c, v: num(row[5]) ?? 0 });
  }
  candles.sort((a, b) => a.t - b.t);
  return candles;
}

/** GET /pools/{pool}/ohlcv/{timeframe}?aggregate&limit. Ascending by t. Cached one candle period. */
export async function getOhlcv(
  pairAddress: string,
  timeframe: OhlcvTimeframe,
  aggregate: number,
  limit: number,
): Promise<Candle[]> {
  const agg = Math.max(1, Math.floor(aggregate));
  const lim = Math.max(1, Math.min(1000, Math.floor(limit)));
  const url = `${BASE}/pools/${encodeURIComponent(pairAddress)}/ohlcv/${timeframe}?aggregate=${agg}&limit=${lim}`;
  const ttlMs = TIMEFRAME_SECONDS[timeframe] * agg * 1000;
  const raw = await getJson<unknown>(url, { limiter, cache: ohlcvCache, cacheTtlMs: ttlMs });
  return normalizeOhlcv(raw);
}
