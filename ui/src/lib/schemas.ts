/**
 * Runtime guards for every endpoint in docs/UI_CONTRACT.md. Objects are "loose" so
 * additive server fields pass through; missing or mistyped fields fail with ApiError.
 */
import { z } from "zod";
import { ApiError } from "./errors";

const num = z.number();
const nnum = z.number().nullable();
const str = z.string();
const bool = z.boolean();

const position = z.looseObject({
  id: num, mint: str, symbol: str, pairAddress: str, status: z.enum(["open", "closed"]),
  openedAt: num, closedAt: nnum, entryPriceUsd: num, entryLiquidityUsd: num, qtyTokens: num, remainingQtyTokens: num,
  costBasisUsd: num, realizedPnlUsd: num, peakPriceUsd: num, tp1Hit: bool, entryScore: num, closeReason: str.nullable(),
});
const openPosition = position.extend({ currentPriceUsd: nnum, pnlPct: nnum, unrealizedPnlUsd: nnum, peakPct: nnum, ageHours: num, remainingPct: num, priceAgeMs: nnum });
const closedPosition = position.extend({ pnlPct: nnum, holdHours: num });

const lens = z.looseObject({ score: num, reasons: z.array(str) });
const decision = z.looseObject({
  ts: num, mint: str, symbol: str, action: z.enum(["filtered", "skip", "enter", "exit"]), total: num,
  lenses: z.record(str, lens).nullable(), reason: str,
});
const candidate = decision.extend({ rank: num });

const order = z.looseObject({
  id: num, positionId: num, side: z.enum(["buy", "sell"]), mint: str, symbol: str, qtyTokens: num, effectivePriceUsd: num,
  referencePriceUsd: num, notionalUsd: num, feeUsd: num, priceImpactPct: num, reason: str, ts: num,
});

const summary = z.looseObject({
  generatedAt: num, startedAt: nnum, mode: z.literal("paper"), configHash: str.nullable(), llmEnabled: bool,
  startingEquityUsd: num, equityUsd: num, cashUsd: num, returnPct: num, peakEquityUsd: num, drawdownFromPeakPct: num,
  dayStartEquityUsd: num, dayPnlPct: num, openCount: num, closedCount: num, killed: bool, haltedUntil: nnum, consecutiveLosses: num,
  breakers: z.looseObject({ haltNewEntries: bool, killSwitch: bool, reasons: z.array(str) }),
  lastTickAt: nnum, lastScreenAt: nnum, botHealthy: bool, pricesStale: bool,
  display: z.looseObject({ currency: z.enum(["AUD", "USD"]), timezone: str, audPerUsd: nnum, fxAsOf: nnum, fxSource: str.nullable() }).nullable().optional(),
});

const SCHEMAS: Record<string, z.ZodType> = {
  "/api/health": z.looseObject({ ok: z.literal(true), ts: num }),
  "/api/summary": summary,
  "/api/equity": z.looseObject({ points: z.array(z.looseObject({ ts: num, equityUsd: num, cashUsd: num })) }),
  "/api/positions": z.looseObject({ open: z.array(openPosition), closed: z.array(closedPosition) }),
  "/api/orders": z.looseObject({ orders: z.array(order) }),
  "/api/decisions": z.looseObject({ decisions: z.array(decision), total: num }),
  "/api/candidates": z.looseObject({ screenedAt: nnum, candidates: z.array(candidate) }),
  "/api/notes": z.looseObject({ notes: z.array(z.looseObject({ ts: num, text: str })) }),
};

/** Validate a response body against the schema for its path. Unknown paths pass through untouched. */
export function parseResponse(path: string, raw: unknown): unknown {
  const pathname = path.split("?")[0] ?? path;
  const schema = SCHEMAS[pathname];
  if (!schema) return raw;
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue ? ` (${[pathname, ...issue.path.map(String)].join(".")}: ${issue.message})` : "";
    throw new ApiError(`Unexpected response shape${where}`);
  }
  return result.data;
}
