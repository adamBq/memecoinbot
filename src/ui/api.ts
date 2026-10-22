/**
 * Builders for every dashboard DTO. Each one is a pure function over a Ledger,
 * an already-fetched price map, the strategy config, and `now`, so the HTTP
 * layer in server.ts is a thin shell and everything here is unit testable
 * without a socket. Nothing in this file writes to the ledger.
 */
import { readFileSync } from "node:fs";
import type { Order } from "../core/types.js";
import { loadStrategyConfig, strategyConfigHash, type StrategyConfig } from "../core/config.js";
import type { DecisionRow, Ledger } from "../execution/ledger.js";
import { loadPortfolio, META } from "../ops/portfolio.js";
import { buildReport } from "../ops/report.js";
import { evaluateBreakers, pnlPct, unrealizedPnlUsd } from "../strategy/risk.js";
import type {
  CandidateDto,
  CandidatesDto,
  ClosedPositionDto,
  ConfigDto,
  DecisionAction,
  DecisionDto,
  DecisionsDto,
  EquityDto,
  LensScoresDto,
  NotesDto,
  OpenPositionDto,
  OrdersDto,
  PositionsDto,
  ReportDto,
  SummaryDto,
} from "./types.js";

export type PriceMap = Record<string, number>;
export type GetPrices = (mints: string[]) => Promise<PriceMap>;

const HOUR_MS = 3_600_000;
/** The bot is considered healthy when its last tick is at most this old. */
export const HEALTHY_TICK_AGE_MS = 3 * 60_000;
export const CLOSED_POSITIONS_LIMIT = 200;
export const DECISIONS_DEFAULT_LIMIT = 100;
export const DECISIONS_MAX_LIMIT = 500;
export const ORDERS_DEFAULT_LIMIT = 100;
/** Upper bound used for "all rows" reads so a huge ledger cannot pin the event loop. */
const ALL_ROWS = 100_000;

export const DECISION_ACTIONS: readonly DecisionAction[] = ["filtered", "skip", "enter", "exit"];
const LENS_NAMES = ["technical", "fundamental", "quantitative", "sentiment", "event"] as const;

