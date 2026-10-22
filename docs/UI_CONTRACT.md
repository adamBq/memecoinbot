# Dashboard contract

Read-only local dashboard. Server: `src/ui/server.ts` (Node built-in `http`, no framework), default
`127.0.0.1:4777` (`UI_PORT`, `UI_HOST` env). Frontend: Vite + React 19 + TypeScript + Recharts in `ui/`,
built to `ui/dist` and served statically by the server with SPA fallback to `index.html`.
The server never writes to the ledger: it opens `new Ledger(path, { readOnly: true })` (option to be
added in `src/execution/ledger.ts`: `readOnly` opens the DatabaseSync read-only and skips migrations).
Live prices come from `getPairsByTokens` + `pickPrimaryPair` in `src/data/dexscreener.ts`, cached 30s.

All endpoints are `GET`, return `application/json`, and never throw to the client: on failure
respond `{ error: string }` with status 500. Unknown `/api/*` paths return 404 JSON.
Timestamps are epoch milliseconds. Money is USD numbers. Percentages are plain numbers (12.5 means 12.5%).

```ts
// shared types live in src/ui/types.ts and are imported by both server and ui (relative import ../../src/ui/types.ts)
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
```

| Path | Query | Response |
|---|---|---|
| `/api/health` | | `{ ok: true, ts }` |
| `/api/summary` | | `SummaryDto` (uses `loadPortfolio(..., { readOnly: true })`, `evaluateBreakers`, live prices for open positions) |
| `/api/equity` | | `{ points: EquityPointDto[] }` ascending, plus a final synthetic point for "now" using live marks |
| `/api/positions` | | `{ open: OpenPositionDto[]; closed: ClosedPositionDto[] }` closed newest first, max 200 |
| `/api/orders` | `limit` (default 100) | `{ orders: Order[] }` newest first |
| `/api/decisions` | `action` (optional, comma list), `limit` (default 100, max 500), `offset`, `since` (ms) | `{ decisions: DecisionDto[]; total: number }` newest first; `lenses` parsed from `lensesJson`, null when not an object with the five lens keys |
| `/api/candidates` | | `{ screenedAt: number | null; candidates: CandidateDto[] }`: decisions with action in filtered/skip/enter whose ts >= meta `last_screen_at`, one per mint (latest), sorted total desc, rank 1-based |
| `/api/notes` | | `{ notes: NoteDto[] }` ascending |
| `/api/report` | | `Report` from `src/ops/report.ts` `buildReport` |
| `/api/config` | | `{ path: string; yaml: string; parsed: StrategyConfig; hash: string }` |

Frontend views (single page, tabs or sidebar; URL hash routing is enough):
1. **Overview**: KPI tiles (equity, return, cash, open positions, max drawdown, win rate), bot health and breaker banner, equity curve (area), drawdown line, last tick / last screen times.
2. **Positions**: open table with live P&L and peak, closed table with pnl, hold time, exit reason.
3. **Decisions**: filter chips by action, search by symbol, paginated table, row expands to show lens scores as bars and reasons.
4. **Candidates**: latest screen ranked list with composite and the five lens scores as horizontal bars, filter failures shown for rejected rows.
5. **Activity**: notes timeline and recent orders.
Auto refresh every 30s with a visible "updated Xs ago" and a pause toggle. Dark/light follows `prefers-color-scheme`.
Phone width must work (16px gutters, no horizontal page scroll). All interactive elements keyboard reachable with visible focus; tables have proper headers; charts have text alternatives.
