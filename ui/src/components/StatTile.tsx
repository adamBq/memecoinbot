import type { ReactNode } from "react";

/** Stat tile: label, value, optional delta line. Hero flag enlarges the value. */
export function StatTile({ label, value, delta, hero = false }: { label: string; value: ReactNode; delta?: ReactNode; hero?: boolean }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className={`value${hero ? " hero" : ""}`}>{value}</div>
      {delta !== undefined ? <div className="delta">{delta}</div> : null}
    </div>
  );
}
