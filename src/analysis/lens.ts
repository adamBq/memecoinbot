/**
 * Shared scaffolding for the five lenses: a weighted component accumulator
 * that renormalises when a component is unavailable, plus small formatting
 * helpers so reasons read consistently.
 */
import type { LensScore, PairSnapshot } from "../core/types.js";
import { clamp01 } from "./indicators.js";

export class LensBuilder {
  private weighted = 0;
  private weightSum = 0;
  private readonly reasons: string[] = [];

  /** Add a scored component. The score is clamped to 0..1. */
  add(score: number, weight: number, reason: string): this {
    const s = clamp01(score);
    this.weighted += s * weight;
    this.weightSum += weight;
    this.reasons.push(`${reason} -> ${fmt(s, 2)}`);
    return this;
  }

  /** Record that a component could not be computed; its weight is dropped. */
  skip(reason: string): this {
    this.reasons.push(`${reason} (skipped)`);
    return this;
  }

  note(reason: string): this {
    this.reasons.push(reason);
    return this;
  }

  /** Total weight of the components that were actually scored. */
  get coverage(): number {
    return this.weightSum;
  }

  build(opts: { cap?: number } = {}): LensScore {
    if (this.weightSum === 0) {
      return { score: 0, reasons: [...this.reasons, "no components available"] };
    }
    let score = clamp01(this.weighted / this.weightSum);
    if (opts.cap !== undefined && score > opts.cap) {
      score = clamp01(opts.cap);
      this.reasons.push(`capped at ${fmt(score, 2)}`);
    }
    return { score, reasons: [...this.reasons] };
  }
}

/** Number with at most `digits` decimals and no trailing zeros. */
export function fmt(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return String(x);
  return Number(x.toFixed(digits)).toString();
}

/** Signed percent string, e.g. "+12.3%". */
export function pct(x: number): string {
  const s = fmt(x, 1);
  return x > 0 ? `+${s}%` : `${s}%`;
}

export function usd(x: number): string {
  return String(Math.round(x));
}

/** Age of the pair in hours, or null when `pairCreatedAt` is unknown. Never negative. */
export function tokenAgeHours(pair: PairSnapshot, now: number): number | null {
  if (pair.pairCreatedAt === null) return null;
  return Math.max(0, (now - pair.pairCreatedAt) / 3_600_000);
}

/** Buyers as a share of all transactions. 0.5 when there are no transactions. */
export function buyPressure(t: { buys: number; sells: number }): number {
  const total = t.buys + t.sells;
  if (total <= 0) return 0.5;
  return t.buys / total;
}
