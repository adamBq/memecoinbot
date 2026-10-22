import { useId, useMemo } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { EquityPointDto } from "../types";
import { fmtDateShort, fmtDateTime, fmtPct, fmtTimeShort, fmtUsd, fmtUsdAxis } from "../lib/format";

const DAY = 86_400_000;

const tick = { fill: "var(--text-muted)", fontSize: 11 } as const;
const axisLine = { stroke: "var(--axis)" } as const;
const tooltipStyle = {
  contentStyle: { background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-primary)", fontSize: 12, padding: "6px 10px" },
  labelStyle: { color: "var(--text-secondary)", marginBottom: 2 },
  itemStyle: { color: "var(--text-primary)", padding: 0 },
  cursor: { stroke: "var(--axis)", strokeWidth: 1 },
} as const;

const MAX_TICKS = 8;

/** Explicit X ticks: local midnights for multi-day windows, 6-hour steps otherwise; thinned to <= MAX_TICKS. */
function useTimeAxis(points: ReadonlyArray<{ ts: number }>): { ticks: number[]; fmt: (ts: number) => string } {
  return useMemo(() => {
    const first = points[0]?.ts ?? 0;
    const last = points[points.length - 1]?.ts ?? 0;
    const span = last - first;
    const ticks: number[] = [];
    if (span >= 2 * DAY) {
      const d = new Date(first);
      d.setHours(24, 0, 0, 0);
      for (let t = d.getTime(); t <= last; t += DAY) ticks.push(t);
    } else {
      const step = 6 * 3_600_000;
      for (let t = Math.ceil(first / step) * step; t <= last; t += step) ticks.push(t);
    }
    const stride = Math.max(1, Math.ceil(ticks.length / MAX_TICKS));
    return { ticks: ticks.filter((_, i) => i % stride === 0), fmt: span >= 2 * DAY ? fmtDateShort : fmtTimeShort };
  }, [points]);
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

function DataTable({ rows, columns, caption }: { caption: string; columns: readonly string[]; rows: ReadonlyArray<readonly string[]> }) {
  return (
    <details>
      <summary>Show data table</summary>
      <div className="table-wrap">
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
                {r.map((cell, j) => (
                  <td key={j} className={j > 0 ? "num" : undefined}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Equity curve: single-series area chart (series-1 blue, 10% wash, 2px line). */
export function EquityChart({ points, refreshing = false }: { points: EquityPointDto[]; refreshing?: boolean }) {
  const id = useId();
  const { ticks, fmt: fmtX } = useTimeAxis(points);
  const stats = useMemo(() => {
    if (points.length === 0) return null;
    const first = points[0]!;
    const last = points[points.length - 1]!;
    let min = first, max = first;
    for (const p of points) {
      if (p.equityUsd < min.equityUsd) min = p;
      if (p.equityUsd > max.equityUsd) max = p;
    }
    const changePct = first.equityUsd > 0 ? ((last.equityUsd - first.equityUsd) / first.equityUsd) * 100 : 0;
    return { first, last, min, max, changePct };
  }, [points]);

  if (!stats) return <p className="empty">No equity snapshots yet.</p>;
  const caption = `Equity from ${fmtUsd(stats.first.equityUsd)} on ${fmtDateTime(stats.first.ts)} to ${fmtUsd(stats.last.equityUsd)} on ${fmtDateTime(stats.last.ts)} (${fmtPct(stats.changePct)}). Low ${fmtUsd(stats.min.equityUsd)} on ${fmtDateTime(stats.min.ts)}, high ${fmtUsd(stats.max.equityUsd)} on ${fmtDateTime(stats.max.ts)}. ${points.length} points.`;

  return (
    <figure className={`chart${refreshing ? " refreshing" : ""}`} aria-labelledby={id} style={{ margin: 0 }}>
      <div className="chart-summary">
        <span>Now <strong>{fmtUsd(stats.last.equityUsd)}</strong></span>
        <span>High <strong>{fmtUsd(stats.max.equityUsd)}</strong></span>
        <span>Low <strong>{fmtUsd(stats.min.equityUsd)}</strong></span>
      </div>
      <div role="img" aria-label={caption}>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
            <XAxis dataKey="ts" type="number" domain={["dataMin", "dataMax"]} scale="time" ticks={ticks} tickFormatter={fmtX} tick={tick} axisLine={axisLine} tickLine={false} minTickGap={40} />
            <YAxis dataKey="equityUsd" domain={["auto", "auto"]} tickFormatter={(v) => fmtUsdAxis(Number(v))} tick={tick} axisLine={false} tickLine={false} width={56} />
            <Tooltip {...tooltipStyle} labelFormatter={(v) => fmtDateTime(Number(v))} formatter={(v) => [fmtUsd(Number(v)), "Equity"]} />
            <Area type="monotone" dataKey="equityUsd" name="Equity" stroke="var(--series-1)" strokeWidth={2} fill="var(--series-1)" fillOpacity={0.1} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface-1)" }} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <figcaption id={id}>{caption}</figcaption>
      <DataTable caption="Equity snapshots" columns={["Time", "Equity", "Cash"]} rows={points.map((p) => [fmtDateTime(p.ts), fmtUsd(p.equityUsd), fmtUsd(p.cashUsd)])} />
    </figure>
  );
}

/** Drawdown from running peak: single-series line (series-2 orange, 2px). */
export function DrawdownChart({ points, refreshing = false }: { points: EquityPointDto[]; refreshing?: boolean }) {
  const id = useId();
  const { ticks, fmt: fmtX } = useTimeAxis(points);
  const data = useMemo(() => toDrawdown(points), [points]);
  const worst = useMemo(() => data.reduce<DrawdownPoint | null>((acc, p) => (acc === null || p.drawdownPct < acc.drawdownPct ? p : acc), null), [data]);

  if (data.length === 0 || !worst) return <p className="empty">No equity snapshots yet.</p>;
  const last = data[data.length - 1]!;
  const caption = `Drawdown from peak equity over time. Current ${fmtPct(last.drawdownPct)}; worst ${fmtPct(worst.drawdownPct)} on ${fmtDateTime(worst.ts)}. ${data.length} points.`;
  const floor = Math.min(-1, Math.floor(worst.drawdownPct) - 1);

  return (
    <figure className={`chart${refreshing ? " refreshing" : ""}`} aria-labelledby={id} style={{ margin: 0 }}>
      <div className="chart-summary">
        <span>Current <strong>{fmtPct(last.drawdownPct)}</strong></span>
        <span>Worst <strong>{fmtPct(worst.drawdownPct)}</strong></span>
      </div>
      <div role="img" aria-label={caption}>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
            <XAxis dataKey="ts" type="number" domain={["dataMin", "dataMax"]} scale="time" ticks={ticks} tickFormatter={fmtX} tick={tick} axisLine={axisLine} tickLine={false} minTickGap={40} />
            <YAxis dataKey="drawdownPct" domain={[floor, 0]} tickFormatter={(v) => fmtPct(Number(v))} tick={tick} axisLine={false} tickLine={false} width={48} />
            <Tooltip {...tooltipStyle} labelFormatter={(v) => fmtDateTime(Number(v))} formatter={(v) => [fmtPct(Number(v)), "Drawdown"]} />
            <Line type="monotone" dataKey="drawdownPct" name="Drawdown" stroke="var(--series-2)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface-1)" }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption id={id}>{caption}</figcaption>
      <DataTable caption="Drawdown by time" columns={["Time", "Drawdown"]} rows={data.map((p) => [fmtDateTime(p.ts), fmtPct(p.drawdownPct)])} />
    </figure>
  );
}
