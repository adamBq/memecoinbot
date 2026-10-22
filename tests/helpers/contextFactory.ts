/**
 * Deterministic TokenContext fixture builder for tests. `makeContext()` gives
 * a realistic "good" token that passes every hard filter, is in a confirmed
 * breakout, and scores above the entry threshold; `makeContext({ good: false })`
 * gives a "rug-ish" token that fails several filters. Every piece can be
 * overridden. No randomness: candles are generated from smooth functions so
 * results are stable across runs.
 */
import { loadStrategyConfig, type StrategyConfig } from "../../src/core/config.js";
import type {
  Candle,
  EventSignals,
  PairSnapshot,
  SafetyReport,
  SellabilityCheck,
  SentimentSignals,
  TokenContext,
} from "../../src/core/types.js";
import { buildEventSignals, buildSentimentSignals } from "../../src/analysis/signals.js";

export const FIXED_NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
export const GOOD_MINT = "GoodMint1111111111111111111111111111111111111";
export const RUG_MINT = "RugMint22222222222222222222222222222222222222";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

let cachedCfg: StrategyConfig | null = null;
/** The locked demo config, loaded once. Clone before mutating. */
export function testConfig(): StrategyConfig {
  if (!cachedCfg) cachedCfg = loadStrategyConfig("config/strategy.yaml");
  return cachedCfg;
}

/** Deep-ish clone of the config so a test can tweak thresholds safely. */
export function configWith(mutate: (cfg: StrategyConfig) => void): StrategyConfig {
  const cfg = structuredClone(testConfig());
  mutate(cfg);
  return cfg;
}

type Window = "m5" | "h1" | "h6" | "h24";
export type PairOverrides = Omit<Partial<PairSnapshot>, "volumeUsd" | "txns" | "priceChangePct"> & {
  volumeUsd?: Partial<Record<Window, number>>;
  txns?: Partial<Record<Window, { buys: number; sells: number }>>;
  priceChangePct?: Partial<Record<Window, number>>;
};

export interface ContextOptions {
  /** true (default) builds a healthy breakout token; false builds a rug-ish one. */
  good?: boolean;
  now?: number;
  pair?: PairOverrides;
  candles5m?: Candle[];
  candles1h?: Candle[];
  safety?: Partial<SafetyReport> | null;
  sellability?: Partial<SellabilityCheck> | null;
  sentiment?: Partial<SentimentSignals>;
  events?: Partial<EventSignals>;
  /** Passed to buildEventSignals when `events` is not fully overridden. */
  enteredTrending?: boolean;
  ranks?: { dexscreener: number | null; coingecko: number | null };
}

export interface Candle5mOptions {
  count?: number;
  /** Last close; every other price scales from it. */
  endPrice?: number;
  now?: number;
  /** Last hour breaks above the prior 6h high on 2.5x volume with a 5m spike at the end. */
  breakout?: boolean;
  baseVolume?: number;
}

/**
 * 5m candles ending at `now`. The prior leg drifts from 0.80 to ~0.92 of the
 * end price with a gentle oscillation; with `breakout` the final hour climbs
 * to the end price on elevated volume, otherwise it idles below the range high.
 */
export function makeCandles5m(opts: Candle5mOptions = {}): Candle[] {
  const count = opts.count ?? 100;
  const endPrice = opts.endPrice ?? 1;
  const now = opts.now ?? FIXED_NOW;
  const breakout = opts.breakout ?? true;
  const baseVolume = opts.baseVolume ?? 1000;
  const lastLeg = Math.min(12, count);
  const priorCount = count - lastLeg;
  const out: Candle[] = [];
  let prevClose: number | null = null;
  for (let i = 0; i < count; i++) {
    let rel: number;
    let vol: number;
    if (i < priorCount) {
      const f = priorCount > 1 ? i / (priorCount - 1) : 1;
      rel = 0.8 + 0.12 * f + 0.012 * Math.sin(i * 0.9);
      vol = baseVolume * (1 + 0.2 * Math.sin(i * 0.7));
    } else {
      const j = i - priorCount;
      const f = lastLeg > 1 ? j / (lastLeg - 1) : 1;
      if (breakout) {
        rel = 0.935 + 0.065 * f + 0.006 * Math.sin(j * 2.1);
        vol = j === lastLeg - 1 ? baseVolume * 4.5 : baseVolume * 2.5;
      } else {
        rel = 0.9 + 0.008 * Math.sin(j * 2.1);
        vol = baseVolume * (1 + 0.2 * Math.sin(i * 0.7));
      }
    }
    if (i === count - 1 && breakout) rel = 1;
    const c = rel * endPrice;
    const o = prevClose ?? c * 0.998;
    const h = Math.max(o, c) * 1.004;
    const l = Math.min(o, c) * 0.996;
    out.push({ t: Math.floor((now - (count - i) * 5 * 60_000) / 1000), o, h, l, c, v: vol });
    prevClose = c;
  }
  return out;
}

