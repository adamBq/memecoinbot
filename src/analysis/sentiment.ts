/**
 * Sentiment lens over SentimentSignals. When an LLM narrative score is present
 * it takes 40% of the lens; otherwise the heuristic components are
 * renormalised to the full weight.
 */
import type { StrategyConfig } from "../core/config.js";
import type { LensScore, TokenContext } from "../core/types.js";
import { clamp01, rampUp } from "./indicators.js";
import { fmt, LensBuilder } from "./lens.js";

export const SENTIMENT_WEIGHTS = {
  boosts: 0.15,
  social: 0.2,
  trending: 0.3,
  buyPressure: 0.35,
} as const;
export const LLM_WEIGHT = 0.4;

function rankScore(rank: number | null, worst: number): number {
  if (rank === null || rank < 1) return 0;
  return Math.max(0.2, 1 - (rank - 1) / worst);
}

export function scoreSentiment(ctx: TokenContext, _cfg: StrategyConfig): LensScore {
  const s = ctx.sentiment;
  const b = new LensBuilder();
  const hasLlm = s.llmNarrativeScore !== null;
  const scale = hasLlm ? 1 - LLM_WEIGHT : 1;

  b.add(clamp01(Math.log10(1 + s.boostsActive) / 3), SENTIMENT_WEIGHTS.boosts * scale, `${s.boostsActive} boosts (log scale to 1000)`);

  const social =
    (s.hasWebsite ? 0.3 : 0) + (s.hasTwitter ? 0.4 : 0) + (s.hasTelegram ? 0.2 : 0) + (s.socialCount >= 3 ? 0.1 : 0);
  b.add(
    social,
    SENTIMENT_WEIGHTS.social * scale,
    `website ${s.hasWebsite ? "yes" : "no"}, twitter ${s.hasTwitter ? "yes" : "no"}, telegram ${s.hasTelegram ? "yes" : "no"}, ${s.socialCount} socials`,
  );

  const dex = rankScore(s.dexscreenerTrendingRank, 50);
  const cg = rankScore(s.coingeckoTrendingRank, 15);
  const trending = clamp01(Math.max(dex, cg) + 0.2 * Math.min(dex, cg));
  b.add(
    trending,
    SENTIMENT_WEIGHTS.trending * scale,
    `trending ranks dexscreener ${s.dexscreenerTrendingRank ?? "none"}, coingecko ${s.coingeckoTrendingRank ?? "none"}`,
  );

  b.add(rampUp(s.buyPressure1h, 0.35, 0.7), SENTIMENT_WEIGHTS.buyPressure * scale, `1h buy pressure ${fmt(s.buyPressure1h, 2)}`);

  if (hasLlm && s.llmNarrativeScore !== null) {
    b.add(s.llmNarrativeScore, LLM_WEIGHT, `LLM narrative: ${s.llmNarrativeReason ?? "no reason given"}`);
  } else {
    b.note("LLM narrative score absent; heuristic components renormalised");
  }

  return b.build();
}
