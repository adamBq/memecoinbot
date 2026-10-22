/**
 * Breakout confirmation on 5m candles: the last close must exceed the highest
 * high of the prior six hours (excluding the most recent hour) AND the most
 * recent hour's volume must exceed 1.5x the average hourly volume of those
 * prior six hours. Needs 84 candles (7h); fewer means not confirmed.
 */
import type { Candle, TokenContext } from "../core/types.js";

export const CANDLES_PER_HOUR_5M = 12;
export const BREAKOUT_LOOKBACK_HOURS = 6;
export const BREAKOUT_MIN_CANDLES_5M = CANDLES_PER_HOUR_5M * (BREAKOUT_LOOKBACK_HOURS + 1); // 84
export const BREAKOUT_VOLUME_MULTIPLE = 1.5;

export interface BreakoutDetails {
  confirmed: boolean;
  lastClose: number | null;
  priorHigh: number | null;
  lastHourVolume: number | null;
  avgPriorHourVolume: number | null;
  reason: string;
}

export function breakoutDetails(candles5m: Candle[]): BreakoutDetails {
  const n = candles5m.length;
  if (n < BREAKOUT_MIN_CANDLES_5M) {
    return {
      confirmed: false,
      lastClose: null,
      priorHigh: null,
      lastHourVolume: null,
      avgPriorHourVolume: null,
      reason: `need ${BREAKOUT_MIN_CANDLES_5M} 5m candles, have ${n}`,
    };
  }
  const lastHour = candles5m.slice(n - CANDLES_PER_HOUR_5M);
  const prior = candles5m.slice(n - BREAKOUT_MIN_CANDLES_5M, n - CANDLES_PER_HOUR_5M);
  const last = lastHour[lastHour.length - 1];
  const lastClose = last ? last.c : 0;
  let priorHigh = -Infinity;
  let priorVolume = 0;
  for (const c of prior) {
    if (c.h > priorHigh) priorHigh = c.h;
    priorVolume += c.v;
  }
  let lastHourVolume = 0;
  for (const c of lastHour) lastHourVolume += c.v;
  const avgPriorHourVolume = priorVolume / BREAKOUT_LOOKBACK_HOURS;

  const priceOk = lastClose > priorHigh;
  const volumeOk = lastHourVolume > BREAKOUT_VOLUME_MULTIPLE * avgPriorHourVolume;
  const confirmed = priceOk && volumeOk;
  const reason = confirmed
    ? `close ${lastClose} > prior 6h high ${priorHigh} and 1h volume ${Math.round(lastHourVolume)} > ${BREAKOUT_VOLUME_MULTIPLE}x avg ${Math.round(avgPriorHourVolume)}`
    : !priceOk
      ? `close ${lastClose} <= prior 6h high ${priorHigh}`
      : `1h volume ${Math.round(lastHourVolume)} <= ${BREAKOUT_VOLUME_MULTIPLE}x avg ${Math.round(avgPriorHourVolume)}`;
  return { confirmed, lastClose, priorHigh, lastHourVolume, avgPriorHourVolume, reason };
}

export function isBreakoutConfirmed(ctx: TokenContext): boolean {
  return breakoutDetails(ctx.candles5m).confirmed;
}
