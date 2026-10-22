/**
 * Dashboard DTOs shared by the read-only API server (src/ui/server.ts) and the
 * frontend in ui/ (which imports this file relatively). Keep this file free of
 * runtime imports so the browser bundle never pulls in Node code.
 *
 * Timestamps are epoch milliseconds, money is USD, percentages are plain
 * numbers (12.5 means 12.5%).
 */
import type { LensName, Order, Position } from "../core/types.js";
import type { StrategyConfig } from "../core/config.js";
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
}

export interface EquityPointDto {
  ts: number;
  equityUsd: number;
  cashUsd: number;
}

export interface OpenPositionDto extends Position {
  currentPriceUsd: number | null;
  pnlPct: number | null;
  unrealizedPnlUsd: number | null;
  peakPct: number;
  ageHours: number;
  remainingPct: number;
}

export interface ClosedPositionDto extends Position {
  pnlPct: number;
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
