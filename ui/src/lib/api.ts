import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { mockFetch } from "../mocks/fixtures";

export const REFRESH_MS = 30_000;

/** `?mock=1` serves fixtures instead of hitting the server. */
export function isMock(): boolean {
  return new URLSearchParams(window.location.search).get("mock") === "1";
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "ApiError";
  }
}

/** GET a JSON endpoint; the server contract returns `{ error }` with status 500 on failure. */
export async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (isMock()) return mockFetch(path) as Promise<T>;
  let res: Response;
  try {
    res = await fetch(path, { signal, headers: { accept: "application/json" } });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
    throw new ApiError("Invalid JSON from server", res.status);
  }
  if (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string") {
    throw new ApiError((body as { error: string }).error, res.status);
  }
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
  return body as T;
}

// ---- Refresh context: pause toggle, manual refresh, and "updated Xs ago" ----

interface RefreshState {
  paused: boolean;
  setPaused: (paused: boolean) => void;
  /** Bumped on manual refresh and on unpause; every useApi refetches when it changes. */
  generation: number;
  refreshNow: () => void;
  /** Most recent successful fetch across all hooks. */
  lastUpdatedAt: number | null;
  markUpdated: (ts: number) => void;
  mock: boolean;
}

const RefreshContext = createContext<RefreshState | null>(null);

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [paused, setPausedState] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const mock = useMemo(isMock, []);

  const refreshNow = useCallback(() => setGeneration((g) => g + 1), []);
  const setPaused = useCallback((next: boolean) => {
    setPausedState((prev) => {
      if (prev && !next) setGeneration((g) => g + 1);
      return next;
    });
  }, []);
  const markUpdated = useCallback((ts: number) => setLastUpdatedAt((prev) => (prev === null || ts > prev ? ts : prev)), []);

  const value = useMemo<RefreshState>(
    () => ({ paused, setPaused, generation, refreshNow, lastUpdatedAt, markUpdated, mock }),
    [paused, setPaused, generation, refreshNow, lastUpdatedAt, markUpdated, mock],
  );
  return createElement(RefreshContext.Provider, { value }, children);
}

export function useRefresh(): RefreshState {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error("useRefresh must be used inside RefreshProvider");
  return ctx;
}

// ---- useApi ----

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  /** First load, nothing to show yet. */
  loading: boolean;
  /** Background refetch while previous data is still on screen. */
  refreshing: boolean;
  /** We are showing old data because the latest fetch failed. */
  stale: boolean;
  updatedAt: number | null;
  refetch: () => void;
}

/**
 * Fetch `path` on mount, every `refreshMs` while not paused, and whenever the
 * global refresh generation changes. Errors never throw; they land in `error`.
 */
export function useApi<T>(path: string, refreshMs: number = REFRESH_MS): ApiState<T> {
  const { paused, generation, markUpdated } = useRefresh();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [localGen, setLocalGen] = useState(0);
  const requestId = useRef(0);

  const refetch = useCallback(() => setLocalGen((g) => g + 1), []);

  useEffect(() => {
    const id = ++requestId.current;
    const controller = new AbortController();
    setRefreshing(true);
    fetchJson<T>(path, controller.signal)
      .then((result) => {
        if (id !== requestId.current) return;
        setData(result);
        setError(null);
        const ts = Date.now();
        setUpdatedAt(ts);
        markUpdated(ts);
      })
      .catch((err: unknown) => {
        if (id !== requestId.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (id !== requestId.current) return;
        setLoading(false);
        setRefreshing(false);
      });
    return () => controller.abort();
  }, [path, generation, localGen, markUpdated]);

  useEffect(() => {
    if (paused || refreshMs <= 0) return;
    const timer = window.setInterval(() => setLocalGen((g) => g + 1), refreshMs);
    return () => window.clearInterval(timer);
  }, [paused, refreshMs, path]);

  return {
    data,
    error,
    loading: loading && data === null,
    refreshing,
    stale: data !== null && error !== null,
    updatedAt,
    refetch,
  };
}
