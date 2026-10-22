/** Deterministic in-memory ledger fixture shared by the dashboard API and server tests. */
import { Ledger } from "../../src/execution/ledger.js";
import { META, utcDayKey } from "../../src/ops/portfolio.js";

export const NOW = 1_761_200_000_000; // fixed "now" in ms
const H = 3_600_000;

export const MINTS = {
  openA: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1",
  openB: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2",
  closedC: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3",
  closedD: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD4",
  closedE: "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE5",
  candF: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF6",
  candG: "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG7",
} as const;

export const VALID_LENSES = {
  technical: { score: 0.8, reasons: ["breakout above 1h high"] },
  fundamental: { score: 0.6, reasons: [] },
  quantitative: { score: 0.7, reasons: ["volume z 2.1"] },
  sentiment: { score: 0.5, reasons: [] },
  event: { score: 0.4, reasons: ["new pool"] },
};
export const VALID_LENSES_JSON = JSON.stringify(VALID_LENSES);

export const SEED = {
  startingEquity: 1000,
  cash: 820,
  peak: 1080,
  dayStart: 1010,
  startedAt: NOW - 72 * H,
  lastTickAt: NOW - 60_000,
  lastScreenAt: NOW - 10 * 60_000,
  configHash: "abcdef0123456789",
  /** Live marks the tests inject through getPrices. */
  prices: { [MINTS.openA]: 0.002, [MINTS.openB]: 0.0009 } as Record<string, number>,
};

export interface Seeded {
  ledger: Ledger;
  openIds: number[];
  closedIds: number[];
}

