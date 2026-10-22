/** Performance report from the ledger. Pure over ledger reads so it is testable. */
import type { Ledger } from "../execution/ledger.js";
import type { Position } from "../core/types.js";

export interface Report {
  generatedAt: number;
  startedAt: number | null;
  startingEquityUsd: number;
  equityUsd: number;
  cashUsd: number;
  returnPct: number;
  peakEquityUsd: number;
  maxDrawdownPct: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgWinUsd: number;
  avgLossUsd: number;
  profitFactor: number;
  bestTrade: { symbol: string; pnlUsd: number } | null;
  worstTrade: { symbol: string; pnlUsd: number } | null;
  avgHoldHours: number;
  exitReasons: Record<string, number>;
  decisionsLast24h: { scored: number; filtered: number; entered: number; exited: number };
  notes: Array<{ ts: number; text: string }>;
}

export function buildReport(ledger: Ledger, startingEquityUsd: number, currentEquityUsd: number, cashUsd: number, now: number): Report {
  const closed = ledger.getClosedPositions(10000);
  const open = ledger.getOpenPositions();
  const curve = ledger.getEquityCurve();
  let peak = startingEquityUsd;
  let maxDd = 0;
  for (const pt of [...curve, { ts: now, equityUsd: currentEquityUsd, cashUsd }]) {
    if (pt.equityUsd > peak) peak = pt.equityUsd;
    const dd = ((peak - pt.equityUsd) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
  }
  const wins = closed.filter((p) => p.realizedPnlUsd > 0);
  const losses = closed.filter((p) => p.realizedPnlUsd <= 0);
  const grossWin = wins.reduce((s, p) => s + p.realizedPnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p.realizedPnlUsd, 0));
  const byPnl = [...closed].sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd);
  const holdHours = closed.map((p) => ((p.closedAt ?? now) - p.openedAt) / 3600e3);
  const exitReasons: Record<string, number> = {};
  for (const p of closed) {
    const k = (p.closeReason ?? "unknown").split(":")[0]!.trim().toLowerCase();
    exitReasons[k] = (exitReasons[k] ?? 0) + 1;
  }
  const dec = ledger.getDecisions(now - 24 * 3600e3, 100000);
  const count = (a: string) => dec.filter((d) => d.action === a).length;
  const startedRaw = ledger.getMeta("started_at");
  const tradeRef = (p: Position | undefined) => (p ? { symbol: p.symbol, pnlUsd: p.realizedPnlUsd } : null);
  return {
    generatedAt: now,
    startedAt: startedRaw ? Number(startedRaw) : null,
    startingEquityUsd,
    equityUsd: currentEquityUsd,
    cashUsd,
    returnPct: ((currentEquityUsd - startingEquityUsd) / startingEquityUsd) * 100,
    peakEquityUsd: peak,
    maxDrawdownPct: maxDd,
    closedTrades: closed.length,
    openTrades: open.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: closed.length ? (wins.length / closed.length) * 100 : 0,
    avgWinUsd: wins.length ? grossWin / wins.length : 0,
    avgLossUsd: losses.length ? grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    bestTrade: tradeRef(byPnl[0]),
    worstTrade: tradeRef(byPnl[byPnl.length - 1]),
    avgHoldHours: holdHours.length ? holdHours.reduce((a, b) => a + b, 0) / holdHours.length : 0,
    exitReasons,
    decisionsLast24h: { scored: count("skip"), filtered: count("filtered"), entered: count("enter"), exited: count("exit") },
    notes: ledger.getNotes().slice(-10),
  };
}

const REPORT_TZ = process.env.DISPLAY_TIMEZONE || "Australia/Sydney";
const tsFmt = new Intl.DateTimeFormat("en-AU", {
  timeZone: REPORT_TZ,
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZoneName: "short",
});
const when = (ts: number) => tsFmt.format(new Date(ts));

export function formatReport(r: Report): string {
  const f = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : String(n));
  const lines = [
    `# memecoinbot paper report  ${when(r.generatedAt)}  (amounts in USD; the dashboard shows AUD)`,
    r.startedAt ? `started ${when(r.startedAt)}  (${((r.generatedAt - r.startedAt) / 86400e3).toFixed(1)} days)` : "",
    ``,
    `equity      ${f(r.equityUsd)} USD  (start ${f(r.startingEquityUsd)}, return ${f(r.returnPct)}%)`,
    `cash        ${f(r.cashUsd)} USD   peak ${f(r.peakEquityUsd)}   max drawdown ${f(r.maxDrawdownPct)}%`,
    `trades      ${r.closedTrades} closed, ${r.openTrades} open   win rate ${f(r.winRatePct)}%  (${r.wins}W/${r.losses}L)`,
    `avg win     ${f(r.avgWinUsd)}   avg loss ${f(r.avgLossUsd)}   profit factor ${f(r.profitFactor)}   avg hold ${f(r.avgHoldHours)}h`,
    `best        ${r.bestTrade ? `${r.bestTrade.symbol} ${f(r.bestTrade.pnlUsd)}` : "-"}   worst ${r.worstTrade ? `${r.worstTrade.symbol} ${f(r.worstTrade.pnlUsd)}` : "-"}`,
    `exits       ${Object.entries(r.exitReasons).map(([k, v]) => `${k}=${v}`).join(", ") || "-"}`,
    `last 24h    scored ${r.decisionsLast24h.scored}, filtered ${r.decisionsLast24h.filtered}, entered ${r.decisionsLast24h.entered}, exited ${r.decisionsLast24h.exited}`,
    ``,
    `notes:`,
    ...r.notes.map((n) => `  ${when(n.ts)}  ${n.text}`),
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}
