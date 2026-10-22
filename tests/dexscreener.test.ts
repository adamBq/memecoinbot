import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import type { PairSnapshot } from "../src/core/types.js";

vi.mock("../src/core/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/http.js")>();
  return { ...actual, getJson: vi.fn() };
});

import { getJson } from "../src/core/http.js";
import {
  normalizePair,
  pickPrimaryPair,
  getPairsByTokens,
  getPairByAddress,
  getTopBoosts,
  getLatestProfiles,
  searchPairs,
  WSOL_MINT,
  USDC_MINT,
} from "../src/data/dexscreener.js";

const mockedGetJson = vi.mocked(getJson);

function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

type RawPair = Record<string, unknown>;
const search = fixture<{ schemaVersion: string; pairs: RawPair[] }>("dexscreener_search.json");
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

beforeEach(() => {
  mockedGetJson.mockReset();
});

describe("normalizePair", () => {
  it("normalises a live solana pair from the search fixture", () => {
    const raw = search.pairs[0]!;
    const p = normalizePair(raw);
    expect(p).not.toBeNull();
    const snap = p as PairSnapshot;
    expect(snap.chainId).toBe("solana");
    expect(snap.pairAddress).toBe(raw.pairAddress);
    expect(snap.mint).toBe(BONK);
    expect(snap.symbol).toBe("Bonk");
    expect(snap.quoteMint).toBe(WSOL_MINT);
    expect(snap.priceUsd).toBeCloseTo(Number(raw.priceUsd), 12);
    expect(snap.priceNative).toBeCloseTo(Number(raw.priceNative), 12);
    expect(snap.liquidityUsd).toBe((raw.liquidity as { usd: number }).usd);
    expect(snap.fdvUsd).toBe(raw.fdv);
    expect(snap.marketCapUsd).toBe(raw.marketCap);
    expect(snap.pairCreatedAt).toBe(raw.pairCreatedAt);
    expect(snap.volumeUsd.h24).toBe((raw.volume as { h24: number }).h24);
    expect(snap.txns.h1).toEqual((raw.txns as { h1: unknown }).h1);
    expect(snap.priceChangePct.h6).toBe((raw.priceChange as { h6: number }).h6);
    expect(snap.labels).toEqual(raw.labels);
    expect(snap.boostsActive).toBe(0);
    expect(snap.websites.length).toBeGreaterThan(0);
    expect(snap.socials.length).toBeGreaterThan(0);
    for (const s of snap.socials) {
      expect(typeof s.type).toBe("string");
      expect(s.url).toMatch(/^https?:\/\//);
    }
    expect(snap.fetchedAt).toBeGreaterThan(0);
  });

  it("returns null for a non-solana pair", () => {
    const base = search.pairs.find((p) => p.chainId !== "solana");
    expect(base).toBeDefined();
    expect(normalizePair(base)).toBeNull();
  });

  it("returns null when priceUsd is absent (dead pair)", () => {
    const dead: RawPair = { ...search.pairs[0]! };
    delete dead.priceUsd;
    expect(normalizePair(dead)).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(normalizePair(null)).toBeNull();
    expect(normalizePair("x")).toBeNull();
    expect(normalizePair({})).toBeNull();
    expect(normalizePair({ chainId: "solana" })).toBeNull();
    expect(normalizePair({ chainId: "solana", pairAddress: "abc", priceUsd: "1" })).toBeNull();
  });

  it("fills defensive defaults for missing optional fields", () => {
    const p = normalizePair({
      chainId: "solana",
      pairAddress: "pair1",
      baseToken: { address: BONK },
      priceUsd: "0.5",
    }) as PairSnapshot;
    expect(p).not.toBeNull();
    expect(p.dexId).toBe("unknown");
    expect(p.symbol).toBe("");
    expect(p.quoteMint).toBe("");
    expect(p.priceNative).toBe(0);
    expect(p.liquidityUsd).toBe(0);
    expect(p.fdvUsd).toBeNull();
    expect(p.marketCapUsd).toBeNull();
    expect(p.pairCreatedAt).toBeNull();
    expect(p.volumeUsd).toEqual({ m5: 0, h1: 0, h6: 0, h24: 0 });
    expect(p.txns.m5).toEqual({ buys: 0, sells: 0 });
    expect(p.socials).toEqual([]);
    expect(p.websites).toEqual([]);
    expect(p.labels).toEqual([]);
  });

  it("reads boosts.active when present", () => {
    const p = normalizePair({ ...search.pairs[0]!, boosts: { active: 30 } }) as PairSnapshot;
    expect(p.boostsActive).toBe(30);
  });
});

describe("pickPrimaryPair", () => {
  const solana = search.pairs.map(normalizePair).filter((p): p is PairSnapshot => p !== null);

  it("returns null on empty input", () => {
    expect(pickPrimaryPair([])).toBeNull();
  });

  it("prefers the highest-liquidity WSOL/USDC pair from the fixture", () => {
    const best = pickPrimaryPair(solana)!;
    expect([WSOL_MINT, USDC_MINT]).toContain(best.quoteMint);
    const preferred = solana.filter((p) => p.quoteMint === WSOL_MINT || p.quoteMint === USDC_MINT);
    expect(best.liquidityUsd).toBe(Math.max(...preferred.map((p) => p.liquidityUsd)));
  });

  it("prefers a lower-liquidity WSOL pair over a higher-liquidity exotic quote", () => {
    const wsol = { ...solana[0]!, quoteMint: WSOL_MINT, liquidityUsd: 100, pairAddress: "a" };
    const exotic = { ...solana[0]!, quoteMint: "SomeOtherMint", liquidityUsd: 10_000, pairAddress: "b" };
    expect(pickPrimaryPair([exotic, wsol])!.pairAddress).toBe("a");
  });

  it("falls back to highest liquidity when no preferred quote exists", () => {
    const a = { ...solana[0]!, quoteMint: "X", liquidityUsd: 5, pairAddress: "a" };
    const b = { ...solana[0]!, quoteMint: "Y", liquidityUsd: 50, pairAddress: "b" };
    expect(pickPrimaryPair([a, b])!.pairAddress).toBe("b");
  });
});

describe("getPairsByTokens", () => {
  it("parses the bare array from /tokens/v1/solana and batches 30 mints per call", async () => {
    mockedGetJson.mockResolvedValue(fixture("dexscreener_tokens.json"));
    const mints = Array.from({ length: 31 }, (_, i) => `mint${i}`);
    const pairs = await getPairsByTokens(mints);
    expect(mockedGetJson).toHaveBeenCalledTimes(2);
    const firstUrl = mockedGetJson.mock.calls[0]![0];
    expect(firstUrl).toMatch(/^https:\/\/api\.dexscreener\.com\/tokens\/v1\/solana\//);
    expect(firstUrl.split("/").pop()!.split(",")).toHaveLength(30);
    expect(mockedGetJson.mock.calls[1]![0].split("/").pop()!.split(",")).toHaveLength(1);
    expect(pairs).toHaveLength(4);
    expect(pairs[0]!.mint).toBe(BONK);
    const opts = mockedGetJson.mock.calls[0]![1]!;
    expect(opts.cacheTtlMs).toBe(30_000);
    expect(opts.cache).toBeDefined();
    expect(opts.limiter).toBeDefined();
  });

  it("dedupes mints and returns [] for empty input without calling the network", async () => {
    expect(await getPairsByTokens([])).toEqual([]);
    expect(mockedGetJson).not.toHaveBeenCalled();
    mockedGetJson.mockResolvedValue([]);
    await getPairsByTokens([BONK, BONK]);
    expect(mockedGetJson).toHaveBeenCalledTimes(1);
    expect(mockedGetJson.mock.calls[0]![0].endsWith(`/${BONK}`)).toBe(true);
  });

  it("tolerates a null response", async () => {
    mockedGetJson.mockResolvedValue(null);
    expect(await getPairsByTokens([BONK])).toEqual([]);
  });
});

describe("getPairByAddress", () => {
  it("normalises the pair object from /latest/dex/pairs/solana/{addr}", async () => {
    mockedGetJson.mockResolvedValue(fixture("dexscreener_pair.json"));
    const p = await getPairByAddress("5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9");
    expect(mockedGetJson.mock.calls[0]![0]).toBe(
      "https://api.dexscreener.com/latest/dex/pairs/solana/5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9",
    );
    expect(p?.pairAddress).toBe("5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9");
    expect(p?.mint).toBe(BONK);
  });

  it("falls back to pairs[0] when pair is absent and null when nothing matches", async () => {
    const fx = fixture<{ pairs: unknown[]; pair: unknown }>("dexscreener_pair.json");
    mockedGetJson.mockResolvedValueOnce({ pairs: fx.pairs, pair: null });
    expect((await getPairByAddress("x"))?.mint).toBe(BONK);
    mockedGetJson.mockResolvedValueOnce({ pairs: null, pair: null });
    expect(await getPairByAddress("x")).toBeNull();
    mockedGetJson.mockResolvedValueOnce(null);
    expect(await getPairByAddress("x")).toBeNull();
  });
});

describe("getTopBoosts", () => {
  it("filters to solana and reads totalAmount", async () => {
    mockedGetJson.mockResolvedValue(fixture("dexscreener_boosts.json"));
    const boosts = await getTopBoosts();
    expect(mockedGetJson.mock.calls[0]![0]).toBe("https://api.dexscreener.com/token-boosts/top/v1");
    expect(boosts).toHaveLength(4);
    for (const b of boosts) {
      expect(b.mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(b.totalAmount).toBe(500);
    }
  });

  it("uses the dedicated boosts limiter rather than the pairs limiter", async () => {
    mockedGetJson.mockResolvedValue(fixture("dexscreener_boosts.json"));
    await getTopBoosts();
    const boostLimiter = mockedGetJson.mock.calls[0]![1]!.limiter;
    mockedGetJson.mockResolvedValue(fixture("dexscreener_tokens.json"));
    await getPairsByTokens([BONK]);
    const pairLimiter = mockedGetJson.mock.calls[1]![1]!.limiter;
    expect(boostLimiter).toBeDefined();
    expect(pairLimiter).toBeDefined();
    expect(boostLimiter).not.toBe(pairLimiter);
  });

  it("falls back to amount and 0, and tolerates null", async () => {
    mockedGetJson.mockResolvedValueOnce([
      { chainId: "solana", tokenAddress: "A", amount: 25 },
      { chainId: "solana", tokenAddress: "B" },
      { chainId: "solana" },
    ]);
    expect(await getTopBoosts()).toEqual([
      { mint: "A", totalAmount: 25 },
      { mint: "B", totalAmount: 0 },
    ]);
    mockedGetJson.mockResolvedValueOnce(null);
    expect(await getTopBoosts()).toEqual([]);
  });
});

describe("getLatestProfiles", () => {
  it("filters to solana and returns null description when absent", async () => {
    mockedGetJson.mockResolvedValue(fixture("dexscreener_profiles.json"));
    const profiles = await getLatestProfiles();
    expect(mockedGetJson.mock.calls[0]![0]).toBe("https://api.dexscreener.com/token-profiles/latest/v1");
    expect(profiles).toHaveLength(4);
    expect(profiles.filter((p) => p.description === null)).toHaveLength(1);
    expect(profiles.filter((p) => typeof p.description === "string")).toHaveLength(3);
  });
});

describe("searchPairs", () => {
  it("returns only solana pairs from the search envelope and encodes the query", async () => {
    mockedGetJson.mockResolvedValue(search);
    const pairs = await searchPairs("BONK & co");
    expect(mockedGetJson.mock.calls[0]![0]).toBe("https://api.dexscreener.com/latest/dex/search?q=BONK%20%26%20co");
    expect(pairs.length).toBe(search.pairs.filter((p) => p.chainId === "solana").length);
    expect(pairs.every((p) => p.chainId === "solana")).toBe(true);
  });

  it("returns [] on null", async () => {
    mockedGetJson.mockResolvedValue(null);
    expect(await searchPairs("x")).toEqual([]);
  });
});
