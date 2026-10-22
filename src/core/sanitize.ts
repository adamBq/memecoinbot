/**
 * Defensive text handling for anything that originated on-chain or from social
 * feeds before it reaches a prompt, a log line, or the ledger. Token names and
 * descriptions are attacker controlled. We normalise (NFKC), strip control and
 * format characters (zero-width, bidi), escape delimiters, cap length, and flag
 * strings that look like instructions. The LLM only ever returns a score; it has
 * no tools. These patterns are telemetry and a tripwire, not a security boundary.
 */

const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b.{0,30}\b(previous|prior|above|all|earlier|these|your)\b.{0,30}\b(instruction|prompt|rule|direction)s?\b/i,
  /\bnew (task|directive|instruction|role)s?\b/i,
  /\bsystem prompt\b/i,
  /\byou are now\b/i,
  /\b(assistant|ai|claude|model)\s*:\s*/i,
  /\brespond (with|only)\b/i,
  /\b(rate|score|output|return)\b.{0,20}\b(1\.0|100%|maximum|highest)\b/i,
  /send .{0,60} to [1-9A-HJ-NP-Za-km-z]{32,44}/i,
  /\btransfer .{0,60} to\b/i,
  /\bapprove .{0,60} for\b/i,
  /\bexecute\b.{0,40}\b(swap|trade|buy|sell)\b/i,
  /<\/?\s*(token_data|system|instructions?|tool)\b/i,
];

export interface SanitizeResult {
  text: string;
  flagged: boolean;
  reasons: string[];
}

export function sanitizeUntrustedText(input: string | null | undefined, maxLen = 240): SanitizeResult {
  if (!input) return { text: "", flagged: false, reasons: [] };
  let text = String(input).normalize("NFKC");
  // Strip control chars (Cc), format chars (Cf: zero-width, bidi overrides, soft hyphen), and collapse whitespace.
  text = text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  const reasons: string[] = [];
  for (const p of INJECTION_PATTERNS) {
    if (p.test(text)) reasons.push(`matched ${p.source.slice(0, 40)}`);
  }
  // Escape delimiter characters so a name can never close or open a prompt block.
  text = text.replace(/</g, "﹤").replace(/>/g, "﹥").replace(/[`|]/g, "'");
  if (text.length > maxLen) text = text.slice(0, maxLen) + "…";
  return { text: reasons.length ? "[redacted: suspicious content]" : text, flagged: reasons.length > 0, reasons };
}

/** Solana base58 address check, 32-44 chars. */
export function isValidMint(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}
