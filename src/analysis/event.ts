/**
 * Event lens over EventSignals. An LLM event score, when present, takes 40%
 * of the lens; otherwise the heuristic components are renormalised.
 */
import type { StrategyConfig } from "../core/config.js";
import type { LensScore, TokenContext } from "../core/types.js";
import { sigmoid } from "./indicators.js";
import { fmt, LensBuilder } from "./lens.js";

export const EVENT_WEIGHTS = {
  graduated: 0.2,
  newPool: 0.15,
  trending: 0.2,
  volumeZ: 0.25,
  spike5m: 0.2,
} as const;
export const LLM_WEIGHT = 0.4;

export function scoreEvent(ctx: TokenContext, _cfg: StrategyConfig): LensScore {
  const e = ctx.events;
  const b = new LensBuilder();
  const hasLlm = e.llmEventScore !== null;
  const scale = hasLlm ? 1 - LLM_WEIGHT : 1;

  b.add(e.graduatedFromLaunchpad ? 1 : 0, EVENT_WEIGHTS.graduated * scale, `graduated from launchpad: ${e.graduatedFromLaunchpad ? "yes" : "no"}`);
  b.add(e.newPoolWithin24h ? 1 : 0, EVENT_WEIGHTS.newPool * scale, `new pool within 24h: ${e.newPoolWithin24h ? "yes" : "no"}`);
  b.add(e.enteredTrendingList ? 1 : 0, EVENT_WEIGHTS.trending * scale, `entered trending list: ${e.enteredTrendingList ? "yes" : "no"}`);
  b.add(sigmoid(e.volumeZScore1h - 1), EVENT_WEIGHTS.volumeZ * scale, `1h volume z-score ${fmt(e.volumeZScore1h, 2)} (sigmoid centred at 1)`);
  b.add(e.volumeSpike5m ? 1 : 0, EVENT_WEIGHTS.spike5m * scale, `5m volume spike: ${e.volumeSpike5m ? "yes" : "no"}`);

  if (hasLlm && e.llmEventScore !== null) {
    b.add(e.llmEventScore, LLM_WEIGHT, `LLM event: ${e.llmEventReason ?? "no reason given"}`);
  } else {
    b.note("LLM event score absent; heuristic components renormalised");
  }

  return b.build();
}
