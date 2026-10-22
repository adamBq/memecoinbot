import type { SummaryDto } from "../types";
import { fmtDateTime } from "../lib/format";

/** Circuit-breaker banner. Shown only when the kill switch fired or new entries are halted. */
export function BreakerBanner({ summary }: { summary: SummaryDto }) {
  const breakers = summary.breakers ?? { haltNewEntries: false, killSwitch: false, reasons: [] };
  const killed = summary.killed === true || breakers.killSwitch === true;
  const halted = breakers.haltNewEntries === true;
  if (!killed && !halted) return null;
  const reasons = Array.isArray(breakers.reasons) ? breakers.reasons : [];
  return (
    <div className={`banner${killed ? "" : " warn"}`} role="alert">
      <span className="icon" aria-hidden="true">{killed ? "⛔" : "⚠"}</span>
      <div>
        <strong>{killed ? "Kill switch active: trading stopped." : "New entries halted."}</strong>
        {summary.haltedUntil ? <span className="subtle"> Until {fmtDateTime(summary.haltedUntil)}.</span> : null}
        {reasons.length > 0 ? (
          <ul>
            {reasons.map((r, i) => (
              <li key={`${i}:${r}`}>{String(r)}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
