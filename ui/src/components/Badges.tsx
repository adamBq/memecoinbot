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

/** Symbol plus a short monospace mint, with the full mint available as hidden text. Both are untrusted strings. */
export function Symbol({ symbol, mint }: { symbol: string | null | undefined; mint: string | null | undefined }) {
  const sym = typeof symbol === "string" && symbol.trim() !== "" ? symbol : "(no symbol)";
  const m = typeof mint === "string" ? mint : "";
  return (
    <span className="sym-cell">
      <span className="sym">{sym}</span>
      {m ? (
        <>
          {" "}
          <code className="mint-short" aria-hidden="true">{fmtMint(m)}</code>
          <span className="visually-hidden"> mint {m}</span>
        </>
      ) : null}
    </span>
  );
}
