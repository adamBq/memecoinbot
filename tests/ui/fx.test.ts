import { beforeEach, describe, expect, it, vi } from "vitest";
import erapiFixture from "../fixtures/fx_erapi_usd.json" with { type: "json" };
import frankfurterFixture from "../fixtures/fx_frankfurter_usd_aud.json" with { type: "json" };

const { getJsonMock } = vi.hoisted(() => ({ getJsonMock: vi.fn() }));

vi.mock("../../src/core/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/http.js")>();
  return { ...actual, getJson: getJsonMock };
});

const ERAPI = "https://open.er-api.com/v6/latest/USD";
const FRANKFURTER = "https://api.frankfurter.dev/v1/latest?from=USD&to=AUD";
const T0 = 1_792_650_000_000;

/** Fresh module per test so the one hour cache does not leak between tests. */
async function load() {
  vi.resetModules();
  return import("../../src/ui/fx.js");
}

function urls(): string[] {
  return getJsonMock.mock.calls.map((c) => c[0] as string);
}

describe("fx: getAudPerUsd", () => {
  // Braces matter: mockReset() returns the spy, and a function returned from beforeEach is run by
  // vitest as per-test cleanup, which would invoke the mock (and fail the test when it rejects).
  beforeEach(() => {
    getJsonMock.mockReset();
  });

  it("uses open.er-api.com first and reports the published time", async () => {
    getJsonMock.mockResolvedValueOnce(erapiFixture);
    const fx = await load();
    const rate = await fx.getAudPerUsd(T0);
    expect(rate).toEqual({ audPerUsd: 1.423201, asOf: 1792627351 * 1000, source: "open.er-api.com" });
    expect(urls()).toEqual([ERAPI]);
    const [, opts] = getJsonMock.mock.calls[0] as [string, { limiter?: unknown; retries?: number }];
    expect(opts.limiter).toBeDefined();
    expect(opts.retries).toBe(1);
  });

  it("falls back to api.frankfurter.dev when the primary throws", async () => {
    getJsonMock.mockRejectedValueOnce(new Error("socket hang up")).mockResolvedValueOnce(frankfurterFixture);
    const fx = await load();
    const rate = await fx.getAudPerUsd(T0);
    expect(rate).toEqual({ audPerUsd: 1.4217, asOf: Date.UTC(2026, 9, 21), source: "api.frankfurter.dev" });
    expect(urls()).toEqual([ERAPI, FRANKFURTER]);
  });

  it("falls back when the primary answers with an unusable body", async () => {
    getJsonMock.mockResolvedValueOnce({ result: "error", "error-type": "quota-reached" }).mockResolvedValueOnce(frankfurterFixture);
    const fx = await load();
    expect((await fx.getAudPerUsd(T0))?.source).toBe("api.frankfurter.dev");

    getJsonMock.mockReset();
    getJsonMock.mockResolvedValueOnce(null).mockResolvedValueOnce(frankfurterFixture);
    const fx2 = await load();
    expect((await fx2.getAudPerUsd(T0))?.source).toBe("api.frankfurter.dev");
  });

  it("caches for one hour and shares one in-flight fetch", async () => {
    let release!: (v: unknown) => void;
    getJsonMock.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const fx = await load();
    const a = fx.getAudPerUsd(T0);
    const b = fx.getAudPerUsd(T0 + 1);
    release(erapiFixture);
    expect((await a)?.audPerUsd).toBe(1.423201);
    expect(await b).toEqual(await a);
    expect(getJsonMock).toHaveBeenCalledTimes(1);

    expect((await fx.getAudPerUsd(T0 + fx.FX_CACHE_TTL_MS - 1))?.audPerUsd).toBe(1.423201);
    expect(getJsonMock).toHaveBeenCalledTimes(1);

    getJsonMock.mockResolvedValueOnce({ ...erapiFixture, rates: { AUD: 1.5 } });
    expect((await fx.getAudPerUsd(T0 + fx.FX_CACHE_TTL_MS))?.audPerUsd).toBe(1.5);
    expect(getJsonMock).toHaveBeenCalledTimes(2);
  });

  it("returns null when every source fails and nothing is cached", async () => {
    getJsonMock.mockImplementation(() => Promise.reject(new Error("down")));
    const fx = await load();
    expect(await fx.getAudPerUsd(T0)).toBeNull();
    expect(urls()).toEqual([ERAPI, FRANKFURTER]);
    // a later call retries rather than negative-caching the null
    expect(await fx.getAudPerUsd(T0 + 1)).toBeNull();
    expect(getJsonMock).toHaveBeenCalledTimes(4);
  });

  it("serves the last cached rate when a refresh fails after expiry", async () => {
    getJsonMock.mockResolvedValueOnce(erapiFixture);
    const fx = await load();
    const first = await fx.getAudPerUsd(T0);
    getJsonMock.mockImplementation(() => Promise.reject(new Error("down")));
    const later = await fx.getAudPerUsd(T0 + fx.FX_CACHE_TTL_MS + 5);
    expect(later).toEqual(first);
    expect(getJsonMock).toHaveBeenCalledTimes(3);
  });

  it("parsers reject malformed bodies", async () => {
    const fx = await load();
    expect(fx.parseErapi(null, T0)).toBeNull();
    expect(fx.parseErapi({ result: "success", rates: { AUD: "1.4" } }, T0)).toBeNull();
    expect(fx.parseErapi({ result: "success", rates: { AUD: 0 } }, T0)).toBeNull();
    expect(fx.parseErapi({ result: "success", rates: { AUD: 1.4 } }, T0)).toEqual({ audPerUsd: 1.4, asOf: T0, source: "open.er-api.com" });
    expect(fx.parseFrankfurter([], T0)).toBeNull();
    expect(fx.parseFrankfurter({ base: "EUR", rates: { AUD: 1.6 } }, T0)).toBeNull();
    expect(fx.parseFrankfurter({ rates: { AUD: -1 } }, T0)).toBeNull();
    expect(fx.parseFrankfurter({ rates: { AUD: 1.42 }, date: "garbage" }, T0)).toEqual({ audPerUsd: 1.42, asOf: T0, source: "api.frankfurter.dev" });
  });
});
