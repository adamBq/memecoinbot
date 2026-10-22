import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";
import "dotenv/config";

const StrategySchema = z.object({
  account: z.object({
    startingEquityUsd: z.number().positive(),
    maxOpenPositions: z.number().int().positive(),
    positionSizePctOfEquity: z.number().positive().max(25),
    minPositionNotionalUsd: z.number().positive(),
  }),
  hardFilters: z.object({
    minLiquidityUsd: z.number(),
    maxLiquidityUsd: z.number(),
    minTokenAgeHours: z.number(),
    maxTokenAgeDays: z.number(),
    minMarketCapUsd: z.number(),
    maxMarketCapUsd: z.number(),
    minVolume24hUsd: z.number(),
    minTxns1h: z.number(),
    maxTop10HolderPct: z.number(),
    maxSingleHolderPct: z.number(),
    requireMintAuthorityRevoked: z.boolean(),
    requireFreezeAuthorityRevoked: z.boolean(),
    minLpLockedPct: z.number(),
    maxRoundTripLossPct: z.number(),
    maxTransferFeePct: z.number(),
    rejectRugcheckDangerRisks: z.array(z.string()),
    minRugcheckNormalisedScore: z.number(),
  }),
  scoring: z.object({
    weights: z.object({
      technical: z.number(),
      fundamental: z.number(),
      quantitative: z.number(),
      sentiment: z.number(),
      event: z.number(),
    }),
    minCompositeToEnter: z.number(),
    minTechnicalToEnter: z.number(),
    requireBreakoutConfirmation: z.boolean(),
  }),
  exits: z.object({
    hardStopLossPct: z.number().min(5).max(60),
    takeProfit1Multiple: z.number(),
    tp1SellFraction: z.number().min(0).max(1),
    trailingStopPctFromPeak: z.number(),
    trailingStopPctFromPeakBeforeTp1: z.number(),
    timeStopHours: z.number(),
    timeStopMinGainPctToHold: z.number(),
    exitOnLiquidityDropPct: z.number(),
    exitOnSafetyDeterioration: z.boolean(),
  }),
  circuitBreakers: z.object({
    // Bounded so a config edit cannot silently disable a breaker.
    dailyLossLimitPct: z.number().min(1).max(50),
    maxDrawdownFromPeakPct: z.number().min(5).max(60),
    maxConsecutiveLosses: z.number().int().min(1).max(50),
    cooldownHours: z.number().min(0.5).max(168),
    dataStaleSeconds: z.number().min(30).max(3600),
    reentryCooldownHours: z.number().min(0).max(720),
  }),
  execution: z.object({
    paperFeePct: z.number(),
    paperExtraSlippagePct: z.number(),
    priorityFeeUsd: z.number(),
    quoteNotionalUsd: z.number(),
  }),
  scheduler: z.object({
    priceCheckSeconds: z.number(),
    screenIntervalSeconds: z.number(),
    equitySnapshotSeconds: z.number(),
    maxCandidatesPerScreen: z.number().int(),
    maxCandlesPerScreen: z.number().int().min(1).max(40),
  }),
  llm: z.object({
    enabled: z.boolean(),
    model: z.string(),
    maxCallsPerScreen: z.number().int(),
    cacheHours: z.number(),
  }),
});

export type StrategyConfig = z.infer<typeof StrategySchema>;

export type DisplayCurrency = "AUD" | "USD";
export const DEFAULT_DISPLAY_CURRENCY: DisplayCurrency = "AUD";
export const DEFAULT_DISPLAY_TIMEZONE = "Australia/Sydney";

export interface AppEnv {
  tradingMode: "paper" | "live";
  dbPath: string;
  strategyConfigPath: string;
  anthropicApiKey: string | undefined;
  /** Currency the dashboard renders money in. Ledger amounts stay USD; conversion is the UI's job. */
  displayCurrency: DisplayCurrency;
  /** IANA zone the dashboard renders timestamps in. */
  displayTimezone: string;
}

/** True when `tz` is an IANA zone this runtime's Intl data recognises. */
export function isValidTimezone(tz: string): boolean {
  if (tz.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseDisplayCurrency(raw: string | undefined): DisplayCurrency {
  const v = (raw ?? "").trim().toUpperCase();
  return v === "AUD" || v === "USD" ? v : DEFAULT_DISPLAY_CURRENCY;
}

function parseDisplayTimezone(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  return isValidTimezone(v) ? v : DEFAULT_DISPLAY_TIMEZONE;
}

export function loadEnv(): AppEnv {
  const mode = process.env.TRADING_MODE ?? "paper";
  if (mode !== "paper" && mode !== "live") throw new Error(`TRADING_MODE must be paper or live, got ${mode}`);
  return {
    tradingMode: mode,
    dbPath: process.env.DB_PATH ?? "data/memecoinbot.db",
    strategyConfigPath: process.env.STRATEGY_CONFIG ?? "config/strategy.yaml",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    displayCurrency: parseDisplayCurrency(process.env.DISPLAY_CURRENCY),
    displayTimezone: parseDisplayTimezone(process.env.DISPLAY_TIMEZONE),
  };
}

/** SHA-256 of the raw config file, stored in the ledger so mid-week edits are visible in the audit trail. */
export function strategyConfigHash(path = process.env.STRATEGY_CONFIG ?? "config/strategy.yaml"): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
}

export function loadStrategyConfig(path = process.env.STRATEGY_CONFIG ?? "config/strategy.yaml"): StrategyConfig {
  const raw = parse(readFileSync(path, "utf8"));
  const cfg = StrategySchema.parse(raw);
  const w = cfg.scoring.weights;
  const sum = w.technical + w.fundamental + w.quantitative + w.sentiment + w.event;
  if (Math.abs(sum - 1) > 1e-6) throw new Error(`scoring weights must sum to 1, got ${sum}`);
  if (cfg.exits.trailingStopPctFromPeakBeforeTp1 < cfg.exits.hardStopLossPct) {
    throw new Error("exits.trailingStopPctFromPeakBeforeTp1 must be >= exits.hardStopLossPct so a trail never exits at a loss");
  }
  return cfg;
}

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
