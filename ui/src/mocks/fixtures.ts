/**
 * Deterministic sample DTOs so the UI can be developed and screenshotted without
 * the server. Served when the page is opened with `?mock=1`.
 * `?mock=1&scenario=halted` or `&scenario=killed` exercises the breaker banner;
 * `&scenario=error` makes every endpoint fail.
 */
import type {
  CandidateDto, CandidatesResponse, ClosedPositionDto, DecisionDto, DecisionsResponse, EquityPointDto, EquityResponse,
  LensName, NotesResponse, OpenPositionDto, Order, OrdersResponse, PositionsResponse, SummaryDto,
} from "../types";
import { LENS_NAMES } from "../types";

// ---- deterministic PRNG so screenshots are reproducible ----
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261022);
const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function mint(): string {
  let s = "";
  for (let i = 0; i < 44; i++) s += BASE58[Math.floor(rand() * BASE58.length)];
  return s;
}

const HOUR = 3_600_000;
const NOW = Date.now();
const STARTED_AT = NOW - 7 * 24 * HOUR;
const LAST_SCREEN_AT = NOW - 2 * 60_000;
const LAST_TICK_AT = NOW - 40_000;

const SYMBOLS = [
  "BONKERS", "PEPEGA", "WOJAK", "SOLCAT", "DOGWIF", "GIGACHAD", "FROGE", "MOONPIG", "SLORP", "RIZZ",
  "BRAINROT", "CHILLGUY", "PENGU", "TRUMPET", "HAWKTUAH", "NEIRO", "GOAT", "PNUT", "FWOG", "MOODENG",
  "RETARDIO", "MICHI", "POPCAT", "SIGMA", "LOCKIN", "ACT", "ZEREBRO", "AI16Z", "GRIFFAIN", "SWARMS",
];
const tokens = SYMBOLS.map((symbol) => ({ symbol, mint: mint(), pairAddress: mint() }));

// ---- equity curve: hourly for 7 days with a drawdown mid-week, then a recovery ----
const equityPoints: EquityPointDto[] = (() => {
  const pts: EquityPointDto[] = [];
  let equity = 1000;
  for (let i = 0; i <= 7 * 24; i++) {
    const ts = STARTED_AT + i * HOUR;
    const phase = i / (7 * 24);
    let drift = 0.0009;
    if (phase > 0.45 && phase < 0.6) drift = -0.0045;
    if (phase > 0.6 && phase < 0.8) drift = 0.0032;
    equity = Math.max(820, equity * (1 + drift + between(-0.006, 0.006)));
    const invested = Math.min(equity * between(0.12, 0.32), 320);
    pts.push({ ts, equityUsd: round2(equity), cashUsd: round2(equity - invested) });
  }
  const last = pts[pts.length - 1] as EquityPointDto;
  pts.push({ ts: NOW, equityUsd: round2(last.equityUsd * 1.004), cashUsd: round2(last.cashUsd) });
  return pts;
})();

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const finalEquity = (equityPoints[equityPoints.length - 1] as EquityPointDto).equityUsd;
const peakEquity = Math.max(...equityPoints.map((p) => p.equityUsd));

// ---- positions ----
let positionId = 1;
function basePosition(t: (typeof tokens)[number], openedAt: number, entryPrice: number, notional: number) {
  const qty = notional / entryPrice;
  return {
    id: positionId++,
    mint: t.mint,
    symbol: t.symbol,
    pairAddress: t.pairAddress,
    openedAt,
    entryPriceUsd: entryPrice,
    entryLiquidityUsd: round2(between(60_000, 900_000)),
    qtyTokens: qty,
    remainingQtyTokens: qty,
    costBasisUsd: round2(notional),
    peakPriceUsd: entryPrice,
    tp1Hit: false,
    entryScore: round2(between(0.62, 0.84)),
  };
}

const openPositions: OpenPositionDto[] = [
  { t: tokens[3]!, hoursAgo: 5.4, pnl: 23.8, peak: 41.2, price: 0.00001834 },
  { t: tokens[6]!, hoursAgo: 19.1, pnl: -12.4, peak: 8.9, price: 0.0042317 },
  { t: tokens[12]!, hoursAgo: 31.7, pnl: 118.5, peak: 152.0, price: 0.0318 },
].map(({ t, hoursAgo, pnl, peak, price }) => {
  const openedAt = NOW - hoursAgo * HOUR;
  const notional = 80;
  const base = basePosition(t, openedAt, price, notional);
  const tp1Hit = pnl > 100;
  const remaining = tp1Hit ? base.qtyTokens * 0.5 : base.qtyTokens;
  const current = price * (1 + pnl / 100);
  return {
    ...base,
    status: "open",
    closedAt: null,
    remainingQtyTokens: remaining,
    realizedPnlUsd: tp1Hit ? round2(notional * 0.5) : 0,
    peakPriceUsd: price * (1 + peak / 100),
    tp1Hit,
    closeReason: null,
    currentPriceUsd: current,
    pnlPct: pnl,
    unrealizedPnlUsd: round2(remaining * (current - price)),
    peakPct: peak,
    ageHours: hoursAgo,
    remainingPct: tp1Hit ? 50 : 100,
  };
});

