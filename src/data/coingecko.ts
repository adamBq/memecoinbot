/**
 * CoinGecko trending list resolved to Solana mints.
 *
 * /search/trending has no chain info, so each coin is looked up via
 * /coins/{id} and its `platforms.solana` address. The public API is tightly
 * rate limited: shared limiter at 10 burst / 0.4 per second, the final
 * trending result is cached 15 minutes and each coin lookup 6 hours.
 */
import { getJson, HttpError, limiterFor, TtlCache } from "../core/http.js";
import { logger } from "../core/logger.js";
import { isValidMint, sanitizeUntrustedText } from "../core/sanitize.js";

export const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";

const TRENDING_TTL_MS = 15 * 60_000;
const COIN_TTL_MS = 6 * 60 * 60_000;
const COIN_QUERY = "localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false";

const limiter = limiterFor("api.coingecko.com", 4, 0.12);

export interface TrendingSolanaCoin {
  mint: string;
  rank: number;
  name: string;
  symbol: string;
}

const trendingCache = new TtlCache<TrendingSolanaCoin[]>();
/** Coin id -> solana mint, or null when the coin has no solana platform. */
const coinMintCache = new TtlCache<string | null>();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pull the solana contract address out of a /coins/{id} body, null when absent or invalid. */
export function extractSolanaMint(coin: unknown): string | null {
  if (!isRecord(coin)) return null;
  const platforms = coin.platforms;
  if (!isRecord(platforms)) return null;
  const mint = platforms.solana;
  if (typeof mint !== "string") return null;
  const trimmed = mint.trim();
  return isValidMint(trimmed) ? trimmed : null;
}

async function lookupSolanaMint(id: string): Promise<string | null> {
  const cached = coinMintCache.get(id);
  if (cached !== undefined) return cached;
  const url = `${COINGECKO_BASE_URL}/coins/${encodeURIComponent(id)}?${COIN_QUERY}`;
  const body = await getJson<unknown>(url, { limiter, nullOnStatus: [404] });
  const mint = body === null ? null : extractSolanaMint(body);
  coinMintCache.set(id, mint, COIN_TTL_MS);
  return mint;
}

interface TrendingItem {
  id: string;
  name: string;
  symbol: string;
}

function parseTrendingItems(body: unknown): TrendingItem[] {
  if (!isRecord(body) || !Array.isArray(body.coins)) return [];
  const items: TrendingItem[] = [];
  for (const entry of body.coins) {
    if (!isRecord(entry) || !isRecord(entry.item)) continue;
    const { id, name, symbol } = entry.item;
    if (typeof id !== "string" || !id) continue;
    items.push({
      id,
      name: sanitizeUntrustedText(typeof name === "string" ? name : "", 80).text,
      symbol: sanitizeUntrustedText(typeof symbol === "string" ? symbol : "", 32).text,
    });
  }
  return items;
}

/**
 * Trending coins that have a Solana mint, in trending order (rank 1 = top).
 * A single failed coin lookup is skipped; a failed trending fetch throws so
 * discovery can treat the whole source as unavailable.
 */
export async function getTrendingSolanaMints(): Promise<TrendingSolanaCoin[]> {
  const cached = trendingCache.get("trending");
  if (cached) return cached;

  const body = await getJson<unknown>(`${COINGECKO_BASE_URL}/search/trending`, { limiter });
  const items = parseTrendingItems(body);

  const out: TrendingSolanaCoin[] = [];
  for (const [index, item] of items.slice(0, 10).entries()) { // top 10 only; the public API 429s beyond that
    const rank = index + 1;
    let mint: string | null;
    try {
      mint = await lookupSolanaMint(item.id);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : undefined;
      logger.warn({ id: item.id, status, err: String(err) }, "coingecko: coin lookup failed, skipping");
      continue;
    }
    if (!mint) continue;
    out.push({ mint, rank, name: item.name, symbol: item.symbol });
  }

  trendingCache.set("trending", out, TRENDING_TTL_MS);
  return out;
}
