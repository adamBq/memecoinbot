import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ledger } from "../../src/execution/ledger.js";
import { strategyConfigHash } from "../../src/core/config.js";
import { testConfig, configWith } from "../helpers/contextFactory.js";
import {
  buildCandidates,
  buildConfigDto,
  buildDecisions,
  buildEquity,
  buildNotes,
  buildOrders,
  buildPositions,
  buildReportDto,
  buildSummary,
  parseLenses,
  priceBook,
  toPriceMap,
  PRICE_STALE_MS,
  DECISIONS_MAX_OFFSET,
} from "../../src/ui/api.js";
import { MINTS, NOW, SEED, VALID_LENSES, VALID_LENSES_JSON, seedLedger } from "./seed.js";

const H = 3_600_000;
const cfg = configWith((c) => {
  c.account.startingEquityUsd = SEED.startingEquity;
  c.llm.enabled = false;
});

describe("ui api builders", () => {
  let ledger: Ledger;
  let openIds: number[];
  let closedIds: number[];
  beforeEach(() => {
    const s = seedLedger();
    ledger = s.ledger;
    openIds = s.openIds;
    closedIds = s.closedIds;
  });
  afterEach(() => ledger.close());

  describe("buildSummary", () => {
    it("marks open positions with live prices and derives the KPI fields", () => {
      const s = buildSummary(ledger, cfg, priceBook(SEED.prices, NOW), NOW);
      // A: 80_000 * 0.002 = 160, B: 80_000 * 0.0009 = 72, cash 820 -> 1052
      expect(s.equityUsd).toBeCloseTo(1052, 6);
      expect(s.cashUsd).toBe(SEED.cash);
      expect(s.startingEquityUsd).toBe(1000);
      expect(s.returnPct).toBeCloseTo(5.2, 6);
      expect(s.peakEquityUsd).toBe(SEED.peak);
      expect(s.drawdownFromPeakPct).toBeCloseTo((1 - 1052 / 1080) * 100, 6);
      expect(s.dayStartEquityUsd).toBe(SEED.dayStart);
      expect(s.dayPnlPct).toBeCloseTo((1052 / 1010 - 1) * 100, 6);
      expect(s.openCount).toBe(2);
      expect(s.closedCount).toBe(3);
      expect(s.mode).toBe("paper");
      expect(s.generatedAt).toBe(NOW);
      expect(s.startedAt).toBe(SEED.startedAt);
      expect(s.configHash).toBe(SEED.configHash);
      expect(s.llmEnabled).toBe(false);
      expect(s.killed).toBe(false);
      expect(s.haltedUntil).toBeNull();
      expect(s.consecutiveLosses).toBe(1);
      expect(s.breakers).toEqual({ haltNewEntries: false, killSwitch: false, reasons: [] });
      expect(s.lastTickAt).toBe(SEED.lastTickAt);
      expect(s.lastScreenAt).toBe(SEED.lastScreenAt);
      expect(s.botHealthy).toBe(true);
      expect(s.pricesStale).toBe(false);
    });

    it("flags stale prices when a mark is missing or older than 2 minutes", () => {
      expect(buildSummary(ledger, cfg, priceBook({ [MINTS.openA]: 0.002 }, NOW), NOW).pricesStale).toBe(true);
      const old = { [MINTS.openA]: { price: 0.002, at: NOW - PRICE_STALE_MS - 1 }, [MINTS.openB]: { price: 0.0009, at: NOW } };
      expect(buildSummary(ledger, cfg, old, NOW).pricesStale).toBe(true);
      const fresh = { [MINTS.openA]: { price: 0.002, at: NOW - PRICE_STALE_MS }, [MINTS.openB]: { price: 0.0009, at: NOW - 5 } };
      expect(buildSummary(ledger, cfg, fresh, NOW).pricesStale).toBe(false);
      expect(buildSummary(ledger, cfg, {}, NOW).pricesStale).toBe(true);
      // still marks equity with the old quote: staleness is a flag, not a drop
      expect(buildSummary(ledger, cfg, old, NOW).equityUsd).toBeCloseTo(1052, 6);
    });

    it("falls back to entry prices when no live mark exists and flags a stale bot", () => {
      const later = NOW + 3 * 60_000 + 1;
      const s = buildSummary(ledger, cfg, {}, later);
      // A: 80_000 * 0.001 = 80, B: 80_000 * 0.0005 = 40, cash 820 -> 940
      expect(s.equityUsd).toBeCloseTo(940, 6);
      expect(s.botHealthy).toBe(false);
      expect(s.generatedAt).toBe(later);
    });

    it("reports breakers and halt state from the ledger meta without writing", () => {
      ledger.setMeta("killed", "1");
      ledger.setMeta("halted_until", String(NOW + H));
      ledger.setMeta("consecutive_losses", "3");
      const before = ledger.getMeta("peak_equity_usd");
      // Push equity above the stored peak: a read-only load must not ratchet the meta value.
      const s = buildSummary(ledger, cfg, priceBook({ [MINTS.openA]: 0.01 }, NOW), NOW);
      expect(ledger.getMeta("peak_equity_usd")).toBe(before);
      expect(s.killed).toBe(true);
      expect(s.haltedUntil).toBe(NOW + H);
      expect(s.consecutiveLosses).toBe(3);
      expect(s.breakers.killSwitch).toBe(true);
      expect(s.breakers.haltNewEntries).toBe(true);
      expect(s.breakers.reasons.some((r) => r.includes("kill switch"))).toBe(true);
      expect(s.breakers.reasons.some((r) => r.includes("cooldown active"))).toBe(true);
    });

    it("handles an uninitialised ledger", () => {
      const fresh = new Ledger(":memory:");
      const s = buildSummary(fresh, cfg, {}, NOW);
      expect(s.equityUsd).toBe(0);
      expect(s.startedAt).toBeNull();
      expect(s.configHash).toBeNull();
      expect(s.lastTickAt).toBeNull();
      expect(s.botHealthy).toBe(false);
      expect(s.openCount).toBe(0);
      expect(s.closedCount).toBe(0);
      fresh.close();
    });
  });

  describe("buildEquity", () => {
    it("returns the stored curve ascending plus a synthetic live point", () => {
      const { points } = buildEquity(ledger, priceBook(SEED.prices, NOW), NOW);
      expect(points.map((p) => p.ts)).toEqual([NOW - 4 * H, NOW - 3 * H, NOW - 2 * H, NOW]);
      expect(points[0]).toEqual({ ts: NOW - 4 * H, equityUsd: 1030, cashUsd: 820 });
      const last = points[points.length - 1]!;
      expect(last.equityUsd).toBeCloseTo(1052, 6);
      expect(last.cashUsd).toBe(820);
    });
  });

  describe("buildPositions", () => {
    it("decorates open positions with live P&L and lists closed newest first", () => {
      const { open, closed } = buildPositions(ledger, priceBook(SEED.prices, NOW), NOW);
      // oldest open first: BBB (20h) then AAA (5h)
      expect(open.map((p) => p.id)).toEqual([openIds[1], openIds[0]]);

      const a = open[1]!;
      expect(a.symbol).toBe("AAA");
      expect(a.currentPriceUsd).toBe(0.002);
      expect(a.pnlPct).toBeCloseTo(100, 6);
      expect(a.unrealizedPnlUsd).toBeCloseTo(80, 6); // 80_000 * 0.002 - 80
      expect(a.peakPct).toBeCloseTo(150, 6);
      expect(a.priceAgeMs).toBe(0);
      expect(a.ageHours).toBeCloseTo(5, 6);
      expect(a.remainingPct).toBe(100);

      const b = open[0]!;
      expect(b.symbol).toBe("BBB");
      expect(b.currentPriceUsd).toBe(0.0009);
      expect(b.pnlPct).toBeCloseTo(80, 6);
      expect(b.unrealizedPnlUsd).toBeCloseTo(80_000 * 0.0009 - 40, 6);
      expect(b.remainingPct).toBe(50);
      expect(b.tp1Hit).toBe(true);
      expect(b.realizedPnlUsd).toBe(38);

      expect(closed.map((p) => p.id)).toEqual([closedIds[2], closedIds[1], closedIds[0]]);
      expect(closed.map((p) => p.symbol)).toEqual(["EEE", "DDD", "CCC"]);
      expect(closed[2]!.pnlPct).toBeCloseTo(50, 6); // 40 / 80
      expect(closed[2]!.holdHours).toBeCloseTo(4, 6);
      expect(closed[1]!.pnlPct).toBeCloseTo(-30, 6);
      expect(closed[1]!.holdHours).toBeCloseTo(10, 6);
      expect(closed[1]!.closeReason).toBe("hard stop: ...");
    });

    it("uses nulls for open positions without a live mark", () => {
      const { open } = buildPositions(ledger, {}, NOW);
      expect(open[1]!.symbol).toBe("AAA");
      expect(open[1]!.currentPriceUsd).toBeNull();
      expect(open[1]!.priceAgeMs).toBeNull();
      expect(open[1]!.pnlPct).toBeNull();
      expect(open[1]!.unrealizedPnlUsd).toBeNull();
      expect(open[1]!.peakPct).toBeCloseTo(150, 6);
      expect(open[0]!.peakPct).toBeCloseTo(120, 6);
    });
  });

  describe("buildPositions guards", () => {
    it("reports price age and nulls non-finite ratios", () => {
      const aged = { [MINTS.openA]: { price: 0.002, at: NOW - 45_000 } };
      const { open } = buildPositions(ledger, aged, NOW);
      expect(open[1]!.priceAgeMs).toBe(45_000);
      expect(open[0]!.priceAgeMs).toBeNull();
      // a non-positive quote is not a live mark
      const zero = buildPositions(ledger, { [MINTS.openA]: { price: 0, at: NOW } }, NOW);
      expect(zero.open[1]!.currentPriceUsd).toBeNull();
      expect(zero.open[1]!.pnlPct).toBeNull();

      // zero entry price / cost basis cannot produce Infinity or NaN
      const [a] = ledger.getOpenPositions();
      ledger.updatePosition({ ...a!, entryPriceUsd: 0, qtyTokens: 0, remainingQtyTokens: 0 });
      const [c] = ledger.getClosedPositions(1);
      ledger.updatePosition({ ...c!, costBasisUsd: 0 });
      const dto = buildPositions(ledger, priceBook(SEED.prices, NOW), NOW);
      const broken = dto.open.find((p) => p.id === a!.id)!;
      expect(broken.peakPct).toBeNull();
      expect(broken.pnlPct).toBe(0); // risk.pnlPct guards a zero entry itself
      expect(broken.remainingPct).toBe(0);
      expect(dto.closed.find((p) => p.id === c!.id)!.pnlPct).toBeNull();
      expect(JSON.stringify(dto)).not.toMatch(/Infinity|NaN/);
    });
  });

  describe("price book helpers", () => {
    it("round-trips a price map", () => {
      const book = priceBook({ a: 1, b: 2 }, 123);
      expect(book).toEqual({ a: { price: 1, at: 123 }, b: { price: 2, at: 123 } });
      expect(toPriceMap(book)).toEqual({ a: 1, b: 2 });
    });
  });

  describe("buildOrders", () => {
    it("returns orders newest first with a limit", () => {
      const all = buildOrders(ledger).orders;
      expect(all).toHaveLength(9);
      expect(all[0]!.symbol).toBe("AAA");
      expect(all[0]!.ts).toBe(NOW - 5 * H);
      expect(all[8]!.ts).toBe(NOW - 50 * H);
      for (let i = 1; i < all.length; i++) expect(all[i - 1]!.ts).toBeGreaterThanOrEqual(all[i]!.ts);

      const two = buildOrders(ledger, 2).orders;
      expect(two.map((o) => o.ts)).toEqual([NOW - 5 * H, NOW - 6 * H]);
      expect(buildOrders(ledger, 0).orders).toHaveLength(9); // invalid limit -> default
      expect(buildOrders(ledger, 1e9).orders).toHaveLength(9); // capped, not an error
    });
  });

  describe("parseLenses", () => {
    it("accepts the five-lens shape and rejects everything else", () => {
      expect(parseLenses(VALID_LENSES_JSON)).toEqual(VALID_LENSES);
      expect(parseLenses("{}")).toBeNull();
      expect(parseLenses('{"kind":"trailing"}')).toBeNull();
      expect(parseLenses("not json")).toBeNull();
      expect(parseLenses("[1,2]")).toBeNull();
      expect(parseLenses("null")).toBeNull();
      const missingOne = JSON.stringify({ ...VALID_LENSES, event: undefined });
      expect(parseLenses(missingOne)).toBeNull();
      const badScore = JSON.stringify({ ...VALID_LENSES, event: { score: "0.4", reasons: [] } });
      expect(parseLenses(badScore)).toBeNull();
      const noReasons = JSON.stringify({ ...VALID_LENSES, event: { score: 0.4 } });
      expect(parseLenses(noReasons)?.event).toEqual({ score: 0.4, reasons: [] });
    });
  });

  describe("buildDecisions", () => {
    it("returns everything newest first with parsed lenses and a total", () => {
      const { decisions, total } = buildDecisions(ledger);
      expect(total).toBe(8);
      expect(decisions).toHaveLength(8);
      for (let i = 1; i < decisions.length; i++) expect(decisions[i - 1]!.ts).toBeGreaterThanOrEqual(decisions[i]!.ts);
      expect(decisions[0]).toEqual({
        ts: SEED.lastScreenAt + 4000,
        mint: MINTS.openB,
        symbol: "BBB",
        action: "exit",
        total: 0,
        lenses: null,
        reason: "tp1 | sold half",
      });
      const enter = decisions.find((d) => d.action === "enter" && d.symbol === "AAA")!;
      expect(enter.lenses).toEqual(VALID_LENSES);
      const garbage = decisions.find((d) => d.symbol === "DDD")!;
      expect(garbage.action).toBe("exit");
      expect(garbage.lenses).toBeNull();
    });

    it("filters by action list, pages, and honours since", () => {
      const skips = buildDecisions(ledger, { action: ["skip"] });
      expect(skips.total).toBe(2);
      expect(skips.decisions.every((d) => d.action === "skip")).toBe(true);

      const two = buildDecisions(ledger, { action: ["enter", "exit"] });
      expect(two.total).toBe(5);
      expect(two.decisions.map((d) => d.action).sort()).toEqual(["enter", "enter", "exit", "exit", "exit"]);

      const page = buildDecisions(ledger, { limit: 3, offset: 3 });
      expect(page.total).toBe(8);
      expect(page.decisions).toHaveLength(3);
      expect(page.decisions[0]!.ts).toBe(SEED.lastScreenAt + 1000);

      const tail = buildDecisions(ledger, { limit: 3, offset: 6 });
      expect(tail.decisions).toHaveLength(2);
      expect(buildDecisions(ledger, { offset: 100 }).decisions).toEqual([]);

      const recent = buildDecisions(ledger, { since: SEED.lastScreenAt });
      expect(recent.total).toBe(5);
      expect(recent.decisions.every((d) => d.ts >= SEED.lastScreenAt)).toBe(true);

      // unknown actions are ignored; an all-unknown filter means no filter
      expect(buildDecisions(ledger, { action: ["bogus"] }).total).toBe(8);
      expect(buildDecisions(ledger, { action: ["bogus", "skip"] }).total).toBe(2);
    });

    it("clamps the offset to 0..100000", () => {
      expect(buildDecisions(ledger, { offset: -3 }).decisions).toHaveLength(8);
      expect(buildDecisions(ledger, { offset: DECISIONS_MAX_OFFSET + 5 }).decisions).toEqual([]);
      expect(buildDecisions(ledger, { offset: DECISIONS_MAX_OFFSET + 5 }).total).toBe(8);
    });

    it("clamps the limit to 1..500", () => {
      expect(buildDecisions(ledger, { limit: 0 }).decisions).toHaveLength(1);
      expect(buildDecisions(ledger, { limit: -5 }).decisions).toHaveLength(1);
      expect(buildDecisions(ledger, { limit: 10_000 }).decisions).toHaveLength(8);
      expect(buildDecisions(ledger, { limit: Number.NaN }).decisions).toHaveLength(8);
    });
  });

  describe("buildCandidates", () => {
    it("ranks the latest screen one row per mint by total, excluding exits", () => {
      const { screenedAt, candidates } = buildCandidates(ledger);
      expect(screenedAt).toBe(SEED.lastScreenAt);
      expect(candidates.map((c) => [c.rank, c.symbol, c.action, c.total])).toEqual([
        [1, "AAA", "enter", 0.72],
        [2, "FFF", "skip", 0.58],
        [3, "GGG", "filtered", 0.2],
      ]);
      // latest FFF row wins, not the earlier 0.55 one
      expect(candidates[1]!.reason).toBe("composite 0.580 < 0.62");
      expect(candidates[1]!.lenses).toEqual(VALID_LENSES);
      expect(candidates.some((c) => c.mint === MINTS.openB)).toBe(false);
    });

    it("is empty before the first screen", () => {
      const fresh = new Ledger(":memory:");
      expect(buildCandidates(fresh)).toEqual({ screenedAt: null, candidates: [] });
      fresh.close();
    });
  });

  describe("buildNotes", () => {
    it("returns notes ascending", () => {
      const { notes } = buildNotes(ledger);
      expect(notes).toEqual([
        { ts: NOW - 72 * H, text: "initialised paper account with 1000 USD" },
        { ts: NOW - 72 * H + 1, text: "strategy config pinned: abcdef0123456789" },
      ]);
    });
  });

  describe("buildReportDto", () => {
    it("delegates to buildReport with live equity", () => {
      const r = buildReportDto(ledger, cfg, priceBook(SEED.prices, NOW), NOW);
      expect(r.generatedAt).toBe(NOW);
      expect(r.startingEquityUsd).toBe(1000);
      expect(r.equityUsd).toBeCloseTo(1052, 6);
      expect(r.cashUsd).toBe(820);
      expect(r.closedTrades).toBe(3);
      expect(r.openTrades).toBe(2);
      expect(r.wins).toBe(1);
      expect(r.losses).toBe(2);
      expect(r.exitReasons).toEqual({ "take profit 1": 1, "hard stop": 1, "time stop": 1 });
    });
  });

  describe("buildConfigDto", () => {
    it("returns the raw yaml, parsed config and hash for the given path", () => {
      const path = resolve("config/strategy.yaml");
      const dto = buildConfigDto(path);
      expect(dto.path).toBe(path);
      expect(dto.yaml).toBe(readFileSync(path, "utf8"));
      expect(dto.hash).toBe(strategyConfigHash(path));
      expect(dto.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(dto.parsed).toEqual(testConfig());
    });

    it("throws for a missing file so the server can answer 500", () => {
      expect(() => buildConfigDto("/nonexistent/strategy.yaml")).toThrow();
    });
  });
});
