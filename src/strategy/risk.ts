/**
 * Risk and strategy engine: circuit breakers, position sizing, entry gating,
 * and exit rules. Every function here is pure (no I/O, no clock, no logging);
 * the caller passes `now` and the config explicitly. All thresholds come from
 * `StrategyConfig`, nothing is hardcoded.
 *
 * Exit precedence (kill switch is handled by the runner before calling here):
 *   safety deterioration > liquidity drop > hard stop > trailing stop
 *   > take profit 1 > time stop > hold
 */

import type { StrategyConfig } from "../core/config.js";
import type {
  ExitKind,
  BreakerState,
  CompositeScore,
  EntryDecision,
  ExitDecision,
  PortfolioState,
  Position,
  SafetyReport,
} from "../core/types.js";

const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Formatting helpers for human readable reasons
// ---------------------------------------------------------------------------

function fmtPct(n: number, dp = 1): string {
  return `${n.toFixed(dp)}%`;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Memecoin prices can be tiny (1e-7), so use significant figures, not fixed decimals. */
function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return `$${Number(n.toPrecision(6))}`;
}

function fmtHours(ms: number): string {
  return `${(ms / HOUR_MS).toFixed(1)}h`;
}

function fmtIso(ts: number): string {
  return new Date(ts).toISOString();
}

// ---------------------------------------------------------------------------
// PnL helpers
// ---------------------------------------------------------------------------

/** Percent gain of `priceUsd` over the position's entry price. +50 means 1.5x. */
export function pnlPct(pos: Position, priceUsd: number): number {
  if (!(pos.entryPriceUsd > 0)) return 0;
  return (priceUsd / pos.entryPriceUsd - 1) * 100;
}

/**
 * Unrealised PnL of the remaining quantity at `priceUsd`, against the share of
 * the original cost basis that the remaining quantity represents. Falls back
 * to entry price when the position quantity is not usable.
 */
export function unrealizedPnlUsd(pos: Position, priceUsd: number): number {
  const remaining = Math.max(0, pos.remainingQtyTokens);
  const costShare =
    pos.qtyTokens > 0 ? pos.costBasisUsd * (remaining / pos.qtyTokens) : remaining * pos.entryPriceUsd;
  return remaining * priceUsd - costShare;
}

/**
 * Timestamp (ms) until which new entries should be halted after a consecutive
 * loss streak. The runner stores this in `PortfolioState.haltedUntil` when
 * `evaluateBreakers` reports the streak; `evaluateBreakers` then respects it.
 */
export function cooldownUntil(now: number, cfg: StrategyConfig): number {
  return now + cfg.circuitBreakers.cooldownHours * HOUR_MS;
}

// ---------------------------------------------------------------------------
// Circuit breakers
// ---------------------------------------------------------------------------

