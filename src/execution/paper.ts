/**
 * Paper execution: deterministic fill simulation plus a broker that derives
 * price impact from live Jupiter quotes (injected through `deps`, so tests
 * never touch the network).
 *
 * Buy:  effective = reference * (1 + (impact + extraSlippage) / 100)
 *       feeUsd    = notional * paperFeePct / 100 + priorityFeeUsd
 *       qtyTokens = (notional - feeUsd) / effective
 *       notionalUsd = notional (cash out of the account)
 * Sell: effective = reference * (1 - (impact + extraSlippage) / 100)
 *       gross     = qtyTokens * effective
 *       feeUsd    = gross * paperFeePct / 100 + priorityFeeUsd
 *       notionalUsd = max(0, gross - feeUsd) (cash into the account)
 */
import { WSOL_MINT, type StrategyConfig } from "../core/config.js";
import { logger } from "../core/logger.js";
import type { Fill, JupiterQuote, PairSnapshot, Side } from "../core/types.js";

/** Matches `getQuote` in src/data/jupiter.ts. Defined locally so this module has no runtime dependency on it. */
export type GetQuoteFn = (
  inputMint: string,
  outputMint: string,
  amountRaw: bigint,
  slippageBps?: number,
) => Promise<JupiterQuote | null>;

/** Matches `getSolPriceUsd` in src/data/jupiter.ts. */
export type GetSolPriceUsdFn = () => Promise<number>;

export interface PaperBrokerDeps {
  getQuote: GetQuoteFn;
  getSolPriceUsd: GetSolPriceUsdFn;
}

/** Impact assumed when Jupiter has no route or the quote fails. Percent. */
export const FALLBACK_PRICE_IMPACT_PCT = 2;
/** A sell with no Jupiter route is treated as a near-rug: half the reference price is lost. */
export const NO_ROUTE_SELL_HAIRCUT_PCT = 50;

export class NoRouteError extends Error {
  constructor(mint: string, side: "buy" | "sell") {
    super(`no Jupiter route for ${side} of ${mint}`);
    this.name = "NoRouteError";
  }
}

const SOL_DECIMALS = 9;

export interface SimulateFillArgs {
  side: Side;
  mint: string;
  referencePriceUsd: number;
  qtyTokens?: number;
  notionalUsd?: number;
  /** Percent, e.g. 0.12 for 0.12%. Negative values are treated as 0. */
  priceImpactPct: number;
  exec: StrategyConfig["execution"];
  ts: number;
}

/**
 * Convert a token amount in whole units to the chain's raw integer amount.
 * Uses decimal string arithmetic so e.g. 1.1 * 10^9 does not pick up float noise.
 */
export function toRawAmount(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`toRawAmount: invalid amount ${amount}`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error(`toRawAmount: invalid decimals ${decimals}`);
  }
  const fixed = amount.toFixed(decimals);
  if (fixed.includes("e")) {
    // Astronomically large amount; precision is already gone, fall back to float math.
    return BigInt(Math.round(amount)) * 10n ** BigInt(decimals);
  }
  const [whole = "0", frac = ""] = fixed.split(".");
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

