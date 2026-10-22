import { describe, it, expect } from "vitest";
import { NO_CANDLE_CAP, scoreTechnical } from "../../src/analysis/technical.js";
import { makeCandles1h, makeContext, makeLinearCandles, testConfig, type ContextOptions } from "../helpers/contextFactory.js";

const cfg = testConfig();
const reason = (reasons: string[], prefix: string) => reasons.find((r) => r.startsWith(prefix));

describe("scoreTechnical", () => {
  it("scores the good fixture highly", () => {
    const s = scoreTechnical(makeContext(), cfg);
    expect(s.score).toBeGreaterThan(0.85);
    expect(s.reasons).toHaveLength(6);
    expect(reason(s.reasons, "momentum")).toMatch(/-> 1$/);
    expect(reason(s.reasons, "1h EMA(9) above EMA(21)")).toBeDefined();
    expect(reason(s.reasons, "5m close above EMA(20)")).toBeDefined();
  });

  it("degrades to pair fields only when candles are missing, and caps the score", () => {
    const s = scoreTechnical(makeContext({ candles5m: [], candles1h: [] }), cfg);
    expect(s.score).toBeLessThanOrEqual(NO_CANDLE_CAP);
    expect(s.score).toBeGreaterThan(0.5);
    expect(s.reasons).toContain("RSI(14) unavailable: need 15+ 5m candles (skipped)");
    expect(s.reasons).toContain("EMA(20) 5m unavailable: need 20+ 5m candles (skipped)");
    expect(s.reasons).toContain("EMA(9)/EMA(21) 1h unavailable: need 21+ 1h candles (skipped)");
    expect(s.reasons).toContain("24h high unavailable: no candles (skipped)");
    expect(s.reasons.some((r) => r.includes("no candles available"))).toBe(true);
  });

  it("falls back to 5m candles for the 24h high when 1h candles are missing", () => {
    const s = scoreTechnical(makeContext({ candles1h: [] }), cfg);
    expect(reason(s.reasons, "price at")).toMatch(/\(5m candles\)/);
  });

  const good = scoreTechnical(makeContext(), cfg).score;
  const lower: Array<{ name: string; opts: ContextOptions; match?: RegExp }> = [
    { name: "negative momentum", opts: { pair: { priceChangePct: { m5: -10, h1: -30, h6: -40, h24: -50 } } }, match: /momentum .* -> 0$/ },
    { name: "parabolic h24", opts: { pair: { priceChangePct: { h24: 450 } } }, match: /already parabolic/ },
    { name: "weak buy/sell ratio", opts: { pair: { txns: { h1: { buys: 100, sells: 300 } } } }, match: /buy\/sell ratio 0.33 .* -> 0$/ },
    { name: "overextended RSI", opts: { candles5m: makeLinearCandles({ count: 100, stepPct: 1 }) }, match: /RSI\(14\) 5m 100 overextended/ },
    { name: "weak RSI", opts: { candles5m: makeLinearCandles({ count: 100, stepPct: -1 }) }, match: /RSI\(14\) 5m 0 weak/ },
    { name: "far below 24h high", opts: { pair: { priceUsd: 0.0021 * 0.5 }, candles1h: makeCandles1h({ endPrice: 0.0021 }) }, match: /price at 49(\.\d)?% of 24h high/ },
  ];
  it.each(lower)("$name scores below the good fixture", ({ opts, match }) => {
    const s = scoreTechnical(makeContext(opts), cfg);
    expect(s.score).toBeLessThan(good);
    expect(s.score).toBeGreaterThanOrEqual(0);
    if (match) expect(s.reasons.some((r) => match.test(r))).toBe(true);
  });

  it("treats h24 above +300% as parabolic and dampens momentum", () => {
    const calm = scoreTechnical(makeContext({ pair: { priceChangePct: { h24: 100 } } }), cfg);
    const hot = scoreTechnical(makeContext({ pair: { priceChangePct: { h24: 301 } } }), cfg);
    expect(hot.score).toBeLessThan(calm.score);
    expect(reason(hot.reasons, "momentum")).toContain("parabolic");
    expect(reason(calm.reasons, "momentum")).not.toContain("parabolic");
  });

  it.each([
    { rsiClosesStep: 1, label: "overextended" },
    { rsiClosesStep: -1, label: "weak" },
  ])("labels RSI as $label", ({ rsiClosesStep, label }) => {
    const s = scoreTechnical(makeContext({ candles5m: makeLinearCandles({ count: 50, stepPct: rsiClosesStep }) }), cfg);
    expect(reason(s.reasons, "RSI(14)")).toContain(label);
  });

  it("is neutral on buy/sell ratio with no transactions and handles zero sells", () => {
    const none = scoreTechnical(makeContext({ pair: { txns: { h1: { buys: 0, sells: 0 } } } }), cfg);
    expect(none.reasons).toContain("no 1h transactions, buy/sell ratio neutral -> 0.5");
    const onlyBuys = scoreTechnical(makeContext({ pair: { txns: { h1: { buys: 50, sells: 0 } } } }), cfg);
    expect(reason(onlyBuys.reasons, "1h buy/sell ratio")).toMatch(/-> 1$/);
  });

  it("flags a close below EMA(20) and a 1h death cross", () => {
    const s = scoreTechnical(
      makeContext({
        candles5m: makeLinearCandles({ count: 100, stepPct: -0.5 }),
        candles1h: makeLinearCandles({ count: 30, stepPct: -3, intervalSec: 3600 }),
      }),
      cfg,
    );
    expect(reason(s.reasons, "5m close below EMA(20)")).toMatch(/-> 0$/);
    expect(reason(s.reasons, "1h EMA(9) below EMA(21)")).toMatch(/-> 0$/);
  });

  it("always returns a score in 0..1", () => {
    for (const opts of [{}, { good: false }, { candles5m: [] }, { candles1h: [] }] as ContextOptions[]) {
      const s = scoreTechnical(makeContext(opts), cfg);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
  });
});
