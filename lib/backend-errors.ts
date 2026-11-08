/**
 * Error mapping for the user-backends tools.
 *
 * Every server REST failure arrives as an `ApiError` whose parsed body is
 * `{ error, code }` (contract section 10). `guard()` wraps a call and rethrows
 * it as a `BackendError`: the server's own text, its machine-readable `code`,
 * and one sentence telling the AI what to do next. Outside a secret call,
 * non-API errors (network, "Not authenticated") pass through untouched; they
 * are already actionable.
 *
 * Secret values. `withRedaction(values, fn)` wraps a whole secret operation:
 * EVERY error that escapes it (API error, JSON parse error, TypeError, network
 * error, anything) leaves as a fresh error whose message has the value removed,
 * with no `cause` and no original stack. Guaranteed: the raw value, the trimmed
 * value, each line / tab segment (trimmed or not, at least MIN_SEGMENT long),
 * and the JSON-escaped, control-escaped and `\uXXXX`-escaped (lower and upper
 * hex) spellings of those. NOT guaranteed: deliberate re-encodings (base64, URL
 * encoding, HTML entities, hashes) that a hostile server could choose to send.
 * A JSON syntax error is replaced by a fixed sentence, because the parser quotes
 * the start of the body it choked on.
 */

import { ApiError } from "./api-client.ts";
import { hasControlChars, safeText } from "./site-data-text.ts";
import { BACKEND_LIMITS, type BackendErrorCode, type BackendRole } from "./backend-shape.ts";

