/**
 * Quantitative lens: volatility, turnover, volume acceleration, volume
 * z-score, sellability and buy-pressure consistency.
 */
import type { StrategyConfig } from "../core/config.js";
import type { LensScore, TokenContext } from "../core/types.js";
import { atrPct, band, lastVolumeZScore, rampUp } from "./indicators.js";
import { buyPressure, fmt, LensBuilder } from "./lens.js";

export const QUANT_WEIGHTS = {
  volatility: 0.15,
  turnover: 0.2,
  acceleration: 0.15,
  volumeZ: 0.15,
  sellability: 0.2,
  buyPressure: 0.15,
} as const;

/**
 * ATR% per 5m candle sweet spot. Memecoins are volatile, so a quiet tape is
 * read as "nothing happening" and an extreme one as "untradeable".
 */
export const ATR_SWEET_SPOT = { lo0: 0.4, lo1: 2, hi1: 12, hi0: 30 } as const;

export function scoreQuantitative(ctx: TokenContext, _cfg: StrategyConfig): LensScore {
  const b = new LensBuilder();
  const { pair, candles5m, candles1h, sellability } = ctx;

  const atr = atrPct(candles5m, 14);
  if (atr === null) {
    b.skip("ATR% unavailable: need 15+ 5m candles");
  } else {
    const { lo0, lo1, hi1, hi0 } = ATR_SWEET_SPOT;
    b.add(band(atr, lo0, lo1, hi1, hi0), QUANT_WEIGHTS.volatility, `ATR(14) ${fmt(atr, 2)}% per 5m (sweet spot ${lo1}-${hi1}%)`);
  }

  const mcap = pair.marketCapUsd ?? pair.fdvUsd;
  if (mcap === null || mcap <= 0) {
    b.skip("turnover unavailable: market cap unknown");
  } else {
    const turnover = pair.volumeUsd.h24 / mcap;
    b.add(band(turnover, 0.05, 0.2, 3, 10), QUANT_WEIGHTS.turnover, `24h volume/mcap ${fmt(turnover, 2)}x (healthy 0.2-3x)`);
  }

  if (pair.volumeUsd.h24 <= 0) {
    b.add(0, QUANT_WEIGHTS.acceleration, "no 24h volume");
  } else {
    const accel = (pair.volumeUsd.h1 * 24) / pair.volumeUsd.h24;
    b.add(band(accel, 0.3, 1.5, 6, 20), QUANT_WEIGHTS.acceleration, `volume acceleration h1*24/h24 ${fmt(accel, 2)}x`);
  }

  const z = lastVolumeZScore(candles1h, 24, 3);
  if (z === null) {
    b.skip("1h volume z-score unavailable: need 4+ 1h candles with variance");
  } else {
    b.add(rampUp(z, -1, 3), QUANT_WEIGHTS.volumeZ, `last 1h volume z-score ${fmt(z, 2)}`);
  }

  if (sellability === null) {
    b.add(0, QUANT_WEIGHTS.sellability, "sellability unknown");
  } else if (!sellability.routeFound) {
    b.add(0, QUANT_WEIGHTS.sellability, "no sell route");
  } else {
    b.add(
      rampUp(sellability.roundTripRetentionPct, 90, 100),
      QUANT_WEIGHTS.sellability,
      `round-trip retention ${fmt(sellability.roundTripRetentionPct, 1)}%`,
    );
  }

  const bps = [buyPressure(pair.txns.m5), buyPressure(pair.txns.h1), buyPressure(pair.txns.h6)];
  const avg = bps.reduce((s, x) => s + rampUp(x, 0.4, 0.65), 0) / bps.length;
  const spread = Math.max(...bps) - Math.min(...bps);
  const consistency = 1 - rampUp(spread, 0, 0.3);
  b.add(
    avg * (0.6 + 0.4 * consistency),
    QUANT_WEIGHTS.buyPressure,
    `buy pressure m5 ${fmt(bps[0] ?? 0.5, 2)} h1 ${fmt(bps[1] ?? 0.5, 2)} h6 ${fmt(bps[2] ?? 0.5, 2)}, consistency ${fmt(consistency, 2)}`,
  );

  return b.build();
}
