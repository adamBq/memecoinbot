import { openLedger } from "../ops/bootstrap.js";
import { getPairsByTokens, pickPrimaryPair } from "../data/dexscreener.js";
import { loadPortfolio } from "../ops/portfolio.js";
import { pnlPct } from "../strategy/risk.js";

const { ledger } = openLedger();
const open = ledger.getOpenPositions();
const prices: Record<string, number> = {};
if (open.length > 0) {
  const pairs = await getPairsByTokens(open.map((p) => p.mint));
  for (const p of open) {
    const prim = pickPrimaryPair(pairs.filter((x) => x.mint === p.mint));
    if (prim) prices[p.mint] = prim.priceUsd;
  }
}
const pf = loadPortfolio(ledger, prices, Date.now(), { readOnly: true });
console.log(`equity ${pf.equityUsd.toFixed(2)}  cash ${pf.cashUsd.toFixed(2)}  peak ${pf.peakEquityUsd.toFixed(2)}  dayStart ${pf.dayStartEquityUsd.toFixed(2)}  killed ${pf.killed}`);
const local = (v: string | null) => (v ? new Date(Number(v)).toLocaleString("en-AU", { timeZone: process.env.DISPLAY_TIMEZONE || "Australia/Sydney", timeZoneName: "short" }) : "never");
console.log(`last tick ${local(ledger.getMeta("last_tick_at"))}  last screen ${local(ledger.getMeta("last_screen_at"))}`);
console.table(
  open.map((p) => ({
    symbol: p.symbol,
    opened: new Date(p.openedAt).toLocaleString("en-AU", { timeZone: process.env.DISPLAY_TIMEZONE || "Australia/Sydney", hour12: false }),
    entry: p.entryPriceUsd,
    now: prices[p.mint] ?? null,
    pnlPct: prices[p.mint] ? pnlPct(p, prices[p.mint]!).toFixed(1) : "?",
    remainingPct: ((p.remainingQtyTokens / p.qtyTokens) * 100).toFixed(0),
    realized: p.realizedPnlUsd.toFixed(2),
    tp1: p.tp1Hit,
    peakPct: (((p.peakPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100).toFixed(1),
  })),
);
ledger.close();
