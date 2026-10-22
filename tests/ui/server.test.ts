import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { configWith } from "../helpers/contextFactory.js";
import { createPriceCache, createServer, hostAllowed, resolveStaticPath } from "../../src/ui/server.js";
import { Ledger } from "../../src/execution/ledger.js";
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
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    return { status: res.status, body: (await res.json()) as T, res };
  }

  /** Raw request so we can set the Host header (fetch silently drops it). */
  function raw(port: number, path: string, headers: Record<string, string>, method = "GET"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
    return new Promise((res, rej) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (r) => {
        let body = "";
        r.setEncoding("utf8");
        r.on("data", (c: string) => (body += c));
        r.on("end", () => res({ status: r.statusCode ?? 0, headers: r.headers, body }));
      });
      req.on("error", rej);
      req.end();
    });
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
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const body = (await res.json()) as { error: string };
      // opaque: no message, path, or SQL leaks to the browser
      expect(body).toEqual({ error: "internal error" });
      expect(JSON.stringify(body)).not.toContain("no-such-config");
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

  it("rejects foreign Host headers with 403 JSON (DNS rebinding)", async () => {
    const port = (server.address() as AddressInfo).port;
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`, "127.0.0.1"]) {
      const r = await raw(port, "/api/health", { Host: host });
      expect(r.status, host).toBe(403);
      expect(r.headers["content-type"], host).toBe("application/json; charset=utf-8");
      expect(r.headers["x-content-type-options"], host).toBe("nosniff");
      expect((JSON.parse(r.body) as { error: string }).error).toContain("forbidden");
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`]) {
      const r = await raw(port, "/api/health", { Host: host });
      expect(r.status, host).toBe(200);
    }
    // static paths are protected too
    expect((await raw(port, "/", { Host: "evil.example" })).status).toBe(403);

    expect(hostAllowed(undefined, 1)).toBe(false);
    expect(hostAllowed("", 1)).toBe(false); // node's client substitutes a default for an empty Host, so this is checked directly
    expect(hostAllowed("localhost:1", 1)).toBe(true);
    expect(hostAllowed("localhost", 1)).toBe(false);
    expect(hostAllowed("10.0.0.5:1", 1)).toBe(false);
    expect(hostAllowed("10.0.0.5:1", 1, ["10.0.0.5"])).toBe(true);
    expect(hostAllowed("10.0.0.5", 1, ["10.0.0.5"])).toBe(true);
    expect(hostAllowed("10.0.0.5:2", 1, ["10.0.0.5"])).toBe(false);
  });

  it("accepts extra allowed hosts when configured", async () => {
    const s = createServer({ ledger, cfg, getPrices, staticDir, configPath: resolve("config/strategy.yaml"), now: () => NOW, allowedHosts: ["dash.lan"] });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    try {
      const port = (s.address() as AddressInfo).port;
      expect((await raw(port, "/api/health", { Host: `dash.lan:${port}` })).status).toBe(200);
      expect((await raw(port, "/api/health", { Host: "dash.lan" })).status).toBe(200);
      expect((await raw(port, "/api/health", { Host: "other.lan" })).status).toBe(403);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it("answers HEAD like GET without a body, for api and SPA routes", async () => {
    const port = (server.address() as AddressInfo).port;
    const api = await raw(port, "/api/summary", { Host: `127.0.0.1:${port}` }, "HEAD");
    expect(api.status).toBe(200);
    expect(api.body).toBe("");
    expect(Number(api.headers["content-length"])).toBeGreaterThan(50);
    expect(api.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(api.headers["x-content-type-options"]).toBe("nosniff");

    const indexLen = Buffer.byteLength("<!doctype html><title>dash</title><div id=root></div>");
    for (const path of ["/", "/positions", "/deep/route"]) {
      const r = await raw(port, path, { Host: `127.0.0.1:${port}` }, "HEAD");
      expect(r.status, path).toBe(200);
      expect(r.body, path).toBe("");
      expect(Number(r.headers["content-length"]), path).toBe(indexLen);
      expect(r.headers["content-type"], path).toBe("text/html; charset=utf-8");
      expect(r.headers["x-content-type-options"], path).toBe("nosniff");
    }
    const js = await raw(port, "/assets/app.js", { Host: `127.0.0.1:${port}` }, "HEAD");
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(Number(js.headers["content-length"])).toBe(Buffer.byteLength("console.log('hi')"));
    expect(js.body).toBe("");
    const notFound = await raw(port, "/api/nope", { Host: `127.0.0.1:${port}` }, "HEAD");
    expect(notFound.status).toBe(404);
    expect(notFound.body).toBe("");
  });

  it("caches built DTOs for 1.5s per path+query, but never /api/health", async () => {
    let clock = NOW;
    const own = seedLedger().ledger;
    const s = createServer({ ledger: own, cfg, getPrices, staticDir, configPath: resolve("config/strategy.yaml"), now: () => clock });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    try {
      const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      const notes = async (q = "") => ((await (await fetch(`${b}/api/notes${q}`)).json()) as NotesDto).notes.length;
      expect(await notes()).toBe(2);
      own.addNote(NOW, "new");
      expect(await notes()).toBe(2); // served from the DTO cache
      expect(await notes("?x=1")).toBe(3); // different query -> different key
      clock += 1000;
      expect(await notes()).toBe(2);
      clock += 600;
      expect(await notes()).toBe(3); // expired after 1.5s
      // query order does not matter for the key
      const d1 = (await (await fetch(`${b}/api/decisions?limit=2&offset=0`)).json()) as DecisionsDto;
      const d2 = (await (await fetch(`${b}/api/decisions?offset=0&limit=2`)).json()) as DecisionsDto;
      expect(d1).toEqual(d2);
      // health always reflects the clock
      const h1 = (await (await fetch(`${b}/api/health`)).json()) as { ts: number };
      clock += 10;
      const h2 = (await (await fetch(`${b}/api/health`)).json()) as { ts: number };
      expect(h2.ts - h1.ts).toBe(10);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
      own.close();
    }
  });

  it("caps the decisions offset at the HTTP layer", async () => {
    const r = await getJson<DecisionsDto>("/api/decisions?offset=99999999999");
    expect(r.status).toBe(200);
    expect(r.body.decisions).toEqual([]);
    expect(r.body.total).toBe(8);
  });

  it("survives a client aborting a static download", async () => {
    const big = Buffer.alloc(4 * 1024 * 1024, 0x41);
    writeFileSync(join(staticDir, "assets", "big.bin"), big);
    const ac = new AbortController();
    const res = await fetch(base + "/assets/big.bin", { signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await expect(reader.read()).rejects.toThrow();
    // the server keeps serving and the handler did not hang
    const health = await getJson<{ ok: boolean }>("/api/health");
    expect(health.body.ok).toBe(true);
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
  type Deferred = { resolve: (v: Record<string, number>) => void; reject: (e: Error) => void };
  function deferredFetcher() {
    const pending: Array<{ mints: string[]; d: Deferred }> = [];
    const fetcher = vi.fn(
      (mints: string[]) =>
        new Promise<Record<string, number>>((resolve, reject) => {
          pending.push({ mints: [...mints], d: { resolve, reject } });
        }),
    );
    return { fetcher, pending };
  }
  const byLength = (mints: string[]) => Object.fromEntries(mints.map((m) => [m, m.length]));

  it("refetches only stale mints, coalesces identical concurrent calls, and survives failures", async () => {
    let t = 0;
    const calls: string[][] = [];
    let fail = false;
    const fetcher = vi.fn(async (mints: string[]) => {
      calls.push([...mints]);
      if (fail) throw new Error("boom");
      return byLength(mints);
    });
    const cached = createPriceCache(fetcher, { ttlMs: 1000, now: () => t });

    const [a, b] = await Promise.all([cached(["x", "yy"]), cached(["x", "yy"])]);
    expect(a).toEqual({ x: { price: 1, at: 0 }, yy: { price: 2, at: 0 } });
    expect(b).toEqual(a);
    expect(fetcher).toHaveBeenCalledTimes(1);

    t = 500;
    expect(await cached(["x", "zzz"])).toEqual({ x: { price: 1, at: 0 }, zzz: { price: 3, at: 500 } });
    expect(calls[1]).toEqual(["zzz"]);

    t = 1500;
    fail = true;
    expect(await cached(["x", "yy"])).toEqual({ x: { price: 1, at: 0 }, yy: { price: 2, at: 0 } }); // stale values kept on failure
    expect(fetcher).toHaveBeenCalledTimes(3);

    expect(await cached([])).toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("concurrent calls with different mints each get their prices (per-mint inflight)", async () => {
    const { fetcher, pending } = deferredFetcher();
    const cached = createPriceCache(fetcher, { ttlMs: 1000, now: () => 0 });
    const p1 = cached(["a"]);
    const p2 = cached(["a", "bb"]);
    const p3 = cached(["bb", "ccc"]);
    await new Promise((r) => setImmediate(r));
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(3);
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual([["a"], ["bb"], ["ccc"]]);
    for (const { mints, d } of pending) d.resolve(byLength(mints));
    expect(await p1).toEqual({ a: { price: 1, at: 0 } });
    expect(await p2).toEqual({ a: { price: 1, at: 0 }, bb: { price: 2, at: 0 } });
    expect(await p3).toEqual({ bb: { price: 2, at: 0 }, ccc: { price: 3, at: 0 } });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("negative-caches misses and failures for one TTL", async () => {
    let t = 0;
    let fail = false;
    const fetcher = vi.fn(async (_mints: string[]) => {
      if (fail) throw new Error("down");
      return {} as Record<string, number>; // upstream knows nothing about this mint
    });
    const cached = createPriceCache(fetcher, { ttlMs: 1000, now: () => t });
    expect(await cached(["m"])).toEqual({});
    t = 10;
    expect(await cached(["m"])).toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(1); // miss not retried within the TTL
    t = 1000;
    fail = true;
    expect(await cached(["m"])).toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(2);
    t = 1500;
    expect(await cached(["m"])).toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(2); // failure not retried within the TTL either
    t = 2000;
    await cached(["m"]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("serves cached marks when upstream is slower than the timeout, then fills the cache", async () => {
    const { fetcher, pending } = deferredFetcher();
    let t = 0;
    const cached = createPriceCache(fetcher, { ttlMs: 1000, fetchTimeoutMs: 20, now: () => t });
    const started = Date.now();
    expect(await cached(["slow"])).toEqual({});
    expect(Date.now() - started).toBeLessThan(500);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // the fetch is still in flight: a second caller joins it rather than refetching
    const second = cached(["slow"]);
    t = 5;
    pending[0]!.d.resolve({ slow: 7 });
    expect(await second).toEqual({ slow: { price: 7, at: 5 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await cached(["slow"])).toEqual({ slow: { price: 7, at: 5 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("drops marks older than the max age and ignores non-positive prices", async () => {
    let t = 0;
    let out: Record<string, number> = { ok: 2, zero: 0, neg: -1, nan: Number.NaN };
    let fail = false;
    const fetcher = vi.fn(async (_mints: string[]) => {
      if (fail) throw new Error("down");
      return out;
    });
    const cached = createPriceCache(fetcher, { ttlMs: 1000, maxAgeMs: 5000, now: () => t });
    expect(await cached(["ok", "zero", "neg", "nan"])).toEqual({ ok: { price: 2, at: 0 } });
    fail = true;
    t = 4000;
    expect(await cached(["ok"])).toEqual({ ok: { price: 2, at: 0 } }); // stale but within max age
    t = 5001;
    expect(await cached(["ok"])).toEqual({}); // too old: dropped rather than served
    fail = false;
    out = { ok: 3 };
    t = 6001;
    expect(await cached(["ok"])).toEqual({ ok: { price: 3, at: 6001 } });
  });
});
