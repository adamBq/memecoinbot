import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshProvider } from "./lib/api";
import { useHashRoute, type Route } from "./lib/router";
import { TopBar } from "./components/TopBar";
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

/** Last line of defence: a render error in one view never blanks the whole page. */
class ViewBoundary extends Component<{ route: Route; children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("View crashed", error, info);
  }
  override componentDidUpdate(prev: { route: Route }) {
    if (prev.route !== this.props.route && this.state.error) this.setState({ error: null });
  }
  override render() {
    if (this.state.error) {
      return (
        <div className="inline-error" role="alert">
          <span className="icon" aria-hidden="true">!</span>
          <div>
            <strong>This view failed to render.</strong> {this.state.error.message}{" "}
            <button type="button" className="btn-link" onClick={() => this.setState({ error: null })}>Try again</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function Shell() {
  const route = useHashRoute();
  const View = VIEWS[route];
  return (
    <div className="app">
      <TopBar route={route} />
      <main id="main">
        <ViewBoundary route={route}>{View()}</ViewBoundary>
      </main>
    </div>
  );
}

export function App() {
  return (
    <RefreshProvider>
      <Shell />
    </RefreshProvider>
  );
}
