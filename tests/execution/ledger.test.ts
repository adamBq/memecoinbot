import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, type OpenPositionInput } from "../../src/execution/ledger.js";
import type { Order } from "../../src/core/types.js";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const T0 = 1_761_100_000_000; // integer ms

function positionInput(overrides: Partial<OpenPositionInput> = {}): OpenPositionInput {
  return {
    mint: MINT,
    symbol: "BONK",
    pairAddress: "pair111",
    openedAt: T0,
    entryPriceUsd: 0.0000215,
    entryLiquidityUsd: 250_000,
    qtyTokens: 3_700_000,
    costBasisUsd: 80,
    entryScore: 0.71,
    ...overrides,
  };
}

function orderInput(positionId: number, overrides: Partial<Omit<Order, "id">> = {}): Omit<Order, "id"> {
  return {
    positionId,
    side: "buy",
    mint: MINT,
    symbol: "BONK",
    qtyTokens: 3_700_000,
    effectivePriceUsd: 0.0000218,
    referencePriceUsd: 0.0000215,
    notionalUsd: 80,
    feeUsd: 0.29,
    priceImpactPct: 0.4,
    reason: "entry",
    ts: T0,
    ...overrides,
  };
}

describe("Ledger (in memory)", () => {
  let ledger: Ledger;
  beforeEach(() => {
    ledger = new Ledger(":memory:");
  });
  afterEach(() => {
    ledger.close();
  });

  it("runs migrations and records a schema version", () => {
    expect(ledger.getMeta("schema_version")).toBe("1");
  });

  it("opens a position with the contract defaults", () => {
    const pos = ledger.openPosition(positionInput());
    expect(pos.id).toBeGreaterThan(0);
    expect(pos.status).toBe("open");
    expect(pos.remainingQtyTokens).toBe(pos.qtyTokens);
    expect(pos.realizedPnlUsd).toBe(0);
    expect(pos.tp1Hit).toBe(false);
    expect(pos.peakPriceUsd).toBe(pos.entryPriceUsd);
    expect(pos.closeReason).toBeNull();
    expect(pos.closedAt).toBeNull();

    const loaded = ledger.getPosition(pos.id);
    expect(loaded).toEqual(pos);
    expect(ledger.getOpenPositions()).toEqual([pos]);
    expect(ledger.getClosedPositions()).toEqual([]);
    expect(ledger.getPosition(9999)).toBeNull();
  });

  it("records orders and reads them back per position and overall", () => {
    const a = ledger.openPosition(positionInput());
    const b = ledger.openPosition(positionInput({ mint: "Mint2222222222222222222222222222222222222222", symbol: "WIF" }));
    const o1 = ledger.recordOrder(orderInput(a.id));
    const o2 = ledger.recordOrder(orderInput(b.id, { symbol: "WIF", ts: T0 + 1000 }));
    const o3 = ledger.recordOrder(
      orderInput(a.id, { side: "sell", qtyTokens: 1_850_000, notionalUsd: 70, reason: "tp1", ts: T0 + 2000 }),
    );
    expect(o1.id).toBeGreaterThan(0);
    expect(o2.id).toBeGreaterThan(o1.id);
    expect(ledger.getOrders(a.id)).toEqual([o1, o3]);
    expect(ledger.getOrders(b.id)).toEqual([o2]);
    expect(ledger.getOrders()).toEqual([o1, o2, o3]);
    expect(ledger.getOrders(a.id)[1]?.side).toBe("sell");
  });

  it("rejects an order for a position that does not exist (foreign keys on)", () => {
    expect(() => ledger.recordOrder(orderInput(42))).toThrow();
  });

  it("applies a partial update (tp1, peak, remaining qty, realized pnl) and preserves booleans", () => {
    const pos = ledger.openPosition(positionInput());
    const updated = {
      ...pos,
      remainingQtyTokens: pos.qtyTokens / 2,
      realizedPnlUsd: 31.5,
      peakPriceUsd: 0.000045,
      tp1Hit: true,
    };
    ledger.updatePosition(updated);
    const loaded = ledger.getPosition(pos.id);
    expect(loaded).toEqual(updated);
    expect(loaded?.tp1Hit).toBe(true);
    expect(loaded?.status).toBe("open");
    expect(ledger.getOpenPositions()).toHaveLength(1);
  });

  it("throws when updating a position that does not exist", () => {
    const pos = ledger.openPosition(positionInput());
    expect(() => ledger.updatePosition({ ...pos, id: pos.id + 100 })).toThrow(/not found/);
  });

  it("closes a position without touching quantities and lists closed newest first", () => {
    const p1 = ledger.openPosition(positionInput({ openedAt: T0 }));
    const p2 = ledger.openPosition(positionInput({ openedAt: T0 + 1 }));
    const p3 = ledger.openPosition(positionInput({ openedAt: T0 + 2 }));
    ledger.updatePosition({ ...p1, remainingQtyTokens: 0, realizedPnlUsd: -12.5 });

    ledger.closePosition(p1.id, T0 + 10_000, "hard_stop");
    ledger.closePosition(p3.id, T0 + 30_000, "trailing_stop");
    ledger.closePosition(p2.id, T0 + 20_000, "time_stop");

    const c1 = ledger.getPosition(p1.id);
    expect(c1?.status).toBe("closed");
    expect(c1?.closedAt).toBe(T0 + 10_000);
    expect(c1?.closeReason).toBe("hard_stop");
    expect(c1?.remainingQtyTokens).toBe(0);
    expect(c1?.realizedPnlUsd).toBe(-12.5);
    expect(c1?.qtyTokens).toBe(p1.qtyTokens);

    expect(ledger.getOpenPositions()).toEqual([]);
    expect(ledger.getClosedPositions().map((p) => p.id)).toEqual([p3.id, p2.id, p1.id]);
    expect(ledger.getClosedPositions(2).map((p) => p.id)).toEqual([p3.id, p2.id]);
    expect(() => ledger.closePosition(999, T0, "x")).toThrow(/not found/);
  });

  it("returns the equity curve in ascending ts order regardless of insert order", () => {
    ledger.snapshotEquity(T0 + 2000, 1020, 900, 1);
    ledger.snapshotEquity(T0, 1000, 1000, 0);
    ledger.snapshotEquity(T0 + 1000, 1010, 920, 1);
    expect(ledger.getEquityCurve()).toEqual([
      { ts: T0, equityUsd: 1000, cashUsd: 1000 },
      { ts: T0 + 1000, equityUsd: 1010, cashUsd: 920 },
      { ts: T0 + 2000, equityUsd: 1020, cashUsd: 900 },
    ]);
  });

  it("returns decisions since a timestamp, newest first, with a limit", () => {
    const lenses = JSON.stringify({ technical: { score: 0.8, reasons: [] } });
    for (let i = 0; i < 5; i++) {
      ledger.recordDecision({
        ts: T0 + i * 1000,
        mint: MINT,
        symbol: "BONK",
        action: i % 2 === 0 ? "skip" : "enter",
        total: 0.5 + i / 10,
        lensesJson: lenses,
        reason: `reason ${i}`,
      });
    }
    const since = ledger.getDecisions(T0 + 2000);
    expect(since.map((d) => d.ts)).toEqual([T0 + 4000, T0 + 3000, T0 + 2000]);
    expect(since[0]).toEqual({
      ts: T0 + 4000,
      mint: MINT,
      symbol: "BONK",
      action: "skip",
      total: 0.9,
      lensesJson: lenses,
      reason: "reason 4",
    });
    expect(ledger.getDecisions(0, 2).map((d) => d.ts)).toEqual([T0 + 4000, T0 + 3000]);
    expect(ledger.getDecisions(T0 + 10_000)).toEqual([]);
  });

  it("reports the last exit ts per mint from closed positions and sell orders", () => {
    expect(ledger.getLastExitTs(MINT)).toBeNull();
    const pos = ledger.openPosition(positionInput());
    ledger.recordOrder(orderInput(pos.id, { ts: T0 }));
    expect(ledger.getLastExitTs(MINT)).toBeNull(); // buys are not exits

    ledger.recordOrder(orderInput(pos.id, { side: "sell", reason: "tp1", ts: T0 + 5000 }));
    expect(ledger.getLastExitTs(MINT)).toBe(T0 + 5000);

    ledger.closePosition(pos.id, T0 + 9000, "trailing_stop");
    expect(ledger.getLastExitTs(MINT)).toBe(T0 + 9000);
    expect(ledger.getLastExitTs("OtherMint")).toBeNull();
  });

  it("stores and overwrites meta values", () => {
    expect(ledger.getMeta("cash_usd")).toBeNull();
    ledger.setMeta("cash_usd", "1000");
    expect(ledger.getMeta("cash_usd")).toBe("1000");
    ledger.setMeta("cash_usd", "987.65");
    expect(ledger.getMeta("cash_usd")).toBe("987.65");
  });

  it("stores notes oldest first", () => {
    ledger.addNote(T0 + 1, "second");
    ledger.addNote(T0, "first");
    expect(ledger.getNotes()).toEqual([
      { ts: T0, text: "first" },
      { ts: T0 + 1, text: "second" },
    ]);
  });
});

