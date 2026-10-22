import { beforeEach, describe, expect, it, vi } from "vitest";
import quoteFixture from "./fixtures/jupiter-quote.json" with { type: "json" };
import quoteErrorFixture from "./fixtures/jupiter-quote-error.json" with { type: "json" };
import priceFixture from "./fixtures/jupiter-price-v3.json" with { type: "json" };

const { getJsonMock } = vi.hoisted(() => ({ getJsonMock: vi.fn() }));

vi.mock("../src/core/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/http.js")>();
  return { ...actual, getJson: getJsonMock };
});

import { HttpError } from "../src/core/http.js";
import { WSOL_MINT } from "../src/core/config.js";
import {
  checkSellability,
  getPricesUsd,
  getQuote,
  getSolPriceUsd,
  normalizeQuote,
  usdToLamports,
} from "../src/data/jupiter.js";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const SOL_PRICE = priceFixture[WSOL_MINT].usdPrice;

function urlOf(call: unknown[]): URL {
  return new URL(String(call[0]));
}

beforeEach(() => {
  getJsonMock.mockReset();
});

describe("normalizeQuote", () => {
  it("parses the recorded WSOL->BONK quote with bigint amounts", () => {
    const q = normalizeQuote(quoteFixture, 1234);
    expect(q).not.toBeNull();
    expect(q!.inputMint).toBe(WSOL_MINT);
    expect(q!.outputMint).toBe(BONK);
    expect(q!.inAmount).toBe(100_000_000n);
    expect(q!.outAmount).toBe(BigInt(quoteFixture.outAmount));
    expect(typeof q!.outAmount).toBe("bigint");
    expect(q!.slippageBps).toBe(100);
    // priceImpactPct is a fraction string in the API, exposed as percent.
    expect(q!.priceImpactPct).toBeCloseTo(Number(quoteFixture.priceImpactPct) * 100, 10);
    expect(q!.routeLabels).toEqual(quoteFixture.routePlan.map((r) => r.swapInfo.label));
    expect(q!.fetchedAt).toBe(1234);
  });

  it("returns null for an error body or malformed input", () => {
    expect(normalizeQuote(quoteErrorFixture)).toBeNull();
    expect(normalizeQuote(null)).toBeNull();
    expect(normalizeQuote("nope")).toBeNull();
    expect(normalizeQuote({ ...quoteFixture, outAmount: "12.5" })).toBeNull();
    expect(normalizeQuote({ ...quoteFixture, inAmount: undefined })).toBeNull();
  });
});

describe("getQuote", () => {
  it("builds the quote URL and normalises the body", async () => {
    getJsonMock.mockResolvedValueOnce(quoteFixture);
    const q = await getQuote(WSOL_MINT, BONK, 100_000_000n, 100);
    expect(q?.outAmount).toBe(BigInt(quoteFixture.outAmount));
    const u = urlOf(getJsonMock.mock.calls[0]!);
    expect(u.origin + u.pathname).toBe("https://lite-api.jup.ag/swap/v1/quote");
    expect(u.searchParams.get("inputMint")).toBe(WSOL_MINT);
    expect(u.searchParams.get("outputMint")).toBe(BONK);
    expect(u.searchParams.get("amount")).toBe("100000000");
    expect(u.searchParams.get("slippageBps")).toBe("100");
  });

  it("returns null when Jupiter answers with an error body, a 4xx, or null", async () => {
    getJsonMock.mockResolvedValueOnce(quoteErrorFixture);
    expect(await getQuote(WSOL_MINT, "11111111111111111111111111111111", 1n)).toBeNull();
    getJsonMock.mockRejectedValueOnce(new HttpError(400, "u", JSON.stringify(quoteErrorFixture)));
    expect(await getQuote(WSOL_MINT, BONK, 1n)).toBeNull();
    getJsonMock.mockResolvedValueOnce(null);
    expect(await getQuote(WSOL_MINT, BONK, 1n)).toBeNull();
  });

  it("does not call the API for a non-positive amount", async () => {
    expect(await getQuote(WSOL_MINT, BONK, 0n)).toBeNull();
    expect(getJsonMock).not.toHaveBeenCalled();
  });
});

