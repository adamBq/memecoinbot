/**
 * Jupiter lite API client: swap quotes and USD prices.
 *
 * Base URL https://lite-api.jup.ag, no API key. Quotes are never cached
 * (they are the live order book); prices are cached 20s. Token amounts are
 * handled as bigint throughout, never as floats.
 */
import { WSOL_MINT } from "../core/config.js";
import { getJson, HttpError, limiterFor, TtlCache } from "../core/http.js";
import { logger } from "../core/logger.js";
import type { JupiterQuote, SellabilityCheck } from "../core/types.js";

export const JUPITER_BASE_URL = "https://lite-api.jup.ag";

const PRICE_TTL_MS = 20_000;
/** price/v3 accepts a comma separated list; keep batches small to stay under URL limits. */
const PRICE_BATCH_SIZE = 50;
const LAMPORTS_PER_SOL = 1_000_000_000n;

const limiter = limiterFor("lite-api.jup.ag", 60, 1);
const priceCache = new TtlCache();

export interface JupiterPrice {
  usdPrice: number;
  decimals: number;
  liquidity: number;
}

interface RawRoutePlan {
  swapInfo?: { ammKey?: unknown; label?: unknown };
  percent?: unknown;
}

interface RawQuote {
  inputMint?: unknown;
  outputMint?: unknown;
  inAmount?: unknown;
  outAmount?: unknown;
  priceImpactPct?: unknown;
  slippageBps?: unknown;
  routePlan?: unknown;
  error?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Jupiter returns raw amounts as decimal strings. Reject anything that is not a plain integer. */
function toBigInt(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Normalise a raw quote body. Null when the body is an error or malformed. */
export function normalizeQuote(raw: unknown, fetchedAt = Date.now()): JupiterQuote | null {
  if (!isRecord(raw)) return null;
  const q = raw as RawQuote;
  if (q.error !== undefined) return null;
  const inAmount = toBigInt(q.inAmount);
  const outAmount = toBigInt(q.outAmount);
  if (typeof q.inputMint !== "string" || typeof q.outputMint !== "string" || inAmount === null || outAmount === null) {
    return null;
  }
  const routeLabels: string[] = [];
  if (Array.isArray(q.routePlan)) {
    for (const leg of q.routePlan as RawRoutePlan[]) {
      const label = leg?.swapInfo?.label;
      if (typeof label === "string" && label) routeLabels.push(label);
    }
  }
  return {
    inputMint: q.inputMint,
    outputMint: q.outputMint,
    inAmount,
    outAmount,
    // Jupiter reports price impact as a fraction string ("0.0013" = 0.13%); expose percent.
    priceImpactPct: (toNumber(q.priceImpactPct) ?? 0) * 100,
    slippageBps: toNumber(q.slippageBps) ?? 0,
    routeLabels,
    fetchedAt,
  };
}

/**
 * GET /swap/v1/quote. Returns null when Jupiter has no route (4xx with an
 * `{error}` body), when the body is malformed, or when the request fails;
 * callers treat null as "not sellable / unknown impact".
 */
export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: bigint,
  slippageBps = 100,
): Promise<JupiterQuote | null> {
  if (amountRaw <= 0n) return null;
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountRaw.toString(),
    slippageBps: String(slippageBps),
  });
  const url = `${JUPITER_BASE_URL}/swap/v1/quote?${params.toString()}`;
  try {
    const body = await getJson<unknown>(url, { limiter, nullOnStatus: [400, 404, 422] });
    if (body === null) return null;
    const quote = normalizeQuote(body);
    if (!quote) {
      const err = isRecord(body) ? body.error : undefined;
      logger.debug({ inputMint, outputMint, err }, "jupiter quote: no route or malformed body");
    }
    return quote;
  } catch (err) {
    if (err instanceof HttpError) {
      logger.debug({ url, status: err.status, body: err.body }, "jupiter quote: http error, treating as no route");
    } else {
      logger.warn({ url, err: String(err) }, "jupiter quote: request failed, treating as no route");
    }
    return null;
  }
}

/** GET /price/v3?ids=csv. Missing or unpriced mints are simply absent from the result. */
export async function getPricesUsd(mints: string[]): Promise<Record<string, JupiterPrice>> {
  const out: Record<string, JupiterPrice> = {};
  const unique = [...new Set(mints.filter((m) => typeof m === "string" && m.length > 0))];
  for (let i = 0; i < unique.length; i += PRICE_BATCH_SIZE) {
    const batch = unique.slice(i, i + PRICE_BATCH_SIZE);
    const url = `${JUPITER_BASE_URL}/price/v3?ids=${batch.join(",")}`;
    const body = await getJson<unknown>(url, { limiter, cache: priceCache, cacheTtlMs: PRICE_TTL_MS });
    if (!isRecord(body)) continue;
    for (const mint of batch) {
      const entry = body[mint];
      if (!isRecord(entry)) continue;
      const usdPrice = toNumber(entry.usdPrice);
      if (usdPrice === null || usdPrice <= 0) continue;
      out[mint] = {
        usdPrice,
        decimals: toNumber(entry.decimals) ?? 0, // 0 means unknown; callers must treat it as missing
        liquidity: toNumber(entry.liquidity) ?? 0,
      };
    }
  }
  return out;
}

export async function getSolPriceUsd(): Promise<number> {
  const prices = await getPricesUsd([WSOL_MINT]);
  const sol = prices[WSOL_MINT];
  if (!sol) throw new Error("jupiter: SOL price unavailable");
  return sol.usdPrice;
}

/** Convert a USD notional to lamports using the SOL price. Rounds to the nearest lamport. */
export function usdToLamports(notionalUsd: number, solPriceUsd: number): bigint {
  if (!(notionalUsd > 0) || !(solPriceUsd > 0)) return 0n;
  return BigInt(Math.round((notionalUsd * Number(LAMPORTS_PER_SOL)) / solPriceUsd));
}

/**
 * Simulate buying `notionalUsd` of `mint` with WSOL then selling the received
 * tokens straight back. Retention is computed on raw lamports with bigint
 * arithmetic (1e-4 percent precision). Either leg missing means no route.
 */
export async function checkSellability(mint: string, notionalUsd: number): Promise<SellabilityCheck> {
  const fetchedAt = Date.now();
  const noRoute = (buyImpact = 0): SellabilityCheck => ({
    mint,
    routeFound: false,
    buyPriceImpactPct: buyImpact,
    sellPriceImpactPct: 0,
    roundTripRetentionPct: 0,
    fetchedAt,
  });

  const solPrice = await getSolPriceUsd();
  const lamportsIn = usdToLamports(notionalUsd, solPrice);
  if (lamportsIn <= 0n) return noRoute();

  const buy = await getQuote(WSOL_MINT, mint, lamportsIn);
  if (!buy || buy.outAmount <= 0n) return noRoute();

  const sell = await getQuote(mint, WSOL_MINT, buy.outAmount);
  if (!sell) return noRoute(buy.priceImpactPct);

  // Integer ratio at 1e-4 percent precision, converted to a float only at the end.
  const retentionMicro = (sell.outAmount * 1_000_000n) / lamportsIn;
  return {
    mint,
    routeFound: true,
    buyPriceImpactPct: buy.priceImpactPct,
    sellPriceImpactPct: sell.priceImpactPct,
    roundTripRetentionPct: Number(retentionMicro) / 10_000,
    fetchedAt,
  };
}
