import { describe, it, expect, vi } from "vitest";
import { PaperBroker, simulateFill, toRawAmount, FALLBACK_PRICE_IMPACT_PCT } from "../../src/execution/paper.js";
import { WSOL_MINT, type StrategyConfig } from "../../src/core/config.js";
import type { JupiterQuote, PairSnapshot } from "../../src/core/types.js";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const TS = 1_761_100_000_000;

const exec: StrategyConfig["execution"] = {
  paperFeePct: 0.3,
  paperExtraSlippagePct: 1.0,
  priorityFeeUsd: 0.05,
  quoteNotionalUsd: 100,
};

/** Only `execution` is read by the broker; the rest is a structural stub. */
const cfg = { execution: exec } as StrategyConfig;

function pair(priceUsd: number): PairSnapshot {
  return {
    pairAddress: "pair111",
    dexId: "raydium",
    chainId: "solana",
    mint: MINT,
    symbol: "BONK",
    name: "Bonk",
    quoteMint: WSOL_MINT,
    quoteSymbol: "SOL",
    priceUsd,
    priceNative: priceUsd / 200,
    liquidityUsd: 300_000,
    fdvUsd: null,
    marketCapUsd: null,
    volumeUsd: { m5: 0, h1: 0, h6: 0, h24: 0 },
    txns: {
      m5: { buys: 0, sells: 0 },
      h1: { buys: 0, sells: 0 },
      h6: { buys: 0, sells: 0 },
      h24: { buys: 0, sells: 0 },
    },
    priceChangePct: { m5: 0, h1: 0, h6: 0, h24: 0 },
    pairCreatedAt: null,
    boostsActive: 0,
    socials: [],
    websites: [],
    labels: [],
    fetchedAt: TS,
  };
}

function quote(input: string, output: string, inAmount: bigint, outAmount: bigint, impactFraction: number): JupiterQuote {
  return {
    inputMint: input,
    outputMint: output,
    inAmount,
    outAmount,
    priceImpactPct: impactFraction * 100, // the real client exposes percent, mirrors src/data/jupiter.ts
    slippageBps: 50,
    routeLabels: ["Raydium"],
    fetchedAt: TS,
  };
}

