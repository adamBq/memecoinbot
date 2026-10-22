# memecoinbot

Solana memecoin trading bot. Paper trading only in this version: fills are simulated from
real Jupiter quotes, no wallet or key is ever loaded, and `TRADING_MODE=live` refuses to start.

## How it decides

1. **Discover** candidates from DexScreener boosts and profiles, GeckoTerminal trending and new pools.
2. **Prefilter** on liquidity, volume, age, and market cap using pair data only.
3. **Enrich** the shortlist: RugCheck safety report, Jupiter round-trip sellability, 5m and 1h candles,
   CoinGecko trending rank, optional Claude narrative and event rating (score only, never an action).
4. **Hard filters** reject anything unsafe. See `config/strategy.yaml`.
5. **Score** five lenses (technical, fundamental, quantitative, sentiment, event) into a composite.
6. **Enter** when composite and technical pass thresholds, breakout is confirmed, and no breaker is active.
7. **Exit** on safety deterioration, liquidity pull, hard stop, trailing stop, take-profit ladder, or time stop.
8. **Breakers**: daily loss halt, consecutive loss cooldown, max drawdown kill switch.

Every decision, including rejections, is written to the SQLite ledger so the week can be audited.

## Run

```bash
cp .env.example .env            # optional: add ANTHROPIC_API_KEY for narrative scoring
npm install
npm test
npm run screen                  # one dry-run screen, prints the scored table
npm start                       # run the bot in the foreground
```

Under PM2 for the demo week:

```bash
npx pm2 start ecosystem.config.cjs
npx pm2 logs memecoinbot
npm run status                  # open positions and equity
npm run report -- --save        # performance report, saved to reports/YYYY-MM-DD.md
```

Keep the Mac awake while it runs, for example `caffeinate -i -s` in another terminal, or
set the Mac to never sleep on power.

## Dashboard

A read-only local dashboard shows equity, positions, every decision with its reasons, the latest
screen's candidates, and the activity log. It never writes to the ledger and never trades.

```bash
npm run ui:build                # build the React app into ui/dist
npm run ui                      # serve it at http://127.0.0.1:4777 (or let PM2 run memecoinbot-ui)
npm run ui:dev                  # Vite dev server with /api proxied to 4777; add ?mock=1 for sample data
```

## Layout

- `src/core` types, config, http, logger, sanitiser
- `src/data` API clients (DexScreener, GeckoTerminal, Jupiter, RugCheck, CoinGecko)
- `src/analysis` hard filters, indicators, lens scorers, composite, LLM scorer
- `src/strategy` entry, exit, and breaker rules
- `src/execution` ledger (node:sqlite) and paper broker
- `src/ops` runner loop, portfolio state, report builder
- `src/cli` run, screen, status, report, ui
- `src/ui` dashboard API server and DTO builders
- `ui` React dashboard (Vite), built to `ui/dist`

## Deploying 24/7

See `deploy/README.md` for the DigitalOcean plus Tailscale runbook: `deploy/bootstrap.sh` prepares the
server once, `npm run deploy -- bot@<ip>` pushes code and restarts, and the dashboard stays private.

## Going live

Not supported in this version. The security review's required controls are listed in
`docs/BEFORE_LIVE.md`; every item must exist before a wallet key is ever loaded.