/** Convert a raw integer amount back to whole units as a float. */
export function fromRawAmount(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export function simulateFill(args: SimulateFillArgs): Fill {
  const { side, mint, referencePriceUsd, exec, ts } = args;
  if (!Number.isFinite(referencePriceUsd) || referencePriceUsd <= 0) {
    throw new Error(`simulateFill: referencePriceUsd must be > 0, got ${referencePriceUsd}`);
  }
  const impactPct = Number.isFinite(args.priceImpactPct) ? Math.max(0, args.priceImpactPct) : FALLBACK_PRICE_IMPACT_PCT;
  const slipPct = impactPct + exec.paperExtraSlippagePct;

  if (side === "buy") {
    const notional = args.notionalUsd;
    if (notional === undefined || !Number.isFinite(notional) || notional <= 0) {
      throw new Error(`simulateFill: buy requires notionalUsd > 0, got ${notional}`);
    }
    const effectivePriceUsd = referencePriceUsd * (1 + slipPct / 100);
    const feeUsd = notional * (exec.paperFeePct / 100) + exec.priorityFeeUsd;
    const qtyTokens = Math.max(0, notional - feeUsd) / effectivePriceUsd;
    return {
      side,
      mint,
      qtyTokens,
      effectivePriceUsd,
      referencePriceUsd,
      notionalUsd: notional,
      feeUsd,
      priceImpactPct: impactPct,
      ts,
    };
  }

  const qty = args.qtyTokens;
  if (qty === undefined || !Number.isFinite(qty) || qty <= 0) {
    throw new Error(`simulateFill: sell requires qtyTokens > 0, got ${qty}`);
  }
  const effectivePriceUsd = Math.max(0, referencePriceUsd * (1 - slipPct / 100));
  const gross = qty * effectivePriceUsd;
  const feeUsd = gross * (exec.paperFeePct / 100) + exec.priorityFeeUsd;
  return {
    side,
    mint,
    qtyTokens: qty,
    effectivePriceUsd,
    referencePriceUsd,
    notionalUsd: Math.max(0, gross - feeUsd),
    feeUsd,
    priceImpactPct: impactPct,
    ts,
  };
}

interface QuoteView {
  /** Percent. */
  impactPct: number;
  /** USD per token implied by the quote amounts, null when it cannot be derived. */
  impliedPriceUsd: number | null;
}

export class PaperBroker {
  private readonly exec: StrategyConfig["execution"];

  constructor(
    cfg: StrategyConfig,
    private readonly deps: PaperBrokerDeps,
  ) {
    this.exec = cfg.execution;
  }

  /**
   * Buy `notionalUsd` of the pair's token. Impact comes from a WSOL -> token
   * quote sized at the notional; the fill price is the worse of the DexScreener
   * price and the quote-implied price. `referencePriceUsd` on the fill is
   * always `pair.priceUsd`.
   */
  async buy(pair: PairSnapshot, decimals: number, notionalUsd: number, ts: number): Promise<Fill> {
    assertPair(pair);
    if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
      throw new Error(`PaperBroker.buy: notionalUsd must be > 0, got ${notionalUsd}`);
    }
    let view: QuoteView | null = null;
    try {
      const solPrice = await this.deps.getSolPriceUsd();
      if (Number.isFinite(solPrice) && solPrice > 0) {
        const lamports = toRawAmount(notionalUsd / solPrice, SOL_DECIMALS);
        const quote = await this.deps.getQuote(WSOL_MINT, pair.mint, lamports);
        if (quote) {
          const inSol = fromRawAmount(quote.inAmount > 0n ? quote.inAmount : lamports, SOL_DECIMALS);
          const outTokens = fromRawAmount(quote.outAmount, decimals);
          view = {
            impactPct: quote.priceImpactPct, // JupiterQuote.priceImpactPct is already in percent
            impliedPriceUsd: outTokens > 0 ? (inSol * solPrice) / outTokens : null,
          };
        }
      } else {
        logger.warn({ mint: pair.mint, solPrice }, "paper buy: invalid SOL price, using fallback impact");
      }
    } catch (err) {
      logger.warn({ mint: pair.mint, err }, "paper buy: quote failed, using fallback impact");
    }

    // Buys fail closed: with no route we cannot know the real cost, so we do not pretend to buy.
    if (!view) {
      logger.warn({ mint: pair.mint, symbol: pair.symbol, notionalUsd }, "paper buy: no Jupiter route, rejecting entry");
      throw new NoRouteError(pair.mint, "buy");
    }
    // The quote-implied price already embeds Jupiter's price impact, so when we use it we apply impact 0
    // (the extra slippage and fee still apply) and only record the quoted impact on the fill.
    // Compare like with like: the pair price after quoted impact versus the quote-implied price, take the worse.
    const impacted = pair.priceUsd * (1 + view.impactPct / 100);
    const worst = view.impliedPriceUsd !== null ? Math.max(impacted, view.impliedPriceUsd) : impacted;
    const fill = simulateFill({
      side: "buy",
      mint: pair.mint,
      referencePriceUsd: worst,
      notionalUsd,
      priceImpactPct: 0,
      exec: this.exec,
      ts,
    });
    return { ...fill, referencePriceUsd: pair.priceUsd, priceImpactPct: view.impactPct };
  }

  /**
   * Sell `qtyTokens` of the pair's token. Impact comes from a token -> WSOL
   * quote for the exact amount; the fill price is the worse (lower) of the
   * DexScreener price and the quote-implied price.
   */
  async sell(pair: PairSnapshot, decimals: number, qtyTokens: number, ts: number): Promise<Fill> {
    assertPair(pair);
    if (!Number.isFinite(qtyTokens) || qtyTokens <= 0) {
      throw new Error(`PaperBroker.sell: qtyTokens must be > 0, got ${qtyTokens}`);
    }
    let view: QuoteView | null = null;
    try {
      const raw = toRawAmount(qtyTokens, decimals);
      const [solPrice, quote] = await Promise.all([
        this.deps.getSolPriceUsd(),
        this.deps.getQuote(pair.mint, WSOL_MINT, raw),
      ]);
      if (quote) {
        const inTokens = fromRawAmount(quote.inAmount > 0n ? quote.inAmount : raw, decimals);
        const outSol = fromRawAmount(quote.outAmount, SOL_DECIMALS);
        const solOk = Number.isFinite(solPrice) && solPrice > 0;
        view = {
          impactPct: quote.priceImpactPct, // JupiterQuote.priceImpactPct is already in percent
          impliedPriceUsd: solOk && inTokens > 0 ? (outSol * solPrice) / inTokens : null,
        };
      }
    } catch (err) {
      logger.warn({ mint: pair.mint, err }, "paper sell: quote failed, using fallback impact");
    }

    if (!view) {
      // Sells never fail (you can always dump), but with no route we assume a near-rug and take a heavy haircut.
      logger.warn(
        { mint: pair.mint, symbol: pair.symbol, qtyTokens, haircutPct: NO_ROUTE_SELL_HAIRCUT_PCT },
        "paper sell: no Jupiter route, applying rug haircut",
      );
      const fill = simulateFill({
        side: "sell",
        mint: pair.mint,
        referencePriceUsd: pair.priceUsd,
        qtyTokens,
        priceImpactPct: NO_ROUTE_SELL_HAIRCUT_PCT,
        exec: this.exec,
        ts,
      });
      return { ...fill, referencePriceUsd: pair.priceUsd };
    }
    const impacted = pair.priceUsd * (1 - view.impactPct / 100);
    const worst = view.impliedPriceUsd !== null && view.impliedPriceUsd > 0 ? Math.min(impacted, view.impliedPriceUsd) : impacted;
    const fill = simulateFill({
      side: "sell",
      mint: pair.mint,
      referencePriceUsd: Math.max(worst, 0),
      qtyTokens,
      priceImpactPct: 0,
      exec: this.exec,
      ts,
    });
    return { ...fill, referencePriceUsd: pair.priceUsd, priceImpactPct: view.impactPct };
  }
}

function assertPair(pair: PairSnapshot): void {
  if (!Number.isFinite(pair.priceUsd) || pair.priceUsd <= 0) {
    throw new Error(`PaperBroker: pair ${pair.mint} has invalid priceUsd ${pair.priceUsd}`);
  }
}
