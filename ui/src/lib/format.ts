/**
 * Formatting helpers. Pure helpers (percentages, durations, scores) are exported directly;
 * anything that shows money or a clock time comes from `makeFormatters(display)` so the
 * user's currency and timezone are applied everywhere. Components get one via `useFmt()`.
 */

export type Currency = "AUD" | "USD";

export interface DisplaySettings {
  currency: Currency;
  /** IANA zone, e.g. "Australia/Sydney". */
  timezone: string;
  audPerUsd: number | null;
  fxAsOf: number | null;
  fxSource: string | null;
}

export const DEFAULT_TIMEZONE = "Australia/Sydney";
export const DEFAULT_DISPLAY: DisplaySettings = { currency: "USD", timezone: DEFAULT_TIMEZONE, audPerUsd: null, fxAsOf: null, fxSource: null };

const LOCALE = "en-AU";

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// ---- pure helpers ----

const pct1 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const qty = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });

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

/** Relative time: "just now", "42s ago", "5m ago", "3h ago", "2d ago". Zone-independent. */
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

/** First and last characters of a mint for compact display. */
export function fmtMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

// ---- currency + timezone aware formatters ----

export interface Formatters {
  /** "A$" when converting to AUD, otherwise "US$" (visible USD label). */
  currencySymbol: string;
  /** True when amounts are converted to AUD. */
  converts: boolean;
  /** Zone abbreviation for the current instant, e.g. "AEDT" / "AEST". */
  zoneAbbr: string;
  timezone: string;
  /** Money with 2 decimals: A$1,234.56 / -US$9.92. */
  money(usd: number | null | undefined): string;
  /** Axis ticks: whole units under 10K (A$1,150), compact above (A$12.3K). */
  moneyAxis(usd: number | null | undefined): string;
  /** Token unit price, up to 8 significant digits, converted: A$0.000012345678. */
  tokenPrice(usd: number | null | undefined): string;
  /** "22 Oct, 13:10" in the display zone. */
  dateTime(ts: number | null | undefined): string;
  /** "22 Oct, 13:10 AEDT": use where a date stands alone (captions, health panel). */
  dateTimeZoned(ts: number | null | undefined): string;
  /** "16 Oct" for chart axes. */
  dateShort(ts: number): string;
  /** "13:10" for chart axes on short windows. */
  timeShort(ts: number): string;
  /** Epoch ms of each local midnight in the display zone strictly after `first` and up to `last`. */
  dayStarts(first: number, last: number): number[];
}

function safeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

interface ZoneParts { y: number; m: number; d: number; h: number; mi: number; s: number }

function zonePartsReader(tz: string): (ts: number) => ZoneParts {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  return (ts) => {
    const p: Record<string, number> = {};
    for (const part of f.formatToParts(ts)) if (part.type !== "literal") p[part.type] = Number(part.value);
    return { y: p.year ?? 1970, m: p.month ?? 1, d: p.day ?? 1, h: (p.hour ?? 0) % 24, mi: p.minute ?? 0, s: p.second ?? 0 };
  };
}

/** Build the formatter set for a display setting. Cheap enough to memoize per settings object. */
export function makeFormatters(display: DisplaySettings): Formatters {
  const timezone = safeZone(display.timezone);
  const converts = display.currency === "AUD" && finite(display.audPerUsd) && display.audPerUsd > 0;
  const rate = converts ? (display.audPerUsd as number) : 1;
  const symbol = converts ? "A$" : "US$";

  const two = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const whole = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
  const compact = new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 });
  const sig8 = new Intl.NumberFormat(LOCALE, { maximumSignificantDigits: 8, useGrouping: false });

  const signed = (v: number, body: string) => `${v < 0 ? "-" : ""}${symbol}${body}`;

  const dt = new Intl.DateTimeFormat(LOCALE, { timeZone: timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const dtz = new Intl.DateTimeFormat(LOCALE, { timeZone: timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" });
  const dShort = new Intl.DateTimeFormat(LOCALE, { timeZone: timezone, day: "numeric", month: "short" });
  const tShort = new Intl.DateTimeFormat(LOCALE, { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const zoneAbbr = new Intl.DateTimeFormat(LOCALE, { timeZone: timezone, timeZoneName: "short" }).formatToParts(Date.now()).find((p) => p.type === "timeZoneName")?.value ?? timezone;

  const parts = zonePartsReader(timezone);
  const offsetMs = (ts: number) => {
    const p = parts(ts);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
  };
  /** Midnight in the zone on the day after the day containing `ts`, DST-safe. */
  const startOfNextDay = (ts: number): number => {
    const p = parts(ts);
    let guess = Date.UTC(p.y, p.m - 1, p.d + 1) - offsetMs(ts);
    const q = parts(guess);
    const intoDay = (q.h * 3600 + q.mi * 60 + q.s) * 1000;
    if (intoDay !== 0) guess += intoDay > 12 * 3_600_000 ? 86_400_000 - intoDay : -intoDay;
    return guess;
  };

  return {
    currencySymbol: symbol,
    converts,
    zoneAbbr,
    timezone,
    money: (usd) => (finite(usd) ? signed(usd * rate, two.format(Math.abs(usd * rate))) : "—"),
    moneyAxis: (usd) => {
      if (!finite(usd)) return "—";
      const v = usd * rate;
      return signed(v, Math.abs(v) < 10_000 ? whole.format(Math.abs(v)) : compact.format(Math.abs(v)));
    },
    tokenPrice: (usd) => (finite(usd) ? signed(usd * rate, sig8.format(Math.abs(usd * rate))) : "—"),
    dateTime: (ts) => (finite(ts) ? dt.format(ts) : "—"),
    dateTimeZoned: (ts) => (finite(ts) ? dtz.format(ts) : "—"),
    dateShort: (ts) => dShort.format(ts),
    timeShort: (ts) => tShort.format(ts),
    dayStarts: (first, last) => {
      const out: number[] = [];
      let t = startOfNextDay(first);
      let guard = 0;
      while (t <= last && guard++ < 4000) {
        out.push(t);
        t = startOfNextDay(t);
      }
      return out;
    },
  };
}
