/** One-off screen in dry-run mode: scores candidates and prints the table, opens nothing. */
import { bootstrap } from "../ops/bootstrap.js";

const { runner, ledger } = bootstrap({ dryRun: true });
const results = await runner.screen();
const rows = results.slice(0, 25).map((r) => ({
  symbol: r.symbol,
  total: r.total.toFixed(3),
  tech: r.lenses.technical.score.toFixed(2),
  fund: r.lenses.fundamental.score.toFixed(2),
  quant: r.lenses.quantitative.score.toFixed(2),
  sent: r.lenses.sentiment.score.toFixed(2),
  event: r.lenses.event.score.toFixed(2),
  filters: r.hardFilterPassed ? "pass" : r.hardFilterFailures[0]?.slice(0, 40) ?? "fail",
  breakout: r.breakoutConfirmed ? "yes" : "no",
}));
console.table(rows);
ledger.close();
