/**
 * Read-only dashboard server: Node built-in `http`, no framework.
 *
 * `/api/*` routes return JSON built by src/ui/api.ts; everything else is
 * served from `staticDir` (the Vite build in ui/dist) with an SPA fallback to
 * index.html. The server never writes to the ledger: `main()` opens it with
 * `{ readOnly: true }` and every builder runs inside `ledger.readTx`.
 *
 * Defences: Host allowlist (DNS rebinding), `X-Content-Type-Options: nosniff`
 * on every response, opaque 500 bodies, static paths pinned under staticDir,
 * bounded query parameters, and short caches for both prices and built DTOs.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_DISPLAY_CURRENCY, DEFAULT_DISPLAY_TIMEZONE, loadEnv, loadStrategyConfig, type DisplayCurrency, type StrategyConfig } from "../core/config.js";
import { logger } from "../core/logger.js";
import { getPairsByTokens, pickPrimaryPair } from "../data/dexscreener.js";
import { Ledger } from "../execution/ledger.js";
import {
  buildCandidates,
  buildConfigDto,
  buildDecisions,
  buildEquity,
  buildNotes,
  buildOrders,
  buildPositions,
  buildReportDto,
  buildSummary,
  DECISIONS_DEFAULT_LIMIT,
  DECISIONS_MAX_OFFSET,
  ORDERS_DEFAULT_LIMIT,
  type GetPrices,
  type PriceBook,
} from "./api.js";
import { getAudPerUsd, type FxRate, type GetFx } from "./fx.js";
import type { HealthDto } from "./types.js";

export const DEFAULT_UI_HOST = "127.0.0.1";
export const DEFAULT_UI_PORT = 4777;
export const PRICE_CACHE_TTL_MS = 30_000;
/** Cached marks older than this are dropped rather than served. */
export const PRICE_MAX_AGE_MS = 10 * 60_000;
/** Longest a request waits for an upstream price fetch before serving cached marks. */
export const PRICE_FETCH_TIMEOUT_MS = 3_000;
export const DTO_CACHE_TTL_MS = 1_500;
/** Longest /api/summary waits for the FX rate before answering with `audPerUsd: null`. */
export const FX_FETCH_TIMEOUT_MS = 3_000;

export interface ServerOptions {
  ledger: Ledger;
  cfg: StrategyConfig;
  /** Fetches live USD prices for the given mints. Missing mints are simply absent from the map. */
  getPrices: GetPrices;
  /** Directory of the built frontend (ui/dist). May not exist yet. */
  staticDir: string;
  /** Strategy YAML path, re-read by /api/config. */
  configPath: string;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Price cache TTL in ms, default 30s. */
  priceTtlMs?: number;
  /** Cap on the wait for an upstream price fetch, default 3s. */
  priceFetchTimeoutMs?: number;
  /** Built-DTO cache TTL in ms, default 1.5s. 0 disables it. */
  dtoTtlMs?: number;
  /** Extra Host header values (host or host:port) accepted besides loopback, e.g. a deliberately bound LAN address. */
  allowedHosts?: string[];
  /** USD->AUD rate source, default `getAudPerUsd` (cached 1h). Injected so tests never hit the network. */
  getFx?: GetFx;
  /** Cap on the wait for the FX rate, default 3s. */
  fxTimeoutMs?: number;
  /** Display preferences surfaced on /api/summary. Defaults: AUD, Australia/Sydney. */
  display?: { currency: DisplayCurrency; timezone: string };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase()) || host === "::1";
}

/**
 * True when the Host header names this server: loopback on the bound port, or
 * one of `extra` (matched as given, with or without a port). A missing or
 * foreign Host is how a DNS-rebinding page reaches a local service.
 */
