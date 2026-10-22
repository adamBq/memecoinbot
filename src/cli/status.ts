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
const pf = loadPortfolio(ledger, prices, Date.now());
console.log(`equity ${pf.equityUsd.toFixed(2)}  cash ${pf.cashUsd.toFixed(2)}  peak ${pf.peakEquityUsd.toFixed(2)}  dayStart ${pf.dayStartEquityUsd.toFixed(2)}  killed ${pf.killed}`);
console.log(`last tick ${ledger.getMeta("last_tick_at") ? new Date(Number(ledger.getMeta("last_tick_at"))).toISOString() : "never"}  last screen ${ledger.getMeta("last_screen_at") ? new Date(Number(ledger.getMeta("last_screen_at"))).toISOString() : "never"}`);
console.table(
  open.map((p) => ({
    symbol: p.symbol,
    opened: new Date(p.openedAt).toISOString().slice(0, 16),
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
