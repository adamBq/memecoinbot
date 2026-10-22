/** Formatting helpers. Every number shown in the UI goes through one of these. */

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const sig8 = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8, useGrouping: false });
const pct1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const qty = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** USD with 2 decimals: $1,234.56. */
export function fmtUsd(v: number | null | undefined): string {
  return finite(v) ? usd.format(v) : "—";
}

/** USD for axis ticks: whole dollars with grouping under $10K ($1,150), compact above ($12.3K). */
export function fmtUsdAxis(v: number | null | undefined): string {
  if (!finite(v)) return "—";
  return Math.abs(v) < 10_000 ? usdWhole.format(v) : usdCompact.format(v);
}

/** Token price with up to 8 significant digits, no exponent: $0.000012345678. */
export function fmtTokenPrice(v: number | null | undefined): string {
  return finite(v) ? `$${sig8.format(v)}` : "—";
}

/** Percentage, 1 decimal, explicit sign: +12.5% / -3.2% / 0.0%. Input is a plain number (12.5 means 12.5%). */
export function fmtPct(v: number | null | undefined, { sign = true }: { sign?: boolean } = {}): string {
  if (!finite(v)) return "—";
  const body = `${pct1.format(Math.abs(v))}%`;
  if (!sign) return body;
  if (v > 0) return `+${body}`;
  if (v < 0) return `-${body}`;
  return body;
}

/** Token quantity, grouped, up to 2 decimals. */
export function fmtQty(v: number | null | undefined): string {
  return finite(v) ? qty.format(v) : "—";
}

/** A 0..1 score as two decimals. */
export function fmtScore(v: number | null | undefined): string {
  return finite(v) ? v.toFixed(2) : "—";
}

/** Hours as a short duration: 45m, 3.2h, 2d 4h. */
export function fmtHours(h: number | null | undefined): string {
  if (!finite(h) || h < 0) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  const days = Math.floor(h / 24);
  const rem = Math.round(h - days * 24);
  return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
}

/** Relative time: "just now", "42s ago", "5m ago", "3h ago", "2d ago". */
export function fmtAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!finite(ts)) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Absolute local date-time for titles and tables. */
export function fmtDateTime(ts: number | null | undefined): string {
  if (!finite(ts)) return "—";
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Short date for chart axes. */
export function fmtDateShort(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Time of day for chart axes when the window is under two days. */
export function fmtTimeShort(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** First and last characters of a mint for compact display. */
export function fmtMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}
