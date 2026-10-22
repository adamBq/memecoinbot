/**
 * The bot loop. Three cadences:
 *   - price tick: mark positions, evaluate exits, enforce breakers
 *   - screen: discover, filter, score, evaluate entries
 *   - snapshot: persist equity for the curve
 * Everything that matters is written to the ledger so a restart resumes cleanly.
 */
import { logger } from "../core/logger.js";
import { sleep } from "../core/http.js";
import type { StrategyConfig } from "../core/config.js";
import type {
  Candle,
  CompositeScore,
  PairSnapshot,
  Position,
  SafetyReport,
  SellabilityCheck,
  TokenContext,
} from "../core/types.js";
import type { Ledger } from "../execution/ledger.js";
import type { PaperBroker } from "../execution/paper.js";
import type { LlmScorer } from "../analysis/llm.js";
import { scoreToken } from "../analysis/composite.js";
import { buildEventSignals, buildSentimentSignals } from "../analysis/signals.js";
import { evaluateBreakers, evaluateEntry, evaluateExits, pnlPct, updatePeak } from "../strategy/risk.js";
import { META, adjustCash, ensureInitialised, loadPortfolio, utcDayKey } from "./portfolio.js";
import { sanitizeUntrustedText } from "../core/sanitize.js";

/** Data dependencies are injected so the runner can be tested without the network. */
export interface RunnerDeps {
  discoverCandidates: () => Promise<Array<{ mint: string; pairAddress: string | null; sources: string[] }>>;
  getPairsByTokens: (mints: string[]) => Promise<PairSnapshot[]>;
  pickPrimaryPair: (pairs: PairSnapshot[]) => PairSnapshot | null;
  getOhlcv: (pairAddress: string, timeframe: "minute" | "hour" | "day", aggregate: number, limit: number) => Promise<Candle[]>;
  getSafetyReport: (mint: string) => Promise<SafetyReport | null>;
  checkSellability: (mint: string, notionalUsd: number) => Promise<SellabilityCheck>;
  getPricesUsd: (mints: string[]) => Promise<Record<string, { usdPrice: number; decimals: number; liquidity: number }>>;
  getTrendingSolanaMints: () => Promise<Array<{ mint: string; rank: number; name: string; symbol: string }>>;
  getLatestProfiles: () => Promise<Array<{ mint: string; description: string | null }>>;
  getTopBoosts: () => Promise<Array<{ mint: string; totalAmount: number }>>;
}

export interface RunnerOptions {
  /** When true, screen() scores and logs but never opens positions. */
  dryRun?: boolean;
  now?: () => number;
}

interface PriceInfo {
  price: number;
  liquidity: number;
  decimals: number;
  fetchedAt: number;
  pair: PairSnapshot | null;
}

const SAFETY_RECHECK_MS = 30 * 60 * 1000;

