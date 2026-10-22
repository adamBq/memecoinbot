import { describe, it, expect } from "vitest";
import {
  atrPct,
  band,
  clamp01,
  ema,
  lastVolumeZScore,
  mean,
  rampDown,
  rampUp,
  rsi,
  sigmoid,
  stddev,
  zscore,
} from "../../src/analysis/indicators.js";
import { makeLinearCandles } from "../helpers/contextFactory.js";

describe("mean / stddev", () => {
  it.each([
    { v: [], m: 0, sd: 0 },
    { v: [5], m: 5, sd: 0 },
    { v: [1, 2, 3], m: 2, sd: Math.sqrt(2 / 3) },
    { v: [2, 4, 4, 4, 5, 5, 7, 9], m: 5, sd: 2 },
  ])("mean/stddev of $v", ({ v, m, sd }) => {
    expect(mean(v)).toBeCloseTo(m, 10);
    expect(stddev(v)).toBeCloseTo(sd, 10);
  });
});

describe("ema", () => {
  it("returns empty for empty input", () => {
    expect(ema([], 3)).toEqual([]);
  });
  it("seeds with the cumulative mean then applies the recursion", () => {
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([1, 1.5, 2, 3, 4]);
  });
  it("keeps output length equal to input length", () => {
    expect(ema([3, 3, 3, 3, 3, 3, 3], 20)).toHaveLength(7);
  });
  it("tracks a constant series exactly", () => {
    const out = ema(new Array(30).fill(7), 9);
    expect(out[29]).toBeCloseTo(7, 10);
  });
});

describe("rsi", () => {
  it("is null with fewer than period + 1 closes", () => {
    expect(rsi(new Array(14).fill(1), 14)).toBeNull();
    expect(rsi([], 14)).toBeNull();
  });
  it.each([
    { label: "monotonic rise", closes: Array.from({ length: 20 }, (_, i) => 1 + i * 0.01), expected: 100 },
    { label: "monotonic fall", closes: Array.from({ length: 20 }, (_, i) => 2 - i * 0.01), expected: 0 },
    { label: "flat", closes: new Array(20).fill(1), expected: 50 },
    { label: "symmetric zigzag over the seed window", closes: Array.from({ length: 15 }, (_, i) => (i % 2 === 0 ? 1 : 1.1)), expected: 50 },
  ])("$label -> $expected", ({ closes, expected }) => {
    expect(rsi(closes, 14)).toBeCloseTo(expected, 6);
  });
  it("stays in 0..100 for a mixed series", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 1 + 0.002 * i + 0.01 * Math.sin(i));
    const r = rsi(closes, 14);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(0);
    expect(r!).toBeLessThan(100);
  });
});

describe("atrPct", () => {
  it("is null with fewer than period + 1 candles", () => {
    expect(atrPct(makeLinearCandles({ count: 14 }), 14)).toBeNull();
  });
  it("equals the constant true range as a percent of the close", () => {
    // Flat body, 1% wick either side: TR = 2% of price.
    const candles = makeLinearCandles({ count: 30, startPrice: 100, stepPct: 0, wickPct: 1 });
    expect(atrPct(candles, 14)).toBeCloseTo(2, 6);
  });
  it("is null when the last close is not positive", () => {
    const candles = makeLinearCandles({ count: 20, startPrice: 1 });
    candles[candles.length - 1]!.c = 0;
    expect(atrPct(candles, 14)).toBeNull();
  });
});

describe("zscore", () => {
  it.each([
    { values: [], current: 1, expected: null },
    { values: [1], current: 1, expected: null },
    { values: [3, 3, 3], current: 9, expected: null },
    { values: [1, 2, 3, 4, 5], current: 5, expected: 2 / Math.sqrt(2) },
    { values: [1, 2, 3, 4, 5], current: 3, expected: 0 },
  ])("zscore($values, $current) -> $expected", ({ values, current, expected }) => {
    const z = zscore(values, current);
    if (expected === null) expect(z).toBeNull();
    else expect(z).toBeCloseTo(expected, 10);
  });
});

describe("lastVolumeZScore", () => {
  it("is null without enough prior candles", () => {
    const candles = makeLinearCandles({ count: 3 });
    expect(lastVolumeZScore(candles, 24, 3)).toBeNull();
  });
  it("scores the last candle volume against the prior window", () => {
    const candles = makeLinearCandles({ count: 5 });
    [10, 20, 30, 40, 60].forEach((v, i) => (candles[i]!.v = v));
    // prior mean 25, population sd sqrt(125)
    expect(lastVolumeZScore(candles, 24, 3)).toBeCloseTo(35 / Math.sqrt(125), 10);
  });
  it("only looks back `lookback` candles", () => {
    const candles = makeLinearCandles({ count: 10 });
    candles.forEach((c, i) => (c.v = i < 5 ? 1_000_000 : 10));
    candles[9]!.v = 20;
    // lookback 4 -> prior [10,10,10,10] has zero variance -> null
    expect(lastVolumeZScore(candles, 4, 3)).toBeNull();
  });
});

describe("shape helpers", () => {
  it.each([
    { x: -1, e: 0 },
    { x: 0.5, e: 0.5 },
    { x: 2, e: 1 },
    { x: Number.NaN, e: 0 },
    { x: Number.POSITIVE_INFINITY, e: 0 },
  ])("clamp01($x) = $e", ({ x, e }) => expect(clamp01(x)).toBe(e));

  it.each([
    { x: 0, e: 0 },
    { x: 10, e: 0 },
    { x: 15, e: 0.5 },
    { x: 20, e: 1 },
    { x: 25, e: 1 },
  ])("rampUp($x, 10, 20) = $e", ({ x, e }) => expect(rampUp(x, 10, 20)).toBeCloseTo(e, 10));

  it("rampDown mirrors rampUp", () => {
    expect(rampDown(10, 10, 20)).toBe(1);
    expect(rampDown(15, 10, 20)).toBeCloseTo(0.5, 10);
    expect(rampDown(20, 10, 20)).toBe(0);
  });

  it("rampUp with a degenerate range is a step", () => {
    expect(rampUp(5, 10, 10)).toBe(0);
    expect(rampUp(10, 10, 10)).toBe(1);
  });

  it.each([
    { x: -5, e: 0 },
    { x: 0, e: 0 },
    { x: 5, e: 0.5 },
    { x: 10, e: 1 },
    { x: 50, e: 1 },
    { x: 100, e: 1 },
    { x: 150, e: 0.5 },
    { x: 200, e: 0 },
    { x: 300, e: 0 },
    { x: Number.NaN, e: 0 },
  ])("band($x, 0, 10, 100, 200) = $e", ({ x, e }) => expect(band(x, 0, 10, 100, 200)).toBeCloseTo(e, 10));

  it("sigmoid is centred at 0 and bounded", () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 10);
    expect(sigmoid(10)).toBeGreaterThan(0.99);
    expect(sigmoid(-10)).toBeLessThan(0.01);
    expect(sigmoid(Number.POSITIVE_INFINITY)).toBe(1);
    expect(sigmoid(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
