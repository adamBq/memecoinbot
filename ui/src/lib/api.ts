import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, isAbortError } from "./errors";
import { parseResponse } from "./schemas";

export { ApiError } from "./errors";

export const REFRESH_MS = 30_000;

/** `?mock=1` serves fixtures instead of hitting the server. Dev builds only; the fixtures are tree-shaken from production. */
export function isMock(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get("mock") === "1";
}

/** GET a JSON endpoint, validate its shape; the server contract returns `{ error }` with status 500 on failure. */
export async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (import.meta.env.DEV && isMock()) {
    const { mockFetch } = await import("../mocks/fixtures");
    return parseResponse(path, await mockFetch(path)) as T;
  }
  let res: Response;
  try {
    res = await fetch(path, { signal, headers: { accept: "application/json" } });
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err;
    throw new ApiError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err;
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
    throw new ApiError("Invalid JSON from server", res.status);
  }
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    throw new ApiError(body.error, res.status);
  }
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
  return parseResponse(path, body) as T;
}

// ---- Refresh context: pause toggle and manual refresh. lastUpdatedAt lives in its own context so only its readers re-render. ----

interface RefreshState {
  paused: boolean;
  setPaused: (paused: boolean) => void;
  /** Bumped on manual refresh and on unpause; every useApi refetches when it changes. */
  generation: number;
  refreshNow: () => void;
  markUpdated: (ts: number) => void;
  mock: boolean;
}

const RefreshContext = createContext<RefreshState | null>(null);
const UpdatedAtContext = createContext<number | null>(null);

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [paused, setPausedState] = useState(false);
  const pausedRef = useRef(false);
  const [generation, setGeneration] = useState(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const mock = useMemo(isMock, []);

  const refreshNow = useCallback(() => setGeneration((g) => g + 1), []);
  const setPaused = useCallback((next: boolean) => {
    const was = pausedRef.current;
    pausedRef.current = next;
    setPausedState(next);
    if (was && !next) setGeneration((g) => g + 1);
  }, []);
  const markUpdated = useCallback((ts: number) => setLastUpdatedAt((prev) => (prev === null || ts > prev ? ts : prev)), []);

  const value = useMemo<RefreshState>(
    () => ({ paused, setPaused, generation, refreshNow, markUpdated, mock }),
    [paused, setPaused, generation, refreshNow, markUpdated, mock],
  );
  return createElement(RefreshContext.Provider, { value }, createElement(UpdatedAtContext.Provider, { value: lastUpdatedAt }, children));
}

export function useRefresh(): RefreshState {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error("useRefresh must be used inside RefreshProvider");
  return ctx;
}

/** Most recent successful fetch across all hooks. */
export function useLastUpdatedAt(): number | null {
  return useContext(UpdatedAtContext);
}

// ---- useApi ----

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  /** First load for this path, nothing to show yet. */
  loading: boolean;
  /** A request is in flight while previous data is still on screen. */
  refreshing: boolean;
  /** We are showing old data because the latest fetch failed. */
  stale: boolean;
  updatedAt: number | null;
  refetch: () => void;
}

interface Stored<T> {
  path: string;
  data: T | null;
  error: string | null;
  updatedAt: number | null;
}

/**
 * Fetch `path` on mount, every `refreshMs` while not paused (0 disables polling), and
 * whenever the global refresh generation changes. Stored results are keyed by path, so a
 * path change never shows the previous path's rows. Errors never throw; they land in `error`.
 */
export function useApi<T>(path: string, refreshMs: number = REFRESH_MS): ApiState<T> {
  const { paused, generation, markUpdated } = useRefresh();
  const [stored, setStored] = useState<Stored<T>>({ path, data: null, error: null, updatedAt: null });
  const [refreshing, setRefreshing] = useState(false);
  const [localGen, setLocalGen] = useState(0);
  const requestId = useRef(0);
  const inFlight = useRef(false);

  const refetch = useCallback(() => setLocalGen((g) => g + 1), []);

  useEffect(() => {
    const id = ++requestId.current;
    const controller = new AbortController();
    inFlight.current = true;
    setRefreshing(true);
    fetchJson<T>(path, controller.signal)
      .then((result) => {
        if (id !== requestId.current) return;
        const ts = Date.now();
        setStored({ path, data: result, error: null, updatedAt: ts });
        markUpdated(ts);
      })
      .catch((err: unknown) => {
        if (id !== requestId.current || isAbortError(err)) return;
        const message = err instanceof Error ? err.message : String(err);
        setStored((prev) => (prev.path === path ? { ...prev, error: message } : { path, data: null, error: message, updatedAt: null }));
      })
      .finally(() => {
        if (id !== requestId.current) return;
        inFlight.current = false;
        setRefreshing(false);
      });
    return () => controller.abort();
  }, [path, generation, localGen, markUpdated]);

  useEffect(() => {
    if (paused || refreshMs <= 0) return;
    const timer = window.setInterval(() => {
      if (inFlight.current) return; // skip this tick rather than abort and restart
      setLocalGen((g) => g + 1);
    }, refreshMs);
    return () => window.clearInterval(timer);
  }, [paused, refreshMs]);

  const current = stored.path === path;
  const data = current ? stored.data : null;
  const error = current ? stored.error : null;
  return {
    data,
    error,
    loading: data === null && error === null,
    refreshing,
    stale: data !== null && error !== null,
    updatedAt: current ? stored.updatedAt : null,
    refetch,
  };
}