const CLOSE_REASONS = [
  "hard_stop: price -30.4% from entry",
  "trailing: -25.6% from peak after tp1",
  "take_profit: tp1 hit at 2.0x, sold 50%",
  "time_stop: 48h elapsed with +4.1% gain below hold threshold",
  "liquidity: pool liquidity dropped 44% vs entry",
  "safety: mint authority re-enabled per rugcheck",
  "trailing: -40.2% from peak before tp1",
];

const closedPositions: ClosedPositionDto[] = Array.from({ length: 12 }, (_, i) => {
  const t = tokens[14 + i]!;
  const holdHours = between(0.8, 52);
  const closedAt = NOW - (6 + i * 11) * HOUR;
  const openedAt = closedAt - holdHours * HOUR;
  const price = pick([0.0000071, 0.000342, 0.0018, 0.0241, 0.11, 0.00000934]);
  const base = basePosition(t, openedAt, price, 80);
  const win = rand() > 0.55;
  const pnlPct = win ? between(6, 140) : between(-31, -4);
  const reason = win ? pick(CLOSE_REASONS.slice(1, 4)) : pick([CLOSE_REASONS[0]!, CLOSE_REASONS[4]!, CLOSE_REASONS[6]!]);
  return {
    ...base,
    status: "closed",
    closedAt,
    remainingQtyTokens: 0,
    realizedPnlUsd: round2((80 * pnlPct) / 100),
    peakPriceUsd: price * (1 + Math.max(pnlPct, between(2, 60)) / 100),
    tp1Hit: pnlPct > 100,
    closeReason: reason,
    pnlPct: round2(pnlPct),
    holdHours: round2(holdHours),
  };
});

