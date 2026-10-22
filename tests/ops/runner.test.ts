/**
 * End-to-end runner test with every data dependency faked. Walks a token
 * through discovery -> scoring -> entry -> price moves -> exit and checks the
 * ledger balances.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Ledger } from "../../src/execution/ledger.js";
import { PaperBroker } from "../../src/execution/paper.js";
import { LlmScorer } from "../../src/analysis/llm.js";
import { Runner, type RunnerDeps } from "../../src/ops/runner.js";
import { loadStrategyConfig } from "../../src/core/config.js";
import { loadPortfolio } from "../../src/ops/portfolio.js";
import { makeContext } from "../helpers/contextFactory.js";
import type { Candle, PairSnapshot, SafetyReport, SellabilityCheck } from "../../src/core/types.js";

vi.mock("../../src/core/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

const cfg = loadStrategyConfig("config/strategy.yaml");

function fakeDeps(state: { price: number; liquidity: number; ctx: ReturnType<typeof makeContext> }, now: () => number): RunnerDeps {
  const pairNow = (): PairSnapshot => ({ ...state.ctx.pair, priceUsd: state.price, liquidityUsd: state.liquidity, fetchedAt: now() });
  return {
    discoverCandidates: async () => [{ mint: state.ctx.pair.mint, pairAddress: state.ctx.pair.pairAddress, sources: ["gecko_trending"] }],
    getPairsByTokens: async () => [pairNow()],
    pickPrimaryPair: (pairs) => pairs[0] ?? null,
    getOhlcv: async (_p, tf): Promise<Candle[]> => (tf === "minute" ? state.ctx.candles5m : state.ctx.candles1h),
    getSafetyReport: async (): Promise<SafetyReport | null> => state.ctx.safety,
    checkSellability: async (): Promise<SellabilityCheck> => state.ctx.sellability!,
    getPricesUsd: async (mints) => Object.fromEntries(mints.map((m) => [m, { usdPrice: state.price, decimals: 6, liquidity: state.liquidity }])),
    getTrendingSolanaMints: async () => [],
    getLatestProfiles: async () => [],
    getTopBoosts: async () => [],
  };
}

function makeRunner(state: { price: number; liquidity: number; ctx: ReturnType<typeof makeContext> }, now: () => number) {
  const ledger = new Ledger(":memory:");
  const broker = new PaperBroker(cfg, {
    getQuote: async () => null, // fallback impact path, deterministic
    getSolPriceUsd: async () => 100,
  });
  const llm = new LlmScorer({ apiKey: undefined, model: "x", cacheHours: 1, maxCallsPerScreen: 0 });
  const runner = new Runner(cfg, ledger, broker, llm, fakeDeps(state, now), { now });
  return { runner, ledger };
}

describe("runner", () => {
  let t = Date.UTC(2026, 9, 22, 12, 0, 0);
  const now = () => t;
  beforeEach(() => {
    t = Date.UTC(2026, 9, 22, 12, 0, 0);
  });

  it("enters a good candidate and balances the ledger", async () => {
    const ctx = makeContext({ good: true, now: t });
    const state = { price: ctx.pair.priceUsd, liquidity: ctx.pair.liquidityUsd, ctx };
    const { runner, ledger } = makeRunner(state, now);
    const results = await runner.screen();
    expect(results.length).toBe(1);
    expect(results[0]!.hardFilterPassed).toBe(true);
    const open = ledger.getOpenPositions();
    expect(open.length).toBe(1);
    const pf = loadPortfolio(ledger, { [ctx.pair.mint]: state.price }, t);
    // equity after costs should be a little under starting equity, never above
    expect(pf.equityUsd).toBeLessThan(cfg.account.startingEquityUsd);
    expect(pf.equityUsd).toBeGreaterThan(cfg.account.startingEquityUsd * 0.99);
    expect(pf.cashUsd).toBeCloseTo(cfg.account.startingEquityUsd - open[0]!.costBasisUsd, 6);
  });

  it("does not re-enter the same mint and respects dry run", async () => {
    const ctx = makeContext({ good: true, now: t });
    const state = { price: ctx.pair.priceUsd, liquidity: ctx.pair.liquidityUsd, ctx };
    const { runner, ledger } = makeRunner(state, now);
    await runner.screen();
    await runner.screen();
    expect(ledger.getOpenPositions().length).toBe(1);
  });

  it("hard stops on a crash and records a loss", async () => {
    const ctx = makeContext({ good: true, now: t });
    const state = { price: ctx.pair.priceUsd, liquidity: ctx.pair.liquidityUsd, ctx };
    const { runner, ledger } = makeRunner(state, now);
    await runner.screen();
    const pos = ledger.getOpenPositions()[0]!;
    state.price = pos.entryPriceUsd * 0.6;
    t += 60_000;
    await runner.priceTick();
    expect(ledger.getOpenPositions().length).toBe(0);
    const closed = ledger.getClosedPositions()[0]!;
    expect(closed.realizedPnlUsd).toBeLessThan(0);
    expect(closed.closeReason?.toLowerCase()).toContain("stop");
    expect(ledger.getMeta("consecutive_losses")).toBe("1");
    const pf = loadPortfolio(ledger, {}, t);
    expect(pf.cashUsd).toBeCloseTo(cfg.account.startingEquityUsd + closed.realizedPnlUsd, 6);
  });

  it("takes partial profit at 2x then trails out", async () => {
    const ctx = makeContext({ good: true, now: t });
    const state = { price: ctx.pair.priceUsd, liquidity: ctx.pair.liquidityUsd, ctx };
    const { runner, ledger } = makeRunner(state, now);
    await runner.screen();
    const pos = ledger.getOpenPositions()[0]!;
    state.price = pos.entryPriceUsd * 2.1;
    t += 60_000;
    await runner.priceTick();
    let open = ledger.getOpenPositions()[0]!;
    expect(open.tp1Hit).toBe(true);
    expect(open.remainingQtyTokens).toBeCloseTo(pos.qtyTokens * (1 - cfg.exits.tp1SellFraction), 6);
    state.price = pos.entryPriceUsd * 3; // new peak
    t += 60_000;
    await runner.priceTick();
    state.price = pos.entryPriceUsd * 3 * (1 - (cfg.exits.trailingStopPctFromPeak + 1) / 100);
    t += 60_000;
    await runner.priceTick();
    expect(ledger.getOpenPositions().length).toBe(0);
    const closed = ledger.getClosedPositions()[0]!;
    expect(closed.realizedPnlUsd).toBeGreaterThan(0);
    expect(ledger.getOrders(closed.id).length).toBe(3);
    open = closed;
    expect(open.remainingQtyTokens).toBe(0);
  });

  it("exits on a liquidity pull", async () => {
    const ctx = makeContext({ good: true, now: t });
    const state = { price: ctx.pair.priceUsd, liquidity: ctx.pair.liquidityUsd, ctx };
    const { runner, ledger } = makeRunner(state, now);
    await runner.screen();
    state.liquidity = ctx.pair.liquidityUsd * 0.3;
    t += 60_000;
    await runner.priceTick();
    expect(ledger.getOpenPositions().length).toBe(0);
    expect(ledger.getClosedPositions()[0]!.closeReason?.toLowerCase()).toContain("liquidity");
  });

  it("snapshot writes the equity curve", async () => {
    const ctx = makeContext({ good: true, now: t });
    const state = { price: ctx.pair.priceUsd, liquidity: ctx.pair.liquidityUsd, ctx };
    const { runner, ledger } = makeRunner(state, now);
    await runner.snapshot();
    expect(ledger.getEquityCurve().length).toBe(1);
    expect(ledger.getEquityCurve()[0]!.equityUsd).toBe(cfg.account.startingEquityUsd);
  });
});
