/**
 * Dashboard DTO types. Copied verbatim from docs/UI_CONTRACT.md; the shared copy
 * lives at src/ui/types.ts once the server lands. Keep this file free of runtime code.
 */

// ---- Domain types mirrored from src/core/types.ts (only what the DTOs need) ----

export type Mint = string;

export type Side = "buy" | "sell";

export type PositionStatus = "open" | "closed";

export type LensName = "technical" | "fundamental" | "quantitative" | "sentiment" | "event";

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

// ---- DTOs from the contract ----

export interface SummaryDto {
  generatedAt: number; startedAt: number | null; mode: "paper"; configHash: string | null; llmEnabled: boolean;
  startingEquityUsd: number; equityUsd: number; cashUsd: number; returnPct: number;
  peakEquityUsd: number; drawdownFromPeakPct: number; dayStartEquityUsd: number; dayPnlPct: number;
  openCount: number; closedCount: number; killed: boolean; haltedUntil: number | null; consecutiveLosses: number;
  breakers: { haltNewEntries: boolean; killSwitch: boolean; reasons: string[] };
  lastTickAt: number | null; lastScreenAt: number | null;
  /** true when lastTickAt is within 3 minutes of now */
  botHealthy: boolean;
}
export interface EquityPointDto { ts: number; equityUsd: number; cashUsd: number }
export interface OpenPositionDto extends Position { currentPriceUsd: number | null; pnlPct: number | null; unrealizedPnlUsd: number | null; peakPct: number; ageHours: number; remainingPct: number }
export interface ClosedPositionDto extends Position { pnlPct: number; holdHours: number }
export interface DecisionDto { ts: number; mint: string; symbol: string; action: "filtered" | "skip" | "enter" | "exit"; total: number; lenses: Record<LensName, { score: number; reasons: string[] }> | null; reason: string }
export interface CandidateDto extends DecisionDto { rank: number }
export interface NoteDto { ts: number; text: string }

// ---- Response envelopes ----

export interface EquityResponse { points: EquityPointDto[] }
export interface PositionsResponse { open: OpenPositionDto[]; closed: ClosedPositionDto[] }
export interface OrdersResponse { orders: Order[] }
export interface DecisionsResponse { decisions: DecisionDto[]; total: number }
export interface CandidatesResponse { screenedAt: number | null; candidates: CandidateDto[] }
export interface NotesResponse { notes: NoteDto[] }

export type DecisionAction = DecisionDto["action"];

export const LENS_NAMES: readonly LensName[] = ["technical", "fundamental", "quantitative", "sentiment", "event"];
