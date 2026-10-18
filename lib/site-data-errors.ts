/**
 * Error mapping for the site data add-on.
 *
 * Every server REST failure arrives as an `ApiError` whose parsed body is
 * `{ error, code }` (contract section 6). `guard()` wraps a call and rethrows
 * it as a `SiteDataError`: the server's own text, its machine-readable `code`,
 * and one sentence telling the AI what to do next. Non-API errors (network,
 * "Not authenticated") pass through untouched; they are already actionable.
 */

import { ApiError } from "./api-client.ts";
import { hasControlChars, safeText, sanitizeOutput } from "./site-data-text.ts";
import type { ApiRole, SiteDataErrorCode } from "./site-data-types.ts";

/** An actionable site-data failure. `code` is null when the body carried none. */
export class SiteDataError extends Error {
  constructor(
    public readonly code: SiteDataErrorCode | null,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SiteDataError";
  }
}

const NOT_AVAILABLE_TEXT = "Site data is not available for this account.";

/** What to do next, per code. `role` is what the failing route requires. */
function hintFor(code: SiteDataErrorCode, role: ApiRole): string | undefined {
  switch (code) {
    case "unauthenticated":
      return "Sign in with the login tool, then retry.";
    case "not_found":
      return "The address was not found, or you are not a member of it. Check the address name you passed.";
    case "forbidden":
      return `This needs the ${role} role on the address${role === "admin" ? " (owner or admin member)" : ""}.`;
    case "not_available":
      return NOT_AVAILABLE_TEXT;
    case "upgrade_required":
      return "Site data needs a Pro or Max plan. Use the upgrade tool, then retry.";
    case "no_subscription":
      return "The add-on bills through a Stripe subscription and this account has none (complimentary plan). Subscribe to a paid plan with the upgrade tool first.";
    case "consent_required":
      return "The charge was not approved. Confirm the price with the user, then retry with accept_charge: true.";
    case "addon_not_enabled":
      return "Enable site data first: data action 'enable'.";
    case "collection_not_found":
      return "List the existing collections with data_collection action 'list'.";
    case "collection_exists":
      return "A collection with that name already exists; use data_collection action 'set' to change it.";
    case "limit_exceeded":
      return "The address is at its collection limit (20). Delete an unused collection first.";
    case "collection_full":
      return "The collection reached max_rows. Archive or delete rows, or raise max_rows with data_collection action 'set'.";
    case "row_too_large":
      return "The row exceeds the collection's max_row_bytes. Send less data or raise max_row_bytes.";
    case "admin_channel_failed":
      return "The data service could not be reached. This is temporary: retry shortly.";
    default:
      return undefined;
  }
}

/** Converts an ApiError carrying a `{ error, code }` body into a SiteDataError; anything else is returned as-is. */
export function toSiteDataError(err: unknown, role: ApiRole): unknown {
  if (!(err instanceof ApiError)) return err;
  const body = err.rawBodyData as { error?: unknown; code?: unknown } | null;
  const code = typeof body?.code === "string" ? (body.code as SiteDataErrorCode) : null;
  if (code === null) {
    // Unstructured (e.g. a gateway 5xx): keep the original error unless its text could forge a line.
    return hasControlChars(err.message) ? new SiteDataError(null, err.status, safeText(err.message)) : err;
  }
  const text = code === "not_available" ? NOT_AVAILABLE_TEXT : typeof body?.error === "string" ? safeText(body.error) : "";
  const hint = hintFor(code, role);
  const parts = [text, `[${safeText(code)}]`, hint === text ? undefined : hint].filter(Boolean);
  return new SiteDataError(code, err.status, parts.join(" "));
}

/**
 * Returns `value` when the caller supplied it, else throws naming the action
 * that needs it. Tools take flat optional arguments; this is where the
 * per-action "required when" rule lives instead of in each adapter.
 */
export function requireArg<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined) throw new Error(`${name} is required when action is '${action}'`);
  return value;
}

/** Runs `fn`, translating site-data API failures for the route's required `role`. */
export async function guard<T>(role: ApiRole, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toSiteDataError(err, role);
  }
}

/**
 * Error boundary for the public site-data entry points. Whatever a lib
 * routine throws (server text, a visitor-supplied key echoed in a message, an
 * argument echoed back) leaves with every control character except `\n`
 * escaped, so error text can never forge a line. The error object is kept
 * (class, status, code); only its message is cleaned.
 */
export async function sanitizeErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof Error)) throw new Error(sanitizeOutput(String(err)));
    err.message = sanitizeOutput(err.message);
    throw err;
  }
}
