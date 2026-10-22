import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/data/dexscreener.js", () => ({
  getTopBoosts: vi.fn(),
  getLatestProfiles: vi.fn(),
}));
vi.mock("../src/data/geckoterminal.js", () => ({
  getTrendingPools: vi.fn(),
  getNewPools: vi.fn(),
}));

import { getTopBoosts, getLatestProfiles } from "../src/data/dexscreener.js";
import { getTrendingPools, getNewPools } from "../src/data/geckoterminal.js";
import { discoverCandidates } from "../src/data/discovery.js";

const boosts = vi.mocked(getTopBoosts);
const profiles = vi.mocked(getLatestProfiles);
const trending = vi.mocked(getTrendingPools);
const newPools = vi.mocked(getNewPools);

// Real-looking base58 mints so isValidMint passes.
const M1 = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const M2 = "CSocnzcRpgSCr1naKcNTieWZUxb6rABe45j844m7pump";
const M3 = "Cbkg5w7V7W2J2sUmecnyN825CbvwvXwasfhduVtNpump";
const M4 = "nxPqZ4F7ux8Vph5NFu25rEP6Kx9Gr1U6Fmj36Rjpump";
const P1 = "6DNxwecbtdNNstpB5tdnxZsfGe3HmsNgEUZhdue4b1PH";
const P2 = "YQ4NNeQxHAtdcB8ohx21eJ9U8eTzxNRvGNHkRaA4Pnw";

beforeEach(() => {
  boosts.mockReset();
  profiles.mockReset();
  trending.mockReset();
  newPools.mockReset();
});

describe("discoverCandidates", () => {
  it("unions all four sources and dedupes by mint, merging sources and pairAddress", async () => {
    boosts.mockResolvedValue([
      { mint: M1, totalAmount: 500 },
      { mint: M2, totalAmount: 100 },
    ]);
    profiles.mockResolvedValue([
      { mint: M2, description: "x" },
      { mint: M3, description: null },
    ]);
    trending.mockResolvedValue([
      { pairAddress: P1, mint: M2, rank: 1 },
      { pairAddress: P2, mint: M4, rank: 2 },
    ]);
    newPools.mockResolvedValue([{ pairAddress: P2, mint: M4, createdAt: 1 }]);

    const out = await discoverCandidates();
    expect(out.map((c) => c.mint)).toEqual([M1, M2, M3, M4]);
    const byMint = Object.fromEntries(out.map((c) => [c.mint, c]));
    expect(byMint[M1]).toEqual({ mint: M1, pairAddress: null, sources: ["dex_boost"] });
    expect(byMint[M2]).toEqual({ mint: M2, pairAddress: P1, sources: ["dex_boost", "dex_profile", "gecko_trending"] });
    expect(byMint[M3]).toEqual({ mint: M3, pairAddress: null, sources: ["dex_profile"] });
    expect(byMint[M4]).toEqual({ mint: M4, pairAddress: P2, sources: ["gecko_trending", "gecko_new"] });
    expect(boosts).toHaveBeenCalledTimes(1);
    expect(profiles).toHaveBeenCalledTimes(1);
    expect(trending).toHaveBeenCalledTimes(1);
    expect(newPools).toHaveBeenCalledTimes(1);
  });

  it("survives any one source throwing and keeps the rest", async () => {
    boosts.mockRejectedValue(new Error("429 boom"));
    profiles.mockResolvedValue([{ mint: M1, description: null }]);
    trending.mockRejectedValue(new Error("gecko down"));
    newPools.mockResolvedValue([{ pairAddress: P1, mint: M2, createdAt: 1 }]);

    const out = await discoverCandidates();
    expect(out).toEqual([
      { mint: M1, pairAddress: null, sources: ["dex_profile"] },
      { mint: M2, pairAddress: P1, sources: ["gecko_new"] },
    ]);
  });

  it("returns [] when every source fails", async () => {
    boosts.mockRejectedValue(new Error("a"));
    profiles.mockRejectedValue(new Error("b"));
    trending.mockRejectedValue(new Error("c"));
    newPools.mockRejectedValue(new Error("d"));
    await expect(discoverCandidates()).resolves.toEqual([]);
  });

  it("drops entries whose mint is not a valid base58 address", async () => {
    boosts.mockResolvedValue([{ mint: "0xdeadbeef", totalAmount: 1 }, { mint: "", totalAmount: 1 }, { mint: M1, totalAmount: 1 }]);
    profiles.mockResolvedValue([]);
    trending.mockResolvedValue([]);
    newPools.mockResolvedValue([]);
    const out = await discoverCandidates();
    expect(out).toEqual([{ mint: M1, pairAddress: null, sources: ["dex_boost"] }]);
  });
});
