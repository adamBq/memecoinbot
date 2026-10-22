/**
 * RugCheck client: GET https://api.rugcheck.xyz/v1/tokens/{mint}/report,
 * normalised into a SafetyReport.
 *
 * Holder concentration excludes pool, AMM, LP, locker and vault accounts so a
 * pump.fun AMM holding most of the supply does not read as a whale. Reports
 * are cached 10 minutes; error bodies are never cached.
 */
import { getJson, HttpError, limiterFor, TtlCache } from "../core/http.js";
import { logger } from "../core/logger.js";
import type { RiskFlag, SafetyReport } from "../core/types.js";

export const RUGCHECK_BASE_URL = "https://api.rugcheck.xyz/v1";

const REPORT_TTL_MS = 10 * 60_000;
/** knownAccounts entries whose type or name match this are not real holders. */
const POOL_ACCOUNT_RE = /amm|pool|lp|raydium|orca|meteora|pump|locker|vault/i;

const limiter = limiterFor("api.rugcheck.xyz", 30, 0.5);
const reportCache = new TtlCache<SafetyReport>();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

/** An authority is revoked when the field is absent, null, or empty. */
function authorityRevoked(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

interface Holder {
  address: string | null;
  owner: string | null;
  pct: number;
}

/**
 * Build the set of addresses that must not count as holders: knownAccounts
 * matching the pool regex, every market address and its liquidity token
 * accounts, and every locker (and the locker's token account / owner).
 */
function collectExcludedAccounts(raw: Record<string, unknown>): Set<string> {
  const excluded = new Set<string>();

  if (isRecord(raw.knownAccounts)) {
    for (const [addr, info] of Object.entries(raw.knownAccounts)) {
      if (!isRecord(info)) continue;
      const type = str(info.type) ?? "";
      const name = str(info.name) ?? "";
      if (POOL_ACCOUNT_RE.test(type) || POOL_ACCOUNT_RE.test(name)) excluded.add(addr);
    }
  }

  if (Array.isArray(raw.markets)) {
    for (const m of raw.markets) {
      if (!isRecord(m)) continue;
      for (const key of ["pubkey", "liquidityA", "liquidityB"]) {
        const v = str(m[key]);
        if (v) excluded.add(v);
      }
    }
  }

  if (isRecord(raw.lockers)) {
    for (const [addr, info] of Object.entries(raw.lockers)) {
      excluded.add(addr);
      if (!isRecord(info)) continue;
      for (const key of ["tokenAccount", "owner"]) {
        const v = str(info[key]);
        if (v) excluded.add(v);
      }
    }
  }
  if (isRecord(raw.lockerOwners)) {
    for (const addr of Object.keys(raw.lockerOwners)) excluded.add(addr);
  }

  return excluded;
}

function extractHolders(raw: Record<string, unknown>): Holder[] {
  if (!Array.isArray(raw.topHolders)) return [];
  const excluded = collectExcludedAccounts(raw);
  const holders: Holder[] = [];
  for (const h of raw.topHolders) {
    if (!isRecord(h)) continue;
    const address = str(h.address);
    const owner = str(h.owner);
    if ((address && excluded.has(address)) || (owner && excluded.has(owner))) continue;
    const pct = num(h.pct, 0);
    if (pct <= 0) continue;
    holders.push({ address, owner, pct });
  }
  holders.sort((a, b) => b.pct - a.pct);
  return holders;
}

function extractLpLockedPct(raw: Record<string, unknown>): number {
  if (!Array.isArray(raw.markets)) return 0;
  let best = 0;
  for (const m of raw.markets) {
    if (!isRecord(m)) continue;
    const marketType = str(m.marketType) ?? "";
    let pct: number;
    if (marketType === "pump_fun_amm") {
      pct = 100;
    } else {
      pct = isRecord(m.lp) ? num(m.lp.lpLockedPct, 0) : 0;
    }
    best = Math.max(best, clampPct(pct));
  }
  return best;
}

function extractRisks(raw: Record<string, unknown>): RiskFlag[] {
  if (!Array.isArray(raw.risks)) return [];
  const out: RiskFlag[] = [];
  for (const r of raw.risks) {
    if (!isRecord(r)) continue;
    const name = str(r.name);
    if (!name) continue;
    const flag: RiskFlag = { name, level: str(r.level) ?? "info" };
    const description = str(r.description);
    if (description) flag.description = description;
    out.push(flag);
  }
  return out;
}

function extractLaunchpad(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  if (isRecord(v)) return str(v.name) ?? str(v.platform);
  return null;
}

/** Normalise a raw report. Malformed input yields a conservative "unknown" report, never throws. */
export function normalizeRugcheckReport(raw: unknown, mint: string): SafetyReport {
  const fetchedAt = Date.now();
  const r = isRecord(raw) ? raw : {};
  const token = isRecord(r.token) ? r.token : {};
  const tokenMeta = isRecord(r.tokenMeta) ? r.tokenMeta : {};
  const transferFee = isRecord(r.transferFee) ? r.transferFee : {};

  const holders = extractHolders(r);
  const top10 = holders.slice(0, 10).reduce((sum, h) => sum + h.pct, 0);

  const mintAuthority = "mintAuthority" in r ? r.mintAuthority : token.mintAuthority;
  const freezeAuthority = "freezeAuthority" in r ? r.freezeAuthority : token.freezeAuthority;

  const scoreNormalised = r.score_normalised;

  return {
    mint,
    mintAuthorityRevoked: authorityRevoked(mintAuthority),
    freezeAuthorityRevoked: authorityRevoked(freezeAuthority),
    top10HolderPct: clampPct(top10),
    largestHolderPct: clampPct(holders[0]?.pct ?? 0),
    totalHolders: Math.max(0, Math.floor(num(r.totalHolders, 0))),
    lpLockedPct: extractLpLockedPct(r),
    rugcheckScoreNormalised: typeof scoreNormalised === "number" && Number.isFinite(scoreNormalised) ? scoreNormalised : null,
    risks: extractRisks(r),
    rugged: r.rugged === true,
    transferFeePct: clampPct(num(transferFee.pct, 0)),
    metadataMutable: tokenMeta.mutable === true,
    launchpad: extractLaunchpad(r.launchpad),
    creator: str(r.creator),
    fetchedAt,
  };
}

/**
 * Fetch and normalise the report for a mint. Null on 4xx, on an `{error}`
 * body ("unable to generate report"), or on a malformed body. Successful
 * reports are cached 10 minutes.
 */
export async function getSafetyReport(mint: string): Promise<SafetyReport | null> {
  const cached = reportCache.get(mint);
  if (cached) return cached;

  const url = `${RUGCHECK_BASE_URL}/tokens/${encodeURIComponent(mint)}/report`;
  let body: unknown;
  try {
    body = await getJson<unknown>(url, { limiter, nullOnStatus: [400, 404], timeoutMs: 20_000 });
  } catch (err) {
    if (err instanceof HttpError && err.status < 500) {
      logger.debug({ mint, status: err.status }, "rugcheck: client error, no report");
      return null;
    }
    throw err;
  }
  if (!isRecord(body)) return null;
  if (body.error !== undefined) {
    logger.debug({ mint, error: body.error }, "rugcheck: report unavailable");
    return null;
  }
  const report = normalizeRugcheckReport(body, mint);
  reportCache.set(mint, report, REPORT_TTL_MS);
  return report;
}
