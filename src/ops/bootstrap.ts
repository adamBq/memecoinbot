/** Wires real data clients, ledger, broker, and LLM into a Runner. */
import { loadEnv, loadStrategyConfig } from "../core/config.js";
import { logger } from "../core/logger.js";
import { Ledger } from "../execution/ledger.js";
import { PaperBroker } from "../execution/paper.js";
import { LlmScorer } from "../analysis/llm.js";
import { Runner, type RunnerDeps, type RunnerOptions } from "./runner.js";
import { discoverCandidates } from "../data/discovery.js";
import { getLatestProfiles, getPairsByTokens, getTopBoosts, pickPrimaryPair } from "../data/dexscreener.js";
import { getOhlcv } from "../data/geckoterminal.js";
import { checkSellability, getPricesUsd, getQuote, getSolPriceUsd } from "../data/jupiter.js";
import { getSafetyReport } from "../data/rugcheck.js";
import { getTrendingSolanaMints } from "../data/coingecko.js";

export function realDeps(): RunnerDeps {
  return {
    discoverCandidates,
    getPairsByTokens,
    pickPrimaryPair,
    getOhlcv,
    getSafetyReport,
    checkSellability,
    getPricesUsd,
    getTrendingSolanaMints,
    getLatestProfiles,
    getTopBoosts,
  };
}

export function bootstrap(opts: RunnerOptions = {}): { runner: Runner; ledger: Ledger } {
  const env = loadEnv();
  if (env.tradingMode !== "paper") {
    throw new Error("live trading is not implemented in this version; set TRADING_MODE=paper");
  }
  const cfg = loadStrategyConfig(env.strategyConfigPath);
  const ledger = new Ledger(env.dbPath);
  const broker = new PaperBroker(cfg, { getQuote, getSolPriceUsd });
  const llm = new LlmScorer({
    apiKey: cfg.llm.enabled ? env.anthropicApiKey : undefined,
    model: cfg.llm.model,
    cacheHours: cfg.llm.cacheHours,
    maxCallsPerScreen: cfg.llm.maxCallsPerScreen,
  });
  logger.info({ mode: env.tradingMode, db: env.dbPath, llm: llm.isEnabled(), model: cfg.llm.model }, "bootstrap");
  return { runner: new Runner(cfg, ledger, broker, llm, realDeps(), opts), ledger };
}

export function openLedger(): { ledger: Ledger; cfg: ReturnType<typeof loadStrategyConfig> } {
  const env = loadEnv();
  return { ledger: new Ledger(env.dbPath), cfg: loadStrategyConfig(env.strategyConfigPath) };
}
