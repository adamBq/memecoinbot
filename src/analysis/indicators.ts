/**
 * Pure numeric helpers shared by every lens. No I/O, no logging.
 *
 * Shape helpers (`rampUp`, `rampDown`, `band`) map a raw metric onto 0..1 so
 * that every lens can describe its preferences as "linear between a and b" or
 * "trapezoid with a sweet spot" without repeating clamp arithmetic.
 */
import type { Candle } from "../core/types.js";

export function mean(v: number[]): number {
  if (v.length === 0) return 0;
  let s = 0;
  for (const x of v) s += x;
  return s / v.length;
}

/** Population standard deviation. 0 for fewer than two samples. */
export function stddev(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  let s = 0;
  for (const x of v) s += (x - m) * (x - m);
  return Math.sqrt(s / v.length);
}

/**
 * Exponential moving average. Output has the same length as the input. The
 * first `period` values are seeded with the cumulative mean (so index
 * `period - 1` equals the SMA of the first `period` values); afterwards the
 * standard `k = 2 / (period + 1)` recursion applies.
 */
export function ema(values: number[], period: number): number[] {
  const p = Math.max(1, Math.floor(period));
  const out: number[] = [];
  if (values.length === 0) return out;
  const k = 2 / (p + 1);
  let sum = 0;
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    const x = values[i] ?? 0;
    if (i < p) {
      sum += x;
      prev = sum / (i + 1);
    } else {
      prev = x * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

/** Wilder RSI. Null when fewer than `period + 1` closes. Flat series gives 50. */
export function rsi(closes: number[], period = 14): number | null {
  const p = Math.max(1, Math.floor(period));
  if (closes.length < p + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / p;
  let avgLoss = loss / p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    avgGain = (avgGain * (p - 1) + Math.max(d, 0)) / p;
    avgLoss = (avgLoss * (p - 1) + Math.max(-d, 0)) / p;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Wilder ATR expressed as a percent of the last close. Null when insufficient candles. */
export function atrPct(candles: Candle[], period = 14): number | null {
  const p = Math.max(1, Math.floor(period));
  if (candles.length < p + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (!c || !prev) continue;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c)));
  }
  let atr = mean(trs.slice(0, p));
  for (let i = p; i < trs.length; i++) atr = (atr * (p - 1) + (trs[i] ?? 0)) / p;
  const last = candles[candles.length - 1];
  if (!last || !(last.c > 0)) return null;
  return (atr / last.c) * 100;
}

/**
 * Z-score of `current` against the sample `values`. Null when fewer than two
 * samples or when the sample has zero variance (the score would be undefined).
 */
export function zscore(values: number[], current: number): number | null {
  if (values.length < 2) return null;
  const sd = stddev(values);
  if (sd === 0) return null;
  return (current - mean(values)) / sd;
}

/**
 * Z-score of the last candle's volume against the preceding `lookback`
 * candles. Null when fewer than `minPrior` prior candles exist.
 */
export function lastVolumeZScore(candles: Candle[], lookback = 24, minPrior = 3): number | null {
  if (candles.length < minPrior + 1) return null;
  const last = candles[candles.length - 1];
  if (!last) return null;
  const start = Math.max(0, candles.length - 1 - lookback);
  const prior = candles.slice(start, candles.length - 1).map((c) => c.v);
  return zscore(prior, last.v);
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** 0 at or below `lo`, 1 at or above `hi`, linear between. */
export function rampUp(x: number, lo: number, hi: number): number {
  if (hi <= lo) return x >= hi ? 1 : 0;
  return clamp01((x - lo) / (hi - lo));
}

/** 1 at or below `lo`, 0 at or above `hi`, linear between. */
export function rampDown(x: number, lo: number, hi: number): number {
  return 1 - rampUp(x, lo, hi);
}

/**
 * Trapezoid: 0 below `lo0`, rises to 1 at `lo1`, flat until `hi1`, falls to 0
 * at `hi0`. Describes a "sweet spot" preference.
 */
export function band(x: number, lo0: number, lo1: number, hi1: number, hi0: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < lo1) return rampUp(x, lo0, lo1);
  if (x > hi1) return rampDown(x, hi1, hi0);
  return 1;
}

export function sigmoid(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  return 1 / (1 + Math.exp(-x));
}
