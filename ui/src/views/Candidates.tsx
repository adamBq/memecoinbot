import { useApi } from "../lib/api";
import type { CandidatesResponse } from "../types";
import { fmtScore } from "../lib/format";
import { useFmt } from "../lib/display";
import { ActionBadge, Symbol } from "../components/Badges";
import { Ago } from "../components/Ago";
import { LensBars } from "../components/LensBars";
import { Reason } from "../components/Reasons";
import { TableWrap } from "../components/TableWrap";
import { InlineError, StaleNote } from "../components/InlineError";

export function Candidates() {
  const { data, error, loading, stale, refreshing, refetch } = useApi<CandidatesResponse>("/api/candidates");
  const candidates = data?.candidates ?? [];
  const fmt = useFmt();

  return (
    <div className="view">
      <section className="card" aria-labelledby="cand-h" aria-busy={refreshing}>
        <div className="view-head">
          <h3 id="cand-h">Latest screen</h3>
          <span className="subtle">
            {data?.screenedAt ? <>screened <Ago ts={data.screenedAt} /> ({fmt.dateTimeZoned(data.screenedAt)})</> : data ? "no screen recorded yet" : ""}
          </span>
        </div>
        {error && !data ? <InlineError message={error} onRetry={refetch} /> : null}
        {stale && error ? <StaleNote message={error} /> : null}
        {loading ? <p className="empty">Loading…</p> : null}
        {data && candidates.length === 0 ? <p className="empty">No candidates in the latest screen.</p> : null}
        {candidates.length > 0 ? (
          <TableWrap label="Candidates table">
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
                {candidates.map((c, i) => (
                  <tr key={`${i}:${c.mint}`}>
                    <td className="num rank">{c.rank}</td>
                    <th scope="row"><Symbol symbol={c.symbol} mint={c.mint} /></th>
                    <td><ActionBadge action={String(c.action)} /></td>
                    <td className="num">{c.lenses ? fmtScore(c.total) : <span className="muted">—</span>}</td>
                    <td className="lens-mini">
                      {c.lenses ? <LensBars lenses={c.lenses} compact /> : <span className="muted">rejected by hard filter</span>}
                    </td>
                    <td className="wrap">
                      {c.action === "filtered" ? <strong className="delta-down">Filter failed: </strong> : null}
                      <Reason text={String(c.reason ?? "")} />
                    </td>
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
