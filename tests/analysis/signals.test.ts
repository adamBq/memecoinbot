import { describe, it, expect } from "vitest";
import { buildEventSignals, buildSentimentSignals, detectVolumeSpike5m, isBondingCurveDex } from "../../src/analysis/signals.js";
import { FIXED_NOW, makeCandles1h, makeCandles5m, makeLinearCandles, makePair, makeSafety } from "../helpers/contextFactory.js";

const HOUR = 3_600_000;

describe("buildSentimentSignals", () => {
  it("maps the good pair", () => {
    const s = buildSentimentSignals(makePair(), { dexscreener: 3, coingecko: 7 }, { score: 0.8, reason: "solid meme" });
    expect(s).toEqual({
      mint: makePair().mint,
      boostsActive: 100,
      hasWebsite: true,
      hasTwitter: true,
      hasTelegram: true,
      socialCount: 2,
      dexscreenerTrendingRank: 3,
      coingeckoTrendingRank: 7,
      buyPressure1h: 400 / 700,
      llmNarrativeScore: 0.8,
      llmNarrativeReason: "solid meme",
    });
  });

  it.each([
    { name: "type twitter", socials: [{ type: "twitter", url: "https://example.com/a" }], twitter: true, telegram: false },
    { name: "type x", socials: [{ type: "X", url: "https://example.com/a" }], twitter: true, telegram: false },
    { name: "x.com url", socials: [{ type: "social", url: "https://x.com/abc" }], twitter: true, telegram: false },
    { name: "twitter.com url", socials: [{ type: "social", url: "https://www.twitter.com/abc" }], twitter: true, telegram: false },
    { name: "t.me url", socials: [{ type: "chat", url: "https://t.me/abc" }], twitter: false, telegram: true },
    { name: "type telegram", socials: [{ type: "Telegram", url: "https://example.com" }], twitter: false, telegram: true },
    { name: "discord only", socials: [{ type: "discord", url: "https://discord.gg/abc" }], twitter: false, telegram: false },
    { name: "none", socials: [], twitter: false, telegram: false },
  ])("detects socials: $name", ({ socials, twitter, telegram }) => {
    const s = buildSentimentSignals(makePair({ socials, websites: [] }), { dexscreener: null, coingecko: null }, null);
    expect(s.hasTwitter).toBe(twitter);
    expect(s.hasTelegram).toBe(telegram);
    expect(s.hasWebsite).toBe(false);
    expect(s.socialCount).toBe(socials.length);
    expect(s.llmNarrativeScore).toBeNull();
    expect(s.llmNarrativeReason).toBeNull();
  });

  it.each([
    { h1: { buys: 0, sells: 0 }, e: 0.5 },
    { h1: { buys: 10, sells: 0 }, e: 1 },
    { h1: { buys: 0, sells: 10 }, e: 0 },
    { h1: { buys: 30, sells: 70 }, e: 0.3 },
  ])("buyPressure1h for $h1 is $e", ({ h1, e }) => {
    const s = buildSentimentSignals(makePair({ txns: { h1 } }), { dexscreener: null, coingecko: null }, null);
    expect(s.buyPressure1h).toBeCloseTo(e, 10);
  });

  it("clamps negative boosts to zero", () => {
    expect(buildSentimentSignals(makePair({ boostsActive: -5 }), { dexscreener: null, coingecko: null }, null).boostsActive).toBe(0);
  });
});

describe("isBondingCurveDex", () => {
  it.each([
    { dexId: "pumpfun", e: true },
    { dexId: "PumpFun ", e: true },
    { dexId: "launchlab", e: true },
    { dexId: "moonshot", e: true },
    { dexId: "pumpswap", e: false },
    { dexId: "raydium", e: false },
    { dexId: "meteora", e: false },
    { dexId: "orca", e: false },
  ])("$dexId -> $e", ({ dexId, e }) => expect(isBondingCurveDex(dexId)).toBe(e));
});

