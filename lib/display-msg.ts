/**
 * displayMsg — display-boundary translator for backend-originated error text.
 *
 * Replaces the standalone English word "namespace" with "address" (case-preserving)
 * so backend error messages (which always say "namespace") read "address" to users.
 *
 * Rules:
 * - Matches the standalone word (singular and plural): `(?<![\w-])namespaces?(?![\w-])`.
 *   The lookbehind/lookahead treats `-` as part of a token, so a user slug like
 *   `namespace-1` is NOT touched (would be corrupted by a naive `\bnamespace\b`
 *   because `-` is a JS word boundary).
 * - Case-preserving: `Namespace` → `Address`, `namespace` → `address`,
 *   `Namespaces` → `Addresses`, `namespaces` → `addresses`.
 * - Idempotent: re-applying is a no-op (the result contains "address", not "namespace").
 * - Pure: no side effects, no network deps — safe for bun:test.
 *
 * MUST be called AFTER any logic that branches on the raw message text. In the MCP
 * adapter, apply at the errResponse() chokepoint so lib/* functions stay raw and
 * testable with their original error strings.
 */

// Matches standalone "namespace" or "namespaces" — not preceded or followed by
// a word character or hyphen, so user slugs like `namespace-1` are preserved.
const STANDALONE_NAMESPACE = /(?<![\w-])namespaces?(?![\w-])/gi;

function preserveCase(match: string): string {
  // Determine singular vs plural from the matched string length
  const plural = match.toLowerCase() === "namespaces";
  // Determine case from the first character
  const first = match[0];
  const upper = first === first.toUpperCase() && first !== first.toLowerCase();
  if (plural) {
    return upper ? "Addresses" : "addresses";
  }
  return upper ? "Address" : "address";
}

export function displayMsg(s: string): string {
  return s.replace(STANDALONE_NAMESPACE, preserveCase);
}