describe("simulateFill", () => {
  it("buy: price marked up by impact + slippage, explicit fee, qty from net notional", () => {
    const fill = simulateFill({
      side: "buy",
      mint: MINT,
      referencePriceUsd: 0.01,
      notionalUsd: 100,
      priceImpactPct: 0.5,
      exec,
      ts: TS,
    });
    // effective = 0.01 * (1 + 1.5/100)
    expect(fill.effectivePriceUsd).toBeCloseTo(0.01015, 12);
    // fee = 100 * 0.3% + 0.05
    expect(fill.feeUsd).toBeCloseTo(0.35, 12);
    // qty = (100 - 0.35) / 0.01015
    expect(fill.qtyTokens).toBeCloseTo(99.65 / 0.01015, 8);
    expect(fill.notionalUsd).toBe(100);
    expect(fill.referencePriceUsd).toBe(0.01);
    expect(fill.priceImpactPct).toBe(0.5);
    expect(fill.side).toBe("buy");
    expect(fill.mint).toBe(MINT);
    expect(fill.ts).toBe(TS);
    // cash out reconciles: qty * effective + fee == notional
    expect(fill.qtyTokens * fill.effectivePriceUsd + fill.feeUsd).toBeCloseTo(100, 9);
  });

  it("sell: price marked down by impact + slippage, fee on gross, net notional in", () => {
    const fill = simulateFill({
      side: "sell",
      mint: MINT,
      referencePriceUsd: 0.01,
      qtyTokens: 10_000,
      priceImpactPct: 0.5,
      exec,
      ts: TS,
    });
    // effective = 0.01 * (1 - 1.5/100)
    expect(fill.effectivePriceUsd).toBeCloseTo(0.00985, 12);
    const gross = 10_000 * 0.00985; // 98.5
    const fee = gross * 0.003 + 0.05; // 0.3455
    expect(fill.feeUsd).toBeCloseTo(fee, 12);
    expect(fill.notionalUsd).toBeCloseTo(gross - fee, 12);
    expect(fill.qtyTokens).toBe(10_000);
    expect(fill.referencePriceUsd).toBe(0.01);
    // cash in reconciles: qty * effective - fee == notional
    expect(fill.qtyTokens * fill.effectivePriceUsd - fill.feeUsd).toBeCloseTo(fill.notionalUsd, 9);
  });

  it("round trip at the same reference loses roughly 2 * (impact + slippage + fee) percent", () => {
    const impact = 0.5;
    const buy = simulateFill({
      side: "buy",
      mint: MINT,
      referencePriceUsd: 0.01,
      notionalUsd: 100,
      priceImpactPct: impact,
      exec,
      ts: TS,
    });
    const sell = simulateFill({
      side: "sell",
      mint: MINT,
      referencePriceUsd: 0.01,
      qtyTokens: buy.qtyTokens,
      priceImpactPct: impact,
      exec,
      ts: TS + 1,
    });
    const lossPct = ((buy.notionalUsd - sell.notionalUsd) / buy.notionalUsd) * 100;
    const expected = 2 * (impact + exec.paperExtraSlippagePct + exec.paperFeePct); // 3.6
    const priorityPct = (2 * exec.priorityFeeUsd) / 100 * 100; // 0.1 on a $100 trade
    expect(lossPct).toBeGreaterThan(expected - 0.2);
    expect(lossPct).toBeLessThan(expected + priorityPct + 0.2);
    expect(sell.notionalUsd).toBeLessThan(buy.notionalUsd);
  });

  it("floors the sell proceeds at zero and clamps negative impact to zero", () => {
    const dust = simulateFill({
      side: "sell",
      mint: MINT,
      referencePriceUsd: 0.000001,
      qtyTokens: 1,
      priceImpactPct: 0,
      exec,
      ts: TS,
    });
    expect(dust.notionalUsd).toBe(0);
    const neg = simulateFill({
      side: "buy",
      mint: MINT,
      referencePriceUsd: 1,
      notionalUsd: 10,
      priceImpactPct: -0.3,
      exec,
      ts: TS,
    });
    expect(neg.priceImpactPct).toBe(0);
    expect(neg.effectivePriceUsd).toBeCloseTo(1.01, 12);
  });

  it("rejects missing or non-positive sizes and prices", () => {
    expect(() => simulateFill({ side: "buy", mint: MINT, referencePriceUsd: 1, priceImpactPct: 0, exec, ts: TS })).toThrow();
    expect(() =>
      simulateFill({ side: "sell", mint: MINT, referencePriceUsd: 1, qtyTokens: 0, priceImpactPct: 0, exec, ts: TS }),
    ).toThrow();
    expect(() =>
      simulateFill({ side: "buy", mint: MINT, referencePriceUsd: 0, notionalUsd: 10, priceImpactPct: 0, exec, ts: TS }),
    ).toThrow();
  });
});

describe("toRawAmount", () => {
  it("converts 5 decimal token amounts exactly", () => {
    expect(toRawAmount(1.5, 5)).toBe(150_000n);
    expect(toRawAmount(3_700_000, 5)).toBe(370_000_000_000n);
    expect(toRawAmount(0.00001, 5)).toBe(1n);
    expect(toRawAmount(0.000001, 5)).toBe(0n);
    expect(toRawAmount(1.1, 5)).toBe(110_000n);
  });

  it("converts 9 decimal amounts (SOL lamports) exactly", () => {
    expect(toRawAmount(1.5, 9)).toBe(1_500_000_000n);
    expect(toRawAmount(0.4, 9)).toBe(400_000_000n);
    expect(toRawAmount(1.1, 9)).toBe(1_100_000_000n); // 1.1 * 1e9 is not exact in float math
    expect(toRawAmount(0.000001234, 9)).toBe(1_234n);
    expect(toRawAmount(123456.789012345, 9)).toBe(123_456_789_012_345n);
    expect(toRawAmount(0, 9)).toBe(0n);
  });

  it("rejects negative or non-finite amounts", () => {
    expect(() => toRawAmount(-1, 9)).toThrow();
    expect(() => toRawAmount(Number.NaN, 9)).toThrow();
    expect(() => toRawAmount(1, 1.5)).toThrow();
  });
});

