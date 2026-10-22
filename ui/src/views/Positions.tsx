import { useApi } from "../lib/api";
import type { PositionsResponse } from "../types";
import { fmtDateTime, fmtHours, fmtPct, fmtTokenPrice, fmtUsd } from "../lib/format";
import { Delta } from "../components/Delta";
import { Symbol } from "../components/Badges";
import { Reason } from "../components/Reasons";
import { InlineError, StaleNote } from "../components/InlineError";

export function Positions() {
  const { data, error, loading, stale, refetch } = useApi<PositionsResponse>("/api/positions");

  return (
    <div className="view">
      {error && !data ? <InlineError message={error} onRetry={refetch} /> : null}
      {stale && error ? <StaleNote message={error} /> : null}

      <section className="card" aria-labelledby="open-h">
        <h2 id="open-h">Open positions {data ? <span className="subtle">({data.open.length})</span> : null}</h2>
        {loading ? <p className="empty">Loading…</p> : null}
        {data && data.open.length === 0 ? <p className="empty">No open positions.</p> : null}
        {data && data.open.length > 0 ? (
          <div className="table-wrap">
            <table>
              <caption className="visually-hidden">Open positions with live P&amp;L</caption>
              <thead>
                <tr>
                  <th scope="col">Symbol</th>
                  <th scope="col" className="num">P&amp;L</th>
                  <th scope="col" className="num">Unrealized</th>
                  <th scope="col" className="num">Peak</th>
                  <th scope="col" className="num">Entry</th>
                  <th scope="col" className="num">Current</th>
                  <th scope="col" className="num">Cost</th>
                  <th scope="col" className="num">Remaining</th>
                  <th scope="col" className="num">Age</th>
                  <th scope="col">TP1</th>
                  <th scope="col" className="num">Score</th>
                  <th scope="col">Opened</th>
                </tr>
              </thead>
              <tbody>
                {data.open.map((p) => (
                  <tr key={p.id}>
                    <th scope="row"><Symbol symbol={p.symbol} mint={p.mint} /></th>
                    <td className="num"><Delta value={p.pnlPct} /></td>
                    <td className="num">{fmtUsd(p.unrealizedPnlUsd)}</td>
                    <td className="num"><Delta value={p.peakPct} /></td>
                    <td className="num">{fmtTokenPrice(p.entryPriceUsd)}</td>
                    <td className="num">{p.currentPriceUsd === null ? <span className="muted">no price</span> : fmtTokenPrice(p.currentPriceUsd)}</td>
                    <td className="num">{fmtUsd(p.costBasisUsd)}</td>
                    <td className="num">{fmtPct(p.remainingPct, { sign: false })}</td>
                    <td className="num">{fmtHours(p.ageHours)}</td>
                    <td>{p.tp1Hit ? "hit" : "—"}</td>
                    <td className="num">{p.entryScore.toFixed(2)}</td>
                    <td>{fmtDateTime(p.openedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="card" aria-labelledby="closed-h">
        <h2 id="closed-h">Closed positions {data ? <span className="subtle">({data.closed.length}, newest first)</span> : null}</h2>
        {loading ? <p className="empty">Loading…</p> : null}
        {data && data.closed.length === 0 ? <p className="empty">No closed positions yet.</p> : null}
        {data && data.closed.length > 0 ? (
          <div className="table-wrap">
            <table>
              <caption className="visually-hidden">Closed positions with realized P&amp;L</caption>
              <thead>
                <tr>
                  <th scope="col">Symbol</th>
                  <th scope="col" className="num">P&amp;L</th>
                  <th scope="col" className="num">Realized</th>
                  <th scope="col" className="num">Hold</th>
                  <th scope="col">Exit reason</th>
                  <th scope="col" className="num">Entry</th>
                  <th scope="col" className="num">Cost</th>
                  <th scope="col" className="num">Score</th>
                  <th scope="col">Closed</th>
                </tr>
              </thead>
              <tbody>
                {data.closed.map((p) => (
                  <tr key={p.id}>
                    <th scope="row"><Symbol symbol={p.symbol} mint={p.mint} /></th>
                    <td className="num"><Delta value={p.pnlPct} /></td>
                    <td className="num">{fmtUsd(p.realizedPnlUsd)}</td>
                    <td className="num">{fmtHours(p.holdHours)}</td>
                    <td className="wrap">{p.closeReason ? <Reason text={p.closeReason} /> : <span className="muted">—</span>}</td>
                    <td className="num">{fmtTokenPrice(p.entryPriceUsd)}</td>
                    <td className="num">{fmtUsd(p.costBasisUsd)}</td>
                    <td className="num">{p.entryScore.toFixed(2)}</td>
                    <td>{fmtDateTime(p.closedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
