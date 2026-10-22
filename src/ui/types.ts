/**
 * Dashboard DTOs shared by the read-only API server (src/ui/server.ts) and the
 * frontend in ui/ (which imports this file relatively). Keep this file free of
 * runtime imports so the browser bundle never pulls in Node code.
 *
 * Timestamps are epoch milliseconds, money is USD, percentages are plain
 * numbers (12.5 means 12.5%).
 */
import type { LensName, Order, Position } from "../core/types.js";
import type { DisplayCurrency, StrategyConfig } from "../core/config.js";
import type { Report } from "../ops/report.js";

export type DecisionAction = "filtered" | "skip" | "enter" | "exit";

export interface SummaryDto {
  generatedAt: number;
  startedAt: number | null;
  mode: "paper";
  configHash: string | null;
  llmEnabled: boolean;
  startingEquityUsd: number;
  equityUsd: number;
  cashUsd: number;
  returnPct: number;
  peakEquityUsd: number;
  drawdownFromPeakPct: number;
  dayStartEquityUsd: number;
  dayPnlPct: number;
  openCount: number;
  closedCount: number;
  killed: boolean;
  haltedUntil: number | null;
  consecutiveLosses: number;
  breakers: { haltNewEntries: boolean; killSwitch: boolean; reasons: string[] };
  lastTickAt: number | null;
  lastScreenAt: number | null;
  /** true when lastTickAt is within 3 minutes of now */
  botHealthy: boolean;
  /** true when any open position has no live mark or its mark is older than 2 minutes */
  pricesStale: boolean;
  /** How the UI should render money and time. Every amount in every DTO stays USD. */
  display: DisplayDto;
}

export interface DisplayDto {
  currency: DisplayCurrency;
  /** IANA zone, e.g. "Australia/Sydney". */
  timezone: string;
  /** AUD per 1 USD, null when no rate is available (render USD then). */
  audPerUsd: number | null;
  /** When the rate was published, ms. */
  fxAsOf: number | null;
  /** Host the rate came from. */
  fxSource: string | null;
}

export interface EquityPointDto {
  ts: number;
  equityUsd: number;
  cashUsd: number;
}

export interface OpenPositionDto extends Position {
  currentPriceUsd: number | null;
  /** Age of currentPriceUsd in ms, null when there is no live mark. */
  priceAgeMs: number | null;
  pnlPct: number | null;
  unrealizedPnlUsd: number | null;
  /** null when the entry price is not positive. */
  peakPct: number | null;
  ageHours: number;
  remainingPct: number;
}

export interface ClosedPositionDto extends Position {
  /** null when the cost basis is not positive. */
  pnlPct: number | null;
  holdHours: number;
}

export type LensScoresDto = Record<LensName, { score: number; reasons: string[] }>;

export interface DecisionDto {
  ts: number;
  mint: string;
  symbol: string;
  action: DecisionAction;
  total: number;
  lenses: LensScoresDto | null;
  reason: string;
}

export interface CandidateDto extends DecisionDto {
  rank: number;
}

export interface NoteDto {
  ts: number;
  text: string;
}

export interface HealthDto {
  ok: true;
  ts: number;
}

export interface EquityDto {
  points: EquityPointDto[];
}

export interface PositionsDto {
  open: OpenPositionDto[];
  closed: ClosedPositionDto[];
}

export interface OrdersDto {
  orders: Order[];
}

export interface DecisionsDto {
  decisions: DecisionDto[];
  total: number;
}

export interface CandidatesDto {
  screenedAt: number | null;
  candidates: CandidateDto[];
}

export interface NotesDto {
  notes: NoteDto[];
}

export interface ConfigDto {
  path: string;
  yaml: string;
  parsed: StrategyConfig;
  hash: string;
}

export type ReportDto = Report;

export interface ApiErrorDto {
  error: string;
}
