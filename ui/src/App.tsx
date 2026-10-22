import { useEffect, useRef, type ReactNode } from "react";
import { RefreshProvider } from "./lib/api";
import { ROUTES, useHashRoute, type Route } from "./lib/router";
import { TopBar } from "./components/TopBar";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { InlineError } from "./components/InlineError";
import { Overview } from "./views/Overview";
import { Positions } from "./views/Positions";
import { Decisions } from "./views/Decisions";
import { Candidates } from "./views/Candidates";
import { Activity } from "./views/Activity";

const VIEWS: Record<Route, () => ReactNode> = {
  overview: () => <Overview />,
  positions: () => <Positions />,
  decisions: () => <Decisions />,
  candidates: () => <Candidates />,
  activity: () => <Activity />,
};

function labelFor(route: Route): string {
  return ROUTES.find((r) => r.id === route)?.label ?? "Overview";
}

function viewFallback(error: Error, reset: () => void) {
  return <InlineError message={`This view failed to render. ${error.message}`} onRetry={reset} />;
}

function shellFallback(error: Error, reset: () => void) {
  return (
    <div className="app">
      <main id="main" tabIndex={-1} style={{ paddingTop: 16 }}>
        <InlineError message={`The dashboard failed to render. ${error.message}`} onRetry={reset} />
      </main>
    </div>
  );
}

function Shell() {
  const route = useHashRoute();
  const label = labelFor(route);
  const mainRef = useRef<HTMLElement>(null);
  const View = VIEWS[route];

  useEffect(() => {
    document.title = `${label} – Memecoin Bot`;
  }, [label]);

  return (
    <div className="app">
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault(); // "#main" would otherwise be read as a route by the hash router
          mainRef.current?.focus();
        }}
      >
        Skip to content
      </a>
      <TopBar route={route} />
      <main id="main" ref={mainRef} tabIndex={-1}>
        <h2 className="view-title">{label}</h2>
        <span className="visually-hidden" role="status" aria-live="polite">{`${label} view`}</span>
        <ErrorBoundary key={route} fallback={viewFallback}>
          {View()}
        </ErrorBoundary>
      </main>
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary fallback={shellFallback}>
      <RefreshProvider>
        <Shell />
      </RefreshProvider>
    </ErrorBoundary>
  );
}
