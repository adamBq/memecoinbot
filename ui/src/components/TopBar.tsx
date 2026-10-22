import { useEffect, useState } from "react";
import { ROUTES, hrefFor, type Route } from "../lib/router";
import { useLastUpdatedAt, useRefresh } from "../lib/api";
import { useDisplay, useFmt } from "../lib/display";
import { Ago } from "./Ago";

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

/**
 * Auto-refresh control. The ticking "updated Xs ago" text is aria-hidden; a separate
 * hidden live region changes only on pause/resume and when data arrives.
 */
function RefreshControl() {
  const { paused, setPaused, refreshNow, mock } = useRefresh();
  const lastUpdatedAt = useLastUpdatedAt();
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (lastUpdatedAt !== null) setAnnouncement("Data updated");
  }, [lastUpdatedAt]);

  const toggle = () => {
    const next = !paused;
    setPaused(next);
    setAnnouncement(next ? "Auto-refresh paused" : "Auto-refresh resumed");
  };

  return (
    <div className="refresh">
      <span className="dot" data-paused={paused} aria-hidden="true" />
      <span className="refresh-state">{paused ? "Paused" : "Live"}</span>
      <span className="refresh-ago" aria-hidden="true">
        {" · updated "}
        <Ago ts={lastUpdatedAt} />
        {mock ? " · mock data" : ""}
      </span>
      <span className="visually-hidden" role="status" aria-live="polite">{announcement}</span>
      <button type="button" className="btn" aria-pressed={!paused} onClick={toggle}>
        Auto-refresh
      </button>
      <button type="button" className="btn" onClick={refreshNow}>
        Refresh now
      </button>
    </div>
  );
}

/** Compact FX readout: "AUD · 1.4232 per USD" (timestamp and source hidden/title), or "USD (no FX rate)". */
function FxBadge() {
  const { currency, audPerUsd, fxAsOf, fxSource } = useDisplay();
  const fmt = useFmt();
  if (currency === "AUD" && audPerUsd !== null) {
    const detail = `FX rate as of ${fmt.dateTimeZoned(fxAsOf)}${fxSource ? ` from ${fxSource}` : ""}`;
    return (
      <span className="fx" title={detail}>
        AUD · {audPerUsd.toFixed(4)} per USD
        <span className="visually-hidden">, {detail}</span>
      </span>
    );
  }
  return <span className="fx">USD (no FX rate)</span>;
}

export function TopBar({ route }: { route: Route }) {
  return (
    <header className="topbar">
      <div className="topbar-row">
        <div className="brand">
          <h1>Memecoin Bot</h1>
          <span className="mode">paper</span>
          <FxBadge />
        </div>
        <RefreshControl />
      </div>
      <Nav current={route} />
    </header>
  );
}
