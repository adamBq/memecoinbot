import { describe, it, expect } from "vitest";
import { aggregateToHourly } from "../src/data/candles.js";

describe("aggregateToHourly", () => {
  it("rolls twelve 5m candles into one hour with correct OHLCV", () => {
    const base = 1_792_630_800; // on the hour
    const c5 = Array.from({ length: 12 }, (_, i) => ({ t: base + i * 300, o: 10 + i, h: 20 + i, l: 5 - (i % 3), c: 11 + i, v: 1 }));
    const h = aggregateToHourly(c5);
    expect(h).toHaveLength(1);
    expect(h[0]).toEqual({ t: base, o: 10, h: 31, l: 3, c: 22, v: 12 });
  });
  it("aligns to hour boundaries and keeps a partial trailing hour", () => {
    const base = 1_792_630_800 + 1800; // half past
    const c5 = Array.from({ length: 12 }, (_, i) => ({ t: base + i * 300, o: 1, h: 1, l: 1, c: 1, v: 1 }));
    const h = aggregateToHourly(c5);
    expect(h).toHaveLength(2);
    expect(h[0]!.v).toBe(6);
    expect(h[1]!.v).toBe(6);
    expect(h[1]!.t - h[0]!.t).toBe(3600);
  });
  it("handles empty input", () => {
    expect(aggregateToHourly([])).toEqual([]);
  });
});
