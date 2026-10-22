/**
 * Read-only dashboard server: Node built-in `http`, no framework.
 *
 * `/api/*` routes return JSON built by src/ui/api.ts; everything else is
 * served from `staticDir` (the Vite build in ui/dist) with an SPA fallback to
 * index.html. The server never writes to the ledger: `main()` opens it with
 * `{ readOnly: true }` and every builder calls loadPortfolio read-only.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, loadStrategyConfig, type StrategyConfig } from "../core/config.js";
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
  ORDERS_DEFAULT_LIMIT,
  type GetPrices,
  type PriceMap,
} from "./api.js";
import type { HealthDto } from "./types.js";

export const DEFAULT_UI_HOST = "127.0.0.1";
export const DEFAULT_UI_PORT = 4777;
export const PRICE_CACHE_TTL_MS = 30_000;

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

// ---------------------------------------------------------------------------
// Price cache

/**
 * Wraps `getPrices` with a per-mint TTL cache. Only stale or unknown mints are
 * fetched; when the fetch fails the last known prices are returned and the
 * error is logged, so a DexScreener outage degrades the marks instead of
 * taking the dashboard down.
 */
export function createPriceCache(getPrices: GetPrices, ttlMs = PRICE_CACHE_TTL_MS, now: () => number = Date.now): GetPrices {
  const cache = new Map<string, { price: number; at: number }>();
  let inflight: Promise<void> | null = null;

  async function refresh(mints: string[]): Promise<void> {
    try {
      const fresh = await getPrices(mints);
      const at = now();
      for (const m of mints) {
        const px = fresh[m];
        if (px !== undefined && Number.isFinite(px)) cache.set(m, { price: px, at });
      }
    } catch (err) {
      logger.warn({ err: String(err), mints: mints.length }, "ui: price fetch failed, using cached marks");
    }
  }

  return async (mints: string[]): Promise<PriceMap> => {
    const unique = [...new Set(mints)];
    const t = now();
    const stale = unique.filter((m) => {
      const hit = cache.get(m);
      return hit === undefined || t - hit.at >= ttlMs;
    });
    if (stale.length > 0) {
      // Coalesce concurrent dashboard requests into one upstream call.
      if (inflight === null) {
        inflight = refresh(stale).finally(() => {
          inflight = null;
        });
      }
      await inflight;
    }
    const out: PriceMap = {};
    for (const m of unique) {
      const hit = cache.get(m);
      if (hit !== undefined) out[m] = hit.price;
    }
    return out;
  };
}

/** Live prices through DexScreener: primary pair per mint. */
export async function fetchDexscreenerPrices(mints: string[]): Promise<PriceMap> {
  if (mints.length === 0) return {};
  const pairs = await getPairsByTokens(mints);
  const out: PriceMap = {};
  for (const mint of mints) {
    const prim = pickPrimaryPair(pairs.filter((p) => p.mint === mint));
    if (prim) out[mint] = prim.priceUsd;
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP helpers

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, (_k, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? null : v));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
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

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

function streamFile(res: ServerResponse, filePath: string, size: number, cacheControl: string): Promise<void> {
  return new Promise((resolveDone) => {
    res.writeHead(200, { "Content-Type": contentTypeFor(filePath), "Content-Length": size, "Cache-Control": cacheControl });
    const stream = createReadStream(filePath);
    stream.on("error", (err) => {
      logger.warn({ err: String(err), filePath }, "ui: static read failed");
      res.destroy();
      resolveDone();
    });
    stream.on("end", () => resolveDone());
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Server

export function createServer(opts: ServerOptions): Server {
  const { ledger, cfg, staticDir, configPath } = opts;
  const now = opts.now ?? Date.now;
  const prices = createPriceCache(opts.getPrices, opts.priceTtlMs ?? PRICE_CACHE_TTL_MS, now);
  const staticRoot = resolve(staticDir);

  async function openPrices(): Promise<PriceMap> {
    const mints = ledger.getOpenPositions().map((p) => p.mint);
    return mints.length > 0 ? prices(mints) : {};
  }

  async function handleApi(pathname: string, params: URLSearchParams): Promise<{ status: number; body: unknown }> {
    const t = now();
    switch (pathname) {
      case "/api/health": {
        const body: HealthDto = { ok: true, ts: t };
        return { status: 200, body };
      }
      case "/api/summary":
        return { status: 200, body: buildSummary(ledger, cfg, await openPrices(), t) };
      case "/api/equity":
        return { status: 200, body: buildEquity(ledger, await openPrices(), t) };
      case "/api/positions":
        return { status: 200, body: buildPositions(ledger, await openPrices(), t) };
      case "/api/orders":
        return { status: 200, body: buildOrders(ledger, intParam(params, "limit") ?? ORDERS_DEFAULT_LIMIT) };
      case "/api/decisions":
        return {
          status: 200,
          body: buildDecisions(ledger, {
            action: listParam(params, "action"),
            limit: intParam(params, "limit") ?? DECISIONS_DEFAULT_LIMIT,
            offset: intParam(params, "offset"),
            since: intParam(params, "since"),
          }),
        };
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

  async function handleStatic(res: ServerResponse, pathname: string): Promise<void> {
    const target = resolveStaticPath(staticRoot, pathname);
    if (target === null) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const candidate = target === staticRoot ? resolve(staticRoot, "index.html") : target;
    let info = await stat(candidate).catch(() => null);
    let filePath = candidate;
    if (info === null || !info.isFile()) {
      // SPA fallback: any unknown GET path renders the app shell and lets hash routing take over.
      filePath = resolve(staticRoot, "index.html");
      info = await stat(filePath).catch(() => null);
      if (info === null || !info.isFile()) {
        sendJson(res, 404, { error: "ui not built: run `npm run ui:build` to produce ui/dist" });
        return;
      }
    }
    const cacheControl = filePath.endsWith("index.html") ? "no-cache" : "public, max-age=3600";
    await streamFile(res, filePath, info.size, cacheControl);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const isApi = pathname === "/api" || pathname.startsWith("/api/");

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: `method not allowed: ${req.method ?? "?"}` });
      return;
    }

    if (isApi) {
      try {
        const { status, body } = await handleApi(pathname, url.searchParams);
        sendJson(res, status, body);
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err), path: pathname }, "ui: api error");
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (req.method === "HEAD") {
      // Static HEAD: answer with headers only, no SPA body.
      const target = resolveStaticPath(staticRoot, pathname);
      const ok = target !== null && (await isFile(target));
      res.writeHead(ok ? 200 : 404, ok ? { "Content-Type": contentTypeFor(target) } : {});
      res.end();
      return;
    }

    await handleStatic(res, pathname);
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      logger.error({ err: String(err), url: req.url }, "ui: unhandled request error");
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

  const server = createServer({ ledger, cfg, getPrices: fetchDexscreenerPrices, staticDir, configPath });

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
  logger.info({ host, port: boundPort, db: env.dbPath, staticDir, readOnly: ledger.isReadOnly }, "ui: listening");
  return server;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    logger.fatal({ err: err instanceof Error ? err.stack ?? err.message : String(err) }, "ui: failed to start");
    process.exit(1);
  });
}
