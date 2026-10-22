import { beforeEach, describe, expect, it, vi } from "vitest";
import bonkFixture from "./fixtures/rugcheck-report-bonk.json" with { type: "json" };
import pumpFixture from "./fixtures/rugcheck-report-pump.json" with { type: "json" };

const { getJsonMock } = vi.hoisted(() => ({ getJsonMock: vi.fn() }));

vi.mock("../src/core/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/http.js")>();
  return { ...actual, getJson: getJsonMock };
});

import { HttpError } from "../src/core/http.js";
import { getSafetyReport, normalizeRugcheckReport } from "../src/data/rugcheck.js";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const PUMP = "CSocnzcRpgSCr1naKcNTieWZUxb6rABe45j844m7pump";

const sumPct = (holders: Array<{ pct: number }>) => holders.reduce((s, h) => s + h.pct, 0);

beforeEach(() => {
  getJsonMock.mockReset();
});

describe("normalizeRugcheckReport", () => {
  it("normalises the recorded BONK report", () => {
    const r = normalizeRugcheckReport(bonkFixture, BONK);
    expect(r.mint).toBe(BONK);
    expect(r.mintAuthorityRevoked).toBe(true);
    expect(r.freezeAuthorityRevoked).toBe(true);
    expect(r.rugged).toBe(false);
    expect(r.totalHolders).toBe(bonkFixture.totalHolders);
    expect(r.rugcheckScoreNormalised).toBe(bonkFixture.score_normalised);
    expect(r.transferFeePct).toBe(0);
    expect(r.metadataMutable).toBe(true);
    expect(r.launchpad).toBeNull();
    expect(r.creator).toBe(bonkFixture.creator);
    expect(r.risks).toEqual([
      { name: "Mutable metadata", level: "warn", description: "Token metadata can be changed by the owner" },
    ]);
    // Fixture keeps one raydium_cpmm market at 100% locked; highest across markets wins.
    expect(r.lpLockedPct).toBe(100);
    // None of BONK's top holders are pool accounts, so the sums are straight from the list.
    const sorted = [...bonkFixture.topHolders].sort((a, b) => b.pct - a.pct);
    expect(r.largestHolderPct).toBeCloseTo(sorted[0]!.pct, 10);
    expect(r.top10HolderPct).toBeCloseTo(sumPct(sorted.slice(0, 10)), 10);
    expect(r.top10HolderPct).toBeLessThan(45);
    expect(r.fetchedAt).toBeGreaterThan(0);
  });

  it("excludes pool, AMM and LP accounts from holder concentration on the pump.fun report", () => {
    const r = normalizeRugcheckReport(pumpFixture, PUMP);
    const marketKeys = new Set(pumpFixture.markets.map((m) => m.pubkey));
    const known = pumpFixture.knownAccounts as Record<string, { name: string; type: string }>;
    const poolRe = /amm|pool|lp|raydium|orca|meteora|pump|locker|vault/i;
    const isPool = (h: { address: string; owner: string }) =>
      marketKeys.has(h.address) ||
      marketKeys.has(h.owner) ||
      [known[h.address], known[h.owner]].some((k) => k && (poolRe.test(k.type) || poolRe.test(k.name)));

    const excluded = pumpFixture.topHolders.filter(isPool);
    const real = pumpFixture.topHolders.filter((h) => !isPool(h)).sort((a, b) => b.pct - a.pct);
    // The fixture really does contain pool-owned holder accounts (pump_fun_amm vault and Meteora DLMM pools).
    expect(excluded.length).toBeGreaterThanOrEqual(3);
    expect(excluded.map((h) => h.owner)).toContain("6DNxwecbtdNNstpB5tdnxZsfGe3HmsNgEUZhdue4b1PH");

    expect(r.largestHolderPct).toBeCloseTo(real[0]!.pct, 10);
    expect(r.top10HolderPct).toBeCloseTo(sumPct(real.slice(0, 10)), 10);
    expect(r.top10HolderPct).toBeLessThan(sumPct(pumpFixture.topHolders.slice(0, 10)));

    expect(r.launchpad).toBe("Pump.Fun");
    expect(r.lpLockedPct).toBe(100); // pump_fun_amm market counts as fully locked
    expect(r.mintAuthorityRevoked).toBe(true);
    expect(r.freezeAuthorityRevoked).toBe(true);
    expect(r.metadataMutable).toBe(false);
    expect(r.risks.map((x) => x.level)).toEqual(["danger", "danger"]);
    expect(r.rugcheckScoreNormalised).toBe(pumpFixture.score_normalised);
  });

  it("treats a pump_fun_amm market as 100% locked even when lp says otherwise", () => {
    const raw = { markets: [{ pubkey: "x", marketType: "pump_fun_amm", lp: { lpLockedPct: 0 } }] };
    expect(normalizeRugcheckReport(raw, PUMP).lpLockedPct).toBe(100);
    const raw2 = { markets: [{ pubkey: "x", marketType: "raydium", lp: { lpLockedPct: 42.5 } }, { marketType: "orca", lp: {} }] };
    expect(normalizeRugcheckReport(raw2, PUMP).lpLockedPct).toBe(42.5);
  });

  it("excludes holders held by lockers and market liquidity accounts", () => {
    const raw = {
      topHolders: [
        { address: "lockerAcct", owner: "someone", pct: 50 },
        { address: "liqA", owner: "pool", pct: 30 },
        { address: "wallet", owner: "human", pct: 5 },
      ],
      markets: [{ pubkey: "poolKey", liquidityA: "liqA", liquidityB: "liqB", marketType: "orca", lp: { lpLockedPct: 0 } }],
      lockers: { lockerAcct: { tokenAccount: "t", owner: "o" } },
    };
    const r = normalizeRugcheckReport(raw, PUMP);
    expect(r.largestHolderPct).toBe(5);
    expect(r.top10HolderPct).toBe(5);
  });

  it("treats present authorities as not revoked and reads launchpad strings", () => {
    const r = normalizeRugcheckReport(
      { mintAuthority: "9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw", freezeAuthority: null, launchpad: "pump.fun", transferFee: { pct: 2.5 }, rugged: true },
      PUMP,
    );
    expect(r.mintAuthorityRevoked).toBe(false);
    expect(r.freezeAuthorityRevoked).toBe(true);
    expect(r.launchpad).toBe("pump.fun");
    expect(r.transferFeePct).toBe(2.5);
    expect(r.rugged).toBe(true);
  });

  it("never throws on garbage and yields conservative defaults", () => {
    for (const raw of [null, undefined, "x", 42, [], {}]) {
      const r = normalizeRugcheckReport(raw, PUMP);
      expect(r).toMatchObject({
        mint: PUMP,
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: true,
        top10HolderPct: 0,
        largestHolderPct: 0,
        totalHolders: 0,
        lpLockedPct: 0,
        rugcheckScoreNormalised: null,
        risks: [],
        rugged: false,
        transferFeePct: 0,
        metadataMutable: false,
        launchpad: null,
        creator: null,
      });
    }
  });
});