describe("buildEventSignals", () => {
  const none = { dexscreener: null, coingecko: null };
  void none;

  it.each([
    { name: "pumpswap with launchpad", dexId: "pumpswap", launchpad: "pump.fun", e: true },
    { name: "pumpswap without safety", dexId: "pumpswap", launchpad: undefined, e: true },
    { name: "raydium with launchpad", dexId: "raydium", launchpad: "pump.fun", e: true },
    { name: "meteora with launchpad", dexId: "meteora", launchpad: "bonk", e: true },
    { name: "raydium with no launchpad", dexId: "raydium", launchpad: null, e: false },
    { name: "raydium without safety", dexId: "raydium", launchpad: undefined, e: false },
    { name: "pumpfun bonding curve", dexId: "pumpfun", launchpad: "pump.fun", e: false },
    { name: "launchlab bonding curve", dexId: "launchlab", launchpad: "launchlab", e: false },
  ])("graduatedFromLaunchpad: $name -> $e", ({ dexId, launchpad, e }) => {
    const safety = launchpad === undefined ? null : makeSafety({ launchpad });
    const ev = buildEventSignals(makePair({ dexId }), [], [], safety, false, null, FIXED_NOW);
    expect(ev.graduatedFromLaunchpad).toBe(e);
  });

  it.each([
    { name: "2h old on raydium", dexId: "raydium", createdAt: FIXED_NOW - 2 * HOUR, e: true },
    { name: "23h old on pumpswap", dexId: "pumpswap", createdAt: FIXED_NOW - 23 * HOUR, e: true },
    { name: "exactly 24h old", dexId: "raydium", createdAt: FIXED_NOW - 24 * HOUR, e: false },
    { name: "30h old", dexId: "raydium", createdAt: FIXED_NOW - 30 * HOUR, e: false },
    { name: "2h old but still on the bonding curve", dexId: "pumpfun", createdAt: FIXED_NOW - 2 * HOUR, e: false },
    { name: "unknown creation", dexId: "raydium", createdAt: null, e: false },
    { name: "created in the future", dexId: "raydium", createdAt: FIXED_NOW + HOUR, e: false },
  ])("newPoolWithin24h: $name -> $e", ({ dexId, createdAt, e }) => {
    const ev = buildEventSignals(makePair({ dexId, pairCreatedAt: createdAt }), [], [], null, false, null, FIXED_NOW);
    expect(ev.newPoolWithin24h).toBe(e);
  });

  it("passes through trending flag and llm fields", () => {
    const ev = buildEventSignals(makePair(), [], [], null, true, { score: 0.7, reason: "listing" }, FIXED_NOW);
    expect(ev.enteredTrendingList).toBe(true);
    expect(ev.llmEventScore).toBe(0.7);
    expect(ev.llmEventReason).toBe("listing");
    expect(ev.mint).toBe(makePair().mint);
    const off = buildEventSignals(makePair(), [], [], null, false, null, FIXED_NOW);
    expect(off.enteredTrendingList).toBe(false);
    expect(off.llmEventScore).toBeNull();
    expect(off.llmEventReason).toBeNull();
  });

  it.each([
    { name: "no 1h candles", candles: [] as ReturnType<typeof makeCandles1h>, e: 0 },
    { name: "three 1h candles", candles: makeCandles1h({ count: 3 }), e: 0 },
    { name: "flat volumes", candles: makeLinearCandles({ count: 30, intervalSec: 3600, volume: 100 }), e: 0 },
  ])("volumeZScore1h is 0 with insufficient data: $name", ({ candles, e }) => {
    expect(buildEventSignals(makePair(), [], candles, null, false, null, FIXED_NOW).volumeZScore1h).toBe(e);
  });

  it("computes volumeZScore1h from the last candle against the prior 24", () => {
    const candles = makeLinearCandles({ count: 30, intervalSec: 3600, volume: 100 });
    candles.forEach((c, i) => (c.v = i < 5 ? 1e9 : 100 + (i % 2) * 20)); // old spikes outside the window
    candles[29]!.v = 500;
    const z = buildEventSignals(makePair(), [], candles, null, false, null, FIXED_NOW).volumeZScore1h;
    // prior 24 alternate 100/120: mean 110, sd 10
    expect(z).toBeCloseTo((500 - 110) / 10, 6);
  });

  it.each([
    { name: "good fixture", candles: makeCandles5m(), e: true },
    { name: "no breakout leg", candles: makeCandles5m({ breakout: false }), e: false },
    { name: "fewer than 13 candles", candles: makeLinearCandles({ count: 12 }), e: false },
    { name: "flat volume", candles: makeLinearCandles({ count: 100 }), e: false },
    { name: "zero prior volume", candles: makeLinearCandles({ count: 20, volume: 0 }), e: false },
  ])("volumeSpike5m: $name -> $e", ({ candles, e }) => {
    expect(detectVolumeSpike5m(candles)).toBe(e);
    expect(buildEventSignals(makePair(), candles, [], null, false, null, FIXED_NOW).volumeSpike5m).toBe(e);
  });

  it("volumeSpike5m needs strictly more than 3x the prior 72-candle average", () => {
    const candles = makeLinearCandles({ count: 100, volume: 100 });
    candles[99]!.v = 300;
    expect(detectVolumeSpike5m(candles)).toBe(false);
    candles[99]!.v = 301;
    expect(detectVolumeSpike5m(candles)).toBe(true);
    // A spike 80 candles ago is outside the 72-candle lookback.
    candles[10]!.v = 1e9;
    expect(detectVolumeSpike5m(candles)).toBe(true);
  });
});
