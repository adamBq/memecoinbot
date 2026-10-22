/**
 * Candle utilities that keep GeckoTerminal usage to one call per token:
 * fetch a long 5m series and aggregate the 1h series locally.
 */
import type { Candle } from "../core/types.js";

/** Aggregate ascending 5m candles into 1h candles aligned to the hour. Partial trailing hour is kept. */
export function aggregateToHourly(c5: Candle[]): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of c5) {
    const bucket = Math.floor(c.t / 3600) * 3600;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v += c.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}
