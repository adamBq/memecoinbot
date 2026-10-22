import { describe, it, expect } from "vitest";
import {
  cooldownUntil,
  evaluateBreakers,
  evaluateEntry,
  evaluateExits,
  pnlPct,
  positionNotional,
  unrealizedPnlUsd,
  updatePeak,
} from "../../src/strategy/risk.js";
import type { BreakerState } from "../../src/core/types.js";
import { HOUR, MINT, T0, makeCfg, makePortfolio, makePosition, makeSafety, makeScore } from "./helpers.js";

const cfg = makeCfg();
const clear: BreakerState = { haltNewEntries: false, killSwitch: false, reasons: [] };

describe("pnl helpers", () => {
  it("pnlPct is relative to entry", () => {
    const pos = makePosition({ entryPriceUsd: 2 });
    expect(pnlPct(pos, 3)).toBeCloseTo(50);
    expect(pnlPct(pos, 1)).toBeCloseTo(-50);
    expect(pnlPct(makePosition({ entryPriceUsd: 0 }), 1)).toBe(0);
  });

  it("unrealizedPnlUsd uses the remaining share of cost basis", () => {
    const pos = makePosition({ qtyTokens: 100, remainingQtyTokens: 50, costBasisUsd: 100 });
    expect(unrealizedPnlUsd(pos, 1.5)).toBeCloseTo(50 * 1.5 - 50);
    expect(unrealizedPnlUsd(makePosition({ remainingQtyTokens: 0 }), 5)).toBe(0);
  });

  it("cooldownUntil adds cooldownHours", () => {
    expect(cooldownUntil(T0, cfg)).toBe(T0 + 12 * HOUR);
  });
});

describe("evaluateBreakers", () => {
  it("is clear on a healthy portfolio", () => {
    const b = evaluateBreakers(makePortfolio(), cfg, T0);
    expect(b).toEqual({ haltNewEntries: false, killSwitch: false, reasons: [] });
  });

  it("kills when p.killed", () => {
    const b = evaluateBreakers(makePortfolio({ killed: true }), cfg, T0);
    expect(b.killSwitch).toBe(true);
    expect(b.haltNewEntries).toBe(true);
    expect(b.reasons.join()).toMatch(/kill switch/);
  });

  it("kills at exactly the drawdown floor (<=)", () => {
    const b = evaluateBreakers(makePortfolio({ equityUsd: 750, peakEquityUsd: 1000, dayStartEquityUsd: 750 }), cfg, T0);
    expect(b.killSwitch).toBe(true);
    expect(b.reasons.join()).toMatch(/drawdown 25\.0%/);
    expect(b.reasons.join()).toMatch(/\$750\.00/);
    const ok = evaluateBreakers(makePortfolio({ equityUsd: 750.01, peakEquityUsd: 1000, dayStartEquityUsd: 750.01 }), cfg, T0);
    expect(ok.killSwitch).toBe(false);
  });

  it("halts (not kills) at the daily loss limit", () => {
    const b = evaluateBreakers(makePortfolio({ equityUsd: 900, peakEquityUsd: 1000, dayStartEquityUsd: 1000 }), cfg, T0);
    expect(b.killSwitch).toBe(false);
    expect(b.haltNewEntries).toBe(true);
    expect(b.reasons).toHaveLength(1);
    expect(b.reasons[0]).toMatch(/daily loss limit: down 10\.0%/);
  });

  it("halts on consecutive losses and names the cooldown", () => {
    const b = evaluateBreakers(makePortfolio({ consecutiveLosses: 6 }), cfg, T0);
    expect(b.haltNewEntries).toBe(true);
    expect(b.killSwitch).toBe(false);
    expect(b.reasons[0]).toMatch(/consecutive losses: 6 >= 6/);
    expect(b.reasons[0]).toMatch(/12h/);
    expect(evaluateBreakers(makePortfolio({ consecutiveLosses: 5 }), cfg, T0).haltNewEntries).toBe(false);
  });

  it("respects haltedUntil while it is in the future", () => {
    const until = T0 + 12 * HOUR;
    const p = makePortfolio({ haltedUntil: until });
    expect(evaluateBreakers(p, cfg, until - 1).haltNewEntries).toBe(true);
    expect(evaluateBreakers(p, cfg, until - 1).reasons[0]).toMatch(/cooldown active/);
    expect(evaluateBreakers(p, cfg, until).haltNewEntries).toBe(false);
  });

  it("lists every trigger", () => {
    const p = makePortfolio({
      killed: true,
      equityUsd: 700,
      peakEquityUsd: 1000,
      dayStartEquityUsd: 1000,
      consecutiveLosses: 7,
      haltedUntil: T0 + HOUR,
    });
    const b = evaluateBreakers(p, cfg, T0);
    expect(b.killSwitch).toBe(true);
    expect(b.haltNewEntries).toBe(true);
    expect(b.reasons).toHaveLength(5);
  });

  it("treats maxConsecutiveLosses <= 0 as disabled", () => {
    const c = makeCfg({ circuitBreakers: { ...cfg.circuitBreakers, maxConsecutiveLosses: 0 } });
    expect(evaluateBreakers(makePortfolio({ consecutiveLosses: 3 }), c, T0).haltNewEntries).toBe(false);
  });
});