export function seedLedger(ledger: Ledger = new Ledger(":memory:")): Seeded {
  // meta
  ledger.setMeta(META.cash, String(SEED.cash));
  ledger.setMeta(META.peakEquity, String(SEED.peak));
  ledger.setMeta(META.dayKey, utcDayKey(NOW));
  ledger.setMeta(META.dayStartEquity, String(SEED.dayStart));
  ledger.setMeta(META.consecutiveLosses, "1");
  ledger.setMeta(META.killed, "0");
  ledger.setMeta(META.started, String(SEED.startedAt));
  ledger.setMeta(META.lastTickAt, String(SEED.lastTickAt));
  ledger.setMeta(META.lastScreenAt, String(SEED.lastScreenAt));
  ledger.setMeta("config_hash", SEED.configHash);

  // open positions: A up 100% on live mark, B half sold after tp1
  const a = ledger.openPosition({
    mint: MINTS.openA,
    symbol: "AAA",
    pairAddress: "pairA",
    openedAt: NOW - 5 * H,
    entryPriceUsd: 0.001,
    entryLiquidityUsd: 200_000,
    qtyTokens: 80_000,
    costBasisUsd: 80,
    entryScore: 0.72,
  });
  ledger.updatePosition({ ...a, peakPriceUsd: 0.0025 });
  const b = ledger.openPosition({
    mint: MINTS.openB,
    symbol: "BBB",
    pairAddress: "pairB",
    openedAt: NOW - 20 * H,
    entryPriceUsd: 0.0005,
    entryLiquidityUsd: 150_000,
    qtyTokens: 160_000,
    costBasisUsd: 80,
    entryScore: 0.66,
  });
  ledger.updatePosition({ ...b, remainingQtyTokens: 80_000, realizedPnlUsd: 38, tp1Hit: true, peakPriceUsd: 0.0011 });

  // closed positions: C win, D loss, E small loss; closed in that order so E is newest
  const mk = (mint: string, symbol: string, openedAt: number) =>
    ledger.openPosition({
      mint,
      symbol,
      pairAddress: `pair${symbol}`,
      openedAt,
      entryPriceUsd: 0.01,
      entryLiquidityUsd: 100_000,
      qtyTokens: 8_000,
      costBasisUsd: 80,
      entryScore: 0.65,
    });
  const c = mk(MINTS.closedC, "CCC", NOW - 50 * H);
  ledger.updatePosition({ ...c, remainingQtyTokens: 0, realizedPnlUsd: 40 });
  ledger.closePosition(c.id, NOW - 46 * H, "take profit 1: ...");
  const d = mk(MINTS.closedD, "DDD", NOW - 40 * H);
  ledger.updatePosition({ ...d, remainingQtyTokens: 0, realizedPnlUsd: -24 });
  ledger.closePosition(d.id, NOW - 30 * H, "hard stop: ...");
  const e = mk(MINTS.closedE, "EEE", NOW - 26 * H);
  ledger.updatePosition({ ...e, remainingQtyTokens: 0, realizedPnlUsd: -8 });
  ledger.closePosition(e.id, NOW - 24 * H, "time stop: ...");

  // orders
  const order = (positionId: number, mint: string, symbol: string, side: "buy" | "sell", ts: number, reason: string) =>
    ledger.recordOrder({
      positionId,
      side,
      mint,
      symbol,
      qtyTokens: 1000,
      effectivePriceUsd: 0.01,
      referencePriceUsd: 0.0099,
      notionalUsd: 10,
      feeUsd: 0.05,
      priceImpactPct: 0.3,
      reason,
      ts,
    });
  order(c.id, MINTS.closedC, "CCC", "buy", NOW - 50 * H, "entry");
  order(c.id, MINTS.closedC, "CCC", "sell", NOW - 46 * H, "tp1");
  order(d.id, MINTS.closedD, "DDD", "buy", NOW - 40 * H, "entry");
  order(d.id, MINTS.closedD, "DDD", "sell", NOW - 30 * H, "hard stop");
  order(e.id, MINTS.closedE, "EEE", "buy", NOW - 26 * H, "entry");
  order(e.id, MINTS.closedE, "EEE", "sell", NOW - 24 * H, "time stop");
  order(b.id, MINTS.openB, "BBB", "buy", NOW - 20 * H, "entry");
  order(b.id, MINTS.openB, "BBB", "sell", NOW - 6 * H, "tp1");
  order(a.id, MINTS.openA, "AAA", "buy", NOW - 5 * H, "entry");

  // equity snapshots, inserted out of order on purpose
  ledger.snapshotEquity(NOW - 2 * H, 1050, 820, 2);
  ledger.snapshotEquity(NOW - 4 * H, 1030, 820, 2);
  ledger.snapshotEquity(NOW - 3 * H, 1080, 820, 2);

  // decisions: older than the last screen
  ledger.recordDecision({ ts: NOW - 48 * H, mint: MINTS.closedC, symbol: "CCC", action: "enter", total: 0.71, lensesJson: VALID_LENSES_JSON, reason: "enter CCC" });
  ledger.recordDecision({ ts: NOW - 46 * H, mint: MINTS.closedC, symbol: "CCC", action: "exit", total: 0, lensesJson: JSON.stringify({ kind: "take_profit" }), reason: "tp1 | sold" });
  ledger.recordDecision({ ts: NOW - 30 * H, mint: MINTS.closedD, symbol: "DDD", action: "exit", total: 0, lensesJson: "not json at all {", reason: "hard stop | sold" });
  // decisions from the latest screen (ts >= lastScreenAt)
  const screen = SEED.lastScreenAt;
  ledger.recordDecision({ ts: screen, mint: MINTS.candG, symbol: "GGG", action: "filtered", total: 0.2, lensesJson: VALID_LENSES_JSON, reason: "liquidity 10000 < 50000" });
  ledger.recordDecision({ ts: screen + 1000, mint: MINTS.candF, symbol: "FFF", action: "skip", total: 0.55, lensesJson: VALID_LENSES_JSON, reason: "composite 0.550 < 0.62" });
  ledger.recordDecision({ ts: screen + 2000, mint: MINTS.candF, symbol: "FFF", action: "skip", total: 0.58, lensesJson: VALID_LENSES_JSON, reason: "composite 0.580 < 0.62" });
  ledger.recordDecision({ ts: screen + 3000, mint: MINTS.openA, symbol: "AAA", action: "enter", total: 0.72, lensesJson: VALID_LENSES_JSON, reason: "enter AAA | bought" });
  ledger.recordDecision({ ts: screen + 4000, mint: MINTS.openB, symbol: "BBB", action: "exit", total: 0, lensesJson: JSON.stringify({ kind: "take_profit" }), reason: "tp1 | sold half" });

  // notes, inserted out of order
  ledger.addNote(NOW - 72 * H + 1, "strategy config pinned: abcdef0123456789");
  ledger.addNote(NOW - 72 * H, "initialised paper account with 1000 USD");

  return { ledger, openIds: [a.id, b.id], closedIds: [c.id, d.id, e.id] };
}
