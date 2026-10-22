import { memo, useCallback, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { EquityPointDto } from "../types";
import { fmtPct, type Formatters } from "../lib/format";
import { useFmt } from "../lib/display";
import { DrawdownValue } from "./Delta";
import { TableWrap } from "./TableWrap";

const DAY = 86_400_000;
const MAX_TICKS = 8;
const MAX_POINTS = 600;

const tick = { fill: "var(--text-muted)", fontSize: 11 } as const;
const axisLine = { stroke: "var(--axis)" } as const;
const tooltipStyle = {
  contentStyle: { background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-primary)", fontSize: 12, padding: "6px 10px" },
  labelStyle: { color: "var(--text-secondary)", marginBottom: 2 },
  itemStyle: { color: "var(--text-primary)", padding: 0 },
  cursor: { stroke: "var(--axis)", strokeWidth: 1 },
} as const;

/** Explicit X ticks: midnights in the display zone for multi-day windows, 6-hour steps otherwise; thinned to <= MAX_TICKS. */
function useTimeAxis(points: ReadonlyArray<{ ts: number }>, fmt: Formatters): { ticks: number[]; fmtTick: (ts: number) => string } {
  return useMemo(() => {
    const first = points[0]?.ts ?? 0;
    const last = points[points.length - 1]?.ts ?? 0;
    const span = last - first;
    const ticks: number[] = [];
    if (span >= 2 * DAY) {
      ticks.push(...fmt.dayStarts(first, last));
    } else {
      const step = 6 * 3_600_000;
      for (let t = Math.ceil(first / step) * step; t <= last; t += step) ticks.push(t);
    }
    const stride = Math.max(1, Math.ceil(ticks.length / MAX_TICKS));
    return { ticks: ticks.filter((_, i) => i % stride === 0), fmtTick: span >= 2 * DAY ? fmt.dateShort : fmt.timeShort };
  }, [points, fmt]);
}

/**
 * Min/max bucket downsampling: keeps first and last, and the extreme points of each bucket in
 * time order, so peaks and troughs survive while Recharts draws at most `max` points.
 */
export function downsample<P extends { ts: number }>(points: P[], value: (p: P) => number, max = MAX_POINTS): P[] {
  if (points.length <= max) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return points;
  const inner = points.slice(1, -1);
  const buckets = Math.max(1, Math.floor(max / 2) - 1);
  const size = inner.length / buckets;
  const out: P[] = [first];
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * size);
    const end = Math.min(inner.length, Math.floor((b + 1) * size));
    if (start >= end) continue;
    let lo = inner[start] as P;
    let hi = lo;
    for (let i = start + 1; i < end; i++) {
      const p = inner[i] as P;
      if (value(p) < value(lo)) lo = p;
      if (value(p) > value(hi)) hi = p;
    }
    if (lo === hi) out.push(lo);
    else if (lo.ts <= hi.ts) out.push(lo, hi);
    else out.push(hi, lo);
  }
  out.push(last);
  return out;
}

export interface DrawdownPoint {
  ts: number;
  drawdownPct: number;
}

/** Running drawdown from the peak equity so far, as a negative-or-zero percentage. */
export function toDrawdown(points: EquityPointDto[]): DrawdownPoint[] {
  let peak = -Infinity;
  return points.map((p) => {
    peak = Math.max(peak, p.equityUsd);
    const dd = peak > 0 ? ((p.equityUsd - peak) / peak) * 100 : 0;
    return { ts: p.ts, drawdownPct: Math.round(dd * 100) / 100 };
  });
}