// ---- orders ----
let orderId = 1;
const orders: Order[] = (() => {
  const out: Order[] = [];
  const all = [...openPositions, ...closedPositions];
  for (const p of all) {
    out.push({
      id: orderId++, positionId: p.id, side: "buy", mint: p.mint, symbol: p.symbol, qtyTokens: p.qtyTokens,
      effectivePriceUsd: p.entryPriceUsd, referencePriceUsd: p.entryPriceUsd / 1.012, notionalUsd: p.costBasisUsd,
      feeUsd: round2(p.costBasisUsd * 0.003), priceImpactPct: round2(between(0.2, 1.4)), reason: `entry: composite ${p.entryScore.toFixed(2)}`, ts: p.openedAt,
    });
    if (p.tp1Hit) {
      out.push({
        id: orderId++, positionId: p.id, side: "sell", mint: p.mint, symbol: p.symbol, qtyTokens: p.qtyTokens * 0.5,
        effectivePriceUsd: p.entryPriceUsd * 2, referencePriceUsd: p.entryPriceUsd * 2.02, notionalUsd: p.costBasisUsd,
        feeUsd: round2(p.costBasisUsd * 0.003), priceImpactPct: round2(between(0.3, 1.8)), reason: "take_profit: tp1 at 2.0x", ts: p.openedAt + 3 * HOUR,
      });
    }
    if (p.status === "closed" && p.closedAt !== null) {
      const notional = 80 * (1 + (p as ClosedPositionDto).pnlPct / 100);
      out.push({
        id: orderId++, positionId: p.id, side: "sell", mint: p.mint, symbol: p.symbol, qtyTokens: p.qtyTokens,
        effectivePriceUsd: notional / p.qtyTokens, referencePriceUsd: (notional / p.qtyTokens) * 1.01, notionalUsd: round2(notional),
        feeUsd: round2(notional * 0.003), priceImpactPct: round2(between(0.3, 2.1)), reason: p.closeReason ?? "exit", ts: p.closedAt,
      });
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
})();

// ---- decisions ----
const LENS_REASONS: Record<LensName, readonly string[]> = {
  technical: [
    "Price above 1h high of prior 6h (breakout confirmed)",
    "1h volume 2.3x trailing 6h average",
    "5m momentum positive, 3 consecutive green candles",
    "Below 1h VWAP, no breakout",
    "Price -18% from 24h high, momentum fading",
  ],
  fundamental: [
    "Mint and freeze authority revoked",
    "Top 10 holders 22.4% (limit 35%)",
    "LP locked 100% (pump.fun AMM)",
    "Round-trip retention 96.2% on $100 quote",
    "Largest holder 11.8%, close to the 15% cap",
  ],
  quantitative: [
    "Liquidity $184K, market cap $2.1M (liq/mcap 8.8%)",
    "Buy pressure 1h 0.61",
    "Volume 24h $1.4M (7.6x liquidity)",
    "Txns 1h 212 (buys 131 / sells 81)",
    "Volume 24h only 1.2x liquidity, thin tape",
  ],
  sentiment: [
    "Twitter and Telegram linked, website present",
    "2 active DexScreener boosts",
    "LLM narrative 0.70: cat-themed meme riding a broader animal-coin rotation with an active community and recent influencer mentions; narrative is derivative but currently has attention",
    "No socials beyond a Telegram group",
    "LLM narrative 0.35: generic AI-agent branding with no differentiated story",
  ],
  event: [
    "Graduated from pump.fun 14h ago",
    "Volume z-score 1h 2.4",
    "Entered DexScreener trending (rank 12)",
    "No catalyst detected in the last 24h",
    "5m volume spike 4.1x 6h average",
  ],
};

const FILTER_FAILURES = [
  "Hard filter: liquidity $32.1K < $50K minimum",
  "Hard filter: token age 1.2h < 2h minimum",
  "Hard filter: top 10 holders 48.3% > 35% limit",
  "Hard filter: mint authority not revoked",
  "Hard filter: round-trip loss 9.4% > 6% maximum",
  "Hard filter: rugcheck danger risk 'Low amount of LP Providers'",
  "Hard filter: volume 24h $41K < $100K minimum",
  "Hard filter: LP locked 12% < 50% minimum",
];

function lensScores(target: number): Record<LensName, { score: number; reasons: string[] }> {
  const out = {} as Record<LensName, { score: number; reasons: string[] }>;
  for (const name of LENS_NAMES) {
    const score = Math.min(1, Math.max(0, target + between(-0.22, 0.22)));
    const pool = LENS_REASONS[name];
    const n = 1 + Math.floor(rand() * 3);
    const reasons = Array.from({ length: n }, (_, i) => pool[(Math.floor(rand() * pool.length) + i) % pool.length] as string);
    out[name] = { score: round2(score), reasons: Array.from(new Set(reasons)) };
  }
  return out;
}

const WEIGHTS: Record<LensName, number> = { technical: 0.3, fundamental: 0.2, quantitative: 0.2, sentiment: 0.15, event: 0.15 };

const decisions: DecisionDto[] = (() => {
  const out: DecisionDto[] = [];
  const screens = 14;
  for (let s = 0; s < screens; s++) {
    const ts = LAST_SCREEN_AT - s * 5 * 60_000 * 6;
    const seen = new Set<number>();
    const n = 7 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) {
      let idx = Math.floor(rand() * tokens.length);
      while (seen.has(idx)) idx = (idx + 1) % tokens.length;
      seen.add(idx);
      const t = tokens[idx]!;
      const r = rand();
      if (r < 0.55) {
        out.push({ ts: ts - i * 900, mint: t.mint, symbol: t.symbol, action: "filtered", total: 0, lenses: null, reason: pick(FILTER_FAILURES) });
      } else if (r < 0.92) {
        const lenses = lensScores(between(0.3, 0.6));
        const total = round2(Math.min(0.61, LENS_NAMES.reduce((acc, k) => acc + lenses[k].score * WEIGHTS[k], 0)));
        const why = lenses.technical.score < 0.55
          ? `skip: technical ${lenses.technical.score.toFixed(2)} < 0.55 minimum`
          : `skip: composite ${total.toFixed(2)} < 0.62 minimum`;
        out.push({ ts: ts - i * 900, mint: t.mint, symbol: t.symbol, action: "skip", total, lenses, reason: why });
      } else {
        const lenses = lensScores(between(0.66, 0.86));
        lenses.technical.score = Math.max(lenses.technical.score, 0.58);
        const total = round2(Math.max(0.62, LENS_NAMES.reduce((acc, k) => acc + lenses[k].score * WEIGHTS[k], 0)));
        out.push({ ts: ts - i * 900, mint: t.mint, symbol: t.symbol, action: "enter", total, lenses, reason: `enter: composite ${total.toFixed(2)}, breakout confirmed, notional $80.00` });
      }
    }
  }
  for (const p of closedPositions) {
    out.push({ ts: p.closedAt ?? NOW, mint: p.mint, symbol: p.symbol, action: "exit", total: 0, lenses: null, reason: p.closeReason ?? "exit" });
  }
  return out.sort((a, b) => b.ts - a.ts);
})();


const candidates: CandidateDto[] = (() => {
  const byMint = new Map<string, DecisionDto>();
  for (const d of decisions) {
    if (d.ts < LAST_SCREEN_AT - 5 * 60_000) continue;
    if (d.action === "exit") continue;
    if (!byMint.has(d.mint)) byMint.set(d.mint, d);
  }
  return [...byMint.values()]
    .sort((a, b) => b.total - a.total)
    .map((d, i) => ({ ...d, rank: i + 1 }));
})();

const notes: NotesResponse = {
  notes: [
    { ts: STARTED_AT, text: "Bot started in paper mode. Starting equity $1,000.00, config hash 9f3a1c2e." },
    { ts: STARTED_AT + 4 * HOUR, text: "LLM lens enabled (claude-haiku-5-5), max 10 calls per screen." },
    { ts: STARTED_AT + 26 * HOUR, text: "GeckoTerminal rate limit hit twice; candle fetch capped at 8 per screen." },
    { ts: STARTED_AT + 3 * 24 * HOUR + 2 * HOUR, text: "Daily loss -10.3%: new entries halted for the rest of the UTC day." },
    { ts: STARTED_AT + 4 * 24 * HOUR, text: "Halt lifted at UTC rollover. Consecutive losses reset to 0." },
    { ts: STARTED_AT + 5 * 24 * HOUR + 9 * HOUR, text: "DexScreener returned stale prices for 6 minutes; entries blocked by dataStaleSeconds." },
    { ts: NOW - 3 * HOUR, text: "PENGU tp1 hit at 2.0x; sold 50%, trailing the remainder at 25% from peak." },
  ],
};

// ---- scenarios ----
function scenario(): string {
  return new URLSearchParams(window.location.search).get("scenario") ?? "";
}

function summary(): SummaryDto {
  const sc = scenario();
  const killed = sc === "killed";
  const halted = sc === "halted";
  const invested = openPositions.reduce((acc, p) => acc + (p.remainingQtyTokens * (p.currentPriceUsd ?? 0)), 0);
  return {
    generatedAt: NOW,
    startedAt: STARTED_AT,
    mode: "paper",
    configHash: "9f3a1c2e7b5d",
    llmEnabled: true,
    startingEquityUsd: 1000,
    equityUsd: finalEquity,
    cashUsd: round2(finalEquity - invested),
    returnPct: round2(((finalEquity - 1000) / 1000) * 100),
    peakEquityUsd: peakEquity,
    drawdownFromPeakPct: round2(((finalEquity - peakEquity) / peakEquity) * 100),
    dayStartEquityUsd: round2(finalEquity / 1.018),
    dayPnlPct: 1.8,
    openCount: openPositions.length,
    closedCount: closedPositions.length,
    killed,
    haltedUntil: halted ? NOW + 7 * HOUR : null,
    consecutiveLosses: halted ? 6 : 2,
    breakers: {
      haltNewEntries: halted || killed,
      killSwitch: killed,
      reasons: killed
        ? ["Drawdown from peak -25.4% exceeds 25% kill switch; all positions closed"]
        : halted
          ? ["6 consecutive losses: new entries paused for 12h cooldown", "Daily loss -10.3% exceeds 10% limit"]
          : [],
    },
    lastTickAt: LAST_TICK_AT,
    lastScreenAt: LAST_SCREEN_AT,
    botHealthy: true,
  };
}

function delay<T>(value: T, ms = 180): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** Route a `/api/...` path (with query) to a fixture. Mirrors the server's query handling. */
export function mockFetch(path: string): Promise<unknown> {
  const url = new URL(path, window.location.origin);
  if (scenario() === "error") return delay(null).then(() => { throw new Error("Mock server failure (scenario=error)"); });
  switch (url.pathname) {
    case "/api/health":
      return delay({ ok: true, ts: Date.now() });
    case "/api/summary":
      return delay(summary());
    case "/api/equity":
      return delay<EquityResponse>({ points: equityPoints });
    case "/api/positions":
      return delay<PositionsResponse>({ open: openPositions, closed: closedPositions });
    case "/api/orders": {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return delay<OrdersResponse>({ orders: orders.slice(0, limit) });
    }
    case "/api/decisions": {
      const actions = url.searchParams.get("action")?.split(",").filter(Boolean) ?? [];
      const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 100));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const since = Number(url.searchParams.get("since") ?? 0);
      const rows = decisions.filter((d) => (actions.length === 0 || actions.includes(d.action)) && d.ts >= since);
      return delay<DecisionsResponse>({ decisions: rows.slice(offset, offset + limit), total: rows.length });
    }
    case "/api/candidates":
      return delay<CandidatesResponse>({ screenedAt: LAST_SCREEN_AT, candidates });
    case "/api/notes":
      return delay(notes);
    default:
      return delay(null).then(() => { throw new Error(`Mock: unknown path ${url.pathname}`); });
  }
}