export interface Candle1hOptions {
  count?: number;
  endPrice?: number;
  now?: number;
  /** Last candle volume is a multiple of the base, producing a high z-score. */
  lastVolumeMultiple?: number;
  baseVolume?: number;
  /** Uptrend (default) or downtrend. */
  trend?: "up" | "down";
}

/** 1h candles ending at `now`, trending from 55% of the end price (up) or 180% (down). */
export function makeCandles1h(opts: Candle1hOptions = {}): Candle[] {
  const count = opts.count ?? 30;
  const endPrice = opts.endPrice ?? 1;
  const now = opts.now ?? FIXED_NOW;
  const baseVolume = opts.baseVolume ?? 50_000;
  const lastMult = opts.lastVolumeMultiple ?? 2.4;
  const trend = opts.trend ?? "up";
  const out: Candle[] = [];
  let prevClose: number | null = null;
  for (let i = 0; i < count; i++) {
    const f = count > 1 ? i / (count - 1) : 1;
    let rel = trend === "up" ? 0.55 + 0.45 * f + 0.02 * Math.sin(i * 1.3) : 1.8 - 0.8 * f + 0.02 * Math.sin(i * 1.3);
    if (i === count - 1) rel = 1;
    const c = rel * endPrice;
    const o = prevClose ?? c * 0.99;
    const h = Math.max(o, c) * 1.02;
    const l = Math.min(o, c) * 0.98;
    const v = i === count - 1 ? baseVolume * lastMult : baseVolume * (1 + 0.3 * Math.sin(i));
    out.push({ t: Math.floor((now - (count - i) * HOUR_MS) / 1000), o, h, l, c, v });
    prevClose = c;
  }
  return out;
}

export function makePair(overrides: PairOverrides = {}, now = FIXED_NOW): PairSnapshot {
  const base: PairSnapshot = {
    pairAddress: "GoodPair111111111111111111111111111111111111",
    dexId: "pumpswap",
    chainId: "solana",
    mint: GOOD_MINT,
    symbol: "GOOD",
    name: "Good Token",
    quoteMint: "So11111111111111111111111111111111111111112",
    quoteSymbol: "SOL",
    priceUsd: 0.0021,
    priceNative: 0.0000105,
    liquidityUsd: 250_000,
    fdvUsd: 2_100_000,
    marketCapUsd: 2_100_000,
    volumeUsd: { m5: 15_000, h1: 120_000, h6: 500_000, h24: 1_500_000 },
    txns: {
      m5: { buys: 40, sells: 25 },
      h1: { buys: 400, sells: 300 },
      h6: { buys: 2000, sells: 1600 },
      h24: { buys: 7000, sells: 6000 },
    },
    priceChangePct: { m5: 2, h1: 12, h6: 35, h24: 80 },
    pairCreatedAt: now - 5 * DAY_MS,
    boostsActive: 100,
    socials: [
      { type: "twitter", url: "https://x.com/goodtoken" },
      { type: "telegram", url: "https://t.me/goodtoken" },
    ],
    websites: ["https://goodtoken.example"],
    labels: [],
    fetchedAt: now,
  };
  const { volumeUsd, txns, priceChangePct, ...rest } = overrides;
  return {
    ...base,
    ...rest,
    volumeUsd: { ...base.volumeUsd, ...(volumeUsd ?? {}) },
    txns: { ...base.txns, ...(txns ?? {}) },
    priceChangePct: { ...base.priceChangePct, ...(priceChangePct ?? {}) },
  };
}

export function makeRugPair(overrides: PairOverrides = {}, now = FIXED_NOW): PairSnapshot {
  return makePair(
    {
      pairAddress: "RugPair2222222222222222222222222222222222222",
      dexId: "pumpfun",
      mint: RUG_MINT,
      symbol: "RUG",
      name: "Definitely Not A Rug",
      priceUsd: 0.00003,
      liquidityUsd: 12_000,
      fdvUsd: 90_000,
      marketCapUsd: 90_000,
      volumeUsd: { m5: 500, h1: 4_000, h6: 12_000, h24: 30_000 },
      txns: {
        m5: { buys: 2, sells: 6 },
        h1: { buys: 10, sells: 30 },
        h6: { buys: 80, sells: 150 },
        h24: { buys: 300, sells: 500 },
      },
      priceChangePct: { m5: -4, h1: -25, h6: -45, h24: -60 },
      pairCreatedAt: now - 1 * HOUR_MS,
      boostsActive: 0,
      socials: [],
      websites: [],
      ...overrides,
    },
    now,
  );
}

export function makeSafety(overrides: Partial<SafetyReport> = {}, now = FIXED_NOW): SafetyReport {
  return {
    mint: GOOD_MINT,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    top10HolderPct: 22,
    largestHolderPct: 6,
    totalHolders: 4000,
    lpLockedPct: 100,
    rugcheckScoreNormalised: 5,
    risks: [],
    rugged: false,
    transferFeePct: 0,
    metadataMutable: false,
    launchpad: "pump.fun",
    creator: "Creator11111111111111111111111111111111111111",
    fetchedAt: now,
    ...overrides,
  };
}