export function hostAllowed(hostHeader: string | undefined, port: number, extra: readonly string[] = []): boolean {
  if (hostHeader === undefined || hostHeader === "") return false;
  const h = hostHeader.trim().toLowerCase();
  for (const lb of LOOPBACK_HOSTS) if (h === `${lb}:${port}`) return true;
  for (const e of extra) {
    const x = e.toLowerCase();
    if (h === x || h === `${x}:${port}`) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Price cache

export interface PriceCacheOptions {
  ttlMs?: number;
  maxAgeMs?: number;
  fetchTimeoutMs?: number;
  now?: () => number;
}

/**
 * Wraps `getPrices` with a per-mint cache.
 *  - A mint is refreshed when its mark is older than `ttlMs`; a miss or a
 *    failed fetch is retried at most once per `ttlMs` (negative caching).
 *  - In-flight fetches are tracked per mint, so concurrent callers with
 *    different mint sets each get their own mints fetched exactly once.
 *  - A caller waits at most `fetchTimeoutMs` for the upstream call, then gets
 *    whatever is cached; the fetch keeps running and fills the cache.
 *  - Marks older than `maxAgeMs` are dropped, and only prices > 0 are stored.
 */
export function createPriceCache(getPrices: GetPrices, opts: PriceCacheOptions = {}): (mints: string[]) => Promise<PriceBook> {
  const ttlMs = opts.ttlMs ?? PRICE_CACHE_TTL_MS;
  const maxAgeMs = opts.maxAgeMs ?? PRICE_MAX_AGE_MS;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? PRICE_FETCH_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { price: number; at: number }>();
  const lastAttempt = new Map<string, number>();
  const inflight = new Map<string, Promise<void>>();

  async function refresh(mints: string[]): Promise<void> {
    try {
      const fresh = await getPrices(mints);
      const at = now();
      for (const m of mints) {
        const px = fresh[m];
        if (px !== undefined && Number.isFinite(px) && px > 0) cache.set(m, { price: px, at });
      }
    } catch (err) {
      logger.warn({ err: String(err), mints: mints.length }, "ui: price fetch failed, using cached marks");
    }
  }

  function snapshot(mints: string[]): PriceBook {
    const t = now();
    const out: PriceBook = {};
    for (const m of mints) {
      const hit = cache.get(m);
      if (hit === undefined) continue;
      if (t - hit.at > maxAgeMs) {
        cache.delete(m);
        continue;
      }
      out[m] = { price: hit.price, at: hit.at };
    }
    return out;
  }

  return async (mints: string[]): Promise<PriceBook> => {
    const unique = [...new Set(mints)];
    const t = now();
    const waits: Promise<void>[] = [];
    const toFetch: string[] = [];
    for (const m of unique) {
      const hit = cache.get(m);
      if (hit !== undefined && t - hit.at < ttlMs) continue;
      const pending = inflight.get(m);
      if (pending !== undefined) {
        waits.push(pending);
        continue;
      }
      const attempted = lastAttempt.get(m);
      if (attempted !== undefined && t - attempted < ttlMs) continue; // negative cache
      toFetch.push(m);
    }
    if (toFetch.length > 0) {
      for (const m of toFetch) lastAttempt.set(m, t);
      const p = refresh(toFetch).finally(() => {
        for (const m of toFetch) if (inflight.get(m) === p) inflight.delete(m);
      });
      for (const m of toFetch) inflight.set(m, p);
      waits.push(p);
    }
    if (waits.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((r) => {
        timer = setTimeout(r, fetchTimeoutMs);
        timer.unref();
      });
      await Promise.race([Promise.all(waits).then(() => undefined), timeout]);
      if (timer !== undefined) clearTimeout(timer);
    }
    return snapshot(unique);
  };
}

/** Live prices through DexScreener: primary pair per mint. */
export async function fetchDexscreenerPrices(mints: string[]): Promise<Record<string, number>> {
  if (mints.length === 0) return {};
  const pairs = await getPairsByTokens(mints);
  const out: Record<string, number> = {};
  for (const mint of mints) {
    const prim = pickPrimaryPair(pairs.filter((p) => p.mint === mint));
    if (prim) out[mint] = prim.priceUsd;
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP helpers

const NOSNIFF = "X-Content-Type-Options";

function encodeJson(body: unknown): string {
  return JSON.stringify(body, (_k, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? null : v));
}

function sendJson(res: ServerResponse, status: number, body: unknown, headOnly = false): void {
  const payload = encodeJson(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
    [NOSNIFF]: "nosniff",
  });
  res.end(headOnly ? undefined : payload);
}

function intParam(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function listParam(params: URLSearchParams, key: string): string[] | undefined {
  const raw = params.getAll(key).flatMap((v) => v.split(","));
  const items = raw.map((s) => s.trim()).filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Resolve a URL path inside `root`, or null when it escapes the root or is malformed. */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, "." + (decoded.startsWith("/") ? decoded : "/" + decoded));
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) return null;
  return target;
}

async function streamFile(res: ServerResponse, filePath: string, size: number, cacheControl: string, headOnly: boolean): Promise<void> {
  res.writeHead(200, {
    "Content-Type": contentTypeFor(filePath),
    "Content-Length": size,
    "Cache-Control": cacheControl,
    [NOSNIFF]: "nosniff",
  });
  if (headOnly) {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  try {
    // pipeline destroys the file stream when the client goes away, so an aborted download never leaks the fd.
    await pipeline(stream, res);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ERR_STREAM_PREMATURE_CLOSE" || code === "ECONNRESET" || code === "EPIPE") {
      logger.debug({ filePath }, "ui: client aborted static download");
    } else {
      logger.warn({ err: String(err), filePath }, "ui: static read failed");
    }
    res.destroy();
  }
}

// ---------------------------------------------------------------------------
// Server

interface ApiResult {
  status: number;
  body: unknown;
}

export function createServer(opts: ServerOptions): Server {
  const { ledger, cfg, staticDir, configPath } = opts;
  const now = opts.now ?? Date.now;
  const prices = createPriceCache(opts.getPrices, {
    ttlMs: opts.priceTtlMs ?? PRICE_CACHE_TTL_MS,
    fetchTimeoutMs: opts.priceFetchTimeoutMs ?? PRICE_FETCH_TIMEOUT_MS,
    now,
  });
  const dtoTtlMs = opts.dtoTtlMs ?? DTO_CACHE_TTL_MS;
  const getFx = opts.getFx ?? (() => getAudPerUsd());
  const fxTimeoutMs = opts.fxTimeoutMs ?? FX_FETCH_TIMEOUT_MS;
  const display = opts.display ?? { currency: DEFAULT_DISPLAY_CURRENCY, timezone: DEFAULT_DISPLAY_TIMEZONE };
  const allowedHosts = opts.allowedHosts ?? [];
  const staticRoot = resolve(staticDir);
  const indexHtml = resolve(staticRoot, "index.html");

  async function openPrices(): Promise<PriceBook> {
    const mints = ledger.readTx(() => ledger.getOpenPositions()).map((p) => p.mint);
    return mints.length > 0 ? prices(mints) : {};
  }

  /** The FX rate, or null when the source fails or is slower than `fxTimeoutMs` (the fetch keeps running to warm its cache). */
  async function fxRate(): Promise<FxRate | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), fxTimeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([getFx().catch((err: unknown) => {
        logger.warn({ err: String(err) }, "ui: fx fetch failed");
        return null;
      }), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function buildApi(pathname: string, params: URLSearchParams): Promise<ApiResult> {
    const t = now();
    switch (pathname) {
      case "/api/health": {
        const body: HealthDto = { ok: true, ts: t };
        return { status: 200, body };
      }
      case "/api/summary": {
        const [prices, fx] = await Promise.all([openPrices(), fxRate()]);
        return { status: 200, body: buildSummary(ledger, cfg, prices, t, { ...display, fx }) };
      }
      case "/api/equity":
        return { status: 200, body: buildEquity(ledger, await openPrices(), t) };
      case "/api/positions":
        return { status: 200, body: buildPositions(ledger, await openPrices(), t) };
      case "/api/orders":
        return { status: 200, body: buildOrders(ledger, intParam(params, "limit") ?? ORDERS_DEFAULT_LIMIT) };
      case "/api/decisions": {
        const offsetRaw = intParam(params, "offset");
        return {
          status: 200,
          body: buildDecisions(ledger, {
            action: listParam(params, "action"),
            limit: intParam(params, "limit") ?? DECISIONS_DEFAULT_LIMIT,
            offset: offsetRaw === undefined ? undefined : Math.min(DECISIONS_MAX_OFFSET, Math.max(0, offsetRaw)),
            since: intParam(params, "since"),
          }),
        };
      }
      case "/api/candidates":
        return { status: 200, body: buildCandidates(ledger) };
      case "/api/notes":
        return { status: 200, body: buildNotes(ledger) };
      case "/api/report":
        return { status: 200, body: buildReportDto(ledger, cfg, await openPrices(), t) };
      case "/api/config":
        return { status: 200, body: buildConfigDto(configPath) };
      default:
        return { status: 404, body: { error: `not found: ${pathname}` } };
    }
  }

  // Short cache of successful DTOs keyed by path+query: a dashboard tab fires several
  // requests per refresh, and concurrent tabs should not each rebuild the same payload.
  const dtoCache = new Map<string, { at: number; result: Promise<ApiResult> }>();

  function handleApi(pathname: string, params: URLSearchParams): Promise<ApiResult> {
    if (dtoTtlMs <= 0 || pathname === "/api/health") return buildApi(pathname, params);
    params.sort();
    const key = `${pathname}?${params.toString()}`;
    const t = now();
    const hit = dtoCache.get(key);
    if (hit !== undefined && t - hit.at < dtoTtlMs) return hit.result;
    const result = buildApi(pathname, params);
    dtoCache.set(key, { at: t, result });
    result.then(
      (r) => {
        if (r.status !== 200) dtoCache.delete(key);
      },
      () => dtoCache.delete(key),
    );
    if (dtoCache.size > 256) {
      for (const [k, v] of dtoCache) if (t - v.at >= dtoTtlMs) dtoCache.delete(k);
    }
    return result;
  }

  async function handleStatic(res: ServerResponse, pathname: string, headOnly: boolean): Promise<void> {
    const target = resolveStaticPath(staticRoot, pathname);
    if (target === null) {
      sendJson(res, 404, { error: "not found" }, headOnly);
      return;
    }
    const candidate = target === staticRoot ? indexHtml : target;
    let info = await stat(candidate).catch(() => null);
    let filePath = candidate;
    if (info === null || !info.isFile()) {
      // SPA fallback: any unknown GET path renders the app shell and lets hash routing take over.
      filePath = indexHtml;
      info = await stat(filePath).catch(() => null);
      if (info === null || !info.isFile()) {
        sendJson(res, 404, { error: "ui not built: run `npm run ui:build` to produce ui/dist" }, headOnly);
        return;
      }
    }
    const cacheControl = filePath === indexHtml ? "no-cache" : "public, max-age=3600";
    await streamFile(res, filePath, info.size, cacheControl, headOnly);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const isApi = pathname === "/api" || pathname.startsWith("/api/");
    const headOnly = req.method === "HEAD";

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: `method not allowed: ${req.method ?? "?"}` });
      return;
    }

    const addr = server.address();
    const port = addr !== null && typeof addr === "object" ? addr.port : DEFAULT_UI_PORT;
    if (!hostAllowed(req.headers.host, port, allowedHosts)) {
      logger.warn({ host: req.headers.host ?? null, remote: req.socket.remoteAddress ?? null }, "ui: rejected request with foreign Host header");
      sendJson(res, 403, { error: "forbidden: unexpected Host header" }, headOnly);
      return;
    }

    if (isApi) {
      try {
        const { status, body } = await handleApi(pathname, url.searchParams);
        sendJson(res, status, body, headOnly);
      } catch (err) {
        // Never leak messages (they can carry file paths or SQL) to the browser.
        logger.error({ err: err instanceof Error ? err.stack ?? err.message : String(err), path: pathname }, "ui: api error");
        sendJson(res, 500, { error: "internal error" }, headOnly);
      }
      return;
    }

    await handleStatic(res, pathname, headOnly);
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      logger.error({ err: err instanceof Error ? err.stack ?? err.message : String(err), url: req.url }, "ui: unhandled request error");
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    });
  });
  return server;
}

