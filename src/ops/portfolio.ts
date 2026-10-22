/**
 * Portfolio state is derived from the ledger on every tick so a crash or
 * restart loses nothing. Mutable scalars (cash, peak equity, day start, halt
 * state) live in the ledger meta table.
 */
import type { Ledger } from "../execution/ledger.js";
import type { PortfolioState, Position } from "../core/types.js";
import { isValidTimezone, type StrategyConfig } from "../core/config.js";

export const META = {
  cash: "cash_usd",
  peakEquity: "peak_equity_usd",
  dayKey: "day_key",
  dayStartEquity: "day_start_equity_usd",
  consecutiveLosses: "consecutive_losses",
  haltedUntil: "halted_until",
  killed: "killed",
  started: "started_at",
  lastScreenAt: "last_screen_at",
  lastTickAt: "last_tick_at",
} as const;

/**
 * Timezone whose midnight resets the daily loss breaker. Separate from the display
 * timezone on purpose: a cosmetic change must never move a risk boundary.
 */
const requestedTz = process.env.TRADING_DAY_TIMEZONE?.trim() || "Australia/Sydney";
export const TRADING_DAY_TIMEZONE = isValidTimezone(requestedTz) ? requestedTz : "Australia/Sydney";

const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TRADING_DAY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD in the trading timezone (Sydney). The daily loss breaker resets at this midnight. */
export function utcDayKey(ts: number): string {
  return dayKeyFormatter.format(new Date(ts));
}

function num(ledger: Ledger, key: string, fallback: number): number {
  const v = ledger.getMeta(key);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function ensureInitialised(ledger: Ledger, cfg: StrategyConfig, now: number): void {
  if (ledger.getMeta(META.cash) === null) {
    ledger.setMeta(META.cash, String(cfg.account.startingEquityUsd));
    ledger.setMeta(META.peakEquity, String(cfg.account.startingEquityUsd));
    ledger.setMeta(META.dayKey, utcDayKey(now));
    ledger.setMeta(META.dayStartEquity, String(cfg.account.startingEquityUsd));
    ledger.setMeta(META.consecutiveLosses, "0");
    ledger.setMeta(META.killed, "0");
    ledger.setMeta(META.started, String(now));
    ledger.addNote(now, `initialised paper account with ${cfg.account.startingEquityUsd} USD`);
  }
}

export function markToMarket(positions: Position[], prices: Record<string, number>): number {
  let v = 0;
  for (const p of positions) {
    const px = prices[p.mint] ?? p.entryPriceUsd;
    v += p.remainingQtyTokens * px;
  }
  return v;
}

/** Build the state. `prices` maps mint -> latest USD price for open positions. */
export function loadPortfolio(ledger: Ledger, prices: Record<string, number>, now: number, opts: { readOnly?: boolean } = {}): PortfolioState {
  const write = !opts.readOnly;
  const openPositions = ledger.getOpenPositions();
  const cashUsd = num(ledger, META.cash, 0);
  const equityUsd = cashUsd + markToMarket(openPositions, prices);

  // Roll the trading day at UTC midnight.
  const today = utcDayKey(now);
  let dayKey = ledger.getMeta(META.dayKey) ?? today;
  let dayStartEquityUsd = num(ledger, META.dayStartEquity, equityUsd);
  if (dayKey !== today && write) {
    dayKey = today;
    dayStartEquityUsd = equityUsd;
    ledger.setMeta(META.dayKey, dayKey);
    ledger.setMeta(META.dayStartEquity, String(dayStartEquityUsd));
  }

  let peakEquityUsd = num(ledger, META.peakEquity, equityUsd);
  if (equityUsd > peakEquityUsd && write) {
    peakEquityUsd = equityUsd;
    ledger.setMeta(META.peakEquity, String(peakEquityUsd));
  }

  const haltedRaw = ledger.getMeta(META.haltedUntil);
  const haltedUntil = haltedRaw ? Number(haltedRaw) : null;

  const lastExitByMint: Record<string, number> = {};
  for (const c of ledger.getClosedPositions(200)) {
    if (c.closedAt !== null && (lastExitByMint[c.mint] ?? 0) < c.closedAt) lastExitByMint[c.mint] = c.closedAt;
  }

  return {
    cashUsd,
    equityUsd,
    peakEquityUsd,
    dayStartEquityUsd,
    dayKey,
    openPositions,
    consecutiveLosses: num(ledger, META.consecutiveLosses, 0),
    haltedUntil: haltedUntil && Number.isFinite(haltedUntil) ? haltedUntil : null,
    killed: ledger.getMeta(META.killed) === "1",
    lastExitByMint,
  };
}

export function adjustCash(ledger: Ledger, deltaUsd: number): number {
  const next = num(ledger, META.cash, 0) + deltaUsd;
  ledger.setMeta(META.cash, String(next));
  return next;
}
