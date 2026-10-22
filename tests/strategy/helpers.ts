/**
 * Shared builders for strategy tests. The config is loaded from the real
 * strategy.yaml for shape, then the sections the tests depend on are pinned
 * explicitly so a mid-week yaml edit cannot silently change expectations.
 */
import { loadStrategyConfig, type StrategyConfig } from "../../src/core/config.js";
import type { CompositeScore, PortfolioState, Position, SafetyReport } from "../../src/core/types.js";

export const HOUR = 3_600_000;
export const T0 = Date.UTC(2026, 9, 22, 0, 0, 0);
export const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

export function makeCfg(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  const base = loadStrategyConfig("config/strategy.yaml");
  return {
    ...base,
    account: { startingEquityUsd: 1000, maxOpenPositions: 5, positionSizePctOfEquity: 8, minPositionNotionalUsd: 25 },
    scoring: { ...base.scoring, minCompositeToEnter: 0.62, minTechnicalToEnter: 0.55, requireBreakoutConfirmation: true },
    exits: {
      hardStopLossPct: 30,
      takeProfit1Multiple: 2.0,
      tp1SellFraction: 0.5,
      trailingStopPctFromPeak: 25,
      trailingStopPctFromPeakBeforeTp1: 40,
      timeStopHours: 48,
      timeStopMinGainPctToHold: 15,
      exitOnLiquidityDropPct: 40,
      exitOnSafetyDeterioration: true,
    },
    circuitBreakers: {
      dailyLossLimitPct: 10,
      maxDrawdownFromPeakPct: 25,
      maxConsecutiveLosses: 6,
      cooldownHours: 12,
      dataStaleSeconds: 300,
      reentryCooldownHours: 24,
    },
    ...overrides,
  };
}

export function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 1,
    mint: MINT,
    symbol: "BONK",
    pairAddress: "pair1",
    status: "open",
    openedAt: T0,
    closedAt: null,
    entryPriceUsd: 1.0,
    entryLiquidityUsd: 100_000,
    qtyTokens: 100,
    remainingQtyTokens: 100,
    costBasisUsd: 100,
    realizedPnlUsd: 0,
    peakPriceUsd: 1.0,
    tp1Hit: false,
    entryScore: 0.7,
    closeReason: null,
    ...overrides,
  };
}

export function makePortfolio(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    cashUsd: 1000,
    equityUsd: 1000,
    peakEquityUsd: 1000,
    dayStartEquityUsd: 1000,
    dayKey: "2026-10-22",
    openPositions: [],
    consecutiveLosses: 0,
    haltedUntil: null,
    killed: false,
    lastExitByMint: {},
    ...overrides,
  };
}

export function makeScore(overrides: Partial<CompositeScore> = {}): CompositeScore {
  return {
    mint: MINT,
    symbol: "BONK",
    pairAddress: "pair1",
    total: 0.7,
    lenses: {
      technical: { score: 0.65, reasons: [] },
      fundamental: { score: 0.7, reasons: [] },
      quantitative: { score: 0.7, reasons: [] },
      sentiment: { score: 0.7, reasons: [] },
      event: { score: 0.7, reasons: [] },
    },
    hardFilterPassed: true,
    hardFilterFailures: [],
    breakoutConfirmed: true,
    computedAt: T0,
    ...overrides,
  };
}

export function makeSafety(overrides: Partial<SafetyReport> = {}): SafetyReport {
  return {
    mint: MINT,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    top10HolderPct: 20,
    largestHolderPct: 5,
    totalHolders: 5000,
    lpLockedPct: 100,
    rugcheckScoreNormalised: 1,
    risks: [],
    rugged: false,
    transferFeePct: 0,
    metadataMutable: false,
    launchpad: null,
    creator: null,
    fetchedAt: T0,
    ...overrides,
  };
}
