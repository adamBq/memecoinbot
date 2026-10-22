/**
 * The bot loop. Three cadences on independent timers:
 *   - price tick: mark positions, evaluate exits, enforce breakers
 *   - screen: discover, filter, score, evaluate entries
 *   - snapshot: persist equity for the curve
 * Every state-changing section runs behind one async mutex so a tick can never
 * interleave with an entry or a kill-switch close-all. Positions are re-read
 * from the ledger after every await before they are written. Everything that
 * matters is written to the ledger so a restart resumes cleanly.
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
import { NoRouteError, type PaperBroker } from "../execution/paper.js";
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

interface Mark {
  price: number;
  /** null when the only source was Jupiter, whose liquidity figure is not comparable to the pair's. */
  liquidity: number | null;
  decimals: number | null;
  at: number;
  pair: PairSnapshot | null;
  source: "dex" | "jupiter" | "both";
}

const SAFETY_RECHECK_MS = 30 * 60 * 1000;
/** Ticks without any usable price before a position is force-exited as presumed unsellable. */
const MISSING_PRICE_TICKS_BEFORE_FORCED_EXIT = 10;
/** DexScreener and Jupiter disagreeing by more than this is treated as an untrusted tick. */
const MAX_SOURCE_DISAGREEMENT_PCT = 50;