describe("getPricesUsd / getSolPriceUsd", () => {
  it("normalises the recorded price/v3 body", async () => {
    getJsonMock.mockResolvedValueOnce(priceFixture);
    const prices = await getPricesUsd([WSOL_MINT, BONK, BONK]);
    expect(Object.keys(prices).sort()).toEqual([BONK, WSOL_MINT].sort());
    expect(prices[WSOL_MINT]).toEqual({ usdPrice: SOL_PRICE, decimals: 9, liquidity: priceFixture[WSOL_MINT].liquidity });
    expect(prices[BONK]?.decimals).toBe(5);
    const u = urlOf(getJsonMock.mock.calls[0]!);
    expect(u.origin + u.pathname).toBe("https://lite-api.jup.ag/price/v3");
    // duplicates are collapsed
    expect(u.searchParams.get("ids")).toBe(`${WSOL_MINT},${BONK}`);
    const opts = getJsonMock.mock.calls[0]![1] as { cacheTtlMs: number };
    expect(opts.cacheTtlMs).toBe(20_000);
  });

  it("omits mints with no usable price", async () => {
    getJsonMock.mockResolvedValueOnce({ [BONK]: { usdPrice: null }, other: "junk" });
    expect(await getPricesUsd([BONK, "other"])).toEqual({});
  });

  it("returns the SOL price and throws when it is missing", async () => {
    getJsonMock.mockResolvedValueOnce(priceFixture);
    expect(await getSolPriceUsd()).toBe(SOL_PRICE);
    getJsonMock.mockResolvedValueOnce({});
    await expect(getSolPriceUsd()).rejects.toThrow(/SOL price/);
  });
});

describe("usdToLamports", () => {
  it("rounds to the nearest lamport using integer-safe math", () => {
    expect(usdToLamports(100, 100)).toBe(1_000_000_000n);
    expect(usdToLamports(1, 3)).toBe(333_333_333n);
    expect(usdToLamports(0, 100)).toBe(0n);
    expect(usdToLamports(100, 0)).toBe(0n);
  });
});

describe("checkSellability", () => {
  const lamportsIn = usdToLamports(100, SOL_PRICE);

  function routeFor(sellOutLamports: bigint | null) {
    getJsonMock.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/price/v3") return priceFixture;
      if (u.pathname !== "/swap/v1/quote") throw new Error(`unexpected url ${url}`);
      const inputMint = u.searchParams.get("inputMint");
      const amount = u.searchParams.get("amount");
      if (inputMint === WSOL_MINT) {
        expect(amount).toBe(lamportsIn.toString());
        return { ...quoteFixture, inAmount: amount, outAmount: quoteFixture.outAmount };
      }
      // sell leg: must sell exactly what the buy leg produced
      expect(inputMint).toBe(BONK);
      expect(amount).toBe(quoteFixture.outAmount);
      if (sellOutLamports === null) return quoteErrorFixture;
      return {
        inputMint: BONK,
        outputMint: WSOL_MINT,
        inAmount: amount,
        outAmount: sellOutLamports.toString(),
        priceImpactPct: "0.0025",
        slippageBps: 100,
        routePlan: [{ swapInfo: { label: "Whirlpool" }, percent: 100 }],
      };
    });
  }

  it("computes round-trip retention from raw lamports", async () => {
    routeFor((lamportsIn * 9_731n) / 10_000n); // 97.31% back
    const r = await checkSellability(BONK, 100);
    expect(r.mint).toBe(BONK);
    expect(r.routeFound).toBe(true);
    expect(r.roundTripRetentionPct).toBeCloseTo(97.31, 2);
    expect(r.buyPriceImpactPct).toBeCloseTo(Number(quoteFixture.priceImpactPct) * 100, 10);
    expect(r.sellPriceImpactPct).toBeCloseTo(0.25, 10);
    expect(getJsonMock).toHaveBeenCalledTimes(3);
  });

  it("reports no route when the sell leg fails", async () => {
    routeFor(null);
    const r = await checkSellability(BONK, 100);
    expect(r.routeFound).toBe(false);
    expect(r.roundTripRetentionPct).toBe(0);
    expect(r.sellPriceImpactPct).toBe(0);
  });

  it("reports no route when the buy leg fails", async () => {
    getJsonMock.mockImplementation(async (url: string) => {
      if (new URL(url).pathname === "/price/v3") return priceFixture;
      return quoteErrorFixture;
    });
    const r = await checkSellability(BONK, 100);
    expect(r).toMatchObject({ routeFound: false, roundTripRetentionPct: 0, buyPriceImpactPct: 0 });
    expect(getJsonMock).toHaveBeenCalledTimes(2);
  });
});
