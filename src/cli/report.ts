import { writeFileSync, mkdirSync } from "node:fs";
import { openLedger } from "../ops/bootstrap.js";
import { getPairsByTokens, pickPrimaryPair } from "../data/dexscreener.js";
import { loadPortfolio } from "../ops/portfolio.js";
import { buildReport, formatReport } from "../ops/report.js";

const { ledger, cfg } = openLedger();
const now = Date.now();
const open = ledger.getOpenPositions();
const prices: Record<string, number> = {};
if (open.length > 0) {
  const pairs = await getPairsByTokens(open.map((p) => p.mint)).catch(() => []);
  for (const p of open) {
    const prim = pickPrimaryPair(pairs.filter((x) => x.mint === p.mint));
    if (prim) prices[p.mint] = prim.priceUsd;
  }
}
const pf = loadPortfolio(ledger, prices, now);
const report = buildReport(ledger, cfg.account.startingEquityUsd, pf.equityUsd, pf.cashUsd, now);
const text = formatReport(report);
console.log(text);
if (process.argv.includes("--save")) {
  mkdirSync("reports", { recursive: true });
  const path = `reports/${new Date(now).toISOString().slice(0, 10)}.md`;
  writeFileSync(path, text + "\n\n```json\n" + JSON.stringify(report, null, 2) + "\n```\n");
  console.log(`saved ${path}`);
}
ledger.close();
