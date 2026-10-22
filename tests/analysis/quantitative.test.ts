import { describe, it, expect } from "vitest";
import { scoreQuantitative } from "../../src/analysis/quantitative.js";
import { makeCandles1h, makeContext, makeLinearCandles, testConfig, type ContextOptions } from "../helpers/contextFactory.js";

const cfg = testConfig();
const reason = (reasons: string[], prefix: string) => reasons.find((r) => r.startsWith(prefix)) ?? "";

describe("scoreQuantitative", () => {
  it("scores the good fixture highly", () => {
    const s = scoreQuantitative(makeContext(), cfg);
    expect(s.score).toBeGreaterThan(0.8);
    expect(s.reasons).toHaveLength(6);
  });

  const components: Array<{ name: string; opts: ContextOptions; prefix: string; ends: string }> = [
    { name: "sellability missing", opts: { sellability: null }, prefix: "sellability unknown", ends: "-> 0" },
    { name: "no sell route", opts: { sellability: { routeFound: false } }, prefix: "no sell route", ends: "-> 0" },
    { name: "retention 90% is zero", opts: { sellability: { roundTripRetentionPct: 90 } }, prefix: "round-trip retention 90%", ends: "-> 0" },
    { name: "retention 95% is half", opts: { sellability: { roundTripRetentionPct: 95 } }, prefix: "round-trip retention 95%", ends: "-> 0.5" },
    { name: "retention 100% is perfect", opts: { sellability: { roundTripRetentionPct: 100 } }, prefix: "round-trip retention 100%", ends: "-> 1" },
    { name: "turnover 0.05x is dead", opts: { pair: { volumeUsd: { h24: 105_000, h1: 4375 } } }, prefix: "24h volume/mcap 0.05x", ends: "-> 0" },
    { name: "turnover 6.5x is suspicious", opts: { pair: { volumeUsd: { h24: 13_650_000, h1: 568_750 } } }, prefix: "24h volume/mcap 6.5x", ends: "-> 0.5" },
    { name: "volume acceleration 0.3x is fading", opts: { pair: { volumeUsd: { h1: 18_750 } } }, prefix: "volume acceleration h1*24/h24 0.3x", ends: "-> 0" },
    { name: "volume acceleration 20x is wash-like", opts: { pair: { volumeUsd: { h1: 1_250_000 } } }, prefix: "volume acceleration h1*24/h24 20x", ends: "-> 0" },
    { name: "no 24h volume", opts: { pair: { volumeUsd: { h24: 0 } } }, prefix: "no 24h volume", ends: "-> 0" },
    { name: "quiet tape ATR", opts: { candles5m: makeLinearCandles({ count: 100, wickPct: 0.1 }) }, prefix: "ATR(14) 0.2% per 5m", ends: "-> 0" },
    { name: "wild tape ATR", opts: { candles5m: makeLinearCandles({ count: 100, wickPct: 15 }) }, prefix: "ATR(14) 30% per 5m", ends: "-> 0" },
    { name: "healthy ATR", opts: { candles5m: makeLinearCandles({ count: 100, wickPct: 2.5 }) }, prefix: "ATR(14) 5% per 5m", ends: "-> 1" },
    { name: "flat 1h volume z-score", opts: { candles1h: makeCandles1h({ lastVolumeMultiple: 1.0 }) }, prefix: "last 1h volume z-score -0.05", ends: "-> 0.24" },
    { name: "sellers in control", opts: { pair: { txns: { m5: { buys: 10, sells: 40 }, h1: { buys: 100, sells: 400 }, h6: { buys: 500, sells: 2000 } } } }, prefix: "buy pressure m5 0.2 h1 0.2 h6 0.2, consistency 1", ends: "-> 0" },
    { name: "strong consistent buying", opts: { pair: { txns: { m5: { buys: 70, sells: 30 }, h1: { buys: 700, sells: 300 }, h6: { buys: 7000, sells: 3000 } } } }, prefix: "buy pressure m5 0.7 h1 0.7 h6 0.7, consistency 1", ends: "-> 1" },
    { name: "inconsistent buying is discounted", opts: { pair: { txns: { m5: { buys: 90, sells: 10 }, h1: { buys: 50, sells: 50 }, h6: { buys: 20, sells: 80 } } } }, prefix: "buy pressure m5 0.9 h1 0.5 h6 0.2, consistency 0", ends: "-> 0.28" },
  ];
  it.each(components)("$name", ({ opts, prefix, ends }) => {
    const s = scoreQuantitative(makeContext(opts), cfg);
    const r = reason(s.reasons, prefix);
    expect(r, `expected a reason starting with "${prefix}" in ${JSON.stringify(s.reasons)}`).not.toBe("");
    expect(r.endsWith(ends), `${r} should end with ${ends}`).toBe(true);
  });

  it("skips candle-driven components without candles and still scores", () => {
    const s = scoreQuantitative(makeContext({ candles5m: [], candles1h: [] }), cfg);
    expect(s.reasons).toContain("ATR% unavailable: need 15+ 5m candles (skipped)");
    expect(s.reasons).toContain("1h volume z-score unavailable: need 4+ 1h candles with variance (skipped)");
    expect(s.score).toBeGreaterThan(0.7);
  });

  it("skips turnover when market cap is unknown", () => {
    const s = scoreQuantitative(makeContext({ pair: { marketCapUsd: null, fdvUsd: null } }), cfg);
    expect(s.reasons).toContain("turnover unavailable: market cap unknown (skipped)");
  });

  it("stays within 0..1 for the rug fixture", () => {
    const s = scoreQuantitative(makeContext({ good: false }), cfg);
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(1);
    expect(reason(s.reasons, "round-trip retention 80%")).toMatch(/-> 0$/);
  });
});