export function makeRugSafety(overrides: Partial<SafetyReport> = {}, now = FIXED_NOW): SafetyReport {
  return makeSafety(
    {
      mint: RUG_MINT,
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      top10HolderPct: 70,
      largestHolderPct: 40,
      totalHolders: 120,
      lpLockedPct: 0,
      rugcheckScoreNormalised: 60,
      risks: [
        { name: "Mint Authority still enabled", level: "danger", description: "Can mint more" },
        { name: "Freeze Authority still enabled", level: "danger", description: "Can freeze" },
        { name: "Top 10 holders high ownership", level: "danger" },
      ],
      metadataMutable: true,
      launchpad: null,
      ...overrides,
    },
    now,
  );
}

export function makeSellability(overrides: Partial<SellabilityCheck> = {}, now = FIXED_NOW): SellabilityCheck {
  return {
    mint: GOOD_MINT,
    routeFound: true,
    buyPriceImpactPct: 0.6,
    sellPriceImpactPct: 0.7,
    roundTripRetentionPct: 97.5,
    fetchedAt: now,
    ...overrides,
  };
}

export function makeSentiment(overrides: Partial<SentimentSignals> = {}): SentimentSignals {
  return {
    mint: GOOD_MINT,
    boostsActive: 100,
    hasWebsite: true,
    hasTwitter: true,
    hasTelegram: true,
    socialCount: 2,
    dexscreenerTrendingRank: 5,
    coingeckoTrendingRank: null,
    buyPressure1h: 400 / 700,
    llmNarrativeScore: null,
    llmNarrativeReason: null,
    ...overrides,
  };
}

export function makeEvents(overrides: Partial<EventSignals> = {}): EventSignals {
  return {
    mint: GOOD_MINT,
    newPoolWithin24h: false,
    graduatedFromLaunchpad: true,
    enteredTrendingList: true,
    volumeZScore1h: 4,
    volumeSpike5m: true,
    llmEventScore: null,
    llmEventReason: null,
    ...overrides,
  };
}

export function makeContext(opts: ContextOptions = {}): TokenContext {
  const good = opts.good ?? true;
  const now = opts.now ?? FIXED_NOW;
  const pair = good ? makePair(opts.pair ?? {}, now) : makeRugPair(opts.pair ?? {}, now);
  const candles5m =
    opts.candles5m ??
    (good
      ? makeCandles5m({ endPrice: pair.priceUsd, now, breakout: true })
      : makeCandles5m({ endPrice: pair.priceUsd, now, breakout: false, count: 30 }));
  const candles1h =
    opts.candles1h ??
    (good
      ? makeCandles1h({ endPrice: pair.priceUsd, now })
      : makeCandles1h({ endPrice: pair.priceUsd, now, count: 2, trend: "down", lastVolumeMultiple: 0.5 }));
  const safety =
    opts.safety === null
      ? null
      : good
        ? makeSafety(opts.safety ?? {}, now)
        : makeRugSafety(opts.safety ?? {}, now);
  const sellability =
    opts.sellability === null
      ? null
      : makeSellability({ mint: pair.mint, ...(good ? {} : { roundTripRetentionPct: 80 }), ...(opts.sellability ?? {}) }, now);
  const ranks = opts.ranks ?? (good ? { dexscreener: 5, coingecko: null } : { dexscreener: null, coingecko: null });
  const sentiment = { ...buildSentimentSignals(pair, ranks, null), ...(opts.sentiment ?? {}) };
  const enteredTrending = opts.enteredTrending ?? good;
  const events = { ...buildEventSignals(pair, candles5m, candles1h, safety, enteredTrending, null, now), ...(opts.events ?? {}) };
  return { pair, candles5m, candles1h, safety, sellability, sentiment, events };
}

export interface LinearCandleOptions {
  count: number;
  startPrice?: number;
  /** Close-to-close change per candle in percent (negative for a downtrend). */
  stepPct?: number;
  /** Half-range of the wick around the body in percent. */
  wickPct?: number;
  volume?: number;
  intervalSec?: number;
  now?: number;
}

/** Simple geometric series of candles, handy for indicator edge cases. */
export function makeLinearCandles(opts: LinearCandleOptions): Candle[] {
  const { count } = opts;
  const startPrice = opts.startPrice ?? 1;
  const stepPct = opts.stepPct ?? 0;
  const wickPct = opts.wickPct ?? 0.5;
  const volume = opts.volume ?? 1000;
  const intervalSec = opts.intervalSec ?? 300;
  const now = opts.now ?? FIXED_NOW;
  const out: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const o = price;
    const c = price * (1 + stepPct / 100);
    const h = Math.max(o, c) * (1 + wickPct / 100);
    const l = Math.min(o, c) * (1 - wickPct / 100);
    out.push({ t: Math.floor(now / 1000) - (count - i) * intervalSec, o, h, l, c, v: volume });
    price = c;
  }
  return out;
}
