import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DISPLAY_CURRENCY, DEFAULT_DISPLAY_TIMEZONE, isValidTimezone, loadEnv } from "../../src/core/config.js";

describe("loadEnv display settings", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to AUD and Australia/Sydney", () => {
    vi.stubEnv("DISPLAY_CURRENCY", "");
    vi.stubEnv("DISPLAY_TIMEZONE", "");
    const env = loadEnv();
    expect(env.displayCurrency).toBe("AUD");
    expect(env.displayTimezone).toBe("Australia/Sydney");
    expect(DEFAULT_DISPLAY_CURRENCY).toBe("AUD");
    expect(DEFAULT_DISPLAY_TIMEZONE).toBe("Australia/Sydney");
  });

  it("accepts USD and any valid IANA zone, case-insensitively for the currency", () => {
    vi.stubEnv("DISPLAY_CURRENCY", "usd");
    vi.stubEnv("DISPLAY_TIMEZONE", "Europe/London");
    const env = loadEnv();
    expect(env.displayCurrency).toBe("USD");
    expect(env.displayTimezone).toBe("Europe/London");
    vi.stubEnv("DISPLAY_CURRENCY", " AUD ");
    vi.stubEnv("DISPLAY_TIMEZONE", "UTC");
    expect(loadEnv()).toMatchObject({ displayCurrency: "AUD", displayTimezone: "UTC" });
  });

  it("falls back to the defaults on an unknown currency or time zone", () => {
    vi.stubEnv("DISPLAY_CURRENCY", "EUR");
    vi.stubEnv("DISPLAY_TIMEZONE", "Mars/Olympus_Mons");
    const env = loadEnv();
    expect(env.displayCurrency).toBe("AUD");
    expect(env.displayTimezone).toBe("Australia/Sydney");
  });

  it("validates time zones with Intl", () => {
    expect(isValidTimezone("Australia/Sydney")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("   ")).toBe(false);
  });

  it("leaves the existing keys untouched", () => {
    vi.stubEnv("TRADING_MODE", "paper");
    vi.stubEnv("DB_PATH", "x.db");
    const env = loadEnv();
    expect(env.tradingMode).toBe("paper");
    expect(env.dbPath).toBe("x.db");
  });
});
