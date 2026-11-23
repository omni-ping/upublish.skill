/** Publish error types and the barricade enrichment applied to manifest/finalize failures. */

import { ApiError } from "./api-client.ts";
import { rewriteAnalyticsGate403 } from "./analytics.ts";
import { ACCOUNT_PAST_DUE_CODE, accountPastDueMessage } from "./billing-text.ts";

// ─── Storage pack approval error ──────────────────────────────────────────────

/** Fallback approval URL when the 402 body omits it. */
const STORAGE_APPROVAL_URL_FALLBACK =
  "https://upubli.sh/profile/settings?storage_request=1";

/**
 * Thrown when the API returns 402 `needs_storage_approval`. Carries the
 * structured fields from the backend response so the adapter can surface the
 * approval URL and pack pricing without reformatting the generic error message.
 *
 * `approval_url` is defensively defaulted to the canonical fallback when the
 * backend body is malformed or missing it — the caller always receives a usable
 * approval URL even on a partial/unexpected body.
 *
 * `price`, `block_gb`, `blocks_needed`, and `interval` are nullable: when the
 * body omits them, the adapter renders pack-language copy without hardcoded
 * price literals.
 */
export class StorageApprovalError extends Error {
  constructor(
    public readonly approval_url: string,
    /** USD price for one 10GB storage block, or null when absent from the 402 body. */
    public readonly price: number | null,
    /** Block size in GB (always 10 per contract), or null when absent. */
    public readonly block_gb: number | null,
    /** Number of blocks needed to cover the overage, or null when absent. */
    public readonly blocks_needed: number | null,
    /** Billing interval of the base subscription, or null when unknown/absent. */
    public readonly interval: "month" | "year" | null,
    message: string,
  ) {
    super(message);
    this.name = "StorageApprovalError";
  }
}

/**
 * Enriches API errors at the publish barricade with storage-pack guidance.
 *
 * - 402 `needs_storage_approval`: converts to `StorageApprovalError` carrying
 *   the approval URL, block price, block size, blocks needed, and billing
 *   interval from the body. All fields are defensively narrowed — a malformed
 *   or partial body still produces a usable error with the canonical fallback
 *   URL and pack wording (no hardcoded price literal).
 * - 403 analytics-gate (body.error contains "analytics"): rewrites to a
 *   friendly upgrade message. The body check disambiguates from a
 *   suspended-user 403 (different body) — the gate only fires when
 *   `analyticsEnabled: false` is in the manifest, so ownership 404s are
 *   separate. A suspended-user 403 body does NOT contain "analytics".
 * - All other errors: pass through unchanged — backend text is already
 *   actionable for the adapter.
 */
export function enrichPublishError(err: Error): Error {
  if (err instanceof ApiError && err.status === 402) {
    const body = err.rawBodyData as Record<string, unknown> | null;
    const code = typeof body?.code === "string" ? body.code : "";
    if (code === "needs_storage_approval") {
      const approvalUrl =
        typeof body?.approval_url === "string" && body.approval_url
          ? body.approval_url
          : STORAGE_APPROVAL_URL_FALLBACK;
      // All pack fields are nullable — a missing/malformed body must not
      // produce a hardcoded price literal. The adapter renders pack copy.
      const price =
        typeof body?.price === "number" && isFinite(body.price) ? body.price : null;
      const block_gb =
        typeof body?.block_gb === "number" && Number.isInteger(body.block_gb) && body.block_gb > 0
          ? body.block_gb
          : null;
      const blocks_needed =
        typeof body?.blocks_needed === "number" && Number.isInteger(body.blocks_needed) && body.blocks_needed > 0
          ? body.blocks_needed
          : null;
      const rawInterval = body?.interval;
      const interval: "month" | "year" | null =
        rawInterval === "month" || rawInterval === "year" ? rawInterval : null;
      return new StorageApprovalError(
        approvalUrl,
        price,
        block_gb,
        blocks_needed,
        interval,
        `Storage pack approval required. Approve at ${approvalUrl}`,
      );
    }
    // 402 with an unexpected code — fall through to pass-through below.
  }

  // 403 account_past_due (finalize): the bare body `{ error: "account_past_due" }` carries no `code`.
  if (err instanceof ApiError && err.status === 403) {
    const body = err.rawBodyData as Record<string, unknown> | null;
    if (body?.error === ACCOUNT_PAST_DUE_CODE) return new Error(accountPastDueMessage());
  }

  // 403 analytics-gate: friendly upgrade message (null for e.g. a suspended-user 403).
  const analyticsGate = rewriteAnalyticsGate403(err);
  if (analyticsGate) return analyticsGate;

  return err;
}
