/**
 * Composite scorer: hard filters first, then the five lenses weighted by
 * `cfg.scoring.weights`. A failed filter yields total 0 but the lenses are
 * still computed so the decision log keeps a full audit trail.
 */
import type { StrategyConfig } from "../core/config.js";
import type { CompositeScore, LensName, LensScore, TokenContext } from "../core/types.js";
import { isBreakoutConfirmed } from "./breakout.js";
import { scoreEvent } from "./event.js";
import { scoreFundamental } from "./fundamental.js";
import { applyHardFilters } from "./hardFilters.js";
import { clamp01 } from "./indicators.js";
import { scoreQuantitative } from "./quantitative.js";
import { scoreSentiment } from "./sentiment.js";
import { scoreTechnical } from "./technical.js";

export function scoreLenses(ctx: TokenContext, cfg: StrategyConfig, now: number = Date.now()): Record<LensName, LensScore> {
  return {
    technical: scoreTechnical(ctx, cfg),
    fundamental: scoreFundamental(ctx, cfg, now),
    quantitative: scoreQuantitative(ctx, cfg),
    sentiment: scoreSentiment(ctx, cfg),
    event: scoreEvent(ctx, cfg),
  };
}

export function weightedTotal(lenses: Record<LensName, LensScore>, cfg: StrategyConfig): number {
  const w = cfg.scoring.weights;
  return clamp01(
    w.technical * lenses.technical.score +
      w.fundamental * lenses.fundamental.score +
      w.quantitative * lenses.quantitative.score +
      w.sentiment * lenses.sentiment.score +
      w.event * lenses.event.score,
  );
}

export function scoreToken(ctx: TokenContext, cfg: StrategyConfig, now: number = Date.now()): CompositeScore {
  const filters = applyHardFilters(ctx, cfg, now);
  const lenses = scoreLenses(ctx, cfg, now);
  const total = filters.passed ? weightedTotal(lenses, cfg) : 0;
  return {
    mint: ctx.pair.mint,
    symbol: ctx.pair.symbol,
    pairAddress: ctx.pair.pairAddress,
    total,
    lenses,
    hardFilterPassed: filters.passed,
    hardFilterFailures: filters.failures,
    breakoutConfirmed: isBreakoutConfirmed(ctx),
    computedAt: now,
  };
}
