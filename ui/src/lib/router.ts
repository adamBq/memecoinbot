import { useEffect, useState } from "react";

export type Route = "overview" | "positions" | "decisions" | "candidates" | "activity";

export const ROUTES: ReadonlyArray<{ id: Route; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "positions", label: "Positions" },
  { id: "decisions", label: "Decisions" },
  { id: "candidates", label: "Candidates" },
  { id: "activity", label: "Activity" },
];

function parseHash(hash: string): Route {
  const name = hash.replace(/^#\/?/, "").split(/[?/]/)[0] ?? "";
  const match = ROUTES.find((r) => r.id === name);
  return match ? match.id : "overview";
}

/** Hash router: `#/overview`, `#/positions`, ... Unknown hashes fall back to overview. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function hrefFor(route: Route): string {
  return `#/${route}`;
}
