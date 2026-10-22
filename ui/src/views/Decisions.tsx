import { Fragment, useId, useMemo, useState } from "react";
import { REFRESH_MS, useApi } from "../lib/api";
import type { DecisionAction, DecisionsResponse } from "../types";
import { fmtScore } from "../lib/format";
import { useFmt } from "../lib/display";
import { ActionBadge, Symbol } from "../components/Badges";
import { LensBars } from "../components/LensBars";
import { Reason } from "../components/Reasons";
import { TableWrap } from "../components/TableWrap";
import { InlineError, StaleNote } from "../components/InlineError";

const ACTIONS: readonly DecisionAction[] = ["filtered", "skip", "enter", "exit"];
const PAGE = 50;

export function Decisions() {
  const [actions, setActions] = useState<Set<DecisionAction>>(() => new Set());
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const searchId = useId();
  const baseId = useId();
  const fmt = useFmt();

  const path = useMemo(() => {
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (actions.size > 0) params.set("action", [...actions].join(","));
    return `/api/decisions?${params.toString()}`;
  }, [actions, offset]);

  // Only the first page polls; deeper pages would shift under the reader as new rows arrive.
  const { data, error, loading, stale, refreshing, refetch } = useApi<DecisionsResponse>(path, offset > 0 ? 0 : REFRESH_MS);

  const rows = useMemo(() => {
    const list = (data?.decisions ?? []).map((d, i) => ({ d, i }));
    const q = query.trim().toLowerCase();
    return q ? list.filter(({ d }) => String(d.symbol ?? "").toLowerCase().includes(q) || String(d.mint ?? "").toLowerCase().includes(q)) : list;
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
      <section className="card" aria-labelledby="dec-h" aria-busy={refreshing}>
        <div className="view-head">
          <h3 id="dec-h">Scoring decisions</h3>
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
          <label htmlFor={searchId} className="visually-hidden">Search by symbol on this page</label>
          <input id={searchId} className="search" type="search" placeholder="Search symbol on this page" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        {error && !data ? <InlineError message={error} onRetry={refetch} /> : null}
        {stale && error ? <StaleNote message={error} /> : null}
        {loading ? <p className="empty">Loading…</p> : null}
        {data && rows.length === 0 ? <p className="empty">{query ? "No decisions on this page match the search." : "No decisions."}</p> : null}

        {rows.length > 0 ? (
          <TableWrap label="Decisions table">
            <table>
              <caption className="visually-hidden">Scoring decisions, newest first</caption>
              <thead>
                <tr>
                  <th scope="col"><span className="visually-hidden">Details</span></th>
                  <th scope="col">Time ({fmt.zoneAbbr})</th>
                  <th scope="col">Symbol</th>
                  <th scope="col">Action</th>
                  <th scope="col" className="num">Composite</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ d, i }) => {
                  const key = `${offset + i}:${d.ts}:${d.mint}`;
                  const expanded = open === key;
                  const detailId = `${baseId}-${offset + i}`;
                  const symbol = typeof d.symbol === "string" && d.symbol ? d.symbol : "this token";
                  return (
                    <Fragment key={key}>
                      <tr className={expanded ? "expanded" : undefined}>
                        <td>
                          <button type="button" className="btn" aria-expanded={expanded} aria-controls={detailId} aria-label={`Lens scores for ${symbol}`} onClick={() => setOpen(expanded ? null : key)}>
                            <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                          </button>
                        </td>
                        <td>{fmt.dateTime(d.ts)}</td>
                        <th scope="row"><Symbol symbol={d.symbol} mint={d.mint} /></th>
                        <td><ActionBadge action={String(d.action)} /></td>
                        <td className="num">{d.lenses ? fmtScore(d.total) : <span className="muted">—</span>}</td>
                        <td className="wrap"><Reason text={String(d.reason ?? "")} /></td>
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
          </TableWrap>
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
