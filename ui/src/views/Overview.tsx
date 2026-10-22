import { Suspense, lazy, useMemo } from "react";
import { useApi } from "../lib/api";
import type { EquityResponse, PositionsResponse, SummaryDto } from "../types";
import { fmtDateTime, fmtPct, fmtScore, fmtUsd } from "../lib/format";
import { StatTile } from "../components/StatTile";
import { Delta, DrawdownValue } from "../components/Delta";
import { BreakerBanner } from "../components/Banner";
import { Badge } from "../components/Badges";
import { Ago } from "../components/Ago";
import { InlineError, StaleNote } from "../components/InlineError";
import { ErrorBoundary, isChunkLoadError } from "../components/ErrorBoundary";

const EquityChart = lazy(() => import("../components/charts").then((m) => ({ default: m.EquityChart })));
const DrawdownChart = lazy(() => import("../components/charts").then((m) => ({ default: m.DrawdownChart })));

/** A failed chart render never blanks the KPIs. A failed chunk load needs a reload, not a retry. */
function chartFallback(error: Error, reset: () => void) {
  const chunk = isChunkLoadError(error);
  return <InlineError message={chunk ? "The chart module failed to load. Reload the page to try again." : error.message} onRetry={chunk ? () => window.location.reload() : reset} />;
}

export function Overview() {
  const summary = useApi<SummaryDto>("/api/summary");
  const equity = useApi<EquityResponse>("/api/equity");
  const positions = useApi<PositionsResponse>("/api/positions");

  const winRate = useMemo(() => {
    const closed = positions.data?.closed ?? [];
    if (closed.length === 0) return null;
    const wins = closed.filter((p) => typeof p.pnlPct === "number" && p.pnlPct > 0).length;
    return { pct: (wins / closed.length) * 100, wins, total: closed.length };
  }, [positions.data]);

  const s = summary.data;
  const breakers = s?.breakers;
  const halted = breakers?.haltNewEntries === true;
  const killed = s?.killed === true || breakers?.killSwitch === true;
  const points = equity.data?.points;

  return (
    <div className="view">
      {summary.error && !s ? <InlineError message={summary.error} onRetry={summary.refetch} /> : null}
      {summary.stale && summary.error ? <StaleNote message={summary.error} /> : null}
      {s ? <BreakerBanner summary={s} /> : null}

      <section aria-label="Key figures" aria-busy={summary.refreshing}>
        <div className="kpi-grid">
          <StatTile label="Equity" hero value={s ? fmtUsd(s.equityUsd) : summary.loading ? "…" : "—"} delta={s ? <>vs start {fmtUsd(s.startingEquityUsd)}</> : undefined} />
          <StatTile label="Return" value={<Delta value={s?.returnPct} />} delta={s ? <>today <Delta value={s.dayPnlPct} /></> : undefined} />
          <StatTile label="Cash" value={s ? fmtUsd(s.cashUsd) : "—"} delta={s ? <>{fmtPct(s.equityUsd > 0 ? (s.cashUsd / s.equityUsd) * 100 : null, { sign: false })} of equity</> : undefined} />
          <StatTile label="Open positions" value={s ? String(s.openCount) : "—"} delta={s ? <>{s.closedCount} closed</> : undefined} />
          <StatTile label="Drawdown from peak" value={<DrawdownValue value={s?.drawdownFromPeakPct} />} delta={s ? <>peak {fmtUsd(s.peakEquityUsd)}</> : undefined} />
          <StatTile
            label="Win rate"
            value={winRate ? fmtPct(winRate.pct, { sign: false }) : positions.loading ? "…" : "—"}
            delta={winRate ? <>{winRate.wins} of {winRate.total} closed</> : positions.error ? <span className="delta-down">unavailable</span> : <>no closed trades</>}
          />
        </div>
      </section>

      <section className="card" aria-labelledby="health-h" aria-busy={summary.refreshing}>
        <h3 id="health-h">Bot health</h3>
        {s ? (
          <div className="controls">
            <Badge tone={s.botHealthy ? "good" : "bad"}>{s.botHealthy ? "Healthy" : "Stalled"}</Badge>
            <Badge tone={killed ? "bad" : halted ? "warn" : "good"}>{killed ? "Killed" : halted ? "Entries halted" : "Trading"}</Badge>
            <Badge tone="neutral">{s.llmEnabled ? "LLM on" : "LLM off"}</Badge>
            {s.pricesStale ? <Badge tone="warn">Prices stale</Badge> : null}
            <dl className="meta-list" style={{ flexBasis: "100%", marginTop: 8 }}>
              <dt>Last tick</dt>
              <dd>
                <Ago ts={s.lastTickAt} /> <span className="muted">({fmtDateTime(s.lastTickAt)})</span>
              </dd>
              <dt>Last screen</dt>
              <dd>
                <Ago ts={s.lastScreenAt} /> <span className="muted">({fmtDateTime(s.lastScreenAt)})</span>
              </dd>
              <dt>Started</dt>
              <dd>{fmtDateTime(s.startedAt)}</dd>
              <dt>Consecutive losses</dt>
              <dd>{fmtScore(s.consecutiveLosses) === "—" ? "—" : String(s.consecutiveLosses)}</dd>
              <dt>Config hash</dt>
              <dd>{s.configHash ?? "—"}</dd>
            </dl>
          </div>
        ) : summary.loading ? (
          <p className="empty">Loading…</p>
        ) : (
          <p className="empty">Unavailable until the summary loads.</p>
        )}
      </section>

      <section className="card" aria-labelledby="equity-h" aria-busy={equity.refreshing}>
        <h3 id="equity-h">Equity curve</h3>
        {equity.error && !points ? <InlineError message={equity.error} onRetry={equity.refetch} /> : null}
        {equity.stale && equity.error ? <StaleNote message={equity.error} /> : null}
        {points ? (
          <ErrorBoundary fallback={chartFallback}>
            <Suspense fallback={<div className="chart-skeleton">Loading chart…</div>}>
              <EquityChart points={points} labelId="equity-h" />
            </Suspense>
          </ErrorBoundary>
        ) : equity.loading ? (
          <div className="chart-skeleton">Loading equity…</div>
        ) : null}
      </section>

      <section className="card" aria-labelledby="dd-h" aria-busy={equity.refreshing}>
        <h3 id="dd-h">Drawdown</h3>
        {points ? (
          <ErrorBoundary fallback={chartFallback}>
            <Suspense fallback={<div className="chart-skeleton">Loading chart…</div>}>
              <DrawdownChart points={points} labelId="dd-h" />
            </Suspense>
          </ErrorBoundary>
        ) : equity.loading ? (
          <div className="chart-skeleton">Loading drawdown…</div>
        ) : (
          <p className="empty">Unavailable until the equity series loads.</p>
        )}
      </section>
    </div>
  );
}
