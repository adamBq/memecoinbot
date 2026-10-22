import type { LensName } from "../types";
import { LENS_NAMES } from "../types";
import { fmtScore } from "../lib/format";

interface LensScore {
  score: number;
  reasons: string[];
}
/** Lens map as the server sends it; any lens may be missing, so every read is guarded. */
type Lenses = Readonly<Record<string, LensScore | undefined>> | Readonly<Record<LensName, LensScore>>;

function clamp01(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function lensAt(lenses: Lenses, name: LensName): LensScore | undefined {
  return (lenses as Readonly<Record<string, LensScore | undefined>>)[name];
}

/** One horizontal 0..1 bar. Value is always shown as text; the bar is decorative. */
export function LensBar({ name, score, compact = false }: { name: string; score: number | undefined; compact?: boolean }) {
  const pct = clamp01(score) * 100;
  return (
    <div className={`lens-row${compact ? " compact" : ""}`}>
      <span className="lens-name">{name}</span>
      <div className="lens-track" aria-hidden="true">
        <div className="lens-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="lens-value">{fmtScore(score)}</span>
    </div>
  );
}

/** The five lens scores as bars, optionally with each lens's reasons underneath. */
export function LensBars({ lenses, withReasons = false, compact = false }: { lenses: Lenses | null | undefined; withReasons?: boolean; compact?: boolean }) {
  if (!lenses) return <span className="muted">No lens scores</span>;
  if (!withReasons) {
    return (
      <ul className="lens-list" aria-label="Lens scores">
        {LENS_NAMES.map((name) => (
          <li key={name}>
            <LensBar name={name} score={lensAt(lenses, name)?.score} compact={compact} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="lens-block">
      {LENS_NAMES.map((name) => {
        const lens = lensAt(lenses, name);
        const reasons = Array.isArray(lens?.reasons) ? lens.reasons : [];
        return (
          <div key={name}>
            <LensBar name={name} score={lens?.score} />
            {reasons.length > 0 ? (
              <ul className="lens-reasons">
                {reasons.map((r, i) => (
                  <li key={`${i}:${r}`}>{String(r)}</li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
