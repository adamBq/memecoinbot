import { useEffect, useState } from "react";
import { ROUTES, hrefFor, type Route } from "../lib/router";
import { useRefresh } from "../lib/api";
import { fmtAgo } from "../lib/format";

function Nav({ current }: { current: Route }) {
  return (
    <nav className="nav" aria-label="Views">
      {ROUTES.map((r) => (
        <a key={r.id} href={hrefFor(r.id)} aria-current={r.id === current ? "page" : undefined}>
          {r.label}
        </a>
      ))}
    </nav>
  );
}

/** "updated Xs ago", a pause toggle, and a manual refresh button. */
function RefreshControl() {
  const { paused, setPaused, refreshNow, lastUpdatedAt, mock } = useRefresh();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="refresh">
      <span className="dot" data-paused={paused} aria-hidden="true" />
      <span role="status" aria-live="polite">
        {paused ? "Paused" : "Live"} · updated {fmtAgo(lastUpdatedAt, now)}
        {mock ? " · mock data" : ""}
      </span>
      <button type="button" className="btn" aria-pressed={paused} onClick={() => setPaused(!paused)}>
        {paused ? "Resume" : "Pause"}
      </button>
      <button type="button" className="btn" onClick={refreshNow} aria-label="Refresh now">
        Refresh
      </button>
    </div>
  );
}

export function TopBar({ route }: { route: Route }) {
  return (
    <header className="topbar">
      <div className="topbar-row">
        <div className="brand">
          <h1>Memecoin Bot</h1>
          <span className="mode">paper</span>
        </div>
        <RefreshControl />
      </div>
      <Nav current={route} />
    </header>
  );
}