/** Resolve with `fallback` if the promise is slow; the original keeps running and warms its cache. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      logger.warn({ ms }, "slow dependency, using fallback for this screen");
      resolve(fallback);
    }, ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

export class Runner {
  private readonly now: () => number;
  private readonly dryRun: boolean;
  private stopping = false;
  private prevTrending = new Set<string>();
  private safetyCache = new Map<string, { report: SafetyReport | null; at: number }>();
  private decimalsCache = new Map<string, number>();
  private lastDataAt = 0;

  constructor(
    private readonly cfg: StrategyConfig,
    private readonly ledger: Ledger,
    private readonly broker: PaperBroker,
    private readonly llm: LlmScorer,
    private readonly deps: RunnerDeps,
    opts: RunnerOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.dryRun = opts.dryRun ?? false;
    ensureInitialised(ledger, cfg, this.now());
  }

  stop(): void {
    this.stopping = true;
  }

  /** Run forever until stop() is called. Ticks and screens run on independent loops so a slow screen never delays an exit. */
  async start(): Promise<void> {
    const s = this.cfg.scheduler;
    logger.info({ dryRun: this.dryRun }, "runner starting");
    const loop = async (name: string, intervalMs: number, fn: () => Promise<unknown>): Promise<void> => {
      while (!this.stopping) {
        const started = this.now();
        try {
          await fn();
        } catch (err) {
          logger.error({ loop: name, err: String(err), stack: (err as Error)?.stack }, "loop iteration failed");
        }
        const elapsed = this.now() - started;
        const wait = Math.max(1000, intervalMs - elapsed);
        for (let waited = 0; waited < wait && !this.stopping; waited += 1000) await sleep(1000);
      }
    };
    await Promise.all([
      loop("tick", s.priceCheckSeconds * 1000, () => this.priceTick()),
      loop("screen", s.screenIntervalSeconds * 1000, () => this.screen()),
      loop("snapshot", s.equitySnapshotSeconds * 1000, () => this.snapshot()),
    ]);
    logger.info("runner stopped");
  }

  // ---------- price tick ----------

  async priceTick(): Promise<void> {
    const now = this.now();
    const open = this.ledger.getOpenPositions();
    this.ledger.setMeta(META.lastTickAt, String(now));
    if (open.length === 0) {
      const p = loadPortfolio(this.ledger, {}, now);
      this.checkKill(p, now);
      return;
    }

    const prices = await this.fetchPrices(open.map((p) => p.mint));
    const priceMap: Record<string, number> = {};
    for (const [mint, info] of Object.entries(prices)) priceMap[mint] = info.price;

    for (const pos of open) {
      const info = prices[pos.mint];
      if (!info) {
        logger.warn({ mint: pos.mint, symbol: pos.symbol }, "no price for open position, holding");
        continue;
      }
      await this.managePosition(pos, info, now);
    }

    const after = loadPortfolio(this.ledger, priceMap, now);
    this.checkKill(after, now);
  }

  private async managePosition(pos: Position, info: PriceInfo, now: number): Promise<void> {
    let position = updatePeak(pos, info.price);
    if (position.peakPriceUsd !== pos.peakPriceUsd) this.ledger.updatePosition(position);

    let safetyNow: SafetyReport | null = null;
    if (this.cfg.exits.exitOnSafetyDeterioration) {
      const cached = this.safetyCache.get(pos.mint);
      if (!cached || now - cached.at > SAFETY_RECHECK_MS) {
        try {
          safetyNow = await this.deps.getSafetyReport(pos.mint);
        } catch (err) {
          logger.warn({ mint: pos.mint, err: String(err) }, "safety recheck failed");
        }
        this.safetyCache.set(pos.mint, { report: safetyNow, at: now });
      } else {
        safetyNow = cached.report;
      }
    }

    const decision = evaluateExits(position, info.price, info.liquidity, safetyNow, this.cfg, now);
    if (decision.action !== "sell" || decision.fraction <= 0) return;

    const pair = info.pair ?? this.syntheticPair(position, info);
    const qty = Math.min(position.remainingQtyTokens, position.remainingQtyTokens * decision.fraction);
    position = await this.executeSell(position, pair, info.decimals, qty, decision.reason, now);
  }

  private async executeSell(position: Position, pair: PairSnapshot, decimals: number, qty: number, reason: string, now: number): Promise<Position> {
    const fill = await this.broker.sell(pair, decimals, qty, now);
    const costShare = position.costBasisUsd * (qty / position.qtyTokens);
    const pnl = fill.notionalUsd - costShare;
    position.remainingQtyTokens = Math.max(0, position.remainingQtyTokens - qty);
    position.realizedPnlUsd += pnl;
    if (reason.toLowerCase().includes("take profit")) position.tp1Hit = true;
    this.ledger.recordOrder({
      positionId: position.id,
      side: "sell",
      mint: position.mint,
      symbol: position.symbol,
      qtyTokens: fill.qtyTokens,
      effectivePriceUsd: fill.effectivePriceUsd,
      referencePriceUsd: fill.referencePriceUsd,
      notionalUsd: fill.notionalUsd,
      feeUsd: fill.feeUsd,
      priceImpactPct: fill.priceImpactPct,
      reason,
      ts: now,
    });
    adjustCash(this.ledger, fill.notionalUsd);
    this.ledger.updatePosition(position);
    this.ledger.recordDecision({
      ts: now,
      mint: position.mint,
      symbol: position.symbol,
      action: "exit",
      total: 0,
      lensesJson: "{}",
      reason: `${reason} | sold ${qty.toFixed(2)} @ ${fill.effectivePriceUsd} pnl ${pnl.toFixed(2)}`,
    });

    const closed = position.remainingQtyTokens <= position.qtyTokens * 1e-6;
    if (closed) {
      position.remainingQtyTokens = 0;
      this.ledger.updatePosition(position);
      this.ledger.closePosition(position.id, now, reason);
      const losses = Number(this.ledger.getMeta(META.consecutiveLosses) ?? "0");
      const next = position.realizedPnlUsd < 0 ? losses + 1 : 0;
      this.ledger.setMeta(META.consecutiveLosses, String(next));
      if (next >= this.cfg.circuitBreakers.maxConsecutiveLosses) {
        const until = now + this.cfg.circuitBreakers.cooldownHours * 3600 * 1000;
        this.ledger.setMeta(META.haltedUntil, String(until));
        this.ledger.setMeta(META.consecutiveLosses, "0"); // reset so the halt expires with the cooldown
        this.ledger.addNote(now, `consecutive loss halt (${next} losses) until ${new Date(until).toISOString()}`);
      }
    }
    logger.info(
      { symbol: position.symbol, qty, price: fill.effectivePriceUsd, pnl: pnl.toFixed(2), closed, reason },
      "SELL",
    );
    return position;
  }

  private checkKill(p: ReturnType<typeof loadPortfolio>, now: number): void {
    const breakers = evaluateBreakers(p, this.cfg, now);
    if (breakers.killSwitch && !p.killed) {
      this.ledger.setMeta(META.killed, "1");
      this.ledger.addNote(now, `KILL SWITCH: ${breakers.reasons.join("; ")}`);
      logger.error({ reasons: breakers.reasons }, "kill switch triggered, closing all positions");
      void this.closeAll("kill switch", now);
    }
  }

  async closeAll(reason: string, now: number): Promise<void> {
    const open = this.ledger.getOpenPositions();
    if (open.length === 0) return;
    const prices = await this.fetchPrices(open.map((p) => p.mint));
    for (const pos of open) {
      const info = prices[pos.mint];
      if (!info) continue;
      const pair = info.pair ?? this.syntheticPair(pos, info);
      await this.executeSell(pos, pair, info.decimals, pos.remainingQtyTokens, reason, now);
    }
  }

  private async fetchPrices(mints: string[]): Promise<Record<string, PriceInfo>> {
    const out: Record<string, PriceInfo> = {};
    const now = this.now();
    let pairs: PairSnapshot[] = [];
    try {
      pairs = await this.deps.getPairsByTokens(mints);
    } catch (err) {
      logger.warn({ err: String(err) }, "dexscreener price fetch failed");
    }
    const byMint = new Map<string, PairSnapshot[]>();
    for (const p of pairs) {
      const arr = byMint.get(p.mint) ?? [];
      arr.push(p);
      byMint.set(p.mint, arr);
    }
    const missing: string[] = [];
    for (const mint of mints) {
      const primary = this.deps.pickPrimaryPair(byMint.get(mint) ?? []);
      if (primary && primary.priceUsd > 0) {
        out[mint] = {
          price: primary.priceUsd,
          liquidity: primary.liquidityUsd,
          decimals: this.decimalsCache.get(mint) ?? 6,
          fetchedAt: now,
          pair: primary,
        };
      } else {
        missing.push(mint);
      }
    }
    const needDecimals = mints.filter((m) => !this.decimalsCache.has(m));
    if (missing.length > 0 || needDecimals.length > 0) {
      try {
        const jp = await this.deps.getPricesUsd([...new Set([...missing, ...needDecimals])]);
        for (const [mint, v] of Object.entries(jp)) {
          this.decimalsCache.set(mint, v.decimals);
          if (out[mint]) out[mint].decimals = v.decimals;
          else if (v.usdPrice > 0) out[mint] = { price: v.usdPrice, liquidity: v.liquidity, decimals: v.decimals, fetchedAt: now, pair: null };
        }
      } catch (err) {
        logger.warn({ err: String(err) }, "jupiter price fetch failed");
      }
    }
    if (Object.keys(out).length > 0) this.lastDataAt = now;
    return out;
  }

  private syntheticPair(pos: Position, info: PriceInfo): PairSnapshot {
    return {
      pairAddress: pos.pairAddress,
      dexId: "unknown",
      chainId: "solana",
      mint: pos.mint,
      symbol: pos.symbol,
      name: pos.symbol,
      quoteMint: "So11111111111111111111111111111111111111112",
      quoteSymbol: "SOL",
      priceUsd: info.price,
      priceNative: 0,
      liquidityUsd: info.liquidity,
      fdvUsd: null,
      marketCapUsd: null,
      volumeUsd: { m5: 0, h1: 0, h6: 0, h24: 0 },
      txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 }, h6: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } },
      priceChangePct: { m5: 0, h1: 0, h6: 0, h24: 0 },
      pairCreatedAt: null,
      boostsActive: 0,
      socials: [],
      websites: [],
      labels: [],
      fetchedAt: info.fetchedAt,
    };
  }

  // ---------- screen ----------

  async screen(): Promise<CompositeScore[]> {
    const now = this.now();
    this.ledger.setMeta(META.lastScreenAt, String(now));
    this.llm.resetBudget();
    const hf = this.cfg.hardFilters;

    const portfolio0 = loadPortfolio(this.ledger, {}, now);
    const breakers0 = evaluateBreakers(portfolio0, this.cfg, now);
    if (breakers0.killSwitch) {
      logger.warn({ reasons: breakers0.reasons }, "screen skipped: kill switch active");
      return [];
    }

    const candidates = await this.deps.discoverCandidates();
    const openMints = new Set(portfolio0.openPositions.map((p) => p.mint));
    const mints = candidates.map((c) => c.mint).filter((m) => !openMints.has(m)).slice(0, this.cfg.scheduler.maxCandidatesPerScreen * 2);
    logger.info({ discovered: candidates.length, considering: mints.length }, "screen: discovery");
    if (mints.length === 0) return [];

    const pairs = await this.deps.getPairsByTokens(mints);
    const byMint = new Map<string, PairSnapshot[]>();
    for (const p of pairs) {
      const arr = byMint.get(p.mint) ?? [];
      arr.push(p);
      byMint.set(p.mint, arr);
    }

    // Cheap prefilter on pair data alone so the expensive calls go to plausible names only.
    const prelim: PairSnapshot[] = [];
    for (const mint of mints) {
      const pair = this.deps.pickPrimaryPair(byMint.get(mint) ?? []);
      if (!pair) continue;
      const ageH = pair.pairCreatedAt ? (now - pair.pairCreatedAt) / 3600e3 : null;
      if (pair.liquidityUsd < hf.minLiquidityUsd || pair.liquidityUsd > hf.maxLiquidityUsd) continue;
      if (pair.volumeUsd.h24 < hf.minVolume24hUsd) continue;
      if (ageH !== null && (ageH < hf.minTokenAgeHours || ageH > hf.maxTokenAgeDays * 24)) continue;
      const mc = pair.marketCapUsd ?? pair.fdvUsd;
      if (mc !== null && (mc < hf.minMarketCapUsd || mc > hf.maxMarketCapUsd)) continue;
      prelim.push(pair);
    }
    prelim.sort((a, b) => b.volumeUsd.h1 - a.volumeUsd.h1);
    const shortlist = prelim.slice(0, this.cfg.scheduler.maxCandidatesPerScreen);
    logger.info({ prelim: prelim.length, shortlist: shortlist.length }, "screen: prefilter");

    const [trending, profiles, boosts] = await Promise.all([
      withTimeout(this.deps.getTrendingSolanaMints(), 20_000, []).catch((e) => {
        logger.warn({ err: String(e) }, "coingecko trending failed");
        return [] as Array<{ mint: string; rank: number; name: string; symbol: string }>;
      }),
      this.deps.getLatestProfiles().catch(() => [] as Array<{ mint: string; description: string | null }>),
      this.deps.getTopBoosts().catch(() => [] as Array<{ mint: string; totalAmount: number }>),
    ]);
    const cgRank = new Map(trending.map((t) => [t.mint, t.rank]));
    const boostRank = new Map(boosts.map((b, i) => [b.mint, i + 1]));
    const descriptions = new Map(profiles.map((p) => [p.mint, p.description]));
    const trendingNow = new Set<string>([...cgRank.keys(), ...boostRank.keys()]);

    const results: CompositeScore[] = [];
    for (const pair of shortlist) {
      try {
        const ctx = await this.buildContext(pair, now, {
          cgRank: cgRank.get(pair.mint) ?? null,
          dexRank: boostRank.get(pair.mint) ?? null,
          enteredTrending: trendingNow.has(pair.mint) && !this.prevTrending.has(pair.mint) && this.prevTrending.size > 0,
          description: descriptions.get(pair.mint) ?? null,
        });
        const score = scoreToken(ctx, this.cfg, now);
        results.push(score);
        this.ledger.recordDecision({
          ts: now,
          mint: score.mint,
          symbol: score.symbol,
          action: score.hardFilterPassed ? "skip" : "filtered",
          total: score.total,
          lensesJson: JSON.stringify(score.lenses),
          reason: score.hardFilterPassed ? "scored" : score.hardFilterFailures.join("; "),
        });
      } catch (err) {
        logger.warn({ mint: pair.mint, symbol: pair.symbol, err: String(err) }, "scoring failed");
      }
    }
    this.prevTrending = trendingNow;
    results.sort((a, b) => b.total - a.total);
    logger.info(
      { top: results.slice(0, 5).map((r) => ({ s: r.symbol, t: r.total.toFixed(3), ok: r.hardFilterPassed, bo: r.breakoutConfirmed })) },
      "screen: top scores",
    );

    // Entries, best first.
    for (const score of results) {
      if (!score.hardFilterPassed) continue;
      const pair = shortlist.find((p) => p.mint === score.mint);
      if (!pair) continue;
      const portfolio = loadPortfolio(this.ledger, {}, now);
      const breakers = evaluateBreakers(portfolio, this.cfg, now);
      const dataAge = (now - pair.fetchedAt) / 1000;
      const entry = evaluateEntry(score, portfolio, breakers, this.cfg, now, dataAge);
      if (!entry.enter) {
        logger.debug({ symbol: score.symbol, reason: entry.reason }, "no entry");
        continue;
      }
      if (this.dryRun) {
        logger.info({ symbol: score.symbol, notional: entry.notionalUsd, reason: entry.reason }, "DRY RUN would BUY");
        continue;
      }
      await this.executeBuy(pair, score, entry.notionalUsd, entry.reason, now);
    }
    return results;
  }

  private async executeBuy(pair: PairSnapshot, score: CompositeScore, notionalUsd: number, reason: string, now: number): Promise<void> {
    const decimals = await this.decimalsFor(pair.mint);
    const fill = await this.broker.buy(pair, decimals, notionalUsd, now);
    const position = this.ledger.openPosition({
      mint: pair.mint,
      symbol: pair.symbol,
      pairAddress: pair.pairAddress,
      openedAt: now,
      entryPriceUsd: fill.effectivePriceUsd,
      entryLiquidityUsd: pair.liquidityUsd,
      qtyTokens: fill.qtyTokens,
      costBasisUsd: fill.notionalUsd,
      entryScore: score.total,
    });
    this.ledger.recordOrder({
      positionId: position.id,
      side: "buy",
      mint: pair.mint,
      symbol: pair.symbol,
      qtyTokens: fill.qtyTokens,
      effectivePriceUsd: fill.effectivePriceUsd,
      referencePriceUsd: fill.referencePriceUsd,
      notionalUsd: fill.notionalUsd,
      feeUsd: fill.feeUsd,
      priceImpactPct: fill.priceImpactPct,
      reason,
      ts: now,
    });
    adjustCash(this.ledger, -fill.notionalUsd);
    this.ledger.recordDecision({
      ts: now,
      mint: pair.mint,
      symbol: pair.symbol,
      action: "enter",
      total: score.total,
      lensesJson: JSON.stringify(score.lenses),
      reason: `${reason} | bought ${fill.qtyTokens.toFixed(2)} @ ${fill.effectivePriceUsd} for ${fill.notionalUsd.toFixed(2)}`,
    });
    logger.info(
      { symbol: pair.symbol, mint: pair.mint, notional: fill.notionalUsd.toFixed(2), price: fill.effectivePriceUsd, score: score.total.toFixed(3) },
      "BUY",
    );
  }

  private async decimalsFor(mint: string): Promise<number> {
    const cached = this.decimalsCache.get(mint);
    if (cached !== undefined) return cached;
    const jp = await this.deps.getPricesUsd([mint]);
    const d = jp[mint]?.decimals ?? 6;
    this.decimalsCache.set(mint, d);
    return d;
  }

  private async buildContext(
    pair: PairSnapshot,
    now: number,
    extra: { cgRank: number | null; dexRank: number | null; enteredTrending: boolean; description: string | null },
  ): Promise<TokenContext> {
    const [safety, sellability, candles5m, candles1h] = await Promise.all([
      this.deps.getSafetyReport(pair.mint).catch((e) => {
        logger.warn({ mint: pair.mint, err: String(e) }, "rugcheck failed");
        return null;
      }),
      this.deps.checkSellability(pair.mint, this.cfg.execution.quoteNotionalUsd).catch((e) => {
        logger.warn({ mint: pair.mint, err: String(e) }, "sellability failed");
        return null;
      }),
      this.deps.getOhlcv(pair.pairAddress, "minute", 5, 100).catch(() => [] as Candle[]),
      this.deps.getOhlcv(pair.pairAddress, "hour", 1, 48).catch(() => [] as Candle[]),
    ]);
    this.safetyCache.set(pair.mint, { report: safety, at: now });

    let llm: { narrativeScore: number; narrativeReason: string; eventScore: number; eventReason: string } | null = null;
    if (this.llm.isEnabled()) {
      llm = await this.llm.assess({
        mint: pair.mint,
        symbol: sanitizeUntrustedText(pair.symbol, 32).text,
        name: sanitizeUntrustedText(pair.name, 64).text,
        description: extra.description,
        socials: pair.socials,
        websites: pair.websites,
        ageHours: pair.pairCreatedAt ? (now - pair.pairCreatedAt) / 3600e3 : -1,
        dexId: pair.dexId,
        priceChange24hPct: pair.priceChangePct.h24,
        launchpad: safety?.launchpad ?? null,
      });
    }

    const sentiment = buildSentimentSignals(
      pair,
      { dexscreener: extra.dexRank, coingecko: extra.cgRank },
      llm ? { score: llm.narrativeScore, reason: llm.narrativeReason } : null,
    );
    const events = buildEventSignals(
      pair,
      candles5m,
      candles1h,
      safety,
      extra.enteredTrending,
      llm ? { score: llm.eventScore, reason: llm.eventReason } : null,
    );
    return { pair, candles5m, candles1h, safety, sellability, sentiment, events };
  }

  // ---------- snapshot ----------

  async snapshot(): Promise<void> {
    const now = this.now();
    const open = this.ledger.getOpenPositions();
    const prices: Record<string, number> = {};
    if (open.length > 0) {
      const info = await this.fetchPrices(open.map((p) => p.mint));
      for (const [m, v] of Object.entries(info)) prices[m] = v.price;
    }
    const p = loadPortfolio(this.ledger, prices, now);
    this.ledger.snapshotEquity(now, p.equityUsd, p.cashUsd, open.length);
    logger.info(
      {
        equity: p.equityUsd.toFixed(2),
        cash: p.cashUsd.toFixed(2),
        open: open.map((o) => ({ s: o.symbol, pnl: `${pnlPct(o, prices[o.mint] ?? o.entryPriceUsd).toFixed(1)}%` })),
        day: utcDayKey(now),
      },
      "snapshot",
    );
  }
}
