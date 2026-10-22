import { useApi } from "../lib/api";
import type { CandidatesResponse } from "../types";
import { fmtAgo, fmtDateTime, fmtScore } from "../lib/format";
import { ActionBadge, Symbol } from "../components/Badges";
import { LensBars } from "../components/LensBars";
import { Reason } from "../components/Reasons";
import { InlineError, StaleNote } from "../components/InlineError";

export function Candidates() {
  const { data, error, loading, stale, refreshing, refetch } = useApi<CandidatesResponse>("/api/candidates");

  return (
    <div className="view">
      <section className="card" aria-labelledby="cand-h">
        <div className="view-head">
          <h2 id="cand-h">Latest screen</h2>
          <span className="subtle">
            {data?.screenedAt ? <>screened {fmtAgo(data.screenedAt)} ({fmtDateTime(data.screenedAt)})</> : data ? "no screen recorded yet" : ""}
          </span>
        </div>
        {error && !data ? <InlineError message={error} onRetry={refetch} /> : null}
        {stale && error ? <StaleNote message={error} /> : null}
        {loading ? <p className="empty">Loading…</p> : null}
        {data && data.candidates.length === 0 ? <p className="empty">No candidates in the latest screen.</p> : null}
        {data && data.candidates.length > 0 ? (
          <div className="table-wrap" style={{ opacity: refreshing ? 0.7 : 1 }}>
            <table>
              <caption className="visually-hidden">Candidates ranked by composite score</caption>
              <thead>
                <tr>
                  <th scope="col" className="num">#</th>
                  <th scope="col">Symbol</th>
                  <th scope="col">Action</th>
                  <th scope="col" className="num">Composite</th>
                  <th scope="col">Lens scores</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.candidates.map((c) => (
                  <tr key={`${c.rank}:${c.mint}`}>
                    <td className="num rank">{c.rank}</td>
                    <th scope="row"><Symbol symbol={c.symbol} mint={c.mint} /></th>
                    <td><ActionBadge action={c.action} /></td>
                    <td className="num">{c.lenses ? fmtScore(c.total) : <span className="muted">—</span>}</td>
                    <td className="lens-mini">
                      {c.lenses ? <LensBars lenses={c.lenses} compact /> : <span className="muted">rejected by hard filter</span>}
                    </td>
                    <td className="wrap">
                      {c.action === "filtered" ? <strong className="delta-down">Filter failed: </strong> : null}
                      <Reason text={c.reason} />
                    </td>
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
