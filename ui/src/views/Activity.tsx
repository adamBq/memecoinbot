import { useMemo } from "react";
import { useApi } from "../lib/api";
import type { NotesResponse, OrdersResponse } from "../types";
import { fmtPct, fmtQty } from "../lib/format";
import { useFmt } from "../lib/display";
import { Symbol } from "../components/Badges";
import { Reason } from "../components/Reasons";
import { TableWrap } from "../components/TableWrap";
import { InlineError, StaleNote } from "../components/InlineError";

export function Activity() {
  const notes = useApi<NotesResponse>("/api/notes");
  const orders = useApi<OrdersResponse>("/api/orders?limit=100");

  // Keep the server index as a stable key; the server sends notes ascending, we show newest first.
  const timeline = useMemo(() => (notes.data?.notes ?? []).map((n, serverIndex) => ({ ...n, serverIndex })).sort((a, b) => b.ts - a.ts), [notes.data]);
  const orderRows = orders.data?.orders ?? [];
  const fmt = useFmt();
  const cur = fmt.currencySymbol;

  return (
    <div className="view">
      <section className="card" aria-labelledby="notes-h" aria-busy={notes.refreshing}>
        <h3 id="notes-h">Notes {timeline.length > 0 ? <span className="subtle">(newest first, {fmt.zoneAbbr})</span> : null}</h3>
        {notes.error && !notes.data ? <InlineError message={notes.error} onRetry={notes.refetch} /> : null}
        {notes.stale && notes.error ? <StaleNote message={notes.error} /> : null}
        {notes.loading ? <p className="empty">Loading…</p> : null}
        {notes.data && timeline.length === 0 ? <p className="empty">No notes recorded.</p> : null}
        {timeline.length > 0 ? (
          <ol className="timeline">
            {timeline.map((n) => (
              <li key={`${n.ts}:${n.serverIndex}`}>
                <time dateTime={new Date(n.ts).toISOString()}>{fmt.dateTime(n.ts)}</time>
                <span className="text"><Reason text={String(n.text ?? "")} limit={240} /></span>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <section className="card" aria-labelledby="orders-h" aria-busy={orders.refreshing}>
        <h3 id="orders-h">Recent orders {orders.data ? <span className="subtle">({orderRows.length}, newest first)</span> : null}</h3>
        {orders.error && !orders.data ? <InlineError message={orders.error} onRetry={orders.refetch} /> : null}
        {orders.stale && orders.error ? <StaleNote message={orders.error} /> : null}
        {orders.loading ? <p className="empty">Loading…</p> : null}
        {orders.data && orderRows.length === 0 ? <p className="empty">No orders yet.</p> : null}
        {orderRows.length > 0 ? (
          <TableWrap label="Recent orders table">
            <table>
              <caption className="visually-hidden">Paper orders, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Time ({fmt.zoneAbbr})</th>
                  <th scope="col">Side</th>
                  <th scope="col">Symbol</th>
                  <th scope="col" className="num">Notional ({cur})</th>
                  <th scope="col" className="num">Price ({cur})</th>
                  <th scope="col" className="num">Qty</th>
                  <th scope="col" className="num">Fee ({cur})</th>
                  <th scope="col" className="num">Impact</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {orderRows.map((o, i) => (
                  <tr key={`${o.id}:${i}`}>
                    <td>{fmt.dateTime(o.ts)}</td>
                    <td>
                      <span className="action" data-action={o.side === "buy" ? "enter" : "exit"}>{String(o.side)}</span>
                    </td>
                    <th scope="row"><Symbol symbol={o.symbol} mint={o.mint} /></th>
                    <td className="num">{fmt.money(o.notionalUsd)}</td>
                    <td className="num">{fmt.tokenPrice(o.effectivePriceUsd)}</td>
                    <td className="num">{fmtQty(o.qtyTokens)}</td>
                    <td className="num">{fmt.money(o.feeUsd)}</td>
                    <td className="num">{fmtPct(o.priceImpactPct, { sign: false })}</td>
                    <td className="wrap"><Reason text={String(o.reason ?? "")} /></td>
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
