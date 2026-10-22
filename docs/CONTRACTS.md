# Module contracts

All modules are ESM TypeScript, strict mode, imports use `.js` extensions
(`import { x } from "../core/types.js"`). Shared types live in `src/core/types.ts`
and must not be changed by feature agents; if a type is missing, add it to your
own module and report it. HTTP goes through `getJson` in `src/core/http.ts`
with a per-host `limiterFor(...)` and a `TtlCache`. Logging via `logger` from
`src/core/logger.ts`. Config via `loadStrategyConfig()` in `src/core/config.ts`.
Untrusted text (token names, descriptions, socials) goes through
`sanitizeUntrustedText` before any prompt.

Tests: Vitest, in `tests/<module>.test.ts`, fixtures as JSON in `tests/fixtures/`.
Tests never hit the network: record a real response once with curl, save it as a
fixture, and test the normaliser against it. Mock `getJson` with `vi.mock` for
client-level tests. Run `npm run typecheck && npm run lint && npx vitest run tests/<yours>`
before reporting done.

## src/data/dexscreener.ts
```ts
export function normalizePair(raw: unknown): PairSnapshot | null;            // null when not solana or malformed
export function pickPrimaryPair(pairs: PairSnapshot[]): PairSnapshot | null; // highest liquidity, prefer WSOL/USDC quote
export async function getPairsByTokens(mints: string[]): Promise<PairSnapshot[]>; // GET /tokens/v1/solana/{csv up to 30}, batches
export async function getPairByAddress(pairAddress: string): Promise<PairSnapshot | null>; // GET /latest/dex/pairs/solana/{addr}
export async function getTopBoosts(): Promise<Array<{ mint: string; totalAmount: number }>>; // GET /token-boosts/top/v1 filtered to solana
export async function getLatestProfiles(): Promise<Array<{ mint: string; description: string | null }>>; // GET /token-profiles/latest/v1
export async function searchPairs(q: string): Promise<PairSnapshot[]>;
```
Rate limits: 300/min for pairs and tokens, 60/min for boosts and profiles. Cache pairs 30s.

## src/data/geckoterminal.ts
```ts
export async function getTrendingPools(pages?: number): Promise<Array<{ pairAddress: string; mint: string; rank: number }>>;
export async function getNewPools(pages?: number): Promise<Array<{ pairAddress: string; mint: string; createdAt: number }>>;
export async function getOhlcv(pairAddress: string, timeframe: "minute" | "hour" | "day", aggregate: number, limit: number): Promise<Candle[]>; // ascending by t
```
Rate limit 30/min. Cache OHLCV for one candle period.

## src/data/discovery.ts
```ts
export interface Candidate { mint: string; pairAddress: string | null; sources: string[] } // sources: dex_boost | dex_profile | gecko_trending | gecko_new
export async function discoverCandidates(): Promise<Candidate[]>; // dedup by mint, tolerant of any single source failing
```

## src/data/jupiter.ts
Base URL `https://lite-api.jup.ag`. Quote: `/swap/v1/quote?inputMint&outputMint&amount&slippageBps`. Price: `/price/v3?ids=csv`.
```ts
export async function getQuote(inputMint: string, outputMint: string, amountRaw: bigint, slippageBps?: number): Promise<JupiterQuote | null>;
export async function getPricesUsd(mints: string[]): Promise<Record<string, { usdPrice: number; decimals: number; liquidity: number }>>;
export async function checkSellability(mint: string, notionalUsd: number): Promise<SellabilityCheck>; // buy notional of token with WSOL, quote selling the received amount back, compute retention
export async function getSolPriceUsd(): Promise<number>;
```
Rate limit 60/min (be conservative). Cache prices 20s, quotes not cached.