describe("positionNotional", () => {
  it("sizes as pct of equity", () => {
    expect(positionNotional(makePortfolio({ equityUsd: 1000, cashUsd: 1000 }), cfg)).toBeCloseTo(80);
  });
  it("floors at the minimum notional", () => {
    expect(positionNotional(makePortfolio({ equityUsd: 100, cashUsd: 100 }), cfg)).toBe(25);
  });
  it("caps at cash", () => {
    expect(positionNotional(makePortfolio({ equityUsd: 1000, cashUsd: 30 }), cfg)).toBe(30);
  });
  it("returns 0 when cash is below the minimum", () => {
    expect(positionNotional(makePortfolio({ equityUsd: 1000, cashUsd: 24.99 }), cfg)).toBe(0);
    expect(positionNotional(makePortfolio({ equityUsd: 1000, cashUsd: 0 }), cfg)).toBe(0);
  });
});

describe("evaluateEntry", () => {
  const p = makePortfolio();

  it("enters a clean candidate with a summary reason", () => {
    const d = evaluateEntry(makeScore(), p, clear, cfg, T0, 10);
    expect(d.enter).toBe(true);
    expect(d.notionalUsd).toBeCloseTo(80);
    expect(d.reason).toMatch(/composite 0\.700 >= 0\.62/);
    expect(d.reason).toMatch(/technical 0\.650 >= 0\.55/);
    expect(d.reason).toMatch(/breakout confirmed/);
    expect(d.reason).toMatch(/\$80\.00/);
  });

  it("refuses when breakers halt", () => {
    const halted: BreakerState = { haltNewEntries: true, killSwitch: false, reasons: ["daily loss limit: down 10.0%"] };
    const d = evaluateEntry(makeScore(), p, halted, cfg, T0, 10);
    expect(d).toEqual({ enter: false, notionalUsd: 0, reason: expect.stringMatching(/breakers halt.*daily loss/) });
  });

  it("refuses at max open positions", () => {
    const full = makePortfolio({ openPositions: [1, 2, 3, 4, 5].map((id) => makePosition({ id, mint: `m${id}` })) });
    const d = evaluateEntry(makeScore(), full, clear, cfg, T0, 10);
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/5 >= 5/);
  });

  it("refuses a mint already open", () => {
    const d = evaluateEntry(makeScore(), makePortfolio({ openPositions: [makePosition()] }), clear, cfg, T0, 10);
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/already holding/);
  });

  it("refuses within the re-entry cooldown and allows after it", () => {
    const exited = makePortfolio({ lastExitByMint: { [MINT]: T0 - 23 * HOUR } });
    const d = evaluateEntry(makeScore(), exited, clear, cfg, T0, 10);
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/re-entry cooldown.*23\.0h ago.*1\.0h remaining/);
    const later = makePortfolio({ lastExitByMint: { [MINT]: T0 - 24 * HOUR } });
    expect(evaluateEntry(makeScore(), later, clear, cfg, T0, 10).enter).toBe(true);
  });

  it("refuses stale data", () => {
    const d = evaluateEntry(makeScore(), p, clear, cfg, T0, 301);
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/stale data: 301s old > 300s/);
    expect(evaluateEntry(makeScore(), p, clear, cfg, T0, 300).enter).toBe(true);
  });

  it("refuses failed hard filters", () => {
    const d = evaluateEntry(makeScore({ hardFilterPassed: false, hardFilterFailures: ["liquidity $10k < $50k"], total: 0 }), p, clear, cfg, T0, 10);
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/hard filters failed: liquidity/);
  });

  it("refuses low composite and low technical", () => {
    expect(evaluateEntry(makeScore({ total: 0.61 }), p, clear, cfg, T0, 10).reason).toMatch(/composite 0\.610 < 0\.62/);
    const lowTech = makeScore({ lenses: { ...makeScore().lenses, technical: { score: 0.5, reasons: [] } } });
    expect(evaluateEntry(lowTech, p, clear, cfg, T0, 10).reason).toMatch(/technical 0\.500 < 0\.55/);
  });

  it("requires breakout only when configured", () => {
    const d = evaluateEntry(makeScore({ breakoutConfirmed: false }), p, clear, cfg, T0, 10);
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/breakout not confirmed/);
    const relaxed = makeCfg({ scoring: { ...cfg.scoring, requireBreakoutConfirmation: false } });
    const ok = evaluateEntry(makeScore({ breakoutConfirmed: false }), p, clear, relaxed, T0, 10);
    expect(ok.enter).toBe(true);
    expect(ok.reason).toMatch(/not required/);
  });

  it("refuses when notional is zero", () => {
    const d = evaluateEntry(makeScore(), makePortfolio({ cashUsd: 10 }), clear, cfg, T0, 10);
    expect(d.enter).toBe(false);
    expect(d.notionalUsd).toBe(0);
    expect(d.reason).toMatch(/insufficient cash: \$10\.00/);
  });
});

