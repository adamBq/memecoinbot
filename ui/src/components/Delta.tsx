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
