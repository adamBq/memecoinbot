/**
 * SQLite ledger: positions, orders, equity curve, decisions, notes, and meta.
 *
 * Uses the Node 24 built-in `node:sqlite` driver (no native dependency).
 * Timestamps are integer milliseconds, money and quantities are REAL,
 * booleans are stored as 0/1. Migrations run in the constructor and are
 * idempotent (CREATE TABLE IF NOT EXISTS plus a `schema_version` meta key).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import type { Order, Position, Side } from "../core/types.js";

type Row = Record<string, SQLOutputValue>;

export type DecisionAction = "filtered" | "skip" | "enter" | "exit";

export interface DecisionInput {
  ts: number;
  mint: string;
  symbol: string;
  action: DecisionAction;
  total: number;
  lensesJson: string;
  reason: string;
}

export interface DecisionRow {
  ts: number;
  mint: string;
  symbol: string;
  action: string;
  total: number;
  lensesJson: string;
  reason: string;
}

export interface EquityPoint {
  ts: number;
  equityUsd: number;
  cashUsd: number;
}

export type OpenPositionInput = Omit<
  Position,
  "id" | "status" | "closedAt" | "realizedPnlUsd" | "remainingQtyTokens" | "tp1Hit" | "closeReason" | "peakPriceUsd"
>;

/** Ordered list of migrations. Index + 1 is the schema version after applying. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS positions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    mint                 TEXT    NOT NULL,
    symbol               TEXT    NOT NULL,
    pair_address         TEXT    NOT NULL,
    status               TEXT    NOT NULL CHECK (status IN ('open', 'closed')),
    opened_at            INTEGER NOT NULL,
    closed_at            INTEGER,
    entry_price_usd      REAL    NOT NULL,
    entry_liquidity_usd  REAL    NOT NULL,
    qty_tokens           REAL    NOT NULL,
    remaining_qty_tokens REAL    NOT NULL,
    cost_basis_usd       REAL    NOT NULL,
    realized_pnl_usd     REAL    NOT NULL DEFAULT 0,
    peak_price_usd       REAL    NOT NULL,
    tp1_hit              INTEGER NOT NULL DEFAULT 0,
    entry_score          REAL    NOT NULL,
    close_reason         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
  CREATE INDEX IF NOT EXISTS idx_positions_mint   ON positions(mint);

  CREATE TABLE IF NOT EXISTS orders (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id         INTEGER NOT NULL REFERENCES positions(id),
    side                TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
    mint                TEXT    NOT NULL,
    symbol              TEXT    NOT NULL,
    qty_tokens          REAL    NOT NULL,
    effective_price_usd REAL    NOT NULL,
    reference_price_usd REAL    NOT NULL,
    notional_usd        REAL    NOT NULL,
    fee_usd             REAL    NOT NULL,
    price_impact_pct    REAL    NOT NULL,
    reason              TEXT    NOT NULL,
    ts                  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_orders_position_id ON orders(position_id);

  CREATE TABLE IF NOT EXISTS equity_snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    equity_usd REAL    NOT NULL,
    cash_usd   REAL    NOT NULL,
    open_count INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_equity_snapshots_ts ON equity_snapshots(ts);

  CREATE TABLE IF NOT EXISTS decisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    mint        TEXT    NOT NULL,
    symbol      TEXT    NOT NULL,
    action      TEXT    NOT NULL,
    total       REAL    NOT NULL,
    lenses_json TEXT    NOT NULL,
    reason      TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts);

  CREATE TABLE IF NOT EXISTS notes (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    ts   INTEGER NOT NULL,
    text TEXT    NOT NULL
  );
  `,
];

function num(v: SQLOutputValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new Error(`ledger: expected numeric column, got ${typeof v}`);
}

function numOrNull(v: SQLOutputValue): number | null {
  return v === null ? null : num(v);
}

function str(v: SQLOutputValue): string {
  if (typeof v === "string") return v;
  throw new Error(`ledger: expected text column, got ${typeof v}`);
}

function strOrNull(v: SQLOutputValue): string | null {
  return v === null ? null : str(v);
}

function col(row: Row, key: string): SQLOutputValue {
  const v = row[key];
  if (v === undefined) throw new Error(`ledger: missing column ${key}`);
  return v;
}

function rowToPosition(row: Row): Position {
  return {
    id: num(col(row, "id")),
    mint: str(col(row, "mint")),
    symbol: str(col(row, "symbol")),
    pairAddress: str(col(row, "pair_address")),
    status: str(col(row, "status")) as Position["status"],
    openedAt: num(col(row, "opened_at")),
    closedAt: numOrNull(col(row, "closed_at")),
    entryPriceUsd: num(col(row, "entry_price_usd")),
    entryLiquidityUsd: num(col(row, "entry_liquidity_usd")),
    qtyTokens: num(col(row, "qty_tokens")),
    remainingQtyTokens: num(col(row, "remaining_qty_tokens")),
    costBasisUsd: num(col(row, "cost_basis_usd")),
    realizedPnlUsd: num(col(row, "realized_pnl_usd")),
    peakPriceUsd: num(col(row, "peak_price_usd")),
    tp1Hit: num(col(row, "tp1_hit")) !== 0,
    entryScore: num(col(row, "entry_score")),
    closeReason: strOrNull(col(row, "close_reason")),
  };
}

function rowToOrder(row: Row): Order {
  return {
    id: num(col(row, "id")),
    positionId: num(col(row, "position_id")),
    side: str(col(row, "side")) as Side,
    mint: str(col(row, "mint")),
    symbol: str(col(row, "symbol")),
    qtyTokens: num(col(row, "qty_tokens")),
    effectivePriceUsd: num(col(row, "effective_price_usd")),
    referencePriceUsd: num(col(row, "reference_price_usd")),
    notionalUsd: num(col(row, "notional_usd")),
    feeUsd: num(col(row, "fee_usd")),
    priceImpactPct: num(col(row, "price_impact_pct")),
    reason: str(col(row, "reason")),
    ts: num(col(row, "ts")),
  };
}

function rowToDecision(row: Row): DecisionRow {
  return {
    ts: num(col(row, "ts")),
    mint: str(col(row, "mint")),
    symbol: str(col(row, "symbol")),
    action: str(col(row, "action")),
    total: num(col(row, "total")),
    lensesJson: str(col(row, "lenses_json")),
    reason: str(col(row, "reason")),
  };
}

const POSITION_COLUMNS =
  "id, mint, symbol, pair_address, status, opened_at, closed_at, entry_price_usd, entry_liquidity_usd, " +
  "qty_tokens, remaining_qty_tokens, cost_basis_usd, realized_pnl_usd, peak_price_usd, tp1_hit, entry_score, close_reason";

const ORDER_COLUMNS =
  "id, position_id, side, mint, symbol, qty_tokens, effective_price_usd, reference_price_usd, notional_usd, " +
  "fee_usd, price_impact_pct, reason, ts";

export class Ledger {
  private inTx = false;
  private readonly db: DatabaseSync;
  private readonly stmts: {
    getMeta: StatementSync;
    setMeta: StatementSync;
    insertPosition: StatementSync;
    updatePosition: StatementSync;
    closePosition: StatementSync;
    getOpenPositions: StatementSync;
    getClosedPositions: StatementSync;
    getPosition: StatementSync;
    insertOrder: StatementSync;
    getOrder: StatementSync;
    getOrders: StatementSync;
    getOrdersForPosition: StatementSync;
    insertEquity: StatementSync;
    getEquityCurve: StatementSync;
    insertDecision: StatementSync;
    getDecisions: StatementSync;
    lastExitTs: StatementSync;
    insertNote: StatementSync;
    getNotes: StatementSync;
  };

  /** `":memory:"` is allowed for tests. Parent directories of a file path are created. */
  constructor(dbPath: string) {
    if (dbPath !== ":memory:" && dbPath !== "") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true, timeout: 5000 });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();

    this.stmts = {
      getMeta: this.db.prepare("SELECT value FROM meta WHERE key = ?"),
      setMeta: this.db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ),
      insertPosition: this.db.prepare(
        `INSERT INTO positions (mint, symbol, pair_address, status, opened_at, closed_at, entry_price_usd,
           entry_liquidity_usd, qty_tokens, remaining_qty_tokens, cost_basis_usd, realized_pnl_usd,
           peak_price_usd, tp1_hit, entry_score, close_reason)
         VALUES (?, ?, ?, 'open', ?, NULL, ?, ?, ?, ?, ?, 0, ?, 0, ?, NULL)`,
      ),
      updatePosition: this.db.prepare(
        `UPDATE positions SET
           mint = ?, symbol = ?, pair_address = ?, status = ?, opened_at = ?, closed_at = ?,
           entry_price_usd = ?, entry_liquidity_usd = ?, qty_tokens = ?, remaining_qty_tokens = ?,
           cost_basis_usd = ?, realized_pnl_usd = ?, peak_price_usd = ?, tp1_hit = ?, entry_score = ?,
           close_reason = ?
         WHERE id = ?`,
      ),
      closePosition: this.db.prepare(
        "UPDATE positions SET status = 'closed', closed_at = ?, close_reason = ? WHERE id = ?",
      ),
      getOpenPositions: this.db.prepare(
        `SELECT ${POSITION_COLUMNS} FROM positions WHERE status = 'open' ORDER BY opened_at ASC, id ASC`,
      ),
      getClosedPositions: this.db.prepare(
        `SELECT ${POSITION_COLUMNS} FROM positions WHERE status = 'closed'
         ORDER BY closed_at DESC, id DESC LIMIT ?`,
      ),
      getPosition: this.db.prepare(`SELECT ${POSITION_COLUMNS} FROM positions WHERE id = ?`),
      insertOrder: this.db.prepare(
        `INSERT INTO orders (position_id, side, mint, symbol, qty_tokens, effective_price_usd, reference_price_usd,
           notional_usd, fee_usd, price_impact_pct, reason, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getOrder: this.db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`),
      getOrders: this.db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders ORDER BY ts ASC, id ASC`),
      getOrdersForPosition: this.db.prepare(
        `SELECT ${ORDER_COLUMNS} FROM orders WHERE position_id = ? ORDER BY ts ASC, id ASC`,
      ),
      insertEquity: this.db.prepare(
        "INSERT INTO equity_snapshots (ts, equity_usd, cash_usd, open_count) VALUES (?, ?, ?, ?)",
      ),
      getEquityCurve: this.db.prepare(
        "SELECT ts, equity_usd, cash_usd FROM equity_snapshots ORDER BY ts ASC, id ASC",
      ),
      insertDecision: this.db.prepare(
        `INSERT INTO decisions (ts, mint, symbol, action, total, lenses_json, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      getDecisions: this.db.prepare(
        `SELECT ts, mint, symbol, action, total, lenses_json, reason FROM decisions
         WHERE ts >= ? ORDER BY ts DESC, id DESC LIMIT ?`,
      ),
      lastExitTs: this.db.prepare(
        `SELECT MAX(ts) AS ts FROM (
           SELECT closed_at AS ts FROM positions WHERE mint = ? AND status = 'closed' AND closed_at IS NOT NULL
           UNION ALL
           SELECT ts FROM orders WHERE mint = ? AND side = 'sell'
         )`,
      ),
      insertNote: this.db.prepare("INSERT INTO notes (ts, text) VALUES (?, ?)"),
      getNotes: this.db.prepare("SELECT ts, text FROM notes ORDER BY ts ASC, id ASC"),
    };
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const read = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'");
    const write = this.db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const row = read.get();
    const current = row ? Number(str(col(row, "value"))) : 0;
    if (current >= MIGRATIONS.length) return;
    this.db.exec("BEGIN");
    try {
      for (let v = current; v < MIGRATIONS.length; v++) {
        const sql = MIGRATIONS[v];
        if (sql === undefined) throw new Error(`ledger: missing migration ${v + 1}`);
        this.db.exec(sql);
        write.run(String(v + 1));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /** Run several writes atomically. Nested calls just run inline. */
  transaction<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.inTx = true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  // ---- meta ---------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.stmts.getMeta.get(key);
    return row ? str(col(row, "value")) : null;
  }

  setMeta(key: string, value: string): void {
    this.stmts.setMeta.run(key, value);
  }

  // ---- positions ----------------------------------------------------------

  openPosition(input: OpenPositionInput): Position {
    const res = this.stmts.insertPosition.run(
      input.mint,
      input.symbol,
      input.pairAddress,
      input.openedAt,
      input.entryPriceUsd,
      input.entryLiquidityUsd,
      input.qtyTokens,
      input.qtyTokens,
      input.costBasisUsd,
      input.entryPriceUsd,
      input.entryScore,
    );
    const id = Number(res.lastInsertRowid);
    return {
      id,
      mint: input.mint,
      symbol: input.symbol,
      pairAddress: input.pairAddress,
      status: "open",
      openedAt: input.openedAt,
      closedAt: null,
      entryPriceUsd: input.entryPriceUsd,
      entryLiquidityUsd: input.entryLiquidityUsd,
      qtyTokens: input.qtyTokens,
      remainingQtyTokens: input.qtyTokens,
      costBasisUsd: input.costBasisUsd,
      realizedPnlUsd: 0,
      peakPriceUsd: input.entryPriceUsd,
      tp1Hit: false,
      entryScore: input.entryScore,
      closeReason: null,
    };
  }

  /** Ratchets the stored peak price up without touching status or quantities. */
  updatePeakPrice(id: number, peakPriceUsd: number): void {
    this.db.prepare("UPDATE positions SET peak_price_usd = MAX(peak_price_usd, ?) WHERE id = ? AND status = 'open'").run(peakPriceUsd, id);
  }

  /** Writes every field of the position (except id) back to the row. */
  updatePosition(pos: Position): void {
    const res = this.stmts.updatePosition.run(
      pos.mint,
      pos.symbol,
      pos.pairAddress,
      pos.status,
      pos.openedAt,
      pos.closedAt,
      pos.entryPriceUsd,
      pos.entryLiquidityUsd,
      pos.qtyTokens,
      pos.remainingQtyTokens,
      pos.costBasisUsd,
      pos.realizedPnlUsd,
      pos.peakPriceUsd,
      pos.tp1Hit ? 1 : 0,
      pos.entryScore,
      pos.closeReason,
      pos.id,
    );
    if (Number(res.changes) === 0) throw new Error(`ledger: position ${pos.id} not found`);
  }

  /** Marks the position closed. Quantities and PnL are left untouched; use updatePosition for those. */
  closePosition(id: number, closedAt: number, reason: string): void {
    const res = this.stmts.closePosition.run(closedAt, reason, id);
    if (Number(res.changes) === 0) throw new Error(`ledger: position ${id} not found`);
  }

  getOpenPositions(): Position[] {
    return this.stmts.getOpenPositions.all().map(rowToPosition);
  }

  /** Newest (most recently closed) first. */
  getClosedPositions(limit = 100): Position[] {
    return this.stmts.getClosedPositions.all(limit).map(rowToPosition);
  }

  getPosition(id: number): Position | null {
    const row = this.stmts.getPosition.get(id);
    return row ? rowToPosition(row) : null;
  }

  // ---- orders -------------------------------------------------------------

  recordOrder(o: Omit<Order, "id">): Order {
    const res = this.stmts.insertOrder.run(
      o.positionId,
      o.side,
      o.mint,
      o.symbol,
      o.qtyTokens,
      o.effectivePriceUsd,
      o.referencePriceUsd,
      o.notionalUsd,
      o.feeUsd,
      o.priceImpactPct,
      o.reason,
      o.ts,
    );
    return { ...o, id: Number(res.lastInsertRowid) };
  }

  /** Oldest first. With no positionId, every order in the ledger. */
  getOrders(positionId?: number): Order[] {
    const rows =
      positionId === undefined ? this.stmts.getOrders.all() : this.stmts.getOrdersForPosition.all(positionId);
    return rows.map(rowToOrder);
  }

  // ---- equity -------------------------------------------------------------

  snapshotEquity(ts: number, equityUsd: number, cashUsd: number, openCount: number): void {
    this.stmts.insertEquity.run(ts, equityUsd, cashUsd, openCount);
  }

  /** Ascending by ts. */
  getEquityCurve(): EquityPoint[] {
    return this.stmts.getEquityCurve.all().map((row) => ({
      ts: num(col(row, "ts")),
      equityUsd: num(col(row, "equity_usd")),
      cashUsd: num(col(row, "cash_usd")),
    }));
  }

  // ---- decisions ----------------------------------------------------------

  recordDecision(d: DecisionInput): void {
    this.stmts.insertDecision.run(d.ts, d.mint, d.symbol, d.action, d.total, d.lensesJson, d.reason);
  }

  /** Decisions with ts >= sinceTs, newest first, capped at `limit`. */
  getDecisions(sinceTs: number, limit = 500): DecisionRow[] {
    return this.stmts.getDecisions.all(sinceTs, limit).map(rowToDecision);
  }

  /** Latest exit for a mint: the later of its last closed position and last sell order. */
  getLastExitTs(mint: string): number | null {
    const row = this.stmts.lastExitTs.get(mint, mint);
    if (!row) return null;
    return numOrNull(col(row, "ts"));
  }

  // ---- notes --------------------------------------------------------------

  addNote(ts: number, text: string): void {
    this.stmts.insertNote.run(ts, text);
  }

  /** Oldest first. */
  getNotes(): Array<{ ts: number; text: string }> {
    return this.stmts.getNotes.all().map((row) => ({ ts: num(col(row, "ts")), text: str(col(row, "text")) }));
  }
}