/** An actionable backend failure. `code` is null when the body carried none. */
export class BackendError extends Error {
  constructor(
    public readonly code: BackendErrorCode | null,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

const NOT_AVAILABLE_TEXT = "The Backend add-on is not available for this account.";

/** Which action a failure came from: `unavailable` and `conflict` mean different things for add-on billing. */
export type BackendErrorContext = "billing_enable" | "billing_disable";

/** What to do next, per code. `role` is what the failing route requires. */
function hintFor(code: BackendErrorCode, role: BackendRole, context?: BackendErrorContext): string | undefined {
  const L = BACKEND_LIMITS;
  switch (code) {
    case "unauthenticated":
      return "Sign in with the login tool, then retry.";
    case "not_found":
      return "The address, site or item was not found, or you are not a member of the address. Check the names you passed; the site must already be published.";
    case "forbidden":
      return `This needs the ${role} role on the address${role === "admin" ? " (owner or admin member)" : ""}.`;
    case "not_available":
      return NOT_AVAILABLE_TEXT;
    case "upgrade_required":
      return "Backends need a Pro or Max plan. Use the upgrade tool, then retry.";
    case "no_subscription":
      return "The add-on bills through a Stripe subscription and this account has none (complimentary plan). Subscribe to a paid plan with the upgrade tool first.";
    case "consent_required":
      return "The charge was not approved. Run `backend` action 'addon_enable' WITHOUT accept_charge to get the current consent, confirm it with the user, then pass accept_charge: true with the printed expected.";
    case "addon_not_enabled":
      return "Enable the Backend add-on first: `backend` action 'addon_status', then 'addon_enable'.";
    case "backend_limit_exceeded":
      return `Limits: ${L.backendsPerNamespace} backends per address, ${L.secretsPerBackend} secrets and ${L.varsPerBackend} vars per backend. Remove an unused one first.`;
    case "deploy_rate_limited":
      return "Deploys and rollbacks are limited per address per hour. Wait a while, then retry.";
    case "bundle_too_large":
      return `The bundled module is over ${L.bundleBytes} bytes. Remove large dependencies or split work off the backend.`;
    case "bundle_rejected":
      return "The bundle must be ONE ES module with a default export (an object with a fetch handler) and must not use Node built-ins.";
    case "version_not_found":
      return `List versions with \`backend\` action 'versions'. Only the ${L.archivedVersionsPerBackend} most recent archived versions are kept.`;
    case "conflict":
      if (context === "billing_disable") {
        return "Site data can't be kept right now, so NOTHING was changed (Backend is still on). Ask the user: wait and retry to keep Site data, or end BOTH Backend and Site data (its rows are deleted after 30 days) by calling `backend` action 'addon_disable' with keep_site_data: false.";
      }
      return context === "billing_enable"
        ? "The subscription is managed by a subscription schedule, so nothing was changed. Change the plan in the Stripe billing portal first."
        : "Another change is in flight or the state moved. Check `backend` action 'status', then retry.";
    case "upstream_failed":
      return "Cloudflare rejected or failed the request. The previous version stays live. Retry shortly.";
    case "unavailable":
      if (context === "billing_enable") {
        return "Billing is temporarily unavailable; the change may not have taken effect. Check `backend` action 'addon_status'. If the add-on is still not enabled, run 'addon_enable' again WITHOUT accept_charge to get a fresh consent. It will not charge again if the add-on is already on.";
      }
      return context === "billing_disable"
        ? "Billing is temporarily unavailable; the change may not have taken effect. Check `backend` action 'addon_status', then retry."
        : "The service had a temporary failure. Retry shortly.";
    default:
      return undefined;
  }
}

/** Pieces of a multi-line secret shorter than this are not redacted on their own (they would mangle ordinary text). */
const MIN_SEGMENT = 4;

/**
 * Every encoding of `v` a server might echo: {raw, JSON body, quoted JSON string, control-escaped} crossed with
 * {non-ASCII left as is, `\uXXXX` lower hex, `\uXXXX` upper hex}. The cross product matters: Python's
 * `json.dumps(ensure_ascii=True)` emits BOTH the JSON escapes (`\"`, `\\`) and `\uXXXX` in one string.
 */
function escapedForms(v: string): string[] {
  const asciiLower = (s: string) => s.replace(/[^\u0000-\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const asciiUpper = (s: string) => asciiLower(s).replace(/\\u([0-9a-f]{4})/g, (_, h: string) => `\\u${h.toUpperCase()}`);
  const bases = [v, JSON.stringify(v).slice(1, -1), JSON.stringify(v), safeText(v)];
  return bases.flatMap((b) => [b, asciiLower(b), asciiUpper(b)]);
}

/**
 * Every spelling of a secret that must never appear: the whole value, each line / tab-separated segment of at
 * least MIN_SEGMENT characters (a partial echo of a PEM key), and the JSON-escaped and control-escaped forms of
 * all of those. Longest first, so a whole value is replaced before its own pieces.
 */
function secretForms(values: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const v of values) {
    if (v === "") continue;
    const segments = v.split(/\r\n|[\r\n\t\u2028\u2029\u0085]/);
    const parts = [v, v.trim(), ...segments, ...segments.map((seg) => seg.trim())].filter((x) => x.length >= MIN_SEGMENT || x === v);
    for (const part of parts) {
      forms.add(part);
      for (const e of escapedForms(part)) if (e !== "") forms.add(e);
    }
  }
  return [...forms].sort((x, y) => y.length - x.length);
}

/** Removes every spelling of each secret value from `text`. */
export function redactValues(text: string, values: readonly string[]): string {
  return secretForms(values).reduce((acc, f) => acc.split(f).join("[redacted]"), text);
}

/**
 * Converts an ApiError carrying a `{ error, code }` body into a BackendError; anything else is returned as-is.
 * Order matters: server strings are redacted RAW first (before `safeText` rewrites newlines and tabs into
 * different characters a redaction would then miss), and the finished message is redacted once more.
 */
export function toBackendError(err: unknown, role: BackendRole, context?: BackendErrorContext, redact: readonly string[] = []): unknown {
  if (!(err instanceof ApiError)) return err;
  const body = err.rawBodyData as { error?: unknown; code?: unknown } | null;
  const rawCode = typeof body?.code === "string" ? redactValues(body.code, redact) : null;
  if (rawCode === null) {
    // Unstructured (e.g. a gateway 5xx): keep the original error unless its text could forge a line or carry a secret.
    const clean = redactValues(err.message, redact);
    return hasControlChars(err.message) || clean !== err.message ? new BackendError(null, err.status, redactValues(safeText(clean), redact)) : err;
  }
  // A code that had to be redacted was never a real code: report it as unknown rather than echoing it.
  const code = rawCode === body!.code ? (rawCode as BackendErrorCode) : null;
  const text = code === "not_available" ? NOT_AVAILABLE_TEXT : typeof body?.error === "string" ? safeText(redactValues(body.error, redact)) : "";
  const hint = code === null ? undefined : hintFor(code, role, context);
  const parts = [text, code === null ? "" : `[${safeText(code)}]`, hint === text ? undefined : hint].filter(Boolean);
  return new BackendError(code, err.status, redactValues(parts.join(" "), redact));
}

/** Runs `fn`, translating backend API failures for the route's required `role`. */
export async function guard<T>(
  role: BackendRole,
  fn: () => Promise<T>,
  opts: { context?: BackendErrorContext; redact?: readonly string[] } = {},
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toBackendError(err, role, opts.context, opts.redact);
  }
}

/**
 * Runs a whole secret operation. Whatever escapes it is rebuilt with its message redacted against `values`:
 * a BackendError keeps its code and status, a JSON syntax error becomes a fixed sentence, anything else keeps
 * only its (redacted) message. The original error, its `cause` and its stack are dropped.
 */
export async function withRedaction<T>(values: readonly string[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BackendError) throw new BackendError(err.code, err.status, redactValues(err.message, values));
    if (err instanceof SyntaxError) throw new Error("The server's reply was not valid JSON. The secret may or may not have been saved; check with list.");
    throw new Error(redactValues(safeText(err instanceof Error ? err.message : err), values));
  }
}
