import type { SummaryDto } from "../types";
import { fmtDateTime } from "../lib/format";

/** Circuit-breaker banner. Shown only when the kill switch fired or new entries are halted. */
export function BreakerBanner({ summary }: { summary: SummaryDto }) {
  const killed = summary.killed || summary.breakers.killSwitch;
  const halted = summary.breakers.haltNewEntries;
  if (!killed && !halted) return null;
  const reasons = summary.breakers.reasons;
  return (
    <div className={`banner${killed ? "" : " warn"}`} role="alert">
      <span className="icon" aria-hidden="true">{killed ? "⛔" : "⚠"}</span>
      <div>
        <strong>{killed ? "Kill switch active: trading stopped." : "New entries halted."}</strong>
        {summary.haltedUntil ? <span className="subtle"> Until {fmtDateTime(summary.haltedUntil)}.</span> : null}
        {reasons.length > 0 ? (
          <ul>
            {reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