## src/data/rugcheck.ts
GET `https://api.rugcheck.xyz/v1/tokens/{mint}/report`. Fields seen live: mintAuthority, freezeAuthority, topHolders[{address, owner, pct, insider}], knownAccounts{addr:{name,type}}, markets[{marketType, lp:{lpLockedPct}}], risks[{name, level, description}], score_normalised, rugged, totalHolders, transferFee{pct}, tokenMeta{mutable}, launchpad, creator, lockers.
```ts
export function normalizeRugcheckReport(raw: unknown, mint: string): SafetyReport;
export async function getSafetyReport(mint: string): Promise<SafetyReport | null>; // null on 4xx or "unable to generate report"
```
Holder concentration must exclude accounts that are pools, AMMs, LP, lockers, or marketType accounts (match knownAccounts type or name with /amm|pool|lp|raydium|orca|meteora|pump|locker|vault/i and exclude any holder address that equals a market's address). `pump_fun_amm` markets count as 100% locked. Rate limit 30/min, cache 10 min.

## src/data/coingecko.ts
```ts
export async function getTrendingSolanaMints(): Promise<Array<{ mint: string; rank: number; name: string; symbol: string }>>; // /search/trending then /coins/{id} for platforms.solana, cache 15 min
```

## src/analysis/*
```ts
// indicators.ts
export function ema(values: number[], period: number): number[];
export function rsi(closes: number[], period?: number): number | null;
export function atrPct(candles: Candle[], period?: number): number | null; // ATR as percent of last close
export function zscore(values: number[], current: number): number | null;
export function mean(v: number[]): number; export function stddev(v: number[]): number;
// hardFilters.ts
export function applyHardFilters(ctx: TokenContext, cfg: StrategyConfig, now?: number): { passed: boolean; failures: string[] };
// breakout.ts
export function isBreakoutConfirmed(ctx: TokenContext): boolean; // last close above the high of the prior 6h (excluding last 1h) on 5m candles AND last 1h volume > 1.5x avg 1h volume of prior 6h
// technical.ts | fundamental.ts | quantitative.ts | sentiment.ts | event.ts
export function scoreTechnical(ctx: TokenContext, cfg: StrategyConfig): LensScore;  // and the other four by the same shape
// signals.ts
export function buildSentimentSignals(pair: PairSnapshot, ranks: { dexscreener: number | null; coingecko: number | null }, llm: { score: number; reason: string } | null): SentimentSignals;
export function buildEventSignals(pair: PairSnapshot, candles5m: Candle[], candles1h: Candle[], safety: SafetyReport | null, enteredTrending: boolean, llm: { score: number; reason: string } | null): EventSignals;
// composite.ts
export function scoreToken(ctx: TokenContext, cfg: StrategyConfig, now?: number): CompositeScore;
```
All scores are clamped 0..1 with human readable reasons. Hard filters run first; a failed filter yields `hardFilterPassed=false` and total 0.

## src/analysis/llm.ts
```ts
export interface LlmAssessment { narrativeScore: number; narrativeReason: string; eventScore: number; eventReason: string }
export interface LlmInput { mint: string; symbol: string; name: string; description: string | null; socials: Social[]; websites: string[]; ageHours: number; dexId: string; priceChange24hPct: number; launchpad: string | null }
export class LlmScorer {
  constructor(opts: { apiKey: string | undefined; model: string; cacheHours: number; maxCallsPerScreen: number });
  isEnabled(): boolean;
  resetBudget(): void;                 // called at the start of every screen
  assess(input: LlmInput): Promise<LlmAssessment | null>; // null when disabled, over budget, or on error; never throws
}
```
The model returns a score only, through a forced tool call with a strict JSON schema. No tools that act. All strings sanitised. Flagged inputs are not sent and return null.

## src/strategy/risk.ts
```ts
export function evaluateBreakers(p: PortfolioState, cfg: StrategyConfig, now: number): BreakerState;
export function positionNotional(p: PortfolioState, cfg: StrategyConfig): number; // pct of equity, floored at minPositionNotionalUsd, capped by cash
export function evaluateEntry(score: CompositeScore, p: PortfolioState, breakers: BreakerState, cfg: StrategyConfig, now: number, dataAgeSeconds: number): EntryDecision;
export function updatePeak(pos: Position, priceUsd: number): Position;
export function evaluateExits(pos: Position, priceUsd: number, liquidityUsd: number | null, safetyNow: SafetyReport | null, cfg: StrategyConfig, now: number): ExitDecision;
```
Exit precedence: kill switch > safety deterioration > liquidity drop > hard stop > trailing stop > take profit 1 > time stop > hold.

## src/execution/ledger.ts (node:sqlite, `DatabaseSync`)
```ts
export class Ledger {
  constructor(dbPath: string); // ":memory:" allowed for tests; runs migrations in constructor
  close(): void;
  getMeta(key: string): string | null; setMeta(key: string, value: string): void;
  openPosition(input: Omit<Position, "id" | "status" | "closedAt" | "realizedPnlUsd" | "remainingQtyTokens" | "tp1Hit" | "closeReason" | "peakPriceUsd">): Position;
  updatePosition(pos: Position): void;
  closePosition(id: number, closedAt: number, reason: string): void;
  getOpenPositions(): Position[]; getClosedPositions(limit?: number): Position[]; getPosition(id: number): Position | null;
  recordOrder(o: Omit<Order, "id">): Order; getOrders(positionId?: number): Order[];
  snapshotEquity(ts: number, equityUsd: number, cashUsd: number, openCount: number): void; getEquityCurve(): Array<{ ts: number; equityUsd: number; cashUsd: number }>;
  recordDecision(d: { ts: number; mint: string; symbol: string; action: "filtered" | "skip" | "enter" | "exit"; total: number; lensesJson: string; reason: string }): void;
  getDecisions(sinceTs: number, limit?: number): Array<{ ts: number; mint: string; symbol: string; action: string; total: number; lensesJson: string; reason: string }>;
  getLastExitTs(mint: string): number | null;
  addNote(ts: number, text: string): void; getNotes(): Array<{ ts: number; text: string }>;
}
```

## src/execution/paper.ts
```ts
export function simulateFill(args: { side: Side; mint: string; referencePriceUsd: number; qtyTokens?: number; notionalUsd?: number; priceImpactPct: number; exec: StrategyConfig["execution"]; ts: number }): Fill;
export class PaperBroker {
  constructor(cfg: StrategyConfig, deps: { getQuote: typeof getQuote; getSolPriceUsd: typeof getSolPriceUsd });
  buy(pair: PairSnapshot, decimals: number, notionalUsd: number, ts: number): Promise<Fill>;  // impact from a Jupiter WSOL->token quote; fallback impact 2% if no route
  sell(pair: PairSnapshot, decimals: number, qtyTokens: number, ts: number): Promise<Fill>;
}
```
Buy effective price = reference * (1 + impact + extraSlippage) and fee added; sell effective price = reference * (1 - impact - extraSlippage) minus fee. Notional in and out must reconcile so the ledger balances.
