import { Fragment, useId, useMemo, useState } from "react";
import { useApi } from "../lib/api";
import type { DecisionAction, DecisionsResponse } from "../types";
import { fmtDateTime, fmtScore } from "../lib/format";
import { ActionBadge, Symbol } from "../components/Badges";
import { LensBars } from "../components/LensBars";
import { Reason } from "../components/Reasons";
import { InlineError, StaleNote } from "../components/InlineError";

const ACTIONS: readonly DecisionAction[] = ["filtered", "skip", "enter", "exit"];
const PAGE = 50;

export function Decisions() {
  const [actions, setActions] = useState<Set<DecisionAction>>(() => new Set());
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const searchId = useId();

  const path = useMemo(() => {
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (actions.size > 0) params.set("action", [...actions].join(","));
    return `/api/decisions?${params.toString()}`;
  }, [actions, offset]);

  const { data, error, loading, stale, refreshing, refetch } = useApi<DecisionsResponse>(path);

  const rows = useMemo(() => {
    const list = data?.decisions ?? [];
    const q = query.trim().toLowerCase();
    return q ? list.filter((d) => d.symbol.toLowerCase().includes(q) || d.mint.toLowerCase().includes(q)) : list;
  }, [data, query]);

  const toggleAction = (a: DecisionAction) => {
    setActions((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });
    setOffset(0);
    setOpen(null);
  };

  const total = data?.total ?? 0;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE, total);

  return (
    <div className="view">
      <section className="card" aria-labelledby="dec-h">
        <div className="view-head">
          <h2 id="dec-h">Decisions</h2>
          <span className="subtle">{data ? `${pageStart}–${pageEnd} of ${total}` : ""}</span>
        </div>
        <div className="controls" style={{ marginBottom: 12 }}>
          <div className="chips" role="group" aria-label="Filter by action">
            <button type="button" className="chip" aria-pressed={actions.size === 0} onClick={() => { setActions(new Set()); setOffset(0); }}>
              All
            </button>
            {ACTIONS.map((a) => (
              <button key={a} type="button" className="chip" aria-pressed={actions.has(a)} onClick={() => toggleAction(a)}>
                {a}
              </button>
            ))}
          </div>
          <label htmlFor={searchId} className="visually-hidden">Search by symbol</label>
          <input id={searchId} className="search" type="search" placeholder="Search symbol on this page" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        {error && !data ? <InlineError message={error} onRetry={refetch} /> : null}
        {stale && error ? <StaleNote message={error} /> : null}
        {loading ? <p className="empty">Loading…</p> : null}
        {data && rows.length === 0 ? <p className="empty">{query ? "No decisions on this page match the search." : "No decisions."}</p> : null}

        {rows.length > 0 ? (
          <div className="table-wrap" style={{ opacity: refreshing ? 0.7 : 1 }}>
            <table>
              <caption className="visually-hidden">Scoring decisions, newest first</caption>
              <thead>
                <tr>
                  <th scope="col"><span className="visually-hidden">Details</span></th>
                  <th scope="col">Time</th>
                  <th scope="col">Symbol</th>
                  <th scope="col">Action</th>
                  <th scope="col" className="num">Composite</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const key = `${d.ts}:${d.mint}`;
                  const expanded = open === key;
                  const detailId = `dec-${d.ts}-${d.mint.slice(0, 8)}`;
                  return (
                    <Fragment key={key}>
                      <tr className={expanded ? "expanded" : undefined}>
                        <td>
                          <button type="button" className="btn" aria-expanded={expanded} aria-controls={detailId} onClick={() => setOpen(expanded ? null : key)} aria-label={`${expanded ? "Hide" : "Show"} lens scores for ${d.symbol}`}>
                            {expanded ? "▾" : "▸"}
                          </button>
                        </td>
                        <td>{fmtDateTime(d.ts)}</td>
                        <td><Symbol symbol={d.symbol} mint={d.mint} /></td>
                        <td><ActionBadge action={d.action} /></td>
                        <td className="num">{d.lenses ? fmtScore(d.total) : <span className="muted">—</span>}</td>
                        <td className="wrap"><Reason text={d.reason} /></td>
                      </tr>
                      {expanded ? (
                        <tr className="detail" id={detailId}>
                          <td colSpan={6}>
                            <LensBars lenses={d.lenses} withReasons />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="pager" style={{ marginTop: 12 }}>
          <button type="button" className="btn" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - PAGE)); setOpen(null); }}>
            Previous
          </button>
          <button type="button" className="btn" disabled={!data || offset + PAGE >= total} onClick={() => { setOffset(offset + PAGE); setOpen(null); }}>
            Next
          </button>
          <span>{data ? `Page ${Math.floor(offset / PAGE) + 1} of ${Math.max(1, Math.ceil(total / PAGE))}` : ""}</span>
        </div>
      </section>
    </div>
  );
}
