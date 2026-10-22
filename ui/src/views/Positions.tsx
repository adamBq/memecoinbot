import { useApi } from "../lib/api";
import { useFmt, useSummary } from "../lib/display";
import type { PositionsResponse } from "../types";
import { fmtHours, fmtPct, fmtScore } from "../lib/format";
import { Delta } from "../components/Delta";
import { Symbol } from "../components/Badges";
import { Ago } from "../components/Ago";
import { Reason } from "../components/Reasons";
import { TableWrap } from "../components/TableWrap";
import { InlineError, StaleNote } from "../components/InlineError";

export function Positions() {
  const { data, error, loading, stale, refreshing, refetch, updatedAt } = useApi<PositionsResponse>("/api/positions");
  const summary = useSummary();
  const fmt = useFmt();
  const cur = fmt.currencySymbol;
  const pricesStale = summary.data?.pricesStale === true;
  const open = data?.open ?? [];
  const closed = data?.closed ?? [];

  return (
    <div className="view">
      {error && !data ? <InlineError message={error} onRetry={refetch} /> : null}
      {stale && error ? <StaleNote message={error} /> : null}
      {pricesStale ? (
        <p className="stale-note" role="status">
          <strong>Prices stale:</strong> at least one open position has no live mark or its mark is older than 2 minutes, so P&amp;L below may lag.
        </p>
      ) : null}

      <section className="card" aria-labelledby="open-h" aria-busy={refreshing}>
        <h3 id="open-h">Open positions {data ? <span className="subtle">({open.length})</span> : null}</h3>
        {loading ? <p className="empty">Loading…</p> : null}
        {data && open.length === 0 ? <p className="empty">No open positions.</p> : null}
        {open.length > 0 ? (
          <TableWrap label="Open positions table">
            <table>
              <caption className="visually-hidden">Open positions with live P&amp;L</caption>
              <thead>
                <tr>
                  <th scope="col">Symbol</th>
                  <th scope="col" className="num">P&amp;L</th>
                  <th scope="col" className="num">Unrealized ({cur})</th>
                  <th scope="col" className="num">Peak</th>
                  <th scope="col" className="num">Entry ({cur})</th>
                  <th scope="col" className="num">Current ({cur})</th>
                  <th scope="col" className="num">Cost ({cur})</th>
                  <th scope="col" className="num">Remaining</th>
                  <th scope="col" className="num">Age</th>
                  <th scope="col">TP1</th>
                  <th scope="col" className="num">Score</th>
                  <th scope="col">Opened ({fmt.zoneAbbr})</th>
                </tr>
              </thead>
              <tbody>
                {open.map((p, i) => (
                  <tr key={`${p.id}:${i}`}>
                    <th scope="row"><Symbol symbol={p.symbol} mint={p.mint} /></th>
                    <td className="num"><Delta value={p.pnlPct} /></td>
                    <td className="num">{fmt.money(p.unrealizedPnlUsd)}</td>
                    <td className="num"><Delta value={p.peakPct} /></td>
                    <td className="num">{fmt.tokenPrice(p.entryPriceUsd)}</td>
                    <td className="num">
                      {p.currentPriceUsd === null ? (
                        <span className="muted">no price</span>
                      ) : (
                        <>
                          {fmt.tokenPrice(p.currentPriceUsd)}
                          {typeof p.priceAgeMs === "number" && updatedAt !== null ? (
                            <span className="muted price-age"> (<Ago ts={updatedAt - p.priceAgeMs} />)</span>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td className="num">{fmt.money(p.costBasisUsd)}</td>
                    <td className="num">{fmtPct(p.remainingPct, { sign: false })}</td>
                    <td className="num">{fmtHours(p.ageHours)}</td>
                    <td>{p.tp1Hit ? "hit" : "—"}</td>
                    <td className="num">{fmtScore(p.entryScore)}</td>
                    <td>{fmt.dateTime(p.openedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        ) : null}
      </section>

      <section className="card" aria-labelledby="closed-h" aria-busy={refreshing}>
        <h3 id="closed-h">Closed positions {data ? <span className="subtle">({closed.length}, newest first)</span> : null}</h3>
        {loading ? <p className="empty">Loading…</p> : null}
        {data && closed.length === 0 ? <p className="empty">No closed positions yet.</p> : null}
        {closed.length > 0 ? (
          <TableWrap label="Closed positions table">
            <table>
              <caption className="visually-hidden">Closed positions with realized P&amp;L</caption>
              <thead>
                <tr>
                  <th scope="col">Symbol</th>
                  <th scope="col" className="num">P&amp;L</th>
                  <th scope="col" className="num">Realized ({cur})</th>
                  <th scope="col" className="num">Hold</th>
                  <th scope="col">Exit reason</th>
                  <th scope="col" className="num">Entry ({cur})</th>
                  <th scope="col" className="num">Cost ({cur})</th>
                  <th scope="col" className="num">Score</th>
                  <th scope="col">Closed ({fmt.zoneAbbr})</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((p, i) => (
                  <tr key={`${p.id}:${i}`}>
                    <th scope="row"><Symbol symbol={p.symbol} mint={p.mint} /></th>
                    <td className="num"><Delta value={p.pnlPct} /></td>
                    <td className="num">{fmt.money(p.realizedPnlUsd)}</td>
                    <td className="num">{fmtHours(p.holdHours)}</td>
                    <td className="wrap">{p.closeReason ? <Reason text={String(p.closeReason)} /> : <span className="muted">—</span>}</td>
                    <td className="num">{fmt.tokenPrice(p.entryPriceUsd)}</td>
                    <td className="num">{fmt.money(p.costBasisUsd)}</td>
                    <td className="num">{fmtScore(p.entryScore)}</td>
                    <td>{fmt.dateTime(p.closedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        ) : null}
      </section>
    </div>
  );
}