/** Resolve with `fallback` if the promise is slow; the original keeps running and warms its cache. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      logger.warn({ ms, label }, "slow dependency, using fallback");
      resolve(fallback);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        logger.warn({ label, err: String(err) }, "dependency failed, using fallback");
        resolve(fallback);
      },
    );
  });
}

function isValidDecimals(d: number | null | undefined): d is number {
  return typeof d === "number" && Number.isInteger(d) && d > 0 && d <= 18;
}

export class Runner {
  private readonly now: () => number;
  private readonly dryRun: boolean;
  private stopping = false;
  private chain: Promise<unknown> = Promise.resolve();
  private prevTrending = new Set<string>();
  private readonly safetyCache = new Map<string, { report: SafetyReport; at: number }>();
  private readonly decimalsCache = new Map<string, number>();
  private readonly marks = new Map<string, Mark>();
  private readonly missingPriceTicks = new Map<number, number>();
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

  /** Serialise every state-changing section. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
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

  // ---------- marks ----------

  private currentPrices(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [mint, m] of this.marks) out[mint] = m.price;
    return out;
  }

  /** True when every open position has a mark fresher than the staleness limit. */
  private openPositionsMarked(open: Position[], now: number): boolean {
    const limit = this.cfg.circuitBreakers.dataStaleSeconds * 1000;
    return open.every((p) => {
      const m = this.marks.get(p.mint);
      return m !== undefined && now - m.at <= limit;
    });
  }

  /**
   * Fetch prices for the given mints from DexScreener and Jupiter, cross-check
   * them, and update the mark cache. Returns only mints with a trusted price.
   */
  private async fetchPrices(mints: string[], preferPair?: Map<string, string>): Promise<Record<string, Mark>> {
    const out: Record<string, Mark> = {};
    if (mints.length === 0) return out;
    const now = this.now();
    const [pairs, jp] = await Promise.all([
      withTimeout(this.deps.getPairsByTokens(mints), 30_000, [] as PairSnapshot[], "dexscreener prices"),
      withTimeout(this.deps.getPricesUsd(mints), 30_000, {} as Awaited<ReturnType<RunnerDeps["getPricesUsd"]>>, "jupiter prices"),
    ]);
    const byMint = new Map<string, PairSnapshot[]>();
    for (const p of pairs) {
      const arr = byMint.get(p.mint) ?? [];
      arr.push(p);
      byMint.set(p.mint, arr);
    }
    for (const mint of mints) {
      const candidates = byMint.get(mint) ?? [];
      const wanted = preferPair?.get(mint);
      const pair = (wanted && candidates.find((c) => c.pairAddress === wanted)) || this.deps.pickPrimaryPair(candidates);
      const dexPrice = pair && pair.priceUsd > 0 ? pair.priceUsd : null;
      const j = jp[mint];
      const jupPrice = j && j.usdPrice > 0 ? j.usdPrice : null;
      if (j && isValidDecimals(j.decimals)) this.decimalsCache.set(mint, j.decimals);

      let price: number | null = null;
      let source: Mark["source"] = "dex";
      if (dexPrice !== null && jupPrice !== null) {
        const disagreement = (Math.abs(dexPrice - jupPrice) / Math.max(dexPrice, jupPrice)) * 100;
        if (disagreement > MAX_SOURCE_DISAGREEMENT_PCT) {
          logger.warn({ mint, dexPrice, jupPrice, disagreement: disagreement.toFixed(1) }, "price sources disagree, tick untrusted");
          continue;
        }
        price = Math.min(dexPrice, jupPrice); // conservative on gains and quick on stops
        source = "both";
      } else if (dexPrice !== null) {
        price = dexPrice;
      } else if (jupPrice !== null) {
        price = jupPrice;
        source = "jupiter";
      }
      if (price === null) continue;
      const mark: Mark = {
        price,
        liquidity: pair && pair.liquidityUsd > 0 ? pair.liquidityUsd : null,
        decimals: this.decimalsCache.get(mint) ?? null,
        at: now,
        pair: pair ?? null,
        source,
      };
      this.marks.set(mint, mark);
      out[mint] = mark;
    }
    if (Object.keys(out).length > 0) this.lastDataAt = now;
    return out;
  }

  // ---------- price tick ----------

  async priceTick(): Promise<void> {
    return this.locked(() => this.priceTickLocked());
  }

  private async priceTickLocked(): Promise<void> {
    const now = this.now();
    this.ledger.setMeta(META.lastTickAt, String(now));
    const open = this.ledger.getOpenPositions();
    const killedAlready = this.ledger.getMeta(META.killed) === "1";

    if (open.length === 0) {
      loadPortfolio(this.ledger, {}, now);
      return;
    }

    const preferPair = new Map(open.map((p) => [p.mint, p.pairAddress]));
    const marks = await this.fetchPrices(
      open.map((p) => p.mint),
      preferPair,
    );

    if (killedAlready) {
      await this.closeAllLocked("kill switch (retry)", now);
      return;
    }

    for (const pos of open) {
      try {
        const mark = marks[pos.mint];
        if (!mark) {
          await this.handleMissingPrice(pos, now);
          continue;
        }
        this.missingPriceTicks.delete(pos.id);
        await this.managePosition(pos, mark, now);
      } catch (err) {
        logger.error({ symbol: pos.symbol, err: String(err) }, "position management failed, continuing with others");
      }
    }

    const after = loadPortfolio(this.ledger, this.currentPrices(), now);
    const breakers = evaluateBreakers(after, this.cfg, now);
    if (breakers.killSwitch && !after.killed) {
      this.ledger.setMeta(META.killed, "1");
      this.ledger.addNote(now, `KILL SWITCH: ${breakers.reasons.join("; ")}`);
      logger.error({ reasons: breakers.reasons }, "kill switch triggered, closing all positions");
      await this.closeAllLocked("kill switch", now);
    }
  }

  private async handleMissingPrice(pos: Position, now: number): Promise<void> {
    const n = (this.missingPriceTicks.get(pos.id) ?? 0) + 1;
    this.missingPriceTicks.set(pos.id, n);
    if (n < MISSING_PRICE_TICKS_BEFORE_FORCED_EXIT) {
      logger.warn({ symbol: pos.symbol, mint: pos.mint, missingTicks: n }, "no trusted price for open position, holding");
      return;
    }
    const last = this.marks.get(pos.mint);
    const refPrice = last?.price ?? pos.entryPriceUsd;
    const pair = this.syntheticPair(pos, refPrice, last?.liquidity ?? null, now);
    logger.error({ symbol: pos.symbol, missingTicks: n, refPrice }, "price feed lost, forcing exit as presumed unsellable");
    await this.executeSell(pos, pair, pos.remainingQtyTokens, `forced exit: no trusted price for ${n} ticks, presumed unsellable`, "forced", now);
    this.missingPriceTicks.delete(pos.id);
  }

  private async managePosition(pos: Position, mark: Mark, now: number): Promise<void> {
    let position = updatePeak(pos, mark.price);
    if (position.peakPriceUsd !== pos.peakPriceUsd) this.ledger.updatePeakPrice(position.id, position.peakPriceUsd);

    let safetyNow: SafetyReport | null = null;
    if (this.cfg.exits.exitOnSafetyDeterioration) {
      const cached = this.safetyCache.get(pos.mint);
      if (!cached || now - cached.at > SAFETY_RECHECK_MS) {
        const fresh = await withTimeout(this.deps.getSafetyReport(pos.mint), 20_000, null, "rugcheck recheck");
        if (fresh) this.safetyCache.set(pos.mint, { report: fresh, at: now });
        safetyNow = fresh ?? cached?.report ?? null; // failures never overwrite a good report
      } else {
        safetyNow = cached.report;
      }
    }

    const decision = evaluateExits(position, mark.price, mark.liquidity, safetyNow, this.cfg, now);
    if (decision.action !== "sell" || decision.fraction <= 0) return;

    const pair = mark.pair ?? this.syntheticPair(position, mark.price, mark.liquidity, now);
    const qty = position.remainingQtyTokens * decision.fraction;
    position = await this.executeSell(position, pair, qty, decision.reason, decision.kind ?? "forced", now);
  }

  /**
   * Sell `qty` of a position. Re-reads the position after the broker await so
   * a concurrent close cannot double-sell, then commits all ledger writes atomically.
   */
  private async executeSell(
    snapshot: Position,
    pair: PairSnapshot,
    qty: number,
    reason: string,
    kind: NonNullable<import("../core/types.js").ExitDecision["kind"]>,
    now: number,
  ): Promise<Position> {
    const decimals = this.decimalsCache.get(snapshot.mint) ?? 6;
    const fill = await this.broker.sell(pair, decimals, qty, now);

    const position = this.ledger.getPosition(snapshot.id);
    if (!position || position.status !== "open" || position.remainingQtyTokens <= 0) {
      logger.warn({ id: snapshot.id, symbol: snapshot.symbol }, "sell skipped: position already closed");
      return position ?? snapshot;
    }
    const soldQty = Math.min(qty, position.remainingQtyTokens);
    const scale = soldQty / qty;
    const notionalIn = fill.notionalUsd * scale;
    const feeUsd = fill.feeUsd * scale;
    const costShare = position.costBasisUsd * (soldQty / position.qtyTokens);
    const pnl = notionalIn - costShare;

    position.remainingQtyTokens = Math.max(0, position.remainingQtyTokens - soldQty);
    position.realizedPnlUsd += pnl;
    position.peakPriceUsd = Math.max(position.peakPriceUsd, snapshot.peakPriceUsd);
    if (kind === "take_profit") position.tp1Hit = true;
    const closed = position.remainingQtyTokens <= position.qtyTokens * 1e-6;
    if (closed) position.remainingQtyTokens = 0;

    this.ledger.transaction(() => {
      this.ledger.recordOrder({
        positionId: position.id,
        side: "sell",
        mint: position.mint,
        symbol: position.symbol,
        qtyTokens: soldQty,
        effectivePriceUsd: fill.effectivePriceUsd,
        referencePriceUsd: fill.referencePriceUsd,
        notionalUsd: notionalIn,
        feeUsd,
        priceImpactPct: fill.priceImpactPct,
        reason,
        ts: now,
      });
      adjustCash(this.ledger, notionalIn);
      this.ledger.updatePosition(position);
      this.ledger.recordDecision({
        ts: now,
        mint: position.mint,
        symbol: position.symbol,
        action: "exit",
        total: 0,
        lensesJson: JSON.stringify({ kind }),
        reason: `${reason} | sold ${soldQty.toFixed(2)} @ ${fill.effectivePriceUsd} pnl ${pnl.toFixed(2)}`,
      });
      if (closed) {
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
    });
    if (closed) {
      position.status = "closed";
      position.closedAt = now;
      position.closeReason = reason;
    }
    logger.info({ symbol: position.symbol, qty: soldQty, price: fill.effectivePriceUsd, pnl: pnl.toFixed(2), closed, kind, reason }, "SELL");
    return position;
  }

  /** Close every open position. Public entry point takes the lock. */
  async closeAll(reason: string, now: number): Promise<void> {
    return this.locked(() => this.closeAllLocked(reason, now));
  }

  private async closeAllLocked(reason: string, now: number): Promise<void> {
    const open = this.ledger.getOpenPositions();
    if (open.length === 0) return;
    const marks = await this.fetchPrices(
      open.map((p) => p.mint),
      new Map(open.map((p) => [p.mint, p.pairAddress])),
    );
    for (const pos of open) {
      try {
        const mark = marks[pos.mint] ?? this.marks.get(pos.mint);
        const refPrice = mark?.price ?? pos.entryPriceUsd;
        const pair = mark?.pair ?? this.syntheticPair(pos, refPrice, mark?.liquidity ?? null, now);
        await this.executeSell(pos, pair, pos.remainingQtyTokens, reason, "forced", now);
      } catch (err) {
        logger.error({ symbol: pos.symbol, err: String(err) }, "close-all sell failed, will retry next tick");
      }
    }
  }

  private syntheticPair(pos: Position, priceUsd: number, liquidityUsd: number | null, now: number): PairSnapshot {
    return {
      pairAddress: pos.pairAddress,
      dexId: "unknown",
      chainId: "solana",
      mint: pos.mint,
      symbol: pos.symbol,
      name: pos.symbol,
      quoteMint: "So11111111111111111111111111111111111111112",
      quoteSymbol: "SOL",
      priceUsd,
      priceNative: 0,
      liquidityUsd: liquidityUsd ?? 0,
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
      fetchedAt: now,
    };
  }

  // ---------- screen ----------

  async screen(): Promise<CompositeScore[]> {
    const startedAt = this.now();
    this.ledger.setMeta(META.lastScreenAt, String(startedAt));
    this.llm.resetBudget();
    const hf = this.cfg.hardFilters;

    if (this.ledger.getMeta(META.killed) === "1") {
      logger.warn("screen skipped: kill switch active");
      return [];
    }

    const candidates = await this.deps.discoverCandidates();
    const openMints = new Set(this.ledger.getOpenPositions().map((p) => p.mint));
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

    const [trending, profiles, boosts] = await Promise.all([
      withTimeout(this.deps.getTrendingSolanaMints(), 20_000, [], "coingecko trending"),
      withTimeout(this.deps.getLatestProfiles(), 15_000, [], "dexscreener profiles"),
      withTimeout(this.deps.getTopBoosts(), 15_000, [], "dexscreener boosts"),
    ]);
    const cgRank = new Map(trending.map((t) => [t.mint, t.rank]));
    const boostRank = new Map(boosts.map((b, i) => [b.mint, i + 1]));
    const descriptions = new Map(profiles.map((p) => [p.mint, p.description]));
    const trendingNow = new Set<string>([...cgRank.keys(), ...boostRank.keys()]);

    // Cheap prefilter on pair data alone so the expensive calls go to plausible names only.
    const prelim: PairSnapshot[] = [];
    for (const mint of mints) {
      const pair = this.deps.pickPrimaryPair(byMint.get(mint) ?? []);
      if (!pair) continue;
      const ageH = pair.pairCreatedAt ? (startedAt - pair.pairCreatedAt) / 3600e3 : null;
      if (pair.liquidityUsd < hf.minLiquidityUsd || pair.liquidityUsd > hf.maxLiquidityUsd) continue;
      if (pair.volumeUsd.h24 < hf.minVolume24hUsd) continue;
      if (ageH !== null && (ageH < hf.minTokenAgeHours || ageH > hf.maxTokenAgeDays * 24)) continue;
      const mc = pair.marketCapUsd ?? pair.fdvUsd;
      if (mc !== null && (mc < hf.minMarketCapUsd || mc > hf.maxMarketCapUsd)) continue;

      // Injection tripwire: any instruction-like text in the token's own metadata is a hard reject.
      const flagged = [pair.symbol, pair.name, descriptions.get(mint) ?? "", ...pair.websites, ...pair.socials.map((s) => s.url)]
        .map((t) => sanitizeUntrustedText(t))
        .filter((r) => r.flagged);
      if (flagged.length > 0) {
        this.ledger.recordDecision({
          ts: this.now(),
          mint,
          symbol: sanitizeUntrustedText(pair.symbol, 32).text,
          action: "filtered",
          total: 0,
          lensesJson: "{}",
          reason: `injection pattern in token metadata: ${flagged[0]!.reasons.join(", ")}`,
        });
        continue;
      }
      prelim.push(pair);
    }
    prelim.sort((a, b) => b.volumeUsd.h1 - a.volumeUsd.h1);
    const shortlist = prelim.slice(0, this.cfg.scheduler.maxCandidatesPerScreen);
    logger.info({ prelim: prelim.length, shortlist: shortlist.length }, "screen: prefilter");

    const results: CompositeScore[] = [];
    for (const pair of shortlist) {
      try {
        const ctx = await this.buildContext(pair, {
          cgRank: cgRank.get(pair.mint) ?? null,
          dexRank: boostRank.get(pair.mint) ?? null,
          enteredTrending: trendingNow.has(pair.mint) && !this.prevTrending.has(pair.mint) && this.prevTrending.size > 0,
          description: descriptions.get(pair.mint) ?? null,
        });
        const score = scoreToken(ctx, this.cfg, this.now());
        results.push(score);
        if (!score.hardFilterPassed) {
          this.ledger.recordDecision({
            ts: this.now(),
            mint: score.mint,
            symbol: score.symbol,
            action: "filtered",
            total: score.total,
            lensesJson: JSON.stringify(score.lenses),
            reason: score.hardFilterFailures.join("; "),
          });
        }
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

    // Entries, best first. Each one takes the lock so it cannot interleave with a tick.
    for (const score of results) {
      if (!score.hardFilterPassed) continue;
      await this.locked(() => this.tryEnter(score));
    }
    return results;
  }

  private async tryEnter(score: CompositeScore): Promise<void> {
    const now = this.now();
    const record = (action: "skip" | "enter", reason: string) =>
      this.ledger.recordDecision({ ts: now, mint: score.mint, symbol: score.symbol, action, total: score.total, lensesJson: JSON.stringify(score.lenses), reason });

    const open = this.ledger.getOpenPositions();
    if (open.length > 0 && !this.openPositionsMarked(open, now)) {
      record("skip", "entries paused: an open position has no fresh mark");
      return;
    }
    if (open.length > 0 && now - this.lastDataAt > this.cfg.circuitBreakers.dataStaleSeconds * 1000) {
      record("skip", "entries paused: price data stale");
      return;
    }
    const portfolio = loadPortfolio(this.ledger, this.currentPrices(), now, { readOnly: true });
    const breakers = evaluateBreakers(portfolio, this.cfg, now);
    const prelimEntry = evaluateEntry(score, portfolio, breakers, this.cfg, now, 0);
    if (!prelimEntry.enter) {
      record("skip", prelimEntry.reason);
      return;
    }

    // Refetch the pair right before buying so the fill price and staleness check use current data.
    const fresh = await this.fetchPrices([score.mint], new Map([[score.mint, score.pairAddress]]));
    const mark = fresh[score.mint];
    if (!mark || !mark.pair) {
      record("skip", "no trusted price at entry time");
      return;
    }
    const t = this.now();
    const entry = evaluateEntry(score, portfolio, breakers, this.cfg, t, (t - mark.at) / 1000);
    if (!entry.enter) {
      record("skip", entry.reason);
      return;
    }
    if (!isValidDecimals(mark.decimals)) {
      record("skip", "token decimals unknown, refusing to size the order");
      return;
    }
    if (this.dryRun) {
      logger.info({ symbol: score.symbol, notional: entry.notionalUsd, reason: entry.reason }, "DRY RUN would BUY");
      record("skip", `dry run: ${entry.reason}`);
      return;
    }
    try {
      await this.executeBuy(mark.pair, mark.decimals, score, entry.notionalUsd, entry.reason, t);
    } catch (err) {
      if (err instanceof NoRouteError) {
        record("skip", "no Jupiter route at entry time");
        return;
      }
      throw err;
    }
  }

  private async executeBuy(pair: PairSnapshot, decimals: number, score: CompositeScore, notionalUsd: number, reason: string, now: number): Promise<void> {
    const fill = await this.broker.buy(pair, decimals, notionalUsd, now);
    this.ledger.transaction(() => {
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
    });
    logger.info(
      { symbol: pair.symbol, mint: pair.mint, notional: fill.notionalUsd.toFixed(2), price: fill.effectivePriceUsd, score: score.total.toFixed(3) },
      "BUY",
    );
  }

  private async buildContext(
    pair: PairSnapshot,
    extra: { cgRank: number | null; dexRank: number | null; enteredTrending: boolean; description: string | null },
  ): Promise<TokenContext> {
    const now = this.now();
    // GeckoTerminal rate-limits bursts hard, so the two candle series go one after the other.
    const candles = (async () => {
      const c5 = await withTimeout(this.deps.getOhlcv(pair.pairAddress, "minute", 5, 100), 40_000, [] as Candle[], "ohlcv 5m");
      const c1 = await withTimeout(this.deps.getOhlcv(pair.pairAddress, "hour", 1, 48), 40_000, [] as Candle[], "ohlcv 1h");
      return [c5, c1] as const;
    })();
    const [safety, sellability, [candles5m, candles1h]] = await Promise.all([
      withTimeout(this.deps.getSafetyReport(pair.mint), 25_000, null, "rugcheck"),
      withTimeout<SellabilityCheck | null>(this.deps.checkSellability(pair.mint, this.cfg.execution.quoteNotionalUsd), 25_000, null, "sellability"),
      candles,
    ]);
    if (safety) this.safetyCache.set(pair.mint, { report: safety, at: now });

    let llm: { narrativeScore: number; narrativeReason: string; eventScore: number; eventReason: string } | null = null;
    if (this.llm.isEnabled()) {
      // Raw text goes in; the scorer sanitises and refuses flagged input itself.
      llm = await this.llm.assess({
        mint: pair.mint,
        symbol: pair.symbol,
        name: pair.name,
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
    return this.locked(async () => {
      const now = this.now();
      const open = this.ledger.getOpenPositions();
      if (open.length > 0) await this.fetchPrices(open.map((p) => p.mint), new Map(open.map((p) => [p.mint, p.pairAddress])));
      const prices = this.currentPrices();
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
    });
  }
}
