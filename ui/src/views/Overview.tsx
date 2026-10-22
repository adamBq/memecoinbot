import { Suspense, lazy, useMemo } from "react";
import { useApi } from "../lib/api";
import type { EquityResponse, PositionsResponse, SummaryDto } from "../types";
import { fmtAgo, fmtDateTime, fmtPct, fmtUsd } from "../lib/format";
import { StatTile } from "../components/StatTile";
import { Delta } from "../components/Delta";
import { BreakerBanner } from "../components/Banner";
import { Badge } from "../components/Badges";
import { InlineError, StaleNote } from "../components/InlineError";

const EquityChart = lazy(() => import("../components/charts").then((m) => ({ default: m.EquityChart })));
const DrawdownChart = lazy(() => import("../components/charts").then((m) => ({ default: m.DrawdownChart })));

export function Overview() {
  const summary = useApi<SummaryDto>("/api/summary");
  const equity = useApi<EquityResponse>("/api/equity");
  const positions = useApi<PositionsResponse>("/api/positions");

  const winRate = useMemo(() => {
    const closed = positions.data?.closed ?? [];
    if (closed.length === 0) return null;
    const wins = closed.filter((p) => p.pnlPct > 0).length;
    return { pct: (wins / closed.length) * 100, wins, total: closed.length };
  }, [positions.data]);

  const s = summary.data;

  return (
    <div className="view">
      {summary.error && !s ? <InlineError message={summary.error} onRetry={summary.refetch} /> : null}
      {summary.stale && summary.error ? <StaleNote message={summary.error} /> : null}
      {s ? <BreakerBanner summary={s} /> : null}

      <section aria-label="Key figures">
        <div className="kpi-grid">
          <StatTile label="Equity" hero value={s ? fmtUsd(s.equityUsd) : summary.loading ? "…" : "—"} delta={s ? <>vs start {fmtUsd(s.startingEquityUsd)}</> : undefined} />
          <StatTile label="Return" value={<Delta value={s?.returnPct} />} delta={s ? <>today <Delta value={s.dayPnlPct} /></> : undefined} />
          <StatTile label="Cash" value={s ? fmtUsd(s.cashUsd) : "—"} delta={s ? <>{fmtPct(s.equityUsd > 0 ? (s.cashUsd / s.equityUsd) * 100 : null, { sign: false })} of equity</> : undefined} />
          <StatTile label="Open positions" value={s ? String(s.openCount) : "—"} delta={s ? <>{s.closedCount} closed</> : undefined} />
          <StatTile label="Drawdown from peak" value={<Delta value={s?.drawdownFromPeakPct} />} delta={s ? <>peak {fmtUsd(s.peakEquityUsd)}</> : undefined} />
          <StatTile
            label="Win rate"
            value={winRate ? fmtPct(winRate.pct, { sign: false }) : positions.loading ? "…" : "—"}
            delta={winRate ? <>{winRate.wins} of {winRate.total} closed</> : positions.error ? <span className="delta-down">unavailable</span> : <>no closed trades</>}
          />
        </div>
      </section>

      <section className="card" aria-label="Bot health">
        <h2>Bot health</h2>
        {s ? (
          <div className="controls">
            <Badge tone={s.botHealthy ? "good" : "bad"}>{s.botHealthy ? "Healthy" : "Stalled"}</Badge>
            <Badge tone={s.killed ? "bad" : s.breakers.haltNewEntries ? "warn" : "good"}>
              {s.killed ? "Killed" : s.breakers.haltNewEntries ? "Entries halted" : "Trading"}
            </Badge>
            <Badge tone="neutral">{s.llmEnabled ? "LLM on" : "LLM off"}</Badge>
            <dl className="meta-list" style={{ flexBasis: "100%", marginTop: 8 }}>
              <dt>Last tick</dt>
              <dd>
                {fmtAgo(s.lastTickAt)} <span className="muted">({fmtDateTime(s.lastTickAt)})</span>
              </dd>
              <dt>Last screen</dt>
              <dd>
                {fmtAgo(s.lastScreenAt)} <span className="muted">({fmtDateTime(s.lastScreenAt)})</span>
              </dd>
              <dt>Started</dt>
              <dd>{fmtDateTime(s.startedAt)}</dd>
              <dt>Consecutive losses</dt>
              <dd>{s.consecutiveLosses}</dd>
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

      <section className="card" aria-labelledby="equity-h">
        <h2 id="equity-h">Equity curve</h2>
        {equity.error && !equity.data ? <InlineError message={equity.error} onRetry={equity.refetch} /> : null}
        {equity.stale && equity.error ? <StaleNote message={equity.error} /> : null}
        {equity.data ? (
          <Suspense fallback={<div className="chart-skeleton">Loading chart…</div>}>
            <EquityChart points={equity.data.points} refreshing={equity.refreshing} />
          </Suspense>
        ) : equity.loading ? <div className="chart-skeleton">Loading equity…</div> : null}
      </section>

      <section className="card" aria-labelledby="dd-h">
        <h2 id="dd-h">Drawdown</h2>
        {equity.data ? (
          <Suspense fallback={<div className="chart-skeleton">Loading chart…</div>}>
            <DrawdownChart points={equity.data.points} refreshing={equity.refreshing} />
          </Suspense>
        ) : equity.loading ? <div className="chart-skeleton">Loading drawdown…</div> : <p className="empty">Unavailable until the equity series loads.</p>}
      </section>
    </div>
  );
}
