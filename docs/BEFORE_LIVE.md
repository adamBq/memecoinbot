# Before this bot may sign real transactions

Output of the security review run on 2026-10-22. This version is paper only; `TRADING_MODE=live`
refuses to start. None of the items below are implemented yet.

1. **Spend policy enforced outside strategy code.** Per-transaction and rolling 24h USD caps, an
   absolute open-notional cap, and a per-token cap, enforced inside the signer process.
2. **Key handling.** A dedicated hot wallet holding only session funds, key loaded from a secret
   manager into a separate signer process that the analysis and LLM code cannot reach. The wallet
   can only swap, never transfer out. `.env` stays mode 0600 and the key is never logged.
3. **Pre-send simulation.** Solana `simulateTransaction` on the real built transaction, mandatory
   `minAmountOut`, program and account allow-list, and rejection of any unexpected instruction
   such as SPL `approve`, `setAuthority`, or a `transfer` to a third party.
4. **Execution safety.** Priority fee caps, short validity window, blockhash expiry handling,
   MEV-protected submission, slippage in bps by liquidity tier, idempotent confirmation tracking,
   and reconciliation of on-chain balances against the ledger.
5. **Breakers that fail closed.** Global halt on stale or missing data, RPC failure, simulation
   failure, or ledger mismatch. Persisted kill switch needing a manual reset. Drawdown computed from
   on-chain balances. Alerting on any halt.
6. **Injection and model containment.** LLM stays score-only with no tools and a capped weight.
   Any flagged injection is a hard reject (already true in paper mode).
7. **Config and audit integrity.** Bounded breaker values with no disable switch in live mode,
   config hash pinned in the ledger (already true), append-only decision log including simulation
   results and transaction signatures.
8. **Arming procedure and canary.** A multi-step arming flow instead of one env flag, a funded
   wallet balance check, a tiny-notional canary phase, fault-injection tests for every breaker,
   pinned SDK versions, and an RPC with failover.
