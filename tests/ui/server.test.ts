import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Ledger } from "../../src/execution/ledger.js";
import { configWith } from "../helpers/contextFactory.js";
import { createPriceCache, createServer, resolveStaticPath } from "../../src/ui/server.js";
import type { SummaryDto, DecisionsDto, CandidatesDto, PositionsDto, EquityDto, OrdersDto, NotesDto, ConfigDto } from "../../src/ui/types.js";
import { MINTS, NOW, SEED, seedLedger } from "./seed.js";

const cfg = configWith((c) => {
  c.account.startingEquityUsd = SEED.startingEquity;
});

describe("ui server", () => {
  let ledger: Ledger;
  let server: Server;
  let base: string;
  let staticDir: string;
  let emptyStaticServer: Server;
  let emptyBase: string;
  const getPrices = vi.fn(async (mints: string[]) => {
    const out: Record<string, number> = {};
    for (const m of mints) if (SEED.prices[m] !== undefined) out[m] = SEED.prices[m]!;
    return out;
  });

  beforeAll(async () => {
    ledger = seedLedger().ledger;
    staticDir = mkdtempSync(join(tmpdir(), "memecoinbot-ui-"));
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>dash</title><div id=root></div>");
    mkdirSync(join(staticDir, "assets"));
    writeFileSync(join(staticDir, "assets", "app.js"), "console.log('hi')");
    writeFileSync(join(staticDir, "assets", "app.css"), "body{margin:0}");
    writeFileSync(join(staticDir, "assets", "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    writeFileSync(join(staticDir, "assets", "app.js.map"), "{}");
    writeFileSync(join(staticDir, "assets", "font.woff2"), Buffer.from([0, 1, 2]));
    writeFileSync(join(staticDir, "assets", "pic.png"), Buffer.from([0x89, 0x50]));
    writeFileSync(join(staticDir, "manifest.json"), '{"name":"dash"}');

    server = createServer({ ledger, cfg, getPrices, staticDir, configPath: resolve("config/strategy.yaml"), now: () => NOW });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    emptyStaticServer = createServer({ ledger, cfg, getPrices, staticDir: join(staticDir, "missing"), configPath: resolve("config/strategy.yaml"), now: () => NOW });
    await new Promise<void>((r) => emptyStaticServer.listen(0, "127.0.0.1", r));
    emptyBase = `http://127.0.0.1:${(emptyStaticServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => emptyStaticServer.close(() => r()));
    ledger.close();
    rmSync(staticDir, { recursive: true, force: true });
  });

  async function getJson<T>(path: string): Promise<{ status: number; body: T; res: Response }> {
    const res = await fetch(base + path);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    return { status: res.status, body: (await res.json()) as T, res };
  }

  it("GET /api/health", async () => {
    const { status, body } = await getJson<{ ok: boolean; ts: number }>("/api/health");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, ts: NOW });
  });

  it("GET /api/summary uses injected prices and never writes", async () => {
    const peakBefore = ledger.getMeta("peak_equity_usd");
    const { status, body } = await getJson<SummaryDto>("/api/summary");
    expect(status).toBe(200);
    expect(body.equityUsd).toBeCloseTo(1052, 6);
    expect(body.openCount).toBe(2);
    expect(body.closedCount).toBe(3);
    expect(body.botHealthy).toBe(true);
    expect(body.breakers).toEqual({ haltNewEntries: false, killSwitch: false, reasons: [] });
    expect(getPrices).toHaveBeenCalled();
    expect(getPrices.mock.calls[0]![0].sort()).toEqual([MINTS.openA, MINTS.openB].sort());
    expect(ledger.getMeta("peak_equity_usd")).toBe(peakBefore);
  });

  it("caches prices for 30s across routes", async () => {
    getPrices.mockClear();
    await getJson("/api/summary");
    await getJson("/api/positions");
    await getJson("/api/equity");
    expect(getPrices).toHaveBeenCalledTimes(0); // warmed by the previous test, still within TTL
  });

  it("GET /api/equity", async () => {
    const { status, body } = await getJson<EquityDto>("/api/equity");
    expect(status).toBe(200);
    expect(body.points).toHaveLength(4);
    expect(body.points[3]!.ts).toBe(NOW);
    expect(body.points[3]!.equityUsd).toBeCloseTo(1052, 6);
  });

  it("GET /api/positions", async () => {
    const { status, body } = await getJson<PositionsDto>("/api/positions");
    expect(status).toBe(200);
    expect(body.open.map((p) => p.symbol)).toEqual(["BBB", "AAA"]);
    expect(body.open[1]!.currentPriceUsd).toBe(0.002);
    expect(body.open[1]!.pnlPct).toBeCloseTo(100, 6);
    expect(body.open[0]!.currentPriceUsd).toBe(0.0009);
    expect(body.closed.map((p) => p.symbol)).toEqual(["EEE", "DDD", "CCC"]);
    expect(body.closed[0]!.holdHours).toBeCloseTo(2, 6);
  });

  it("GET /api/orders with limit", async () => {
    const all = await getJson<OrdersDto>("/api/orders");
    expect(all.status).toBe(200);
    expect(all.body.orders).toHaveLength(9);
    expect(all.body.orders[0]!.symbol).toBe("AAA");
    const two = await getJson<OrdersDto>("/api/orders?limit=2");
    expect(two.body.orders).toHaveLength(2);
  });

  it("GET /api/decisions with filters and paging", async () => {
    const all = await getJson<DecisionsDto>("/api/decisions");
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(8);
    expect(all.body.decisions).toHaveLength(8);
    expect(all.body.decisions[0]!.lenses).toBeNull();

    const filtered = await getJson<DecisionsDto>("/api/decisions?action=skip,filtered&limit=2&offset=1");
    expect(filtered.body.total).toBe(3);
    expect(filtered.body.decisions).toHaveLength(2);
    expect(filtered.body.decisions.every((d) => d.action === "skip" || d.action === "filtered")).toBe(true);

    const since = await getJson<DecisionsDto>(`/api/decisions?since=${SEED.lastScreenAt}`);
    expect(since.body.total).toBe(5);

    const enter = await getJson<DecisionsDto>("/api/decisions?action=enter");
    expect(enter.body.decisions[0]!.lenses?.technical.score).toBe(0.8);
  });

  it("GET /api/candidates", async () => {
    const { status, body } = await getJson<CandidatesDto>("/api/candidates");
    expect(status).toBe(200);
    expect(body.screenedAt).toBe(SEED.lastScreenAt);
    expect(body.candidates.map((c) => [c.rank, c.symbol])).toEqual([
      [1, "AAA"],
      [2, "FFF"],
      [3, "GGG"],
    ]);
  });

  it("GET /api/notes", async () => {
    const { status, body } = await getJson<NotesDto>("/api/notes");
    expect(status).toBe(200);
    expect(body.notes).toHaveLength(2);
    expect(body.notes[0]!.ts).toBeLessThan(body.notes[1]!.ts);
  });

  it("GET /api/report", async () => {
    const { status, body } = await getJson<{ closedTrades: number; openTrades: number; equityUsd: number }>("/api/report");
    expect(status).toBe(200);
    expect(body.closedTrades).toBe(3);
    expect(body.openTrades).toBe(2);
    expect(body.equityUsd).toBeCloseTo(1052, 6);
  });

  it("GET /api/config", async () => {
    const { status, body } = await getJson<ConfigDto>("/api/config");
    expect(status).toBe(200);
    expect(body.path).toBe(resolve("config/strategy.yaml"));
    expect(body.yaml).toContain("account:");
    expect(body.parsed.account.startingEquityUsd).toBeGreaterThan(0);
    expect(body.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("unknown /api paths return 404 JSON", async () => {
    const { status, body } = await getJson<{ error: string }>("/api/nope");
    expect(status).toBe(404);
    expect(body.error).toContain("not found");
    const bare = await getJson<{ error: string }>("/api");
    expect(bare.status).toBe(404);
  });

  it("non-GET methods return 405 JSON", async () => {
    const res = await fetch(base + "/api/summary", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(((await res.json()) as { error: string }).error).toContain("method not allowed");
  });

  it("api failures return 500 JSON instead of throwing", async () => {
    const broken = createServer({
      ledger,
      cfg,
      getPrices,
      staticDir,
      configPath: join(staticDir, "no-such-config.yaml"),
      now: () => NOW,
    });
    await new Promise<void>((r) => broken.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(broken.address() as AddressInfo).port}/api/config`);
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      const body = (await res.json()) as { error: string };
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((r) => broken.close(() => r()));
    }
  });

  it("degrades to cached or empty prices when the fetch fails", async () => {
    const failing = vi.fn(async () => {
      throw new Error("dexscreener down");
    });
    const s = createServer({ ledger, cfg, getPrices: failing, staticDir, configPath: resolve("config/strategy.yaml"), now: () => NOW });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/positions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as PositionsDto;
      expect(body.open[0]!.currentPriceUsd).toBeNull();
      expect(failing).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it("serves static files with the right content types", async () => {
    const cases: Array<[string, string, string]> = [
      ["/index.html", "text/html; charset=utf-8", "<!doctype html>"],
      ["/assets/app.js", "text/javascript; charset=utf-8", "console.log"],
      ["/assets/app.css", "text/css; charset=utf-8", "body{margin:0}"],
      ["/assets/logo.svg", "image/svg+xml", "<svg"],
      ["/manifest.json", "application/json; charset=utf-8", '"name"'],
      ["/assets/app.js.map", "application/json; charset=utf-8", "{}"],
    ];
    for (const [path, type, snippet] of cases) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe(type);
      expect(await res.text(), path).toContain(snippet);
    }
    const png = await fetch(base + "/assets/pic.png");
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50]));
    const woff = await fetch(base + "/assets/font.woff2");
    expect(woff.headers.get("content-type")).toBe("font/woff2");
    expect((await woff.arrayBuffer()).byteLength).toBe(3);
  });

  it("falls back to index.html for non-api GET paths", async () => {
    for (const path of ["/", "/positions", "/some/deep/route", "/assets/missing.js"]) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
      expect(await res.text(), path).toContain("<title>dash</title>");
    }
  });

  it("blocks path traversal", async () => {
    for (const path of ["/..%2f..%2fetc/passwd", "/assets/..%2f..%2f..%2fetc/passwd", "/%2e%2e%2f%2e%2e%2fetc/passwd", "/assets/%00"]) {
      const res = await fetch(base + path);
      expect(res.status, path).not.toBe(500);
      const text = await res.text();
      expect(text, path).not.toContain("root:");
    }
    expect(resolveStaticPath(staticDir, "/../../etc/passwd")).toBeNull();
    expect(resolveStaticPath(staticDir, "/assets/../../x")).toBeNull();
    expect(resolveStaticPath(staticDir, "/%ZZ")).toBeNull();
    expect(resolveStaticPath(staticDir, "/assets/../index.html")).toBe(join(staticDir, "index.html"));
    expect(resolveStaticPath(staticDir, "/")).toBe(resolve(staticDir));
  });

  it("returns 404 JSON when the ui is not built", async () => {
    const res = await fetch(emptyBase + "/");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(((await res.json()) as { error: string }).error).toContain("ui not built");
    // api still works without a static dir
    const api = await fetch(emptyBase + "/api/health");
    expect(api.status).toBe(200);
  });
});

describe("createPriceCache", () => {
  it("refetches only stale mints, coalesces concurrent calls, and survives failures", async () => {
    let t = 0;
    const calls: string[][] = [];
    let fail = false;
    const fetcher = vi.fn(async (mints: string[]) => {
      calls.push([...mints]);
      if (fail) throw new Error("boom");
      return Object.fromEntries(mints.map((m) => [m, m.length]));
    });
    const cached = createPriceCache(fetcher, 1000, () => t);

    const [a, b] = await Promise.all([cached(["x", "yy"]), cached(["x", "yy"])]);
    expect(a).toEqual({ x: 1, yy: 2 });
    expect(b).toEqual(a);
    expect(fetcher).toHaveBeenCalledTimes(1);

    t = 500;
    expect(await cached(["x", "zzz"])).toEqual({ x: 1, zzz: 3 });
    expect(calls[1]).toEqual(["zzz"]);

    t = 1500;
    fail = true;
    expect(await cached(["x", "yy"])).toEqual({ x: 1, yy: 2 }); // stale values kept on failure
    expect(fetcher).toHaveBeenCalledTimes(3);

    expect(await cached([])).toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