describe("PaperBroker", () => {
  const solPrice = 200;

  it("buy: quotes WSOL -> mint with lamports for the notional and converts impact fraction to percent", async () => {
    const decimals = 5;
    const priceUsd = 0.01;
    const notional = 80;
    // 80 USD / 200 USD per SOL = 0.4 SOL = 400_000_000 lamports.
    // Quote returns tokens at exactly the DexScreener price so the implied price is not worse.
    const outTokens = notional / priceUsd; // 8000 tokens
    const getQuote = vi.fn(async (input: string, output: string, amount: bigint) => {
      return quote(input, output, amount, toRawAmount(outTokens, decimals), 0.0012);
    });
    const getSolPriceUsd = vi.fn(async () => solPrice);
    const broker = new PaperBroker(cfg, { getQuote, getSolPriceUsd });

    const fill = await broker.buy(pair(priceUsd), decimals, notional, TS);

    expect(getQuote).toHaveBeenCalledTimes(1);
    expect(getQuote.mock.calls[0]?.[0]).toBe(WSOL_MINT);
    expect(getQuote.mock.calls[0]?.[1]).toBe(MINT);
    expect(getQuote.mock.calls[0]?.[2]).toBe(400_000_000n);
    expect(fill.priceImpactPct).toBeCloseTo(0.12, 12);
    expect(fill.referencePriceUsd).toBe(priceUsd);
    // effective = 0.01 * (1 + (0.12 + 1.0)/100)
    expect(fill.effectivePriceUsd).toBeCloseTo(0.01 * 1.0112, 12);
    expect(fill.notionalUsd).toBe(notional);
    expect(fill.feeUsd).toBeCloseTo(80 * 0.003 + 0.05, 12);
    expect(fill.qtyTokens).toBeCloseTo((80 - fill.feeUsd) / fill.effectivePriceUsd, 8);
  });

  it("buy: uses the quote-implied price when it is worse than the pair price, but reports the pair price as reference", async () => {
    const decimals = 9;
    const priceUsd = 0.01;
    const notional = 80;
    // Quote gives only 7000 tokens for $80 => implied 0.011428 USD/token (worse than 0.01).
    const getQuote = vi.fn(async (input: string, output: string, amount: bigint) =>
      quote(input, output, amount, toRawAmount(7000, decimals), 0.001),
    );
    const broker = new PaperBroker(cfg, { getQuote, getSolPriceUsd: async () => solPrice });
    const fill = await broker.buy(pair(priceUsd), decimals, notional, TS);
    const implied = 80 / 7000;
    expect(fill.referencePriceUsd).toBe(priceUsd);
    expect(fill.effectivePriceUsd).toBeCloseTo(implied * (1 + (0.1 + 1.0) / 100), 12);
  });

  it("buy: falls back to 2% impact when there is no route", async () => {
    const getQuote = vi.fn(async () => null);
    const broker = new PaperBroker(cfg, { getQuote, getSolPriceUsd: async () => solPrice });
    const fill = await broker.buy(pair(0.01), 6, 80, TS);
    expect(getQuote).toHaveBeenCalledTimes(1);
    expect(fill.priceImpactPct).toBe(FALLBACK_PRICE_IMPACT_PCT);
    expect(fill.effectivePriceUsd).toBeCloseTo(0.01 * (1 + (2 + 1.0) / 100), 12);
    expect(fill.referencePriceUsd).toBe(0.01);
    expect(fill.notionalUsd).toBe(80);
  });

  it("buy: falls back when the quote or SOL price throws", async () => {
    const broker = new PaperBroker(cfg, {
      getQuote: async () => {
        throw new Error("network down");
      },
      getSolPriceUsd: async () => solPrice,
    });
    const fill = await broker.buy(pair(0.01), 6, 80, TS);
    expect(fill.priceImpactPct).toBe(FALLBACK_PRICE_IMPACT_PCT);

    const broker2 = new PaperBroker(cfg, {
      getQuote: vi.fn(async () => null),
      getSolPriceUsd: async () => {
        throw new Error("price down");
      },
    });
    const fill2 = await broker2.buy(pair(0.01), 6, 80, TS);
    expect(fill2.priceImpactPct).toBe(FALLBACK_PRICE_IMPACT_PCT);
  });

  it("sell: quotes mint -> WSOL with the raw token amount for 9 decimals", async () => {
    const decimals = 9;
    const priceUsd = 0.01;
    const qty = 1234.5678;
    // 1234.5678 tokens * $0.01 = $12.345678 = 0.06172839 SOL at $200/SOL.
    const outSol = (qty * priceUsd) / solPrice;
    const getQuote = vi.fn(async (input: string, output: string, amount: bigint) =>
      quote(input, output, amount, toRawAmount(outSol, 9), 0.0025),
    );
    const broker = new PaperBroker(cfg, { getQuote, getSolPriceUsd: async () => solPrice });
    const fill = await broker.sell(pair(priceUsd), decimals, qty, TS);

    expect(getQuote.mock.calls[0]?.[0]).toBe(MINT);
    expect(getQuote.mock.calls[0]?.[1]).toBe(WSOL_MINT);
    expect(getQuote.mock.calls[0]?.[2]).toBe(1_234_567_800_000n);
    expect(fill.priceImpactPct).toBeCloseTo(0.25, 12);
    expect(fill.referencePriceUsd).toBe(priceUsd);
    // Implied price equals pair price (within lamport rounding), so effective = 0.01 * (1 - 1.25/100).
    expect(fill.effectivePriceUsd).toBeCloseTo(0.01 * (1 - 0.0125), 9);
    expect(fill.qtyTokens).toBe(qty);
    const gross = fill.qtyTokens * fill.effectivePriceUsd;
    expect(fill.feeUsd).toBeCloseTo(gross * 0.003 + 0.05, 12);
    expect(fill.notionalUsd).toBeCloseTo(gross - fill.feeUsd, 12);
  });

  it("sell: quotes with the raw amount for 5 decimals and uses the implied price when it is lower", async () => {
    const decimals = 5;
    const priceUsd = 0.01;
    const qty = 8000;
    // Quote pays only 0.36 SOL ($72) for 8000 tokens => implied $0.009 (worse than $0.01).
    const getQuote = vi.fn(async (input: string, output: string, amount: bigint) =>
      quote(input, output, amount, 360_000_000n, 0.002),
    );
    const broker = new PaperBroker(cfg, { getQuote, getSolPriceUsd: async () => solPrice });
    const fill = await broker.sell(pair(priceUsd), decimals, qty, TS);
    expect(getQuote.mock.calls[0]?.[2]).toBe(800_000_000n);
    expect(fill.referencePriceUsd).toBe(priceUsd);
    expect(fill.effectivePriceUsd).toBeCloseTo(0.009 * (1 - (0.2 + 1.0) / 100), 12);
  });

  it("sell: falls back to 2% impact when there is no route", async () => {
    const broker = new PaperBroker(cfg, { getQuote: async () => null, getSolPriceUsd: async () => solPrice });
    const fill = await broker.sell(pair(0.01), 6, 1000, TS);
    expect(fill.priceImpactPct).toBe(FALLBACK_PRICE_IMPACT_PCT);
    expect(fill.effectivePriceUsd).toBeCloseTo(0.01 * (1 - 0.03), 12);
    expect(fill.referencePriceUsd).toBe(0.01);
  });

  it("buy then sell through the broker at the same price reconciles to a small round-trip loss", async () => {
    const decimals = 6;
    const priceUsd = 0.02;
    const impact = 0.004; // 0.4%
    const getQuote = vi.fn(async (input: string, output: string, amount: bigint) => {
      if (input === WSOL_MINT) {
        const usdIn = (Number(amount) / 1e9) * solPrice;
        return quote(input, output, amount, toRawAmount(usdIn / priceUsd, decimals), impact);
      }
      const tokensIn = Number(amount) / 10 ** decimals;
      return quote(input, output, amount, toRawAmount((tokensIn * priceUsd) / solPrice, 9), impact);
    });
    const broker = new PaperBroker(cfg, { getQuote, getSolPriceUsd: async () => solPrice });
    const buy = await broker.buy(pair(priceUsd), decimals, 100, TS);
    const sell = await broker.sell(pair(priceUsd), decimals, buy.qtyTokens, TS + 1);
    const lossPct = ((buy.notionalUsd - sell.notionalUsd) / buy.notionalUsd) * 100;
    const expected = 2 * (0.4 + exec.paperExtraSlippagePct + exec.paperFeePct); // 3.4
    expect(lossPct).toBeGreaterThan(expected - 0.2);
    expect(lossPct).toBeLessThan(expected + 0.3);
  });

  it("rejects invalid sizes and pair prices", async () => {
    const broker = new PaperBroker(cfg, { getQuote: async () => null, getSolPriceUsd: async () => solPrice });
    await expect(broker.buy(pair(0.01), 6, 0, TS)).rejects.toThrow();
    await expect(broker.sell(pair(0.01), 6, -1, TS)).rejects.toThrow();
    await expect(broker.buy(pair(0), 6, 10, TS)).rejects.toThrow();
  });
});