describe("updatePeak", () => {
  it("ratchets up and never down, returning a copy", () => {
    const pos = makePosition({ peakPriceUsd: 1.5 });
    const up = updatePeak(pos, 2);
    expect(up.peakPriceUsd).toBe(2);
    expect(up).not.toBe(pos);
    expect(pos.peakPriceUsd).toBe(1.5);
    expect(updatePeak(pos, 1).peakPriceUsd).toBe(1.5);
  });
});

describe("evaluateExits", () => {
  const hold = (pos = makePosition(), price = 1.0) => evaluateExits(pos, price, null, null, cfg, T0 + HOUR);

  it("holds with a descriptive reason", () => {
    const d = hold();
    expect(d.action).toBe("hold");
    expect(d.fraction).toBe(0);
    expect(d.reason).toMatch(/hold: price \$1, entry \$1, pnl 0\.0%/);
  });

  it("safety deterioration sells everything", () => {
    for (const bad of [{ rugged: true }, { mintAuthorityRevoked: false }, { freezeAuthorityRevoked: false }]) {
      const d = evaluateExits(makePosition(), 5, null, makeSafety(bad), cfg, T0);
      expect(d.action).toBe("sell");
      expect(d.fraction).toBe(1);
      expect(d.reason).toMatch(/safety deterioration/);
    }
    expect(evaluateExits(makePosition(), 1, null, makeSafety(), cfg, T0).action).toBe("hold");
  });

  it("safety deterioration is ignored when disabled or absent", () => {
    const off = makeCfg({ exits: { ...cfg.exits, exitOnSafetyDeterioration: false } });
    expect(evaluateExits(makePosition(), 1, null, makeSafety({ rugged: true }), off, T0).action).toBe("hold");
    expect(evaluateExits(makePosition(), 1, null, null, cfg, T0).action).toBe("hold");
  });

  it("liquidity drop sells everything, null liquidity is ignored", () => {
    const d = evaluateExits(makePosition(), 1, 59_999, null, cfg, T0);
    expect(d.action).toBe("sell");
    expect(d.fraction).toBe(1);
    expect(d.reason).toMatch(/liquidity drop: \$59999\.00 is 40\.0% below entry \$100000\.00/);
    expect(evaluateExits(makePosition(), 1, 60_000, null, cfg, T0).action).toBe("hold");
    expect(evaluateExits(makePosition(), 1, null, null, cfg, T0).action).toBe("hold");
  });

  it("hard stop at exactly -30%", () => {
    const d = evaluateExits(makePosition(), 0.7, null, null, cfg, T0);
    expect(d.action).toBe("sell");
    expect(d.fraction).toBe(1);
    expect(d.reason).toMatch(/hard stop: price \$0\.7, entry \$1, pnl -30\.0%/);
    expect(evaluateExits(makePosition(), 0.7001, null, null, cfg, T0).action).toBe("hold");
  });

  it("trailing stop uses the pre-tp1 trail until tp1 is hit", () => {
    const pos = makePosition({ peakPriceUsd: 1.9 });
    expect(evaluateExits(pos, 1.15, null, null, cfg, T0).action).toBe("hold");
    const d = evaluateExits(pos, 1.14, null, null, cfg, T0);
    expect(d.action).toBe("sell");
    expect(d.fraction).toBe(1);
    expect(d.reason).toMatch(/trailing stop \(pre-tp1\): 40\.0% off peak \$1\.9/);
  });

  it("trailing stop tightens after tp1", () => {
    const pos = makePosition({ peakPriceUsd: 3, tp1Hit: true, remainingQtyTokens: 50 });
    expect(evaluateExits(pos, 2.26, null, null, cfg, T0).action).toBe("hold");
    const d = evaluateExits(pos, 2.25, null, null, cfg, T0);
    expect(d.action).toBe("sell");
    expect(d.reason).toMatch(/trailing stop \(post-tp1\): 25\.0% off peak \$3 >= 25\.0% trail/);
  });

  it("trailing stop never fires when the peak is not above entry", () => {
    const tight = makeCfg({ exits: { ...cfg.exits, trailingStopPctFromPeakBeforeTp1: 10 } });
    const d = evaluateExits(makePosition({ peakPriceUsd: 1.0 }), 0.85, null, null, tight, T0);
    expect(d.action).toBe("hold");
    const d2 = evaluateExits(makePosition({ peakPriceUsd: 1.01 }), 0.85, null, null, tight, T0);
    expect(d2.action).toBe("sell");
    expect(d2.reason).toMatch(/trailing stop/);
  });

  it("take profit 1 sells the configured fraction once", () => {
    const d = evaluateExits(makePosition({ peakPriceUsd: 2 }), 2, null, null, cfg, T0);
    expect(d.action).toBe("sell");
    expect(d.fraction).toBe(0.5);
    expect(d.reason).toMatch(/take profit 1: .*>= 2x entry \(\$2\), selling 50% of remaining/);
    expect(evaluateExits(makePosition({ peakPriceUsd: 2 }), 1.99, null, null, cfg, T0).action).toBe("hold");
    const again = evaluateExits(makePosition({ peakPriceUsd: 2, tp1Hit: true }), 2, null, null, cfg, T0);
    expect(again.action).toBe("hold");
  });

  it("time stop fires at 48h when gain is below the hold threshold", () => {
    const pos = makePosition({ peakPriceUsd: 1.1 });
    const d = evaluateExits(pos, 1.05, null, null, cfg, T0 + 48 * HOUR);
    expect(d.action).toBe("sell");
    expect(d.fraction).toBe(1);
    expect(d.reason).toMatch(/time stop: held 48\.0h >= 48h with pnl 5\.0% < 15\.0%/);
    expect(evaluateExits(pos, 1.05, null, null, cfg, T0 + 48 * HOUR - 1).action).toBe("hold");
  });

  it("time stop does not fire at or above the hold threshold", () => {
    const pos = makePosition({ peakPriceUsd: 1.2 });
    expect(evaluateExits(pos, 1.16, null, null, cfg, T0 + 72 * HOUR).action).toBe("hold");
    expect(evaluateExits(pos, 1.2, null, null, cfg, T0 + 72 * HOUR).action).toBe("hold");
  });

  it("applies the documented precedence", () => {
    const pos = makePosition({ peakPriceUsd: 3, tp1Hit: false });
    const late = T0 + 72 * HOUR;
    // safety > liquidity
    expect(evaluateExits(pos, 0.1, 1, makeSafety({ rugged: true }), cfg, late).reason).toMatch(/^safety/);
    // liquidity > hard stop
    expect(evaluateExits(pos, 0.1, 1, null, cfg, late).reason).toMatch(/^liquidity/);
    // hard stop > trailing
    expect(evaluateExits(pos, 0.1, null, null, cfg, late).reason).toMatch(/^hard stop/);
    // trailing > take profit (peak 4, price 2.0 is 50% off peak, beyond the 40% trail, and also >= 2x)
    expect(evaluateExits(makePosition({ peakPriceUsd: 4 }), 2.0, null, null, cfg, late).reason).toMatch(/^trailing/);
    // take profit > time stop
    const fresh = makePosition({ peakPriceUsd: 2.1 });
    expect(evaluateExits(fresh, 2.05, null, null, cfg, late).reason).toMatch(/^take profit/);
    // time stop > hold
    expect(evaluateExits(makePosition({ peakPriceUsd: 1.05 }), 1.0, null, null, cfg, late).reason).toMatch(/^time stop/);
  });
});
