import { describe, it, expect } from "vitest";
import { scoreLenses, scoreToken, weightedTotal } from "../../src/analysis/composite.js";
import { configWith, FIXED_NOW, makeContext, testConfig } from "../helpers/contextFactory.js";
import type { LensName } from "../../src/core/types.js";

const cfg = testConfig();
const LENSES: LensName[] = ["technical", "fundamental", "quantitative", "sentiment", "event"];

describe("scoreToken", () => {
  it("golden: the good fixture clears the entry thresholds with a confirmed breakout", () => {
    const s = scoreToken(makeContext(), cfg, FIXED_NOW);
    expect(s.hardFilterPassed).toBe(true);
    expect(s.hardFilterFailures).toEqual([]);
    expect(s.breakoutConfirmed).toBe(true);
    expect(s.total).toBeGreaterThan(cfg.scoring.minCompositeToEnter);
    expect(s.total).toBeGreaterThan(0.62);
    expect(s.lenses.technical.score).toBeGreaterThan(cfg.scoring.minTechnicalToEnter);
    expect(s.mint).toBe(makeContext().pair.mint);
    expect(s.symbol).toBe("GOOD");
    expect(s.pairAddress).toBe(makeContext().pair.pairAddress);
    expect(s.computedAt).toBe(FIXED_NOW);
    for (const name of LENSES) {
      expect(s.lenses[name].score).toBeGreaterThanOrEqual(0);
      expect(s.lenses[name].score).toBeLessThanOrEqual(1);
      expect(s.lenses[name].reasons.length).toBeGreaterThan(0);
    }
  });

  it("golden: still clears the threshold without trending ranks or an LLM (as the runner builds it)", () => {
    const ctx = makeContext({ ranks: { dexscreener: null, coingecko: null }, enteredTrending: false });
    const s = scoreToken(ctx, cfg, FIXED_NOW);
    expect(s.hardFilterPassed).toBe(true);
    expect(s.total).toBeGreaterThan(0.62);
    expect(s.breakoutConfirmed).toBe(true);
  });

  it("golden: the rug-ish fixture fails hard filters, totals 0, and keeps the lens audit trail", () => {
    const s = scoreToken(makeContext({ good: false }), cfg, FIXED_NOW);
    expect(s.hardFilterPassed).toBe(false);
    expect(s.hardFilterFailures.length).toBeGreaterThanOrEqual(5);
    expect(s.hardFilterFailures).toContain("liquidity 12000 < min 50000");
    expect(s.total).toBe(0);
    expect(s.breakoutConfirmed).toBe(false);
    for (const name of LENSES) {
      expect(s.lenses[name].reasons.length).toBeGreaterThan(0);
    }
    expect(s.lenses.fundamental.score).toBeLessThan(0.2);
    expect(s.lenses.sentiment.score).toBe(0);
  });

  it("total is the config-weighted sum of the lenses", () => {
    const ctx = makeContext();
    const s = scoreToken(ctx, cfg, FIXED_NOW);
    const w = cfg.scoring.weights;
    const expected =
      w.technical * s.lenses.technical.score +
      w.fundamental * s.lenses.fundamental.score +
      w.quantitative * s.lenses.quantitative.score +
      w.sentiment * s.lenses.sentiment.score +
      w.event * s.lenses.event.score;
    expect(s.total).toBeCloseTo(expected, 10);
    expect(weightedTotal(scoreLenses(ctx, cfg, FIXED_NOW), cfg)).toBeCloseTo(expected, 10);
  });

  it("a single filter failure zeroes the total even when the lenses are strong", () => {
    const s = scoreToken(makeContext({ sellability: null }), cfg, FIXED_NOW);
    expect(s.hardFilterPassed).toBe(false);
    expect(s.hardFilterFailures).toEqual(["sellability check unavailable"]);
    expect(s.total).toBe(0);
    expect(s.lenses.technical.score).toBeGreaterThan(0.8);
  });

  it("responds to the configured weights", () => {
    const ctx = makeContext({ ranks: { dexscreener: null, coingecko: null }, enteredTrending: false, sentiment: { boostsActive: 0, hasWebsite: false, hasTwitter: false, hasTelegram: false, socialCount: 0, buyPressure1h: 0.3 } });
    const base = scoreToken(ctx, cfg, FIXED_NOW);
    const sentimentHeavy = configWith((c) => {
      c.scoring.weights = { technical: 0.1, fundamental: 0.1, quantitative: 0.1, sentiment: 0.6, event: 0.1 };
    });
    const s = scoreToken(ctx, sentimentHeavy, FIXED_NOW);
    expect(s.lenses.sentiment.score).toBe(0);
    expect(s.total).toBeLessThan(base.total);
  });

  it("is deterministic for the same input and time", () => {
    const a = scoreToken(makeContext(), cfg, FIXED_NOW);
    const b = scoreToken(makeContext(), cfg, FIXED_NOW);
    expect(a).toEqual(b);
  });
});
