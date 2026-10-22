/**
 * Candidate discovery: union of DexScreener boosts and profiles with
 * GeckoTerminal trending and new pools, deduplicated by mint. Any single
 * source may fail (rate limit, outage) without taking the screen down.
 */
import { logger } from "../core/logger.js";
import { isValidMint } from "../core/sanitize.js";
import { getLatestProfiles, getTopBoosts } from "./dexscreener.js";
import { getNewPools, getTrendingPools } from "./geckoterminal.js";

export interface Candidate {
  mint: string;
  pairAddress: string | null;
  /** dex_boost | dex_profile | gecko_trending | gecko_new */
  sources: string[];
}

interface SourceHit {
  mint: string;
  pairAddress: string | null;
}

interface Source {
  name: string;
  fetch: () => Promise<SourceHit[]>;
}

const SOURCES: Source[] = [
  {
    name: "dex_boost",
    fetch: async () => (await getTopBoosts()).map((b) => ({ mint: b.mint, pairAddress: null })),
  },
  {
    name: "dex_profile",
    fetch: async () => (await getLatestProfiles()).map((p) => ({ mint: p.mint, pairAddress: null })),
  },
  {
    name: "gecko_trending",
    fetch: async () => (await getTrendingPools()).map((p) => ({ mint: p.mint, pairAddress: p.pairAddress })),
  },
  {
    name: "gecko_new",
    fetch: async () => (await getNewPools()).map((p) => ({ mint: p.mint, pairAddress: p.pairAddress })),
  },
];

/** Union of all sources, deduplicated by mint. Tolerates any single source throwing. */
export async function discoverCandidates(): Promise<Candidate[]> {
  const results = await Promise.allSettled(SOURCES.map((s) => s.fetch()));
  const byMint = new Map<string, Candidate>();

  results.forEach((res, i) => {
    const source = SOURCES[i];
    if (!source) return;
    if (res.status === "rejected") {
      logger.warn({ source: source.name, err: String(res.reason) }, "discovery source failed");
      return;
    }
    for (const hit of res.value) {
      if (!isValidMint(hit.mint)) continue;
      const existing = byMint.get(hit.mint);
      if (existing) {
        if (!existing.sources.includes(source.name)) existing.sources.push(source.name);
        if (existing.pairAddress === null && hit.pairAddress) existing.pairAddress = hit.pairAddress;
      } else {
        byMint.set(hit.mint, { mint: hit.mint, pairAddress: hit.pairAddress, sources: [source.name] });
      }
    }
    logger.debug({ source: source.name, count: res.value.length }, "discovery source ok");
  });

  const candidates = [...byMint.values()];
  logger.info({ total: candidates.length, failed: results.filter((r) => r.status === "rejected").length }, "discovery complete");
  return candidates;
}
