import { fmtMint } from "../lib/format";

/** Status pill with a coloured dot plus a text label (never colour alone). */
export function Badge({ tone, children }: { tone: "good" | "bad" | "warn" | "neutral"; children: string }) {
  return (
    <span className="badge" data-tone={tone}>
      <span className="dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function ActionBadge({ action }: { action: string }) {
  return (
    <span className="action" data-action={action}>
      {action}
    </span>
  );
}

/** Symbol rendered as text with the mint in the title. Symbols are untrusted. */
export function Symbol({ symbol, mint }: { symbol: string; mint: string }) {
  return (
    <span className="sym" title={mint}>
      {symbol || fmtMint(mint)}
    </span>
  );
}