function metaNumber(ledger: Ledger, key: string): number | null {
  const raw = ledger.getMeta(key);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function isAction(v: string): v is DecisionAction {
  return (DECISION_ACTIONS as readonly string[]).includes(v);
}

/**
 * Parse `lensesJson` into the five-lens shape, or null when it is not an
 * object carrying all five lens keys (exit decisions store `{ kind }`, filtered
 * injection rejections store `{}`, and a corrupt row may store anything).
 */
export function parseLenses(lensesJson: string): LensScoresDto | null {
  let raw: unknown;
  try {
    raw = JSON.parse(lensesJson);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const out: Partial<LensScoresDto> = {};
  for (const name of LENS_NAMES) {
    const lens = rec[name];
    if (typeof lens !== "object" || lens === null || Array.isArray(lens)) return null;
    const { score, reasons } = lens as Record<string, unknown>;
    if (typeof score !== "number" || !Number.isFinite(score)) return null;
    out[name] = {
      score,
      reasons: Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === "string") : [],
    };
  }
  return out as LensScoresDto;
}

export function toDecisionDto(row: DecisionRow): DecisionDto {
  return {
    ts: row.ts,
    mint: row.mint,
    symbol: row.symbol,
    // Unknown actions cannot be produced by the runner; keep the row rather than drop it.
    action: isAction(row.action) ? row.action : "skip",
    total: row.total,
    lenses: parseLenses(row.lensesJson),
    reason: row.reason,
  };
}

// ---------------------------------------------------------------------------

export function buildSummary(ledger: Ledger, cfg: StrategyConfig, prices: PriceMap, now: number): SummaryDto {
  const pf = loadPortfolio(ledger, prices, now, { readOnly: true });
  const breakers = evaluateBreakers(pf, cfg, now);
  const starting = cfg.account.startingEquityUsd;
  const lastTickAt = metaNumber(ledger, META.lastTickAt);
  return {
    generatedAt: now,
    startedAt: metaNumber(ledger, META.started),
    mode: "paper",
    configHash: ledger.getMeta("config_hash"),
    llmEnabled: cfg.llm.enabled && Boolean(process.env.ANTHROPIC_API_KEY),
    startingEquityUsd: starting,
    equityUsd: pf.equityUsd,
    cashUsd: pf.cashUsd,
    returnPct: starting > 0 ? ((pf.equityUsd - starting) / starting) * 100 : 0,
    peakEquityUsd: pf.peakEquityUsd,
    drawdownFromPeakPct: pf.peakEquityUsd > 0 ? Math.max(0, (1 - pf.equityUsd / pf.peakEquityUsd) * 100) : 0,
    dayStartEquityUsd: pf.dayStartEquityUsd,
    dayPnlPct: pf.dayStartEquityUsd > 0 ? (pf.equityUsd / pf.dayStartEquityUsd - 1) * 100 : 0,
    openCount: pf.openPositions.length,
    closedCount: ledger.getClosedPositions(ALL_ROWS).length,
    killed: pf.killed,
    haltedUntil: pf.haltedUntil,
    consecutiveLosses: pf.consecutiveLosses,
    breakers: { haltNewEntries: breakers.haltNewEntries, killSwitch: breakers.killSwitch, reasons: breakers.reasons },
    lastTickAt,
    lastScreenAt: metaNumber(ledger, META.lastScreenAt),
    botHealthy: lastTickAt !== null && now - lastTickAt <= HEALTHY_TICK_AGE_MS,
  };
}

/** Stored equity curve ascending, plus a synthetic point for `now` marked with the live prices. */
export function buildEquity(ledger: Ledger, prices: PriceMap, now: number): EquityDto {
  const pf = loadPortfolio(ledger, prices, now, { readOnly: true });
  const points = ledger.getEquityCurve().map((p) => ({ ts: p.ts, equityUsd: p.equityUsd, cashUsd: p.cashUsd }));
  points.push({ ts: now, equityUsd: pf.equityUsd, cashUsd: pf.cashUsd });
  return { points };
}

export function buildPositions(ledger: Ledger, prices: PriceMap, now: number): PositionsDto {
  const open: OpenPositionDto[] = ledger.getOpenPositions().map((p) => {
    const px = prices[p.mint];
    const currentPriceUsd = px !== undefined && Number.isFinite(px) ? px : null;
    return {
      ...p,
      currentPriceUsd,
      pnlPct: currentPriceUsd === null ? null : pnlPct(p, currentPriceUsd),
      unrealizedPnlUsd: currentPriceUsd === null ? null : unrealizedPnlUsd(p, currentPriceUsd),
      peakPct: p.entryPriceUsd > 0 ? (p.peakPriceUsd / p.entryPriceUsd - 1) * 100 : 0,
      ageHours: (now - p.openedAt) / HOUR_MS,
      remainingPct: p.qtyTokens > 0 ? (p.remainingQtyTokens / p.qtyTokens) * 100 : 0,
    };
  });
  const closed: ClosedPositionDto[] = ledger.getClosedPositions(CLOSED_POSITIONS_LIMIT).map((p) => ({
    ...p,
    pnlPct: p.costBasisUsd > 0 ? (p.realizedPnlUsd / p.costBasisUsd) * 100 : 0,
    holdHours: ((p.closedAt ?? now) - p.openedAt) / HOUR_MS,
  }));
  return { open, closed };
}

/** Newest first, capped at `limit`. */
export function buildOrders(ledger: Ledger, limit: number = ORDERS_DEFAULT_LIMIT): OrdersDto {
  const all: Order[] = ledger.getOrders();
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : ORDERS_DEFAULT_LIMIT;
  return { orders: all.slice(Math.max(0, all.length - n)).reverse() };
}

export interface DecisionsQuery {
  /** Filter to these actions. Empty or undefined means all. Unknown names are ignored. */
  action?: string[];
  /** Page size, default 100, clamped to 1..500. */
  limit?: number;
  /** Rows to skip after filtering, default 0. */
  offset?: number;
  /** Only decisions with ts >= since. */
  since?: number;
}

/** Newest first. `total` counts every matching row before paging. */
export function buildDecisions(ledger: Ledger, query: DecisionsQuery = {}): DecisionsDto {
  const limitRaw = query.limit ?? DECISIONS_DEFAULT_LIMIT;
  const limit = Number.isFinite(limitRaw) ? Math.min(DECISIONS_MAX_LIMIT, Math.max(1, Math.floor(limitRaw))) : DECISIONS_DEFAULT_LIMIT;
  const offset = query.offset !== undefined && Number.isFinite(query.offset) ? Math.max(0, Math.floor(query.offset)) : 0;
  const since = query.since !== undefined && Number.isFinite(query.since) ? query.since : 0;
  const actions = new Set((query.action ?? []).filter(isAction));

  const rows = ledger.getDecisions(since, ALL_ROWS);
  const matching = actions.size > 0 ? rows.filter((r) => actions.has(r.action as DecisionAction)) : rows;
  return {
    decisions: matching.slice(offset, offset + limit).map(toDecisionDto),
    total: matching.length,
  };
}

/**
 * The latest screen: filtered/skip/enter decisions since meta `last_screen_at`,
 * the most recent one per mint, ranked by composite total descending.
 */
/** Window before the latest screen start so the previous completed screen stays visible while the next one runs. */
export const CANDIDATES_WINDOW_MS = 10 * 60 * 1000;

export function buildCandidates(ledger: Ledger, windowMs = CANDIDATES_WINDOW_MS): CandidatesDto {
  const screenedAt = metaNumber(ledger, META.lastScreenAt);
  if (screenedAt === null) return { screenedAt: null, candidates: [] };
  const byMint = new Map<string, DecisionDto>();
  // Rows arrive newest first, so the first one seen per mint is the latest.
  for (const row of ledger.getDecisions(screenedAt - windowMs, ALL_ROWS)) {
    if (row.action === "exit" || !isAction(row.action)) continue;
    if (!byMint.has(row.mint)) byMint.set(row.mint, toDecisionDto(row));
  }
  const sorted = [...byMint.values()].sort((a, b) => b.total - a.total || b.ts - a.ts);
  const candidates: CandidateDto[] = sorted.map((d, i) => ({ ...d, rank: i + 1 }));
  return { screenedAt, candidates };
}

/** Ascending by ts. */
export function buildNotes(ledger: Ledger): NotesDto {
  return { notes: ledger.getNotes() };
}

export function buildReportDto(ledger: Ledger, cfg: StrategyConfig, prices: PriceMap, now: number): ReportDto {
  const pf = loadPortfolio(ledger, prices, now, { readOnly: true });
  return buildReport(ledger, cfg.account.startingEquityUsd, pf.equityUsd, pf.cashUsd, now);
}

/** Reads and validates the strategy file on every call so a mid-week edit is visible immediately. */
export function buildConfigDto(configPath: string): ConfigDto {
  return {
    path: configPath,
    yaml: readFileSync(configPath, "utf8"),
    parsed: loadStrategyConfig(configPath),
    hash: strategyConfigHash(configPath),
  };
}
