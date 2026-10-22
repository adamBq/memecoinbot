/**
 * Builds the derived SentimentSignals and EventSignals from raw inputs. Pure.
 */
import type { Candle, EventSignals, PairSnapshot, SafetyReport, SentimentSignals } from "../core/types.js";
import { buyPressure } from "./lens.js";
import { lastVolumeZScore, mean } from "./indicators.js";

/** DexScreener dexIds that are launchpad bonding curves, i.e. not yet graduated. */
export const BONDING_CURVE_DEX_IDS: ReadonlySet<string> = new Set(["pumpfun", "launchlab", "moonshot", "moonit", "boop"]);
/** AMMs that only ever list tokens which graduated from a launchpad. */
export const LAUNCHPAD_AMM_DEX_IDS: ReadonlySet<string> = new Set(["pumpswap"]);

export const DAY_MS = 24 * 60 * 60 * 1000;
export const VOLUME_SPIKE_MULTIPLE = 3;
export const VOLUME_SPIKE_LOOKBACK_5M = 72;
export const VOLUME_SPIKE_MIN_PRIOR_5M = 12;
export const VOLUME_Z_LOOKBACK_1H = 24;
export const VOLUME_Z_MIN_PRIOR_1H = 3;

export function isBondingCurveDex(dexId: string): boolean {
  return BONDING_CURVE_DEX_IDS.has(dexId.trim().toLowerCase());
}

function matchesSocial(s: { type: string; url: string }, typeRe: RegExp, urlRe: RegExp): boolean {
  return typeRe.test(s.type.trim()) || urlRe.test(s.url.trim());
}

export function buildSentimentSignals(
  pair: PairSnapshot,
  ranks: { dexscreener: number | null; coingecko: number | null },
  llm: { score: number; reason: string } | null,
): SentimentSignals {
  const hasTwitter = pair.socials.some((s) =>
    matchesSocial(s, /^(twitter|x)$/i, /^https?:\/\/(www\.)?(twitter\.com|x\.com)\//i),
  );
  const hasTelegram = pair.socials.some((s) => matchesSocial(s, /^telegram$/i, /^https?:\/\/(www\.)?(t\.me|telegram\.(me|org))\//i));
  return {
    mint: pair.mint,
    boostsActive: Math.max(0, pair.boostsActive),
    hasWebsite: pair.websites.length > 0,
    hasTwitter,
    hasTelegram,
    socialCount: pair.socials.length,
    dexscreenerTrendingRank: ranks.dexscreener,
    coingeckoTrendingRank: ranks.coingecko,
    buyPressure1h: buyPressure(pair.txns.h1),
    llmNarrativeScore: llm ? llm.score : null,
    llmNarrativeReason: llm ? llm.reason : null,
  };
}

/** Last 5m candle volume above `multiple` x the average of the preceding `lookback` candles. */
export function detectVolumeSpike5m(
  candles5m: Candle[],
  multiple = VOLUME_SPIKE_MULTIPLE,
  lookback = VOLUME_SPIKE_LOOKBACK_5M,
  minPrior = VOLUME_SPIKE_MIN_PRIOR_5M,
): boolean {
  if (candles5m.length < minPrior + 1) return false;
  const last = candles5m[candles5m.length - 1];
  if (!last) return false;
  const start = Math.max(0, candles5m.length - 1 - lookback);
  const prior = candles5m.slice(start, candles5m.length - 1).map((c) => c.v);
  const avg = mean(prior);
  if (avg <= 0) return false;
  return last.v > multiple * avg;
}

export function buildEventSignals(
  pair: PairSnapshot,
  candles5m: Candle[],
  candles1h: Candle[],
  safety: SafetyReport | null,
  enteredTrending: boolean,
  llm: { score: number; reason: string } | null,
  now: number = Date.now(),
): EventSignals {
  const dexId = pair.dexId.trim().toLowerCase();
  const onBondingCurve = isBondingCurveDex(dexId);
  const launchpadKnown = (safety?.launchpad ?? null) !== null || LAUNCHPAD_AMM_DEX_IDS.has(dexId);
  const graduatedFromLaunchpad = launchpadKnown && !onBondingCurve;
  const newPoolWithin24h =
    pair.pairCreatedAt !== null && !onBondingCurve && now - pair.pairCreatedAt >= 0 && now - pair.pairCreatedAt < DAY_MS;
  return {
    mint: pair.mint,
    newPoolWithin24h,
    graduatedFromLaunchpad,
    enteredTrendingList: enteredTrending,
    volumeZScore1h: lastVolumeZScore(candles1h, VOLUME_Z_LOOKBACK_1H, VOLUME_Z_MIN_PRIOR_1H) ?? 0,
    volumeSpike5m: detectVolumeSpike5m(candles5m),
    llmEventScore: llm ? llm.score : null,
    llmEventReason: llm ? llm.reason : null,
  };
}
