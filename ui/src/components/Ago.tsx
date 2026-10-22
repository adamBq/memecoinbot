import { useEffect, useState } from "react";
import { fmtAgo } from "../lib/format";

/** "42s ago" that re-renders itself once a second, so parents do not have to tick. */
export function Ago({ ts }: { ts: number | null | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ts === null || ts === undefined) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [ts]);
  return <>{fmtAgo(ts, Math.max(now, ts ?? 0))}</>;
}
