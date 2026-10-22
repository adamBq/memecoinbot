import { describe, it, expect } from "vitest";
import { scoreSentiment } from "../../src/analysis/sentiment.js";
import { makeContext, makeSentiment, testConfig } from "../helpers/contextFactory.js";
import type { SentimentSignals } from "../../src/core/types.js";

const cfg = testConfig();
const score = (overrides: Partial<SentimentSignals>) => scoreSentiment(makeContext({ sentiment: makeSentiment(overrides) }), cfg);
const reason = (reasons: string[], prefix: string) => reasons.find((r) => r.startsWith(prefix)) ?? "";

const nothing: Partial<SentimentSignals> = {
  boostsActive: 0,
  hasWebsite: false,
  hasTwitter: false,
  hasTelegram: false,
  socialCount: 0,
  dexscreenerTrendingRank: null,
  coingeckoTrendingRank: null,
  buyPressure1h: 0.3,
  llmNarrativeScore: null,
  llmNarrativeReason: null,
};
const everything: Partial<SentimentSignals> = {
  boostsActive: 1000,
  hasWebsite: true,
  hasTwitter: true,
  hasTelegram: true,
  socialCount: 3,
  dexscreenerTrendingRank: 1,
  coingeckoTrendingRank: 1,
  buyPressure1h: 0.8,
  llmNarrativeScore: null,
  llmNarrativeReason: null,
};

describe("scoreSentiment", () => {
  it.each([
    { name: "nothing", s: nothing, lo: 0, hi: 0 },
    { name: "everything", s: everything, lo: 1, hi: 1 },
    { name: "good fixture", s: {}, lo: 0.7, hi: 0.85 },
  ])("$name scores in [$lo, $hi]", ({ s, lo, hi }) => {
    const r = score(s);
    expect(r.score).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(r.score).toBeLessThanOrEqual(hi + 1e-9);
  });

  it.each([
    { name: "boosts 0", s: { boostsActive: 0 }, prefix: "0 boosts", ends: "-> 0" },
    { name: "boosts 999 saturate", s: { boostsActive: 999 }, prefix: "999 boosts", ends: "-> 1" },
    { name: "boosts 9 are a third", s: { boostsActive: 9 }, prefix: "9 boosts", ends: "-> 0.33" },
    { name: "website only", s: { hasWebsite: true, hasTwitter: false, hasTelegram: false, socialCount: 0 }, prefix: "website yes, twitter no, telegram no", ends: "-> 0.3" },
    { name: "twitter only", s: { hasWebsite: false, hasTwitter: true, hasTelegram: false, socialCount: 1 }, prefix: "website no, twitter yes, telegram no", ends: "-> 0.4" },
    { name: "three socials bonus", s: { hasWebsite: true, hasTwitter: true, hasTelegram: true, socialCount: 3 }, prefix: "website yes, twitter yes, telegram yes, 3 socials", ends: "-> 1" },
    { name: "dexscreener rank 1", s: { dexscreenerTrendingRank: 1, coingeckoTrendingRank: null }, prefix: "trending ranks dexscreener 1", ends: "-> 1" },
    { name: "dexscreener rank 26", s: { dexscreenerTrendingRank: 26, coingeckoTrendingRank: null }, prefix: "trending ranks dexscreener 26", ends: "-> 0.5" },
    { name: "dexscreener rank 200 floors at 0.2", s: { dexscreenerTrendingRank: 200, coingeckoTrendingRank: null }, prefix: "trending ranks dexscreener 200", ends: "-> 0.2" },
    { name: "coingecko rank 1", s: { dexscreenerTrendingRank: null, coingeckoTrendingRank: 1 }, prefix: "trending ranks dexscreener none, coingecko 1", ends: "-> 1" },
    { name: "no ranks", s: { dexscreenerTrendingRank: null, coingeckoTrendingRank: null }, prefix: "trending ranks dexscreener none, coingecko none", ends: "-> 0" },
    { name: "buy pressure 0.35 is zero", s: { buyPressure1h: 0.35 }, prefix: "1h buy pressure 0.35", ends: "-> 0" },
    { name: "buy pressure 0.525 is half", s: { buyPressure1h: 0.525 }, prefix: "1h buy pressure 0.53", ends: "-> 0.5" },
    { name: "buy pressure 0.7 is full", s: { buyPressure1h: 0.7 }, prefix: "1h buy pressure 0.7", ends: "-> 1" },
  ])("$name", ({ s, prefix, ends }) => {
    const r = reason(score(s).reasons, prefix);
    expect(r, `missing reason ${prefix}`).not.toBe("");
    expect(r.endsWith(ends), `${r} should end with ${ends}`).toBe(true);
  });

  it("notes the absence of an LLM score and renormalises", () => {
    const r = score({});
    expect(r.reasons).toContain("LLM narrative score absent; heuristic components renormalised");
  });

  it("gives the LLM narrative 40% of the lens when present", () => {
    const llmOnly = score({ ...nothing, llmNarrativeScore: 1, llmNarrativeReason: "strong meme" });
    expect(llmOnly.score).toBeCloseTo(0.4, 6);
    expect(llmOnly.reasons).toContain("LLM narrative: strong meme -> 1");
    const heuristicsOnly = score({ ...everything, llmNarrativeScore: 0, llmNarrativeReason: "nothing here" });
    expect(heuristicsOnly.score).toBeCloseTo(0.6, 6);
    const both = score({ ...everything, llmNarrativeScore: 1, llmNarrativeReason: "great" });
    expect(both.score).toBeCloseTo(1, 6);
  });
});
