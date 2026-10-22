import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import "dotenv/config";

const StrategySchema = z.object({
  account: z.object({
    startingEquityUsd: z.number().positive(),
    maxOpenPositions: z.number().int().positive(),
    positionSizePctOfEquity: z.number().positive().max(100),
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
    hardStopLossPct: z.number(),
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
    dailyLossLimitPct: z.number(),
    maxDrawdownFromPeakPct: z.number(),
    maxConsecutiveLosses: z.number().int(),
    cooldownHours: z.number(),
    dataStaleSeconds: z.number(),
    reentryCooldownHours: z.number(),
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
  }),
  llm: z.object({
    enabled: z.boolean(),
    model: z.string(),
    maxCallsPerScreen: z.number().int(),
    cacheHours: z.number(),
  }),
});

export type StrategyConfig = z.infer<typeof StrategySchema>;

export interface AppEnv {
  tradingMode: "paper" | "live";
  dbPath: string;
  strategyConfigPath: string;
  anthropicApiKey: string | undefined;
}

export function loadEnv(): AppEnv {
  const mode = process.env.TRADING_MODE ?? "paper";
  if (mode !== "paper" && mode !== "live") throw new Error(`TRADING_MODE must be paper or live, got ${mode}`);
  return {
    tradingMode: mode,
    dbPath: process.env.DB_PATH ?? "data/memecoinbot.db",
    strategyConfigPath: process.env.STRATEGY_CONFIG ?? "config/strategy.yaml",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
  };
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