// ---------------------------------------------------------------------------
// Entry point

export async function main(): Promise<Server> {
  const env = loadEnv();
  const host = process.env.UI_HOST ?? DEFAULT_UI_HOST;
  const portRaw = Number(process.env.UI_PORT ?? DEFAULT_UI_PORT);
  const port = Number.isInteger(portRaw) && portRaw >= 0 && portRaw <= 65535 ? portRaw : DEFAULT_UI_PORT;
  const configPath = env.strategyConfigPath;
  const cfg = loadStrategyConfig(configPath);
  const ledger = new Ledger(env.dbPath, { readOnly: true });
  const staticDir = resolve("ui/dist");

  const loopback = isLoopbackHost(host);
  if (!loopback) {
    logger.warn({ host }, "ui: UI_HOST is not loopback; the read-only dashboard is reachable from the network");
  }
  const server = createServer({
    ledger,
    cfg,
    getPrices: fetchDexscreenerPrices,
    staticDir,
    configPath,
    allowedHosts: loopback ? [] : [host.includes(":") && !host.startsWith("[") ? `[${host}]` : host],
    display: { currency: env.displayCurrency, timezone: env.displayTimezone },
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "ui: shutting down");
    server.close(() => {
      ledger.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const addr = server.address();
  const boundPort = addr !== null && typeof addr === "object" ? addr.port : port;
  logger.info(
    { host, port: boundPort, db: env.dbPath, staticDir, readOnly: ledger.isReadOnly, currency: env.displayCurrency, timezone: env.displayTimezone },
    "ui: listening",
  );
  return server;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    logger.fatal({ err: err instanceof Error ? err.stack ?? err.message : String(err) }, "ui: failed to start");
    process.exit(1);
  });
}
