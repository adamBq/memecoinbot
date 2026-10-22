import { useMemo } from "react";
import { useApi } from "../lib/api";
import type { NotesResponse, OrdersResponse } from "../types";
import { fmtDateTime, fmtPct, fmtQty, fmtTokenPrice, fmtUsd } from "../lib/format";
import { Symbol } from "../components/Badges";
import { Reason } from "../components/Reasons";
import { InlineError, StaleNote } from "../components/InlineError";

export function Activity() {
  const notes = useApi<NotesResponse>("/api/notes");
  const orders = useApi<OrdersResponse>("/api/orders?limit=100");

  const timeline = useMemo(() => [...(notes.data?.notes ?? [])].sort((a, b) => b.ts - a.ts), [notes.data]);

  return (
    <div className="view">
      <section className="card" aria-labelledby="notes-h">
        <h2 id="notes-h">Notes {timeline.length > 0 ? <span className="subtle">(newest first)</span> : null}</h2>
        {notes.error && !notes.data ? <InlineError message={notes.error} onRetry={notes.refetch} /> : null}
        {notes.stale && notes.error ? <StaleNote message={notes.error} /> : null}
        {notes.loading ? <p className="empty">Loading…</p> : null}
        {notes.data && timeline.length === 0 ? <p className="empty">No notes recorded.</p> : null}
        {timeline.length > 0 ? (
          <ol className="timeline">
            {timeline.map((n, i) => (
              <li key={`${n.ts}:${i}`}>
                <time dateTime={new Date(n.ts).toISOString()}>{fmtDateTime(n.ts)}</time>
                <span className="text"><Reason text={n.text} limit={240} /></span>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <section className="card" aria-labelledby="orders-h">
        <h2 id="orders-h">Recent orders {orders.data ? <span className="subtle">({orders.data.orders.length}, newest first)</span> : null}</h2>
        {orders.error && !orders.data ? <InlineError message={orders.error} onRetry={orders.refetch} /> : null}
        {orders.stale && orders.error ? <StaleNote message={orders.error} /> : null}
        {orders.loading ? <p className="empty">Loading…</p> : null}
        {orders.data && orders.data.orders.length === 0 ? <p className="empty">No orders yet.</p> : null}
        {orders.data && orders.data.orders.length > 0 ? (
          <div className="table-wrap">
            <table>
              <caption className="visually-hidden">Paper orders, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Side</th>
                  <th scope="col">Symbol</th>
                  <th scope="col" className="num">Notional</th>
                  <th scope="col" className="num">Price</th>
                  <th scope="col" className="num">Qty</th>
                  <th scope="col" className="num">Fee</th>
                  <th scope="col" className="num">Impact</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {orders.data.orders.map((o) => (
                  <tr key={o.id}>
                    <td>{fmtDateTime(o.ts)}</td>
                    <td>
                      <span className="action" data-action={o.side === "buy" ? "enter" : "exit"}>{o.side}</span>
                    </td>
                    <td><Symbol symbol={o.symbol} mint={o.mint} /></td>
                    <td className="num">{fmtUsd(o.notionalUsd)}</td>
                    <td className="num">{fmtTokenPrice(o.effectivePriceUsd)}</td>
                    <td className="num">{fmtQty(o.qtyTokens)}</td>
                    <td className="num">{fmtUsd(o.feeUsd)}</td>
                    <td className="num">{fmtPct(o.priceImpactPct, { sign: false })}</td>
                    <td className="wrap"><Reason text={o.reason} /></td>
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
