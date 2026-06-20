/**
 * Upgrade module for upublish — opens the Stripe Checkout page for a chosen plan.
 *
 * `startUpgrade()` POSTs `{ plan, interval }` to the backend checkout endpoint
 * (which resolves the Stripe price ID server-side — the skill never hardcodes
 * price IDs), then opens the returned Stripe URL in the browser, mirroring the
 * `login` tool. Stripe card entry is browser-only by design (PCI); this tool
 * only opens the page — it cannot complete payment.
 *
 * No throwing for expected failures: like the other lib/ modules, it returns a
 * structured discriminated result. The URL is captured BEFORE the browser is
 * opened so a failed `openBrowser` (headless / no DISPLAY) still returns the URL
 * for the user to open manually.
 *
 * Side-effectful operations (the api client, the browser opener) are injected
 * for testability — the same hexagonal deps-bag pattern as `login`.
 */

import { ApiError } from "./api-client.ts";

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Plans the checkout endpoint accepts. Validated client-side before any call. */
const VALID_PLANS = ["pro", "max"] as const;
/** Billing intervals the checkout endpoint accepts. */
const VALID_INTERVALS = ["month", "year"] as const;

const DEFAULT_PLAN: Plan = "pro";
const DEFAULT_INTERVAL: Interval = "month";

/** One-line hint appended to free-tier tier-limit walls so agents can act. */
export const UPGRADE_HINT =
  "To lift this limit, run the `upgrade` tool to open the checkout page in your browser.";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type Plan = (typeof VALID_PLANS)[number];
export type Interval = (typeof VALID_INTERVALS)[number];

/** Arguments accepted by startUpgrade — both optional, defaulted pro/month. */
export interface UpgradeArgs {
  plan?: string;
  interval?: string;
}

/**
 * Minimal api-client surface startUpgrade needs. Narrowed to `post` so tests
 * inject a tiny stub and the lib never depends on the full client shape.
 */
export interface UpgradeApiClient {
  post<T>(path: string, body: unknown): Promise<T>;
}

export interface UpgradeDeps {
  /** Authenticated api client (built by the core wrapper). */
  apiClient: UpgradeApiClient;
  /** Opens a URL in the default browser. May reject in headless environments. */
  openBrowser(url: string): Promise<void>;
}

/**
 * Structured upgrade result — no throw for expected failures.
 *
 * On `ok:false`, `url` is present only when checkout succeeded but the browser
 * could not be opened (so the caller can still surface the manual-open URL).
 */
export type UpgradeResult =
  | { ok: true; url: string }
  | { ok: false; error: string; url?: string };

interface CheckoutResponse {
  url: string;
  sessionId?: string;
}

// ─── Validation ────────────────────────────────────────────────────────────────

function isValidPlan(v: string): v is Plan {
  return (VALID_PLANS as readonly string[]).includes(v);
}

function isValidInterval(v: string): v is Interval {
  return (VALID_INTERVALS as readonly string[]).includes(v);
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Starts an upgrade: validate args, create a checkout session, open the URL.
 *
 * 1. Validate `plan`/`interval` at the entry barricade BEFORE any API call —
 *    absent args default to pro/month; a present-but-invalid value is rejected,
 *    never coerced (financial input is validated client-side, not just server-
 *    side). Returns a structured error with NO network call on invalid input.
 * 2. POST `{ plan, interval }` to `/api/billing/checkout`. The backend resolves
 *    the Stripe price ID and returns `{ url, sessionId }`. Auth failures and
 *    400s (e.g. already-subscribed) surface as the api client's message verbatim.
 * 3. Capture the URL, then open the browser. A rejected `openBrowser` still
 *    returns the URL (ok:false + url) so headless envs can open it manually.
 *
 * @returns `{ ok:true, url }` on success, or a structured `{ ok:false, error }`
 *   (with `url` when the browser failed to open after a successful checkout).
 */
export async function startUpgrade(
  deps: UpgradeDeps,
  args: UpgradeArgs = {},
): Promise<UpgradeResult> {
  // ── 1. Validate at the barricade (DW-2.5) — before any API call. ──
  const plan = args.plan ?? DEFAULT_PLAN;
  if (!isValidPlan(plan)) {
    return {
      ok: false,
      error: `Invalid plan '${plan}'. Choose one of: ${VALID_PLANS.join(", ")}.`,
    };
  }

  const interval = args.interval ?? DEFAULT_INTERVAL;
  if (!isValidInterval(interval)) {
    return {
      ok: false,
      error: `Invalid interval '${interval}'. Choose one of: ${VALID_INTERVALS.join(", ")}.`,
    };
  }

  // ── 2. Create the checkout session. ──
  let url: string;
  try {
    const res = await deps.apiClient.post<CheckoutResponse>(
      "/api/billing/checkout",
      { plan, interval },
    );
    if (!res || typeof res.url !== "string" || res.url.length === 0) {
      return { ok: false, error: "Checkout did not return a URL. Please try again." };
    }
    url = res.url;
  } catch (err) {
    // Expected failures (not authenticated, 400 already-subscribed, etc.) —
    // surface the api client's existing message verbatim, never throw.
    return { ok: false, error: (err as Error).message };
  }

  // ── 3. Open the browser. URL is already captured, so a rejection here still
  //       returns the URL for manual opening (DW-2.3). No unhandled rejection. ──
  try {
    await deps.openBrowser(url);
  } catch {
    return { ok: false, url, error: "Could not open a browser automatically." };
  }

  return { ok: true, url };
}

// ─── Tier-limit 403 discriminator + hint ───────────────────────────────────────

/**
 * True iff `err` is a free-tier TIER-LIMIT 403 — the only 403 an upgrade can lift.
 *
 * Verified discriminator: a tier-limit 403 body carries `limit` + `usage` and
 * has NO `code` field (backend file-size at namespace-sites.ts:745, free-tier
 * storage at :813). The 1 TiB ceiling carries `{ code: "hard_max" }` (an upgrade
 * can't lift it). Admin/auth 403s carry no `limit`/`usage`. Both are excluded.
 */
export function isFreeTierLimit403(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 403) return false;
  const body = err.rawBodyData;
  if (body === null || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  // A `code` field (e.g. "hard_max") means this is NOT a liftable tier limit.
  if ("code" in b && b.code !== undefined && b.code !== null) return false;
  return b.limit !== undefined && b.usage !== undefined;
}

/**
 * Appends the run-`upgrade` hint to a message when the error is a free-tier
 * tier-limit 403; otherwise returns the message unchanged. Centralizes the
 * discriminator + copy so publish and namespace_create stay consistent.
 */
export function appendUpgradeHint(message: string, err: unknown): string {
  return isFreeTierLimit403(err) ? `${message} ${UPGRADE_HINT}` : message;
}
