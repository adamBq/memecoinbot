import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../src/core/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/http.js")>();
  return { ...actual, getJson: vi.fn() };
});

import { getJson } from "../src/core/http.js";
import { getTrendingPools, getNewPools, getOhlcv, normalizeOhlcv } from "../src/data/geckoterminal.js";

const mockedGetJson = vi.mocked(getJson);

function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

interface GeckoPool {
  id: string;
  attributes: { address: string; pool_created_at: string };
  relationships: { base_token: { data: { id: string } } };
}

beforeEach(() => {
  mockedGetJson.mockReset();
});

describe("getTrendingPools", () => {
  it("maps the fixture to pairAddress, mint, rank", async () => {
    const fx = fixture<{ data: GeckoPool[] }>("gecko_trending.json");
    mockedGetJson.mockResolvedValue(fx);
    const pools = await getTrendingPools();
    expect(mockedGetJson).toHaveBeenCalledTimes(1);
    expect(mockedGetJson.mock.calls[0]![0]).toBe("https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1");
    expect(mockedGetJson.mock.calls[0]![1]!.limiter).toBeDefined();
    expect(pools).toHaveLength(fx.data.length);
    pools.forEach((p, i) => {
      expect(p.rank).toBe(i + 1);
      expect(p.pairAddress).toBe(fx.data[i]!.attributes.address);
      expect(p.mint).toBe(fx.data[i]!.relationships.base_token.data.id.replace(/^solana_/, ""));
      expect(p.mint).not.toMatch(/^solana_/);
    });
  });

  it("walks multiple pages with continuous ranks and stops on an empty page", async () => {
    const fx = fixture<{ data: GeckoPool[] }>("gecko_trending.json");
    mockedGetJson.mockResolvedValueOnce(fx).mockResolvedValueOnce(fx).mockResolvedValueOnce({ data: [] });
    const pools = await getTrendingPools(3);
    expect(mockedGetJson).toHaveBeenCalledTimes(3);
    expect(mockedGetJson.mock.calls[1]![0]).toContain("page=2");
    expect(pools).toHaveLength(fx.data.length * 2);
    expect(pools.at(-1)!.rank).toBe(fx.data.length * 2);
  });

  it("skips malformed entries and tolerates null", async () => {
    mockedGetJson.mockResolvedValueOnce({ data: [{ id: "solana_x" }, null, { attributes: { address: "p" }, relationships: {} }] });
    expect(await getTrendingPools()).toEqual([]);
    mockedGetJson.mockResolvedValueOnce(null);
    expect(await getTrendingPools()).toEqual([]);
  });

  it("falls back to the id when attributes.address is missing", async () => {
    mockedGetJson.mockResolvedValueOnce({
      data: [{ id: "solana_POOL", attributes: {}, relationships: { base_token: { data: { id: "solana_MINT" } } } }],
    });
    expect(await getTrendingPools()).toEqual([{ pairAddress: "POOL", mint: "MINT", rank: 1 }]);
  });
});

describe("getNewPools", () => {
  it("maps pool_created_at to ms since epoch", async () => {
    const fx = fixture<{ data: GeckoPool[] }>("gecko_new.json");
    mockedGetJson.mockResolvedValue(fx);
    const pools = await getNewPools();
    expect(mockedGetJson.mock.calls[0]![0]).toBe("https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1");
    expect(pools).toHaveLength(fx.data.length);
    pools.forEach((p, i) => {
      expect(p.createdAt).toBe(Date.parse(fx.data[i]!.attributes.pool_created_at));
      expect(p.createdAt).toBeGreaterThan(1.7e12);
      expect(p.pairAddress).toBe(fx.data[i]!.attributes.address);
    });
  });

  it("uses createdAt 0 when the timestamp is missing", async () => {
    mockedGetJson.mockResolvedValueOnce({
      data: [{ id: "solana_POOL", attributes: { address: "POOL" }, relationships: { base_token: { data: { id: "solana_MINT" } } } }],
    });
    expect(await getNewPools()).toEqual([{ pairAddress: "POOL", mint: "MINT", createdAt: 0 }]);
  });
});

describe("normalizeOhlcv / getOhlcv", () => {
  it("returns the fixture ascending by t with numeric fields", () => {
    const fx = fixture<{ data: { attributes: { ohlcv_list: number[][] } } }>("gecko_ohlcv.json");
    const list = fx.data.attributes.ohlcv_list;
    expect(list[0]![0]).toBeGreaterThan(list.at(-1)![0]!); // fixture is newest first
    const candles = normalizeOhlcv(fx);
    expect(candles).toHaveLength(list.length);
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t);
    expect(candles[0]!.t).toBe(list.at(-1)![0]);
    expect(candles.at(-1)!.t).toBe(list[0]![0]);
    const newest = list[0]!;
    expect(candles.at(-1)).toEqual({ t: newest[0], o: newest[1], h: newest[2], l: newest[3], c: newest[4], v: newest[5] });
    // 5-minute aggregate: consecutive opens 300s apart
    expect(candles[1]!.t - candles[0]!.t).toBe(300);
  });

  it("drops malformed rows and returns [] for bad payloads", () => {
    expect(normalizeOhlcv(null)).toEqual([]);
    expect(normalizeOhlcv({ data: {} })).toEqual([]);
    const out = normalizeOhlcv({
      data: { attributes: { ohlcv_list: [[10, 1, 2, 0.5, 1.5, 100], [5, "x", 2, 0.5, 1.5, 1], [1, 2, 3], "junk", [2, "1", "2", "0.5", "1.5"]] } },
    });
    expect(out).toEqual([
      { t: 2, o: 1, h: 2, l: 0.5, c: 1.5, v: 0 },
      { t: 10, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 },
    ]);
  });

  it("builds the URL and caches for one candle period", async () => {
    mockedGetJson.mockResolvedValue(fixture("gecko_ohlcv.json"));
    const candles = await getOhlcv("POOL", "minute", 5, 100);
    expect(candles).toHaveLength(6);
    const [url, opts] = mockedGetJson.mock.calls[0]!;
    expect(url).toBe("https://api.geckoterminal.com/api/v2/networks/solana/pools/POOL/ohlcv/minute?aggregate=5&limit=100");
    expect(opts!.cacheTtlMs).toBe(5 * 60 * 1000);
    expect(opts!.cache).toBeDefined();
    expect(opts!.limiter).toBeDefined();

    await getOhlcv("POOL", "hour", 1, 50);
    expect(mockedGetJson.mock.calls[1]![0]).toContain("/ohlcv/hour?aggregate=1&limit=50");
    expect(mockedGetJson.mock.calls[1]![1]!.cacheTtlMs).toBe(3600 * 1000);
    await getOhlcv("POOL", "day", 1, 30);
    expect(mockedGetJson.mock.calls[2]![1]!.cacheTtlMs).toBe(86400 * 1000);
  });

  it("returns [] when the response is null", async () => {
    mockedGetJson.mockResolvedValue(null);
    expect(await getOhlcv("POOL", "minute", 5, 10)).toEqual([]);
  });
});