describe("Ledger (file)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memecoinbot-ledger-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists data across reopen and re-running migrations is idempotent", () => {
    const path = join(dir, "nested", "ledger.db");
    const first = new Ledger(path);
    const pos = first.openPosition(positionInput());
    const order = first.recordOrder(orderInput(pos.id));
    first.setMeta("cash_usd", "920");
    first.snapshotEquity(T0, 1000, 920, 1);
    first.addNote(T0, "strategy locked");
    first.close();
    expect(existsSync(path)).toBe(true);

    const second = new Ledger(path);
    expect(second.getMeta("schema_version")).toBe("1");
    expect(second.getMeta("cash_usd")).toBe("920");
    expect(second.getOpenPositions()).toEqual([pos]);
    expect(second.getOrders(pos.id)).toEqual([order]);
    expect(second.getEquityCurve()).toEqual([{ ts: T0, equityUsd: 1000, cashUsd: 920 }]);
    expect(second.getNotes()).toEqual([{ ts: T0, text: "strategy locked" }]);
    second.closePosition(pos.id, T0 + 1, "manual");
    second.close();

    const third = new Ledger(path);
    expect(third.getOpenPositions()).toEqual([]);
    expect(third.getClosedPositions()[0]?.closeReason).toBe("manual");
    third.close();
  });

  it("opens read-only: reads work, writes throw, nothing is created on disk", () => {
    const path = join(dir, "ro.db");
    const rw = new Ledger(path);
    const pos = rw.openPosition(positionInput());
    rw.setMeta("cash_usd", "920");
    rw.addNote(T0, "hello");
    rw.close();

    const ro = new Ledger(path, { readOnly: true });
    expect(ro.isReadOnly).toBe(true);
    expect(ro.getMeta("schema_version")).toBe("1");
    expect(ro.getMeta("cash_usd")).toBe("920");
    expect(ro.getOpenPositions()).toEqual([pos]);
    expect(ro.getPosition(pos.id)).toEqual(pos);
    expect(ro.getClosedPositions()).toEqual([]);
    expect(ro.getOrders()).toEqual([]);
    expect(ro.getEquityCurve()).toEqual([]);
    expect(ro.getDecisions(0)).toEqual([]);
    expect(ro.getNotes()).toEqual([{ ts: T0, text: "hello" }]);
    expect(ro.getLastExitTs(MINT)).toBeNull();

    expect(() => ro.setMeta("cash_usd", "1")).toThrow(/readonly/i);
    expect(() => ro.openPosition(positionInput())).toThrow(/readonly/i);
    expect(() => ro.addNote(T0, "nope")).toThrow(/readonly/i);
    expect(() => ro.snapshotEquity(T0, 1, 1, 0)).toThrow(/readonly/i);
    ro.close();

    // The read-only handle changed nothing.
    const again = new Ledger(path, { readOnly: true });
    expect(again.getMeta("cash_usd")).toBe("920");
    expect(again.getNotes()).toHaveLength(1);
    again.close();

    // A missing file is not created by a read-only open.
    const missing = join(dir, "does-not-exist", "x.db");
    expect(() => new Ledger(missing, { readOnly: true })).toThrow();
    expect(existsSync(missing)).toBe(false);
  });

  it("keeps the one-argument constructor read-write", () => {
    const l = new Ledger(join(dir, "rw.db"));
    expect(l.isReadOnly).toBe(false);
    l.setMeta("k", "v");
    expect(l.getMeta("k")).toBe("v");
    l.close();
  });
});