export function evaluateBreakers(p: PortfolioState, cfg: StrategyConfig, now: number): BreakerState {
  const cb = cfg.circuitBreakers;
  const reasons: string[] = [];
  let killSwitch = false;

  if (p.killed) {
    killSwitch = true;
    reasons.push("kill switch already engaged");
  }

  if (p.peakEquityUsd > 0) {
    const floor = p.peakEquityUsd * (1 - cb.maxDrawdownFromPeakPct / 100);
    if (p.equityUsd <= floor) {
      killSwitch = true;
      const dd = (1 - p.equityUsd / p.peakEquityUsd) * 100;
      reasons.push(
        `kill switch: drawdown ${fmtPct(dd)} from peak ${fmtUsd(p.peakEquityUsd)} ` +
          `(equity ${fmtUsd(p.equityUsd)} <= floor ${fmtUsd(floor)}, limit ${fmtPct(cb.maxDrawdownFromPeakPct)})`,
      );
    }
  }

  let haltNewEntries = killSwitch;

  if (p.dayStartEquityUsd > 0) {
    const floor = p.dayStartEquityUsd * (1 - cb.dailyLossLimitPct / 100);
    if (p.equityUsd <= floor) {
      haltNewEntries = true;
      const loss = (1 - p.equityUsd / p.dayStartEquityUsd) * 100;
      reasons.push(
        `daily loss limit: down ${fmtPct(loss)} on day ${p.dayKey} ` +
          `(equity ${fmtUsd(p.equityUsd)} <= floor ${fmtUsd(floor)}, limit ${fmtPct(cb.dailyLossLimitPct)})`,
      );
    }
  }

  if (cb.maxConsecutiveLosses > 0 && p.consecutiveLosses >= cb.maxConsecutiveLosses) {
    haltNewEntries = true;
    reasons.push(
      `consecutive losses: ${p.consecutiveLosses} >= ${cb.maxConsecutiveLosses}, ` +
        `cooldown ${cb.cooldownHours}h (until ${fmtIso(cooldownUntil(now, cfg))} if started now)`,
    );
  }

  if (p.haltedUntil !== null && now < p.haltedUntil) {
    haltNewEntries = true;
    reasons.push(`cooldown active: halted until ${fmtIso(p.haltedUntil)} (${fmtHours(p.haltedUntil - now)} remaining)`);
  }

  return { haltNewEntries, killSwitch, reasons };
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/** Pct of equity, floored at minPositionNotionalUsd, capped by cash; 0 when cash is below the floor. */
export function positionNotional(p: PortfolioState, cfg: StrategyConfig): number {
  const a = cfg.account;
  if (!(p.cashUsd >= a.minPositionNotionalUsd)) return 0;
  const target = Math.max((p.equityUsd * a.positionSizePctOfEquity) / 100, a.minPositionNotionalUsd);
  return Math.min(target, p.cashUsd);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function skip(reason: string): EntryDecision {
  return { enter: false, notionalUsd: 0, reason };
}

export function evaluateEntry(
  score: CompositeScore,
  p: PortfolioState,
  breakers: BreakerState,
  cfg: StrategyConfig,
  now: number,
  dataAgeSeconds: number,
): EntryDecision {
  const { account, scoring, circuitBreakers: cb } = cfg;

  if (breakers.haltNewEntries) {
    const why = breakers.reasons.length > 0 ? breakers.reasons.join("; ") : "no reason given";
    return skip(`breakers halt new entries: ${why}`);
  }

  if (p.openPositions.length >= account.maxOpenPositions) {
    return skip(`max open positions reached: ${p.openPositions.length} >= ${account.maxOpenPositions}`);
  }

  if (p.openPositions.some((pos) => pos.mint === score.mint)) {
    return skip(`already holding ${score.symbol} (${score.mint})`);
  }

  const lastExit = p.lastExitByMint[score.mint];
  if (lastExit !== undefined) {
    const cooldownMs = cb.reentryCooldownHours * HOUR_MS;
    const since = now - lastExit;
    if (since < cooldownMs) {
      return skip(
        `re-entry cooldown: exited ${score.symbol} ${fmtHours(since)} ago, ` +
          `cooldown ${cb.reentryCooldownHours}h (${fmtHours(cooldownMs - since)} remaining)`,
      );
    }
  }

  if (dataAgeSeconds > cb.dataStaleSeconds) {
    return skip(`stale data: ${dataAgeSeconds.toFixed(0)}s old > ${cb.dataStaleSeconds}s`);
  }

  if (!score.hardFilterPassed) {
    const failures = score.hardFilterFailures.length > 0 ? score.hardFilterFailures.join(", ") : "unspecified";
    return skip(`hard filters failed: ${failures}`);
  }

  if (score.total < scoring.minCompositeToEnter) {
    return skip(`composite ${score.total.toFixed(3)} < ${scoring.minCompositeToEnter}`);
  }

  const technical = score.lenses.technical.score;
  if (technical < scoring.minTechnicalToEnter) {
    return skip(`technical ${technical.toFixed(3)} < ${scoring.minTechnicalToEnter}`);
  }

  if (scoring.requireBreakoutConfirmation && !score.breakoutConfirmed) {
    return skip(`breakout not confirmed (composite ${score.total.toFixed(3)})`);
  }

  const notionalUsd = positionNotional(p, cfg);
  if (notionalUsd <= 0) {
    return skip(
      `insufficient cash: ${fmtUsd(p.cashUsd)} < min notional ${fmtUsd(account.minPositionNotionalUsd)}`,
    );
  }

  const breakout = score.breakoutConfirmed ? "breakout confirmed" : "breakout not confirmed (not required)";
  return {
    enter: true,
    notionalUsd,
    reason:
      `enter ${score.symbol}: composite ${score.total.toFixed(3)} >= ${scoring.minCompositeToEnter}, ` +
      `technical ${technical.toFixed(3)} >= ${scoring.minTechnicalToEnter}, ${breakout}, ` +
      `notional ${fmtUsd(notionalUsd)} (${account.positionSizePctOfEquity}% of ${fmtUsd(p.equityUsd)})`,
  };
}

// ---------------------------------------------------------------------------
// Exits
// ---------------------------------------------------------------------------

/** Returns a copy of `pos` with the peak price ratcheted up to `priceUsd` if higher. */
export function updatePeak(pos: Position, priceUsd: number): Position {
  return { ...pos, peakPriceUsd: Math.max(pos.peakPriceUsd, priceUsd) };
}

function sell(fraction: number, reason: string, kind: ExitKind): ExitDecision {
  return { action: "sell", fraction, reason, kind };
}

export function evaluateExits(
  pos: Position,
  priceUsd: number,
  liquidityUsd: number | null,
  safetyNow: SafetyReport | null,
  cfg: StrategyConfig,
  now: number,
): ExitDecision {
  const ex = cfg.exits;
  const entry = pos.entryPriceUsd;
  const gain = pnlPct(pos, priceUsd);
  const state = `price ${fmtPrice(priceUsd)}, entry ${fmtPrice(entry)}, pnl ${fmtPct(gain)}`;

  // 1. Safety deterioration
  if (ex.exitOnSafetyDeterioration && safetyNow !== null) {
    const flags: string[] = [];
    if (safetyNow.rugged) flags.push("rugged");
    if (!safetyNow.mintAuthorityRevoked) flags.push("mint authority not revoked");
    if (!safetyNow.freezeAuthorityRevoked) flags.push("freeze authority not revoked");
    if (flags.length > 0) {
      return sell(1, `safety deterioration: ${flags.join(", ")} (${state})`, "safety");
    }
  }

  // 2. Liquidity drop vs entry
  if (liquidityUsd !== null) {
    const floor = pos.entryLiquidityUsd * (1 - ex.exitOnLiquidityDropPct / 100);
    if (liquidityUsd < floor) {
      const drop = pos.entryLiquidityUsd > 0 ? (1 - liquidityUsd / pos.entryLiquidityUsd) * 100 : 100;
      return sell(
        1,
        `liquidity drop: ${fmtUsd(liquidityUsd)} is ${fmtPct(drop)} below entry ${fmtUsd(pos.entryLiquidityUsd)} ` +
          `(limit ${fmtPct(ex.exitOnLiquidityDropPct)}, floor ${fmtUsd(floor)}; ${state})`,
        "liquidity",
      );
    }
  }

  // 3. Hard stop
  const hardStopPrice = entry * (1 - ex.hardStopLossPct / 100);
  if (priceUsd <= hardStopPrice) {
    return sell(1, `hard stop: ${state} <= stop ${fmtPrice(hardStopPrice)} (${fmtPct(ex.hardStopLossPct)} below entry)`, "hard_stop");
  }

  // 4. Trailing stop (only once the position has been in profit; the hard stop covers the rest)
  const trailPct = pos.tp1Hit ? ex.trailingStopPctFromPeak : ex.trailingStopPctFromPeakBeforeTp1;
  if (pos.peakPriceUsd > entry) {
    const trailPrice = pos.peakPriceUsd * (1 - trailPct / 100);
    if (priceUsd <= trailPrice) {
      const offPeak = (1 - priceUsd / pos.peakPriceUsd) * 100;
      return sell(
        1,
        `trailing stop${pos.tp1Hit ? " (post-tp1)" : " (pre-tp1)"}: ${fmtPct(offPeak)} off peak ${fmtPrice(pos.peakPriceUsd)} ` +
          `>= ${fmtPct(trailPct)} trail (trigger ${fmtPrice(trailPrice)}; ${state})`,
        "trailing",
      );
    }
  }

  // 5. Take profit 1
  const tp1Price = entry * ex.takeProfit1Multiple;
  if (!pos.tp1Hit && priceUsd >= tp1Price) {
    return sell(
      ex.tp1SellFraction,
      `take profit 1: ${state} >= ${ex.takeProfit1Multiple}x entry (${fmtPrice(tp1Price)}), ` +
        `selling ${fmtPct(ex.tp1SellFraction * 100, 0)} of remaining`,
      "take_profit",
    );
  }

  // 6. Time stop
  const heldMs = now - pos.openedAt;
  const timeStopMs = ex.timeStopHours * HOUR_MS;
  if (heldMs >= timeStopMs && gain < ex.timeStopMinGainPctToHold) {
    return sell(
      1,
      `time stop: held ${fmtHours(heldMs)} >= ${ex.timeStopHours}h with pnl ${fmtPct(gain)} ` +
        `< ${fmtPct(ex.timeStopMinGainPctToHold)} required to hold`,
      "time_stop",
    );
  }

  // 7. Hold
  return {
    action: "hold",
    fraction: 0,
    reason:
      `hold: ${state}, peak ${fmtPrice(pos.peakPriceUsd)}, trail ${fmtPct(trailPct)}, ` +
      `tp1 ${pos.tp1Hit ? "hit" : `at ${fmtPrice(tp1Price)}`}, held ${fmtHours(heldMs)}`,
  };
}
