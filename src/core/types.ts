/**
 * Shared domain types. Every module imports from here. Keep this file free of
 * runtime dependencies so it can be used by scorers, tests, and clients alike.
 */

export type Mint = string;

export interface Social {
  type: string;
  url: string;
}

/** A DEX pair snapshot. Sourced from DexScreener, normalised. */
export interface PairSnapshot {
  pairAddress: string;
  dexId: string;
  chainId: "solana";
  mint: Mint;
  symbol: string;
  name: string;
  quoteMint: string;
  quoteSymbol: string;
  priceUsd: number;
  priceNative: number;
  liquidityUsd: number;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  volumeUsd: { m5: number; h1: number; h6: number; h24: number };
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  priceChangePct: { m5: number; h1: number; h6: number; h24: number };
  /** Milliseconds since epoch, null if unknown. */
  pairCreatedAt: number | null;
  boostsActive: number;
  socials: Social[];
  websites: string[];
  labels: string[];
  fetchedAt: number;
}

/** OHLCV candle. `t` is unix seconds for the candle open. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface RiskFlag {
  name: string;
  level: "warn" | "danger" | "info" | string;
  description?: string;
}

/** Token safety data, normalised from RugCheck. */
export interface SafetyReport {
  mint: Mint;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  /** Share held by the top 10 holders, excluding known pool and AMM accounts. 0-100. */
  top10HolderPct: number;
  /** Largest single non-pool holder, 0-100. */
  largestHolderPct: number;
  totalHolders: number;
  /** Highest LP locked percentage across markets, 0-100. Pump.fun AMM counts as 100. */
  lpLockedPct: number;
  rugcheckScoreNormalised: number | null;
  risks: RiskFlag[];
  rugged: boolean;
  transferFeePct: number;
  metadataMutable: boolean;
  launchpad: string | null;
  creator: string | null;
  fetchedAt: number;
}

/** Result of a simulated buy then sell via Jupiter quotes. */
export interface SellabilityCheck {
  mint: Mint;
  routeFound: boolean;
  buyPriceImpactPct: number;
  sellPriceImpactPct: number;
  /** Percent of the input USD retained after buy then sell, 0-100. */
  roundTripRetentionPct: number;
  fetchedAt: number;
}

export interface JupiterQuote {
  inputMint: Mint;
  outputMint: Mint;
  inAmount: bigint;
  outAmount: bigint;
  /** Percent, not a fraction: 0.13 means 0.13%. Jupiter's raw fraction is converted by the client. */
  priceImpactPct: number;
  slippageBps: number;
  routeLabels: string[];
  fetchedAt: number;
}

export interface SentimentSignals {
  mint: Mint;
  boostsActive: number;
  hasWebsite: boolean;
  hasTwitter: boolean;
  hasTelegram: boolean;
  socialCount: number;
  dexscreenerTrendingRank: number | null;
  coingeckoTrendingRank: number | null;
  /** Buyers vs sellers in the last hour, 0-1 where 0.5 is balanced. */
  buyPressure1h: number;
  /** 0-1 from Claude, null when LLM disabled or unavailable. */
  llmNarrativeScore: number | null;
  llmNarrativeReason: string | null;
}

export interface EventSignals {
  mint: Mint;
  /** Pair created in the last 24h on a non-launchpad DEX, i.e. graduated or newly listed. */
  newPoolWithin24h: boolean;
  /** Pump.fun launchpad token now trading on an AMM. */
  graduatedFromLaunchpad: boolean;
  enteredTrendingList: boolean;
  /** Z-score of 1h volume against the trailing 24 one-hour buckets. */
  volumeZScore1h: number;
  /** Candles show a 5m volume spike relative to the 6h average. */
  volumeSpike5m: boolean;
  /** 0-1 from Claude, null when disabled. */
  llmEventScore: number | null;
  llmEventReason: string | null;
}

/** Everything the scoring engine needs for one token. */
export interface TokenContext {
  pair: PairSnapshot;
  candles5m: Candle[];
  candles1h: Candle[];
  safety: SafetyReport | null;
  sellability: SellabilityCheck | null;
  sentiment: SentimentSignals;
  events: EventSignals;
}

export interface LensScore {
  /** 0-1. */
  score: number;
  reasons: string[];
}

export type LensName = "technical" | "fundamental" | "quantitative" | "sentiment" | "event";

export interface CompositeScore {
  mint: Mint;
  symbol: string;
  pairAddress: string;
  total: number;
  lenses: Record<LensName, LensScore>;
  hardFilterPassed: boolean;
  hardFilterFailures: string[];
  breakoutConfirmed: boolean;
  computedAt: number;
}

export type Side = "buy" | "sell";

export interface Fill {
  side: Side;
  mint: Mint;
  qtyTokens: number;
  /** Effective USD price per token after impact, slippage, and fees. */
  effectivePriceUsd: number;
  /** Mid price at the time of the fill, for slippage accounting. */
  referencePriceUsd: number;
  notionalUsd: number;
  feeUsd: number;
  priceImpactPct: number;
  ts: number;
}

export interface Order {
  id: number;
  positionId: number;
  side: Side;
  mint: Mint;
  symbol: string;
  qtyTokens: number;
  effectivePriceUsd: number;
  referencePriceUsd: number;
  notionalUsd: number;
  feeUsd: number;
  priceImpactPct: number;
  reason: string;
  ts: number;
}

export type PositionStatus = "open" | "closed";

export interface Position {
  id: number;
  mint: Mint;
  symbol: string;
  pairAddress: string;
  status: PositionStatus;
  openedAt: number;
  closedAt: number | null;
  entryPriceUsd: number;
  entryLiquidityUsd: number;
  qtyTokens: number;
  remainingQtyTokens: number;
  costBasisUsd: number;
  realizedPnlUsd: number;
  peakPriceUsd: number;
  tp1Hit: boolean;
  entryScore: number;
  closeReason: string | null;
}

export interface PortfolioState {
  cashUsd: number;
  equityUsd: number;
  peakEquityUsd: number;
  dayStartEquityUsd: number;
  dayKey: string;
  openPositions: Position[];
  consecutiveLosses: number;
  haltedUntil: number | null;
  killed: boolean;
  lastExitByMint: Record<Mint, number>;
}

export interface ExitDecision {
  action: "hold" | "sell";
  /** Fraction of the remaining quantity to sell, 0-1. */
  fraction: number;
  reason: string;
}

export interface EntryDecision {
  enter: boolean;
  notionalUsd: number;
  reason: string;
}

export interface BreakerState {
  haltNewEntries: boolean;
  killSwitch: boolean;
  reasons: string[];
}
