import { describe, it, expect } from "vitest";
import { BREAKOUT_MIN_CANDLES_5M, breakoutDetails, isBreakoutConfirmed } from "../../src/analysis/breakout.js";
import { makeCandles5m, makeContext } from "../helpers/contextFactory.js";

describe("isBreakoutConfirmed", () => {
  it("confirms the good fixture", () => {
    const ctx = makeContext();
    expect(isBreakoutConfirmed(ctx)).toBe(true);
    const d = breakoutDetails(ctx.candles5m);
    expect(d.lastClose!).toBeGreaterThan(d.priorHigh!);
    expect(d.lastHourVolume!).toBeGreaterThan(1.5 * d.avgPriorHourVolume!);
  });

  it("is false with fewer than 84 candles", () => {
    expect(BREAKOUT_MIN_CANDLES_5M).toBe(84);
    const ctx = makeContext({ candles5m: makeCandles5m({ count: 83 }) });
    expect(isBreakoutConfirmed(ctx)).toBe(false);
    expect(breakoutDetails(ctx.candles5m).reason).toBe("need 84 5m candles, have 83");
    expect(isBreakoutConfirmed(makeContext({ candles5m: [] }))).toBe(false);
  });

  it("is true with exactly 84 candles when both conditions hold", () => {
    expect(isBreakoutConfirmed(makeContext({ candles5m: makeCandles5m({ count: 84 }) }))).toBe(true);
  });

  it("is false when the last close does not exceed the prior 6h high", () => {
    expect(isBreakoutConfirmed(makeContext({ candles5m: makeCandles5m({ breakout: false }) }))).toBe(false);
    const candles = makeCandles5m();
    const last = candles[candles.length - 1]!;
    last.c = last.o * 0.9;
    const d = breakoutDetails(candles);
    expect(d.confirmed).toBe(false);
    expect(d.reason).toMatch(/<= prior 6h high/);
  });

  it("is false when the last hour volume is not above 1.5x the prior average", () => {
    const candles = makeCandles5m();
    for (const c of candles.slice(-12)) c.v = 1000;
    const d = breakoutDetails(candles);
    expect(d.confirmed).toBe(false);
    expect(d.reason).toMatch(/1h volume .* <= 1.5x avg/);
  });

  it("ignores candles older than the 7h window", () => {
    const candles = makeCandles5m({ count: 120 });
    // A huge spike well before the lookback window must not matter.
    candles[5]!.h = 999;
    candles[5]!.v = 1e9;
    expect(breakoutDetails(candles).confirmed).toBe(true);
  });
});
