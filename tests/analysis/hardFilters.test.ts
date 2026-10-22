import { describe, it, expect } from "vitest";
import { applyHardFilters } from "../../src/analysis/hardFilters.js";
import { configWith, FIXED_NOW, makeContext, testConfig, type ContextOptions } from "../helpers/contextFactory.js";

const cfg = testConfig();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("applyHardFilters", () => {
  it("passes the good fixture with no failures", () => {
    const r = applyHardFilters(makeContext(), cfg, FIXED_NOW);
    expect(r).toEqual({ passed: true, failures: [] });
  });

  it("collects every failure for the rug fixture, not just the first", () => {
    const r = applyHardFilters(makeContext({ good: false }), cfg, FIXED_NOW);
    expect(r.passed).toBe(false);
    expect(r.failures).toEqual([
      "liquidity 12000 < min 50000",
      "token age 1h < min 2h",
      "market cap 90000 < min 150000",
      "volume 24h 30000 < min 100000",
      "txns 1h 40 < min 50",
      "mint authority not revoked",
      "freeze authority not revoked",
      "top10 holders 70% > max 35%",
      "largest holder 40% > max 15%",
      "LP locked 0% < min 50%",
      "rugcheck danger risk: Mint Authority still enabled",
      "rugcheck danger risk: Freeze Authority still enabled",
      "round-trip loss 20% > max 6%",
    ]);
  });

  const cases: Array<{ name: string; opts: ContextOptions; expected: string }> = [
    { name: "liquidity below min", opts: { pair: { liquidityUsd: 12_000 } }, expected: "liquidity 12000 < min 50000" },
    { name: "liquidity above max", opts: { pair: { liquidityUsd: 6_000_000 } }, expected: "liquidity 6000000 > max 5000000" },
    { name: "unknown age", opts: { pair: { pairCreatedAt: null } }, expected: "unknown age (pairCreatedAt missing)" },
    { name: "too young", opts: { pair: { pairCreatedAt: FIXED_NOW - 1.5 * HOUR } }, expected: "token age 1.5h < min 2h" },
    { name: "too old", opts: { pair: { pairCreatedAt: FIXED_NOW - 120 * DAY } }, expected: "token age 120d > max 90d" },
    { name: "created in the future counts as age 0", opts: { pair: { pairCreatedAt: FIXED_NOW + HOUR } }, expected: "token age 0h < min 2h" },
    { name: "market cap unknown", opts: { pair: { marketCapUsd: null, fdvUsd: null } }, expected: "unknown market cap (marketCapUsd and fdvUsd missing)" },
    { name: "market cap below min", opts: { pair: { marketCapUsd: 100_000 } }, expected: "market cap 100000 < min 150000" },
    { name: "market cap above max", opts: { pair: { marketCapUsd: 60_000_000 } }, expected: "market cap 60000000 > max 50000000" },
    { name: "fdv fallback below min", opts: { pair: { marketCapUsd: null, fdvUsd: 120_000 } }, expected: "market cap 120000 < min 150000" },
    { name: "volume 24h below min", opts: { pair: { volumeUsd: { h24: 99_999 } } }, expected: "volume 24h 99999 < min 100000" },
    { name: "txns 1h below min", opts: { pair: { txns: { h1: { buys: 20, sells: 29 } } } }, expected: "txns 1h 49 < min 50" },
    { name: "safety missing", opts: { safety: null }, expected: "safety report unavailable" },
    { name: "rugged", opts: { safety: { rugged: true } }, expected: "rugcheck flags token as rugged" },
    { name: "mint authority", opts: { safety: { mintAuthorityRevoked: false } }, expected: "mint authority not revoked" },
    { name: "freeze authority", opts: { safety: { freezeAuthorityRevoked: false } }, expected: "freeze authority not revoked" },
    { name: "top10 above max", opts: { safety: { top10HolderPct: 35.5 } }, expected: "top10 holders 35.5% > max 35%" },
    { name: "largest holder above max", opts: { safety: { largestHolderPct: 16 } }, expected: "largest holder 16% > max 15%" },
    { name: "LP locked below min", opts: { safety: { lpLockedPct: 49 } }, expected: "LP locked 49% < min 50%" },
    { name: "transfer fee above max", opts: { safety: { transferFeePct: 1.5 } }, expected: "transfer fee 1.5% > max 0%" },
    {
      name: "listed danger risk",
      opts: { safety: { risks: [{ name: "Copycat token", level: "danger" }] } },
      expected: "rugcheck danger risk: Copycat token",
    },
    {
      name: "listed danger risk matched case-insensitively",
      opts: { safety: { risks: [{ name: "  low AMOUNT of lp providers ", level: "Danger" }] } },
      expected: "rugcheck danger risk: low AMOUNT of lp providers",
    },
    { name: "sellability missing", opts: { sellability: null }, expected: "sellability check unavailable" },
    { name: "no route", opts: { sellability: { routeFound: false } }, expected: "no Jupiter route found for round trip" },
    { name: "round trip loss above max", opts: { sellability: { roundTripRetentionPct: 93.9 } }, expected: "round-trip loss 6.1% > max 6%" },
  ];

  it.each(cases)("$name -> $expected", ({ opts, expected }) => {
    const r = applyHardFilters(makeContext(opts), cfg, FIXED_NOW);
    expect(r.passed).toBe(false);
    expect(r.failures).toContain(expected);
  });

  it.each([
    { name: "boundary liquidity equals min", opts: { pair: { liquidityUsd: 50_000 } } },
    { name: "boundary age equals min", opts: { pair: { pairCreatedAt: FIXED_NOW - 2 * HOUR } } },
    { name: "boundary top10 equals max", opts: { safety: { top10HolderPct: 35 } } },
    { name: "boundary round trip loss equals max", opts: { sellability: { roundTripRetentionPct: 94 } } },
    { name: "warn-level listed risk is not rejected", opts: { safety: { risks: [{ name: "Copycat token", level: "warn" }] } } },
    { name: "unlisted danger risk is not rejected", opts: { safety: { risks: [{ name: "Something odd", level: "danger" }] } } },
  ] satisfies Array<{ name: string; opts: ContextOptions }>)("$name passes", ({ opts }) => {
    expect(applyHardFilters(makeContext(opts), cfg, FIXED_NOW).passed).toBe(true);
  });

  it("never auto-rejects pool-driven holder risks even when they are listed", () => {
    const strict = configWith((c) => {
      c.hardFilters.rejectRugcheckDangerRisks.push("Top 10 holders high ownership", "Single holder ownership");
    });
    const ctx = makeContext({
      safety: {
        risks: [
          { name: "Top 10 holders high ownership", level: "danger" },
          { name: "Single holder ownership", level: "danger" },
        ],
      },
    });
    expect(applyHardFilters(ctx, strict, FIXED_NOW).passed).toBe(true);
  });

  it("applies the rugcheck normalised score floor only when enabled", () => {
    const enabled = configWith((c) => {
      c.hardFilters.minRugcheckNormalisedScore = 10;
    });
    expect(applyHardFilters(makeContext({ safety: { rugcheckScoreNormalised: 5 } }), enabled, FIXED_NOW).failures).toContain(
      "rugcheck normalised score 5 < min 10",
    );
    expect(applyHardFilters(makeContext({ safety: { rugcheckScoreNormalised: null } }), enabled, FIXED_NOW).failures).toContain(
      "rugcheck normalised score unavailable",
    );
    expect(applyHardFilters(makeContext({ safety: { rugcheckScoreNormalised: null } }), cfg, FIXED_NOW).passed).toBe(true);
  });

  it("does not require authorities when the config relaxes them", () => {
    const relaxed = configWith((c) => {
      c.hardFilters.requireMintAuthorityRevoked = false;
      c.hardFilters.requireFreezeAuthorityRevoked = false;
    });
    const ctx = makeContext({ safety: { mintAuthorityRevoked: false, freezeAuthorityRevoked: false } });
    expect(applyHardFilters(ctx, relaxed, FIXED_NOW).passed).toBe(true);
  });

  it("defaults now to the wall clock", () => {
    const ctx = makeContext({ pair: { pairCreatedAt: Date.now() - 5 * DAY } });
    expect(applyHardFilters(ctx, cfg).passed).toBe(true);
  });
});
