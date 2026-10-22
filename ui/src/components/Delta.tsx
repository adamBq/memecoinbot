import { fmtPct } from "../lib/format";

/** Signed percentage with colour AND a non-colour cue (arrow + sign). */
export function Delta({ value, className = "" }: { value: number | null | undefined; className?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={`delta-flat ${className}`}>—</span>;
  const tone = value > 0 ? "delta-up" : value < 0 ? "delta-down" : "delta-flat";
  const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "—";
  const word = value > 0 ? "up" : value < 0 ? "down" : "flat";
  return (
    <span className={`${tone} ${className}`}>
      <span aria-hidden="true">{arrow} </span>
      <span className="visually-hidden">{word} </span>
      {fmtPct(value)}
    </span>
  );
}

/**
 * Drawdown is a loss-style figure: any magnitude renders as "▼ -x%" in red, zero as a neutral
 * "0.0%" with no arrow or colour. Accepts either sign convention (server gives a positive magnitude).
 */
export function DrawdownValue({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className="delta-flat">—</span>;
  const magnitude = Math.abs(value);
  if (Math.round(magnitude * 10) === 0) return <span className="delta-flat">{fmtPct(0, { sign: false })}</span>;
  return (
    <span className="delta-down">
      <span aria-hidden="true">{"▼"} </span>
      <span className="visually-hidden">down </span>
      {fmtPct(-magnitude)}
    </span>
  );
}
