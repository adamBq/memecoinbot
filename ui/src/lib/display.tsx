import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useApi, type ApiState } from "./api";
import type { SummaryDto } from "../types";
import { DEFAULT_DISPLAY, makeFormatters, type DisplaySettings, type Formatters } from "./format";

const DisplayContext = createContext<DisplaySettings>(DEFAULT_DISPLAY);
const SummaryContext = createContext<ApiState<SummaryDto> | null>(null);

/** Normalise the server's `display` block; old servers (no block) render in USD, Sydney time. */
export function displayFromSummary(summary: SummaryDto | null | undefined): DisplaySettings {
  const d = summary?.display;
  if (!d || typeof d !== "object") return DEFAULT_DISPLAY;
  return {
    currency: d.currency === "AUD" ? "AUD" : "USD",
    timezone: typeof d.timezone === "string" && d.timezone ? d.timezone : DEFAULT_DISPLAY.timezone,
    audPerUsd: typeof d.audPerUsd === "number" && Number.isFinite(d.audPerUsd) && d.audPerUsd > 0 ? d.audPerUsd : null,
    fxAsOf: typeof d.fxAsOf === "number" ? d.fxAsOf : null,
    fxSource: typeof d.fxSource === "string" ? d.fxSource : null,
  };
}

/** Fetches /api/summary once on the shared refresh cadence; provides display settings and the summary itself. */
export function DisplayProvider({ children }: { children: ReactNode }) {
  const summary = useApi<SummaryDto>("/api/summary");
  const raw = displayFromSummary(summary.data);
  const display = useMemo<DisplaySettings>(
    () => ({ currency: raw.currency, timezone: raw.timezone, audPerUsd: raw.audPerUsd, fxAsOf: raw.fxAsOf, fxSource: raw.fxSource }),
    [raw.currency, raw.timezone, raw.audPerUsd, raw.fxAsOf, raw.fxSource],
  );
  return (
    <DisplayContext.Provider value={display}>
      <SummaryContext.Provider value={summary}>{children}</SummaryContext.Provider>
    </DisplayContext.Provider>
  );
}

export function useDisplay(): DisplaySettings {
  return useContext(DisplayContext);
}

/** The shared /api/summary state (Overview and Positions read it instead of fetching again). */
export function useSummary(): ApiState<SummaryDto> {
  const ctx = useContext(SummaryContext);
  if (!ctx) throw new Error("useSummary must be used inside DisplayProvider");
  return ctx;
}

/** Currency- and timezone-aware formatters for the current display settings. */
export function useFmt(): Formatters {
  const display = useDisplay();
  return useMemo(() => makeFormatters(display), [display]);
}