describe("getSafetyReport", () => {
  it("returns null on an error body, a 4xx, or a null body, without caching", async () => {
    getJsonMock.mockResolvedValueOnce({ error: "unable to generate report" });
    expect(await getSafetyReport("errMint1")).toBeNull();
    getJsonMock.mockRejectedValueOnce(new HttpError(400, "u", "bad"));
    expect(await getSafetyReport("errMint2")).toBeNull();
    getJsonMock.mockResolvedValueOnce(null);
    expect(await getSafetyReport("errMint3")).toBeNull();
    expect(getJsonMock).toHaveBeenCalledTimes(3);
    getJsonMock.mockResolvedValueOnce({ error: "unable to generate report" });
    expect(await getSafetyReport("errMint1")).toBeNull();
    expect(getJsonMock).toHaveBeenCalledTimes(4);
  });

  it("rethrows server errors", async () => {
    getJsonMock.mockRejectedValueOnce(new HttpError(503, "u", "down"));
    await expect(getSafetyReport("errMint5")).rejects.toThrow(HttpError);
  });

  it("fetches the report URL, normalises it, and caches it for 10 minutes", async () => {
    getJsonMock.mockResolvedValueOnce(bonkFixture);
    const r1 = await getSafetyReport(BONK);
    expect(r1?.mint).toBe(BONK);
    expect(r1?.lpLockedPct).toBe(100);
    expect(getJsonMock.mock.calls[0]![0]).toBe(`https://api.rugcheck.xyz/v1/tokens/${BONK}/report`);
    const r2 = await getSafetyReport(BONK);
    expect(r2).toBe(r1);
    expect(getJsonMock).toHaveBeenCalledTimes(1);
  });
});
