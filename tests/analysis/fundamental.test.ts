import { describe, it, expect } from "vitest";
import { NO_SAFETY_SCORE, scoreFundamental } from "../../src/analysis/fundamental.js";
import { FIXED_NOW, makeContext, testConfig, type ContextOptions } from "../helpers/contextFactory.js";

const cfg = testConfig();
const DAY = 24 * 3_600_000;
const reason = (reasons: string[], prefix: string) => reasons.find((r) => r.startsWith(prefix)) ?? "";

describe("scoreFundamental", () => {
  it("defaults to 0.2 without a safety report", () => {
    const s = scoreFundamental(makeContext({ safety: null }), cfg, FIXED_NOW);
    expect(s.score).toBe(NO_SAFETY_SCORE);
    expect(s.reasons).toEqual(["no safety report; fundamental lens defaulted to 0.2"]);
  });

  it("scores the good fixture highly and the rug fixture low", () => {
    expect(scoreFundamental(makeContext(), cfg, FIXED_NOW).score).toBeGreaterThan(0.85);
    expect(scoreFundamental(makeContext({ good: false }), cfg, FIXED_NOW).score).toBeLessThan(0.15);
  });

  const components: Array<{ name: string; opts: ContextOptions; prefix: string; ends: string }> = [
    { name: "both authorities active", opts: { safety: { mintAuthorityRevoked: false, freezeAuthorityRevoked: false } }, prefix: "mint authority ACTIVE", ends: "-> 0" },
    { name: "one authority active", opts: { safety: { mintAuthorityRevoked: false } }, prefix: "mint authority ACTIVE, freeze authority revoked", ends: "-> 0.5" },
    { name: "top10 at 10% is perfect", opts: { safety: { top10HolderPct: 10 } }, prefix: "top10 holders 10%", ends: "-> 1" },
    { name: "top10 at 30% is mid", opts: { safety: { top10HolderPct: 30 } }, prefix: "top10 holders 30%", ends: "-> 0.5" },
    { name: "top10 at 50% is zero", opts: { safety: { top10HolderPct: 50 } }, prefix: "top10 holders 50%", ends: "-> 0" },
    { name: "largest holder 3% is perfect", opts: { safety: { largestHolderPct: 3 } }, prefix: "largest holder 3%", ends: "-> 1" },
    { name: "largest holder 20% is zero", opts: { safety: { largestHolderPct: 20 } }, prefix: "largest holder 20%", ends: "-> 0" },
    { name: "LP 50% locked is half", opts: { safety: { lpLockedPct: 50 } }, prefix: "LP locked 50%", ends: "-> 0.5" },
    { name: "500 holders is the floor", opts: { safety: { totalHolders: 500 } }, prefix: "500 holders", ends: "-> 0" },
    { name: "20000 holders is the ceiling", opts: { safety: { totalHolders: 20000 } }, prefix: "20000 holders", ends: "-> 1" },
    { name: "40000 holders stays at the ceiling", opts: { safety: { totalHolders: 40000 } }, prefix: "40000 holders", ends: "-> 1" },
    { name: "liquidity/mcap 1% is thin", opts: { pair: { liquidityUsd: 21_000 } }, prefix: "liquidity/mcap 1%", ends: "-> 0" },
    { name: "liquidity/mcap 45% is over the healthy band", opts: { pair: { liquidityUsd: 945_000 } }, prefix: "liquidity/mcap 45%", ends: "-> 0.5" },
    { name: "one danger risk", opts: { safety: { risks: [{ name: "Copycat token", level: "danger" }, { name: "x", level: "warn" }] } }, prefix: "1 danger risk(s): Copycat token", ends: "-> 0.65" },
    { name: "three danger risks floor at zero", opts: { safety: { risks: [{ name: "a", level: "danger" }, { name: "b", level: "danger" }, { name: "c", level: "danger" }] } }, prefix: "3 danger risk(s)", ends: "-> 0" },
    { name: "mutable metadata", opts: { safety: { metadataMutable: true } }, prefix: "metadata mutable", ends: "-> 0" },
    { name: "no website or twitter", opts: { pair: { websites: [], socials: [] } }, prefix: "website no, twitter no", ends: "-> 0" },
    { name: "twitter via x.com url", opts: { pair: { websites: [], socials: [{ type: "social", url: "https://x.com/abc" }] } }, prefix: "website no, twitter yes", ends: "-> 0.5" },
    { name: "age 12h is half way to the sweet spot", opts: { pair: { pairCreatedAt: FIXED_NOW - 0.5 * DAY } }, prefix: "token age 0.5d", ends: "-> 0.45" },
    { name: "age 60d is past the sweet spot", opts: { pair: { pairCreatedAt: FIXED_NOW - 60 * DAY } }, prefix: "token age 60d", ends: "-> 0.5" },
    { name: "age 90d scores zero", opts: { pair: { pairCreatedAt: FIXED_NOW - 90 * DAY } }, prefix: "token age 90d", ends: "-> 0" },
  ];
  it.each(components)("$name", ({ opts, prefix, ends }) => {
    const s = scoreFundamental(makeContext(opts), cfg, FIXED_NOW);
    const r = reason(s.reasons, prefix);
    expect(r, `expected a reason starting with "${prefix}" in ${JSON.stringify(s.reasons)}`).not.toBe("");
    expect(r.endsWith(ends), `${r} should end with ${ends}`).toBe(true);
  });

  it("skips components whose inputs are unknown and renormalises", () => {
    const s = scoreFundamental(makeContext({ pair: { marketCapUsd: null, fdvUsd: null, pairCreatedAt: null } }), cfg, FIXED_NOW);
    expect(s.reasons).toContain("liquidity/market cap ratio unavailable: market cap unknown (skipped)");
    expect(s.reasons).toContain("token age unavailable: pairCreatedAt missing (skipped)");
    expect(s.score).toBeGreaterThan(0.8);
    expect(s.score).toBeLessThanOrEqual(1);
  });

  it("every component change moves the score monotonically", () => {
    const base = scoreFundamental(makeContext(), cfg, FIXED_NOW).score;
    for (const opts of components.map((c) => c.opts)) {
      const s = scoreFundamental(makeContext(opts), cfg, FIXED_NOW).score;
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
      expect(Math.abs(s - base)).toBeLessThan(0.3);
    }
  });
});
