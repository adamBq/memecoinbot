/**
 * Synthetic price-path simulations. A tiny simulator walks a Position through
 * ticks the way the runner would: updatePeak, then evaluateExits, applying
 * partial sells to remainingQtyTokens and flagging tp1Hit.
 */
import { describe, it, expect } from "vitest";
import { evaluateBreakers, evaluateExits, updatePeak } from "../../src/strategy/risk.js";
import type { Position } from "../../src/core/types.js";
import type { StrategyConfig } from "../../src/core/config.js";
import { HOUR, T0, makeCfg, makePortfolio, makePosition } from "./helpers.js";

interface Tick {
  t: number;
  price: number;
  liquidity?: number;
}

interface Exit {
  t: number;
  price: number;
  fraction: number;
  reason: string;
}

interface SimResult {
  position: Position;
  exits: Exit[];
  closedAt: number | null;
  closeReason: string | null;
  ticksConsumed: number;
}

function simulate(start: Position, ticks: Tick[], cfg: StrategyConfig): SimResult {
  let pos = start;
  const exits: Exit[] = [];
  let closedAt: number | null = null;
  let closeReason: string | null = null;
  let ticksConsumed = 0;

  for (const tick of ticks) {
    ticksConsumed += 1;
    pos = updatePeak(pos, tick.price);
    const d = evaluateExits(pos, tick.price, tick.liquidity ?? null, null, cfg, tick.t);
    if (d.action !== "sell") continue;

    const qty = pos.remainingQtyTokens * d.fraction;
    pos = {
      ...pos,
      remainingQtyTokens: pos.remainingQtyTokens - qty,
      realizedPnlUsd: pos.realizedPnlUsd + qty * (tick.price - pos.entryPriceUsd),
      tp1Hit: pos.tp1Hit || d.fraction < 1,
    };
    exits.push({ t: tick.t, price: tick.price, fraction: d.fraction, reason: d.reason });

    if (pos.remainingQtyTokens <= 1e-9) {
      pos = { ...pos, status: "closed", closedAt: tick.t, closeReason: d.reason };
      closedAt = tick.t;
      closeReason = d.reason;
      break;
    }
  }

  return { position: pos, exits, closedAt, closeReason, ticksConsumed };
}

/** Ticks at a fixed interval from T0 + step, one per price. */
function path(prices: number[], stepMs = 60_000, liquidity?: number): Tick[] {
  return prices.map((price, i) => ({ t: T0 + (i + 1) * stepMs, price, ...(liquidity !== undefined ? { liquidity } : {}) }));
}

const cfg = makeCfg();

