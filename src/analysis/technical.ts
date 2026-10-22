/**
 * Technical lens: multi-timeframe momentum, RSI(14) on 5m, EMA trend on 5m
 * and 1h, proximity to the 24h high, and the 1h buy/sell ratio. Candle-based
 * components are skipped when candles are missing; the lens then runs on pair
 * fields only and is capped, which is noted in the reasons.
 */
import type { StrategyConfig } from "../core/config.js";
import type { LensScore, TokenContext } from "../core/types.js";
import { band, ema, rampUp, rsi } from "./indicators.js";
import { fmt, LensBuilder, pct } from "./lens.js";

export const TECHNICAL_WEIGHTS = {
  momentum: 0.3,
  rsi: 0.15,
  ema5m: 0.15,
  ema1h: 0.15,
  high24h: 0.1,
  buySell: 0.15,
} as const;

/** Upper bound for the lens when no candle-based component could be scored. */
export const NO_CANDLE_CAP = 0.75;
export const PARABOLIC_H24_PCT = 300;

export function scoreTechnical(ctx: TokenContext, _cfg: StrategyConfig): LensScore {
  const b = new LensBuilder();
  const { pair, candles5m, candles1h } = ctx;
  const pc = pair.priceChangePct;

  // Multi-timeframe momentum: favour positive h1/h6, h24 not already parabolic.
  const m5 = band(pc.m5, -8, 0, 15, 40);
  const h1 = band(pc.h1, -10, 5, 40, 150);
  const h6 = band(pc.h6, -15, 5, 80, 300);
  const h24 = band(pc.h24, -30, 0, 150, PARABOLIC_H24_PCT);
  let momentum = 0.15 * m5 + 0.4 * h1 + 0.3 * h6 + 0.15 * h24;
  let momentumNote = "";
  if (pc.h24 > PARABOLIC_H24_PCT) {
    momentum *= 0.7;
    momentumNote = ` (h24 ${pct(pc.h24)} already parabolic, dampened)`;
  }
  b.add(
    momentum,
    TECHNICAL_WEIGHTS.momentum,
    `momentum m5 ${pct(pc.m5)} h1 ${pct(pc.h1)} h6 ${pct(pc.h6)} h24 ${pct(pc.h24)}${momentumNote}`,
  );

  const closes5m = candles5m.map((c) => c.c);
  const closes1h = candles1h.map((c) => c.c);
  const lastClose5m = closes5m.length > 0 ? closes5m[closes5m.length - 1] : undefined;
  const price = pair.priceUsd > 0 ? pair.priceUsd : (lastClose5m ?? 0);

  // RSI(14) on 5m closes, sweet spot 50-75.
  const r = rsi(closes5m, 14);
  if (r === null) {
    b.skip("RSI(14) unavailable: need 15+ 5m candles");
  } else {
    const label = r < 40 ? "weak" : r > 85 ? "overextended" : r >= 50 && r <= 75 ? "sweet spot" : "neutral";
    b.add(band(r, 30, 50, 75, 95), TECHNICAL_WEIGHTS.rsi, `RSI(14) 5m ${fmt(r, 0)} ${label}`);
  }

  // Price vs EMA(20) on 5m.
  if (closes5m.length < 20 || lastClose5m === undefined) {
    b.skip("EMA(20) 5m unavailable: need 20+ 5m candles");
  } else {
    const e = ema(closes5m, 20);
    const e20 = e[e.length - 1] ?? 0;
    const ratio = e20 > 0 ? lastClose5m / e20 - 1 : 0;
    b.add(
      rampUp(ratio, -0.03, 0.03),
      TECHNICAL_WEIGHTS.ema5m,
      `5m close ${ratio >= 0 ? "above" : "below"} EMA(20) by ${pct(ratio * 100)}`,
    );
  }

  // EMA(9) vs EMA(21) on 1h.
  if (closes1h.length < 21) {
    b.skip("EMA(9)/EMA(21) 1h unavailable: need 21+ 1h candles");
  } else {
    const e9 = ema(closes1h, 9);
    const e21 = ema(closes1h, 21);
    const a = e9[e9.length - 1] ?? 0;
    const c = e21[e21.length - 1] ?? 0;
    const ratio = c > 0 ? a / c - 1 : 0;
    b.add(
      rampUp(ratio, -0.05, 0.05),
      TECHNICAL_WEIGHTS.ema1h,
      `1h EMA(9) ${ratio >= 0 ? "above" : "below"} EMA(21) by ${pct(ratio * 100)}`,
    );
  }

  // Proximity to the 24h high (1h candles preferred, 5m fallback).
  let highs: number[] = [];
  let source = "";
  if (candles1h.length >= 2) {
    highs = candles1h.slice(-24).map((c) => c.h);
    source = "1h";
  } else if (candles5m.length >= 12) {
    highs = candles5m.slice(-288).map((c) => c.h);
    source = "5m";
  }
  const high24 = highs.length > 0 ? Math.max(...highs) : 0;
  if (high24 <= 0 || price <= 0) {
    b.skip("24h high unavailable: no candles");
  } else {
    const prox = price / high24;
    b.add(rampUp(prox, 0.7, 1.0), TECHNICAL_WEIGHTS.high24h, `price at ${fmt(prox * 100, 1)}% of 24h high (${source} candles)`);
  }

  // Buy/sell transaction ratio over the last hour.
  const { buys, sells } = pair.txns.h1;
  if (buys + sells === 0) {
    b.add(0.5, TECHNICAL_WEIGHTS.buySell, "no 1h transactions, buy/sell ratio neutral");
  } else {
    const ratio = sells === 0 ? Math.max(1.4, buys) : buys / sells;
    b.add(rampUp(ratio, 0.6, 1.4), TECHNICAL_WEIGHTS.buySell, `1h buy/sell ratio ${fmt(ratio, 2)} (${buys}/${sells})`);
  }

  const candleWeight = b.coverage - TECHNICAL_WEIGHTS.momentum - TECHNICAL_WEIGHTS.buySell;
  if (candleWeight <= 1e-9) {
    b.note(`no candles available: technical lens uses pair fields only, capped at ${NO_CANDLE_CAP}`);
    return b.build({ cap: NO_CANDLE_CAP });
  }
  return b.build();
}
