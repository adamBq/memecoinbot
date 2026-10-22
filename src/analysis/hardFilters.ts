/**
 * Hard filters: every threshold in `cfg.hardFilters` is checked and every
 * failure is reported, so the audit trail shows the full picture rather than
 * the first problem found.
 */
import type { StrategyConfig } from "../core/config.js";
import type { TokenContext } from "../core/types.js";
import { fmt, tokenAgeHours, usd } from "./lens.js";

/**
 * RugCheck risks that are usually triggered by the pool or AMM account itself
 * holding a large share. We rely on our own pool-excluded holder percentages
 * (`top10HolderPct`, `largestHolderPct`) instead, so these names are never
 * auto-rejected even when they appear in `rejectRugcheckDangerRisks`.
 */
export const POOL_DRIVEN_RISK_NAMES: ReadonlySet<string> = new Set([
  "top 10 holders high ownership",
  "single holder ownership",
]);

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export function applyHardFilters(
  ctx: TokenContext,
  cfg: StrategyConfig,
  now: number = Date.now(),
): { passed: boolean; failures: string[] } {
  const f = cfg.hardFilters;
  const { pair, safety, sellability } = ctx;
  const failures: string[] = [];

  // Pair-level thresholds
  if (pair.liquidityUsd < f.minLiquidityUsd) {
    failures.push(`liquidity ${usd(pair.liquidityUsd)} < min ${usd(f.minLiquidityUsd)}`);
  }
  if (pair.liquidityUsd > f.maxLiquidityUsd) {
    failures.push(`liquidity ${usd(pair.liquidityUsd)} > max ${usd(f.maxLiquidityUsd)}`);
  }

  const ageHours = tokenAgeHours(pair, now);
  if (ageHours === null) {
    failures.push("unknown age (pairCreatedAt missing)");
  } else {
    if (ageHours < f.minTokenAgeHours) {
      failures.push(`token age ${fmt(ageHours, 1)}h < min ${fmt(f.minTokenAgeHours, 1)}h`);
    }
    const ageDays = ageHours / 24;
    if (ageDays > f.maxTokenAgeDays) {
      failures.push(`token age ${fmt(ageDays, 1)}d > max ${fmt(f.maxTokenAgeDays, 1)}d`);
    }
  }

  const mcap = pair.marketCapUsd ?? pair.fdvUsd;
  if (mcap === null) {
    failures.push("unknown market cap (marketCapUsd and fdvUsd missing)");
  } else {
    if (mcap < f.minMarketCapUsd) failures.push(`market cap ${usd(mcap)} < min ${usd(f.minMarketCapUsd)}`);
    if (mcap > f.maxMarketCapUsd) failures.push(`market cap ${usd(mcap)} > max ${usd(f.maxMarketCapUsd)}`);
  }

  if (pair.volumeUsd.h24 < f.minVolume24hUsd) {
    failures.push(`volume 24h ${usd(pair.volumeUsd.h24)} < min ${usd(f.minVolume24hUsd)}`);
  }

  const txns1h = pair.txns.h1.buys + pair.txns.h1.sells;
  if (txns1h < f.minTxns1h) {
    failures.push(`txns 1h ${txns1h} < min ${f.minTxns1h}`);
  }

  // Safety thresholds
  if (safety === null) {
    failures.push("safety report unavailable");
  } else {
    if (safety.rugged) failures.push("rugcheck flags token as rugged");
    if (f.requireMintAuthorityRevoked && !safety.mintAuthorityRevoked) failures.push("mint authority not revoked");
    if (f.requireFreezeAuthorityRevoked && !safety.freezeAuthorityRevoked) failures.push("freeze authority not revoked");
    if (safety.top10HolderPct > f.maxTop10HolderPct) {
      failures.push(`top10 holders ${fmt(safety.top10HolderPct, 1)}% > max ${fmt(f.maxTop10HolderPct, 1)}%`);
    }
    if (safety.largestHolderPct > f.maxSingleHolderPct) {
      failures.push(`largest holder ${fmt(safety.largestHolderPct, 1)}% > max ${fmt(f.maxSingleHolderPct, 1)}%`);
    }
    if (safety.lpLockedPct < f.minLpLockedPct) {
      failures.push(`LP locked ${fmt(safety.lpLockedPct, 1)}% < min ${fmt(f.minLpLockedPct, 1)}%`);
    }
    if (safety.transferFeePct > f.maxTransferFeePct) {
      failures.push(`transfer fee ${fmt(safety.transferFeePct, 2)}% > max ${fmt(f.maxTransferFeePct, 2)}%`);
    }
    const rejectNames = new Set(f.rejectRugcheckDangerRisks.map(norm));
    for (const risk of safety.risks) {
      if (norm(risk.level) !== "danger") continue;
      const name = norm(risk.name);
      if (POOL_DRIVEN_RISK_NAMES.has(name)) continue;
      if (rejectNames.has(name)) failures.push(`rugcheck danger risk: ${risk.name.trim()}`);
    }
    if (f.minRugcheckNormalisedScore > 0) {
      if (safety.rugcheckScoreNormalised === null) {
        failures.push("rugcheck normalised score unavailable");
      } else if (safety.rugcheckScoreNormalised < f.minRugcheckNormalisedScore) {
        failures.push(
          `rugcheck normalised score ${fmt(safety.rugcheckScoreNormalised, 1)} < min ${fmt(f.minRugcheckNormalisedScore, 1)}`,
        );
      }
    }
  }

  // Sellability thresholds
  if (sellability === null) {
    failures.push("sellability check unavailable");
  } else if (!sellability.routeFound) {
    failures.push("no Jupiter route found for round trip");
  } else {
    const loss = 100 - sellability.roundTripRetentionPct;
    if (loss > f.maxRoundTripLossPct) {
      failures.push(`round-trip loss ${fmt(loss, 1)}% > max ${fmt(f.maxRoundTripLossPct, 1)}%`);
    }
  }

  return { passed: failures.length === 0, failures };
}
