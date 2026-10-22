/**
 * Fundamental lens: token safety and structure from the RugCheck report and
 * the pair snapshot. Without a safety report the lens defaults to 0.2.
 */
import type { StrategyConfig } from "../core/config.js";
import type { LensScore, TokenContext } from "../core/types.js";
import { band, clamp01, rampDown, rampUp } from "./indicators.js";
import { fmt, LensBuilder, tokenAgeHours } from "./lens.js";

export const FUNDAMENTAL_WEIGHTS = {
  authorities: 0.15,
  top10: 0.12,
  largestHolder: 0.1,
  lpLocked: 0.1,
  holders: 0.12,
  liqToMcap: 0.1,
  dangerRisks: 0.1,
  metadata: 0.06,
  presence: 0.07,
  age: 0.08,
} as const;

export const NO_SAFETY_SCORE = 0.2;
const HOLDERS_LO = 500;
const HOLDERS_HI = 20000;

export function scoreFundamental(ctx: TokenContext, _cfg: StrategyConfig, now: number = Date.now()): LensScore {
  const { pair, safety } = ctx;
  if (safety === null) {
    return { score: NO_SAFETY_SCORE, reasons: [`no safety report; fundamental lens defaulted to ${NO_SAFETY_SCORE}`] };
  }
  const b = new LensBuilder();

  const auth = (safety.mintAuthorityRevoked ? 0.5 : 0) + (safety.freezeAuthorityRevoked ? 0.5 : 0);
  b.add(
    auth,
    FUNDAMENTAL_WEIGHTS.authorities,
    `mint authority ${safety.mintAuthorityRevoked ? "revoked" : "ACTIVE"}, freeze authority ${safety.freezeAuthorityRevoked ? "revoked" : "ACTIVE"}`,
  );

  b.add(rampDown(safety.top10HolderPct, 10, 50), FUNDAMENTAL_WEIGHTS.top10, `top10 holders ${fmt(safety.top10HolderPct, 1)}% (excl. pools)`);
  b.add(rampDown(safety.largestHolderPct, 3, 20), FUNDAMENTAL_WEIGHTS.largestHolder, `largest holder ${fmt(safety.largestHolderPct, 1)}%`);
  b.add(rampUp(safety.lpLockedPct, 0, 100), FUNDAMENTAL_WEIGHTS.lpLocked, `LP locked ${fmt(safety.lpLockedPct, 1)}%`);

  const h = Math.max(1, safety.totalHolders);
  const holdersScore = clamp01((Math.log(h) - Math.log(HOLDERS_LO)) / (Math.log(HOLDERS_HI) - Math.log(HOLDERS_LO)));
  b.add(holdersScore, FUNDAMENTAL_WEIGHTS.holders, `${safety.totalHolders} holders (log scale ${HOLDERS_LO}-${HOLDERS_HI})`);

  const mcap = pair.marketCapUsd ?? pair.fdvUsd;
  if (mcap === null || mcap <= 0) {
    b.skip("liquidity/market cap ratio unavailable: market cap unknown");
  } else {
    const ratio = pair.liquidityUsd / mcap;
    b.add(band(ratio, 0.01, 0.03, 0.3, 0.6), FUNDAMENTAL_WEIGHTS.liqToMcap, `liquidity/mcap ${fmt(ratio * 100, 1)}% (healthy 3-30%)`);
  }

  const dangers = safety.risks.filter((r) => r.level.trim().toLowerCase() === "danger");
  const dangerScore = Math.max(0, 1 - 0.35 * dangers.length);
  b.add(
    dangerScore,
    FUNDAMENTAL_WEIGHTS.dangerRisks,
    dangers.length === 0 ? "no danger risks" : `${dangers.length} danger risk(s): ${dangers.map((d) => d.name).join(", ")}`,
  );

  b.add(safety.metadataMutable ? 0 : 1, FUNDAMENTAL_WEIGHTS.metadata, `metadata ${safety.metadataMutable ? "mutable" : "immutable"}`);

  const hasWebsite = pair.websites.length > 0;
  const hasTwitter = pair.socials.some((s) => /^(twitter|x)$/i.test(s.type.trim()) || /(twitter\.com|x\.com)\//i.test(s.url));
  b.add(
    (hasWebsite ? 0.5 : 0) + (hasTwitter ? 0.5 : 0),
    FUNDAMENTAL_WEIGHTS.presence,
    `website ${hasWebsite ? "yes" : "no"}, twitter ${hasTwitter ? "yes" : "no"}`,
  );

  const ageHours = tokenAgeHours(pair, now);
  if (ageHours === null) {
    b.skip("token age unavailable: pairCreatedAt missing");
  } else {
    b.add(band(ageHours, 2, 24, 720, 2160), FUNDAMENTAL_WEIGHTS.age, `token age ${fmt(ageHours / 24, 1)}d (sweet spot 1-30d)`);
  }

  return b.build();
}
