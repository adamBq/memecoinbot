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

## Layout

- `src/core` types, config, http, logger, sanitiser
- `src/data` API clients (DexScreener, GeckoTerminal, Jupiter, RugCheck, CoinGecko)
- `src/analysis` hard filters, indicators, lens scorers, composite, LLM scorer
- `src/strategy` entry, exit, and breaker rules
- `src/execution` ledger (node:sqlite) and paper broker
- `src/ops` runner loop, portfolio state, report builder
- `src/cli` run, screen, status, report