describe("price paths", () => {
  it("rug: -80% in one tick exits on the hard stop at the first tick at or below -30%", () => {
    const r = simulate(makePosition(), path([1.0, 0.95, 0.9, 0.2, 0.1]), cfg);
    expect(r.exits).toHaveLength(1);
    expect(r.exits[0]?.price).toBe(0.2);
    expect(r.exits[0]?.fraction).toBe(1);
    expect(r.exits[0]?.reason).toMatch(/^hard stop/);
    expect(r.ticksConsumed).toBe(4);
    expect(r.position.status).toBe("closed");
    expect(r.position.realizedPnlUsd).toBeCloseTo(-80);
  });

  it("3x run then fade: tp1 at 2x then trailing exit 25% off peak", () => {
    const prices = [1.1, 1.5, 1.99, 2.0, 2.5, 3.0, 2.4, 2.26, 2.25, 1.0];
    const r = simulate(makePosition(), path(prices), cfg);
    expect(r.exits).toHaveLength(2);
    expect(r.exits[0]).toMatchObject({ price: 2.0, fraction: 0.5 });
    expect(r.exits[0]?.reason).toMatch(/^take profit 1/);
    expect(r.exits[1]).toMatchObject({ price: 2.25, fraction: 1 });
    expect(r.exits[1]?.reason).toMatch(/^trailing stop \(post-tp1\)/);
    expect(r.position.tp1Hit).toBe(true);
    expect(r.position.peakPriceUsd).toBe(3.0);
    expect(r.position.status).toBe("closed");
    expect(r.position.remainingQtyTokens).toBe(0);
    // 50 tokens at +1.00 and 50 tokens at +1.25
    expect(r.position.realizedPnlUsd).toBeCloseTo(50 + 62.5);
  });

  it("flat 48h chop: nothing fires until the time stop at 48h", () => {
    const prices = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 0.97 : 1.03));
    const ticks = path(prices, HOUR); // tick i is at T0 + (i+1)h, so index 47 is exactly 48h
    const r = simulate(makePosition(), ticks, cfg);
    expect(r.exits).toHaveLength(1);
    expect(r.exits[0]?.t).toBe(T0 + 48 * HOUR);
    expect(r.exits[0]?.fraction).toBe(1);
    expect(r.exits[0]?.reason).toMatch(/^time stop: held 48\.0h/);
    expect(r.position.status).toBe("closed");
  });

  it("liquidity pull: a 40% drop vs entry liquidity exits in full even with price flat", () => {
    const ticks: Tick[] = [
      { t: T0 + 1 * 60_000, price: 1.0, liquidity: 100_000 },
      { t: T0 + 2 * 60_000, price: 1.01, liquidity: 90_000 },
      { t: T0 + 3 * 60_000, price: 1.01, liquidity: 65_000 }, // 35% drop, holds
      { t: T0 + 4 * 60_000, price: 1.0, liquidity: 55_000 }, // 45% drop, exits
      { t: T0 + 5 * 60_000, price: 0.5, liquidity: 10_000 },
    ];
    const r = simulate(makePosition(), ticks, cfg);
    expect(r.exits).toHaveLength(1);
    expect(r.exits[0]?.t).toBe(T0 + 4 * 60_000);
    expect(r.exits[0]?.reason).toMatch(/^liquidity drop: \$55000\.00 is 45\.0% below entry \$100000\.00/);
    expect(r.position.status).toBe("closed");
  });

  it("slow grind never reaching 2x exits via the 40% pre-tp1 trail in profit", () => {
    const prices = [1.05, 1.1, 1.2, 1.4, 1.6, 1.8, 1.9, 1.7, 1.5, 1.2, 1.14, 0.9];
    const r = simulate(makePosition(), path(prices, 30 * 60_000), cfg);
    expect(r.exits).toHaveLength(1);
    expect(r.exits[0]?.price).toBe(1.14);
    expect(r.exits[0]?.fraction).toBe(1);
    expect(r.exits[0]?.reason).toMatch(/^trailing stop \(pre-tp1\): 40\.0% off peak \$1\.9/);
    expect(r.position.tp1Hit).toBe(false);
    expect(r.position.realizedPnlUsd).toBeCloseTo(14);
  });

  it("a 48h+ hold that is up 20% is not time-stopped", () => {
    // Rise to 1.2 over 48h and sit there through 60h.
    const prices = Array.from({ length: 60 }, (_, i) => 1 + Math.min(0.2, (0.2 * (i + 1)) / 48));
    const r = simulate(makePosition(), path(prices, HOUR), cfg);
    expect(r.exits).toHaveLength(0);
    expect(r.position.status).toBe("open");
    expect(r.position.remainingQtyTokens).toBe(100);
    expect(r.position.peakPriceUsd).toBeCloseTo(1.2);
    expect(r.ticksConsumed).toBe(60);
  });
});

describe("breaker paths", () => {
  it("a 10% daily loss halts new entries but does not kill", () => {
    const p = makePortfolio({ equityUsd: 900, peakEquityUsd: 1000, dayStartEquityUsd: 1000 });
    const b = evaluateBreakers(p, cfg, T0);
    expect(b.haltNewEntries).toBe(true);
    expect(b.killSwitch).toBe(false);
    expect(b.reasons).toEqual([expect.stringMatching(/^daily loss limit/)]);
  });

  it("a 25% drawdown from peak kills, and daily loss also lists when it applies", () => {
    const p = makePortfolio({ equityUsd: 740, peakEquityUsd: 1000, dayStartEquityUsd: 800 });
    const b = evaluateBreakers(p, cfg, T0);
    expect(b.killSwitch).toBe(true);
    expect(b.haltNewEntries).toBe(true);
    expect(b.reasons.some((r) => r.startsWith("kill switch: drawdown"))).toBe(true);
    // 740 / 800 is a 7.5% day loss, below the 10% limit, so only the kill reason.
    expect(b.reasons).toHaveLength(1);
  });

  it("six consecutive losses halt, then the cooldown is respected and expires", () => {
    const streak = makePortfolio({ consecutiveLosses: 6 });
    const first = evaluateBreakers(streak, cfg, T0);
    expect(first.haltNewEntries).toBe(true);
    expect(first.reasons[0]).toMatch(/^consecutive losses: 6 >= 6/);

    // Runner applies the cooldown and resets the streak.
    const cooled = makePortfolio({ consecutiveLosses: 0, haltedUntil: T0 + cfg.circuitBreakers.cooldownHours * HOUR });
    const during = evaluateBreakers(cooled, cfg, T0 + 11 * HOUR);
    expect(during.haltNewEntries).toBe(true);
    expect(during.reasons[0]).toMatch(/^cooldown active: halted until .* \(1\.0h remaining\)/);

    const after = evaluateBreakers(cooled, cfg, T0 + 12 * HOUR);
    expect(after.haltNewEntries).toBe(false);
    expect(after.reasons).toEqual([]);
  });
});