/** Collapsed data-table twin. Rows are only built when the reader opens it. */
function DataTable({ caption, columns, getRows }: { caption: string; columns: readonly string[]; getRows: () => ReadonlyArray<readonly string[]> }) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => (open ? getRows() : []), [open, getRows]);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Show data table</summary>
      {open ? (
        <TableWrap label={caption} className="chart-table">
          <table>
            <caption className="visually-hidden">{caption}</caption>
            <thead>
              <tr>
                {columns.map((c, i) => (
                  <th key={c} scope="col" className={i > 0 ? "num" : undefined}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {r.map((cell, j) =>
                    j === 0 ? (
                      <th key={j} scope="row">{cell}</th>
                    ) : (
                      <td key={j} className="num">{cell}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : null}
    </details>
  );
}

interface ChartProps {
  points: EquityPointDto[];
  /** id of the heading that names this chart (the section's h3). */
  labelId: string;
}

/** Equity curve: single-series area chart (series-1 blue, 10% wash, 2px line). */
export const EquityChart = memo(function EquityChart({ points, labelId }: ChartProps) {
  const fmt = useFmt();
  const data = useMemo(() => downsample(points, (p) => p.equityUsd), [points]);
  const { ticks, fmtTick } = useTimeAxis(data, fmt);
  const stats = useMemo(() => {
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) return null;
    let min = first;
    let max = first;
    for (const p of points) {
      if (p.equityUsd < min.equityUsd) min = p;
      if (p.equityUsd > max.equityUsd) max = p;
    }
    const changePct = first.equityUsd > 0 ? ((last.equityUsd - first.equityUsd) / first.equityUsd) * 100 : 0;
    return { first, last, min, max, changePct };
  }, [points]);
  const getRows = useCallback(() => points.map((p) => [fmt.dateTime(p.ts), fmt.money(p.equityUsd), fmt.money(p.cashUsd)] as const), [points, fmt]);

  if (!stats) return <p className="empty">No equity snapshots yet.</p>;
  const summary = `Equity from ${fmt.money(stats.first.equityUsd)} on ${fmt.dateTimeZoned(stats.first.ts)} to ${fmt.money(stats.last.equityUsd)} on ${fmt.dateTime(stats.last.ts)} (${fmtPct(stats.changePct)}). Low ${fmt.money(stats.min.equityUsd)} on ${fmt.dateTime(stats.min.ts)}, high ${fmt.money(stats.max.equityUsd)} on ${fmt.dateTime(stats.max.ts)}. ${points.length} points${fmt.converts ? "" : ", amounts in USD"}.`;

  return (
    <figure className="chart" aria-labelledby={labelId} style={{ margin: 0 }}>
      <div className="chart-summary">
        <span>Now <strong>{fmt.money(stats.last.equityUsd)}</strong></span>
        <span>High <strong>{fmt.money(stats.max.equityUsd)}</strong></span>
        <span>Low <strong>{fmt.money(stats.min.equityUsd)}</strong></span>
      </div>
      <div role="img" aria-label="Equity curve chart; summary and data table follow">
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} accessibilityLayer={false}>
            <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
            <XAxis dataKey="ts" type="number" domain={["dataMin", "dataMax"]} scale="time" ticks={ticks} tickFormatter={fmtTick} tick={tick} axisLine={axisLine} tickLine={false} minTickGap={40} />
            <YAxis dataKey="equityUsd" domain={["auto", "auto"]} tickFormatter={(v) => fmt.moneyAxis(Number(v))} tick={tick} axisLine={false} tickLine={false} width={66} />
            <Tooltip {...tooltipStyle} labelFormatter={(v) => fmt.dateTime(Number(v))} formatter={(v) => [fmt.money(Number(v)), "Equity"]} />
            <Area type="monotone" dataKey="equityUsd" name="Equity" stroke="var(--series-1)" strokeWidth={2} fill="var(--series-1)" fillOpacity={0.1} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface-1)" }} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <figcaption>{summary}</figcaption>
      <DataTable caption="Equity snapshots" columns={[`Time (${fmt.zoneAbbr})`, `Equity (${fmt.currencySymbol})`, `Cash (${fmt.currencySymbol})`]} getRows={getRows} />
    </figure>
  );
});

/** Drawdown from running peak: single-series line (series-2 orange, 2px). */
export const DrawdownChart = memo(function DrawdownChart({ points, labelId }: ChartProps) {
  const fmt = useFmt();
  const full = useMemo(() => toDrawdown(points), [points]);
  const data = useMemo(() => downsample(full, (p) => p.drawdownPct), [full]);
  const { ticks, fmtTick } = useTimeAxis(data, fmt);
  const worst = useMemo(() => full.reduce<DrawdownPoint | null>((acc, p) => (acc === null || p.drawdownPct < acc.drawdownPct ? p : acc), null), [full]);
  const getRows = useCallback(() => full.map((p) => [fmt.dateTime(p.ts), fmtPct(p.drawdownPct)] as const), [full, fmt]);

  const last = full[full.length - 1];
  if (!last || !worst) return <p className="empty">No equity snapshots yet.</p>;
  const summary = `Drawdown from peak equity over time. Current ${fmtPct(last.drawdownPct)}; worst ${fmtPct(worst.drawdownPct)} on ${fmt.dateTimeZoned(worst.ts)}. ${full.length} points.`;
  const floor = Math.min(-1, Math.floor(worst.drawdownPct) - 1);

  return (
    <figure className="chart" aria-labelledby={labelId} style={{ margin: 0 }}>
      <div className="chart-summary">
        <span>Current <strong><DrawdownValue value={last.drawdownPct} /></strong></span>
        <span>Worst <strong><DrawdownValue value={worst.drawdownPct} /></strong></span>
      </div>
      <div role="img" aria-label="Drawdown chart; summary and data table follow">
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} accessibilityLayer={false}>
            <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
            <XAxis dataKey="ts" type="number" domain={["dataMin", "dataMax"]} scale="time" ticks={ticks} tickFormatter={fmtTick} tick={tick} axisLine={axisLine} tickLine={false} minTickGap={40} />
            <YAxis dataKey="drawdownPct" domain={[floor, 0]} tickFormatter={(v) => fmtPct(Number(v))} tick={tick} axisLine={false} tickLine={false} width={48} />
            <Tooltip {...tooltipStyle} labelFormatter={(v) => fmt.dateTime(Number(v))} formatter={(v) => [fmtPct(Number(v)), "Drawdown"]} />
            <Line type="monotone" dataKey="drawdownPct" name="Drawdown" stroke="var(--series-2)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface-1)" }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption>{summary}</figcaption>
      <DataTable caption="Drawdown by time" columns={[`Time (${fmt.zoneAbbr})`, "Drawdown"]} getRows={getRows} />
    </figure>
  );
});
