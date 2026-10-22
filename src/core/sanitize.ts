/**
 * Defensive text handling for anything that originated on-chain or from social
 * feeds before it reaches a prompt. Token names and descriptions are attacker
 * controlled. We strip control characters, cap length, and refuse strings that
 * look like instructions. The LLM only ever returns a score; it has no tools.
 */

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (previous|all|prior) instructions/i,
  /new (task|directive|instruction)s?\b/i,
  /system prompt/i,
  /\b(assistant|ai)\s*:\s*/i,
  /send .{0,60} to [1-9A-HJ-NP-Za-km-z]{32,44}/i,
  /transfer .{0,60} to\b/i,
  /approve .{0,60} for\b/i,
  /\bexecute\b.{0,40}\b(swap|trade|buy|sell)\b/i,
];

export interface SanitizeResult {
  text: string;
  flagged: boolean;
  reasons: string[];
}

export function sanitizeUntrustedText(input: string | null | undefined, maxLen = 240): SanitizeResult {
  if (!input) return { text: "", flagged: false, reasons: [] };
  let text = input.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  const reasons: string[] = [];
  for (const p of INJECTION_PATTERNS) {
    if (p.test(text)) reasons.push(`matched ${p.source}`);
  }
  if (text.length > maxLen) text = text.slice(0, maxLen) + "…";
  return { text: reasons.length ? "[redacted: suspicious content]" : text, flagged: reasons.length > 0, reasons };
}

/** Solana base58 address check, 32-44 chars. */
export function isValidMint(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}
