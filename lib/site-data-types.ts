/**
 * Wire types for the site data add-on (server REST `/api/ns/:nsId/data/*`).
 *
 * Mirrored by hand from the frozen contract (`@upublish/shared/site-data`,
 * backend commit 45f6dd0: `api.ts`, `kv.ts`, `store.ts`, `errors.ts`,
 * `limits.ts`, `identity.ts`) so the skill repo stays self-contained, the same
 * way `lib/types.ts` mirrors `@upublish/shared`. Types and constants only; no
 * behavior beyond the pure name validators. If the contract changes, refresh
 * `tests/fixtures/site-data/` and update this file together.
 */

import { safeText } from "./site-data-text.ts";

// ─── Limits (contract section 10) ─────────────────────────────────────────────

export const SITE_DATA_LIMITS = {
  maxCollectionsPerNamespace: 20,
  maxCollectionNameLength: 40,
  maxSitesPerCollection: 20,
  maxClaimMatchers: 4,
  maxClaimKeyLength: 64,
  maxClaimsPerMatcher: 4,
  maxRowsCeiling: 100_000,
  maxRowBytesCeiling: 65_536,
  writesPerMinCeiling: 600,
  maxRowIdLength: 128,
  maxPageSize: 100,
  maxImportRowsPerCall: 500,
  wipeRetentionDays: 30,
} as const;

// ─── Names ────────────────────────────────────────────────────────────────────

const COLLECTION_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ROW_ID_RE = /^[A-Za-z0-9._~-]+$/;

/** Collection names: lowercase alphanumerics and hyphens, 1..40 chars, never start with `_`. */
export const isValidCollectionName = (s: string): boolean =>
  s.length >= 1 && s.length <= SITE_DATA_LIMITS.maxCollectionNameLength && COLLECTION_NAME_RE.test(s);

/** Throws the one user-facing error for a bad collection name; returns the name when valid. */
export function assertCollectionName(name: string): string {
  if (!isValidCollectionName(name)) {
    throw new Error(`Invalid collection name '${safeText(name)}': use 1-${SITE_DATA_LIMITS.maxCollectionNameLength} lowercase letters, digits and hyphens (no leading/trailing hyphen).`);
  }
  return name;
}

/** Row ids: URL-unreserved characters, 1..128 chars, not `.` or `..`. */
export const isValidRowId = (s: string): boolean =>
  s.length >= 1 && s.length <= SITE_DATA_LIMITS.maxRowIdLength && ROW_ID_RE.test(s) && s !== "." && s !== "..";

// ─── Error codes (contract section 6) ─────────────────────────────────────────

/** Machine-readable `code` in every error body `{ error, code }`. */
export type SiteDataErrorCode =
  | "invalid_request" | "invalid_token" | "forbidden" | "csrf_blocked" | "data_unavailable"
  | "not_found" | "method_not_allowed" | "exists" | "identity_limit_reached" | "collection_full"
  | "site_moved" | "row_too_large" | "rate_limited" | "overloaded" | "data_plane_disabled"
  | "unavailable" | "bad_signature" | "stale_timestamp" | "replayed_nonce" | "unauthenticated"
  | "not_available" | "upgrade_required" | "no_subscription" | "consent_required"
  | "addon_not_enabled" | "collection_exists" | "collection_not_found" | "limit_exceeded"
  | "admin_channel_failed";

/** Role the server requires for a route (contract section 8). */
export type ApiRole = "member" | "admin" | "owner";

// ─── Collection config ────────────────────────────────────────────────────────

export type RulePreset = "append-only" | "own-rows" | "inbox" | "owner-only";
export type WriterKind = "anonymous" | "passcode" | "jwt";

/** Matches visitor identities of one kind whose claims equal ALL listed values (OR across matchers). */
export interface ClaimMatcher {
  kind: "passcode" | "jwt";
  /** Passcode matchers must include `site` (a site id that is in the collection's `sites`). */
  claims: Record<string, string | boolean>;
}

export interface CollectionConfig {
  rule: RulePreset;
  /** `site_id`s (the server never sees slugs). */
  sites: string[];
  writers: WriterKind[];
  per_identity_limit: number | null;
  write_claims: ClaimMatcher[];
  admin_claims: ClaimMatcher[];
  max_rows: number;
  max_row_bytes: number;
  writes_per_min: number;
}

/** `POST /collections` body: `rule`, `sites`, `writers` required; the rest defaulted by the server. */
export interface CollectionInput extends Pick<CollectionConfig, "rule" | "sites" | "writers"> {
  name: string;
  per_identity_limit?: number | null;
  write_claims?: ClaimMatcher[];
  admin_claims?: ClaimMatcher[];
  max_rows?: number;
  max_row_bytes?: number;
  writes_per_min?: number;
}

/** `PATCH /collections/:name` body: any subset of the mutable fields (not the name). */
export type CollectionPatch = Partial<Omit<CollectionInput, "name">>;

/** A collection as the server returns it. */
export interface CollectionView extends CollectionConfig {
  name: string;
  created_at: string;
  updated_at: string;
}

// ─── Status / enable / disable ────────────────────────────────────────────────

export type BillingInterval = "month" | "year";

export interface CollectionStats {
  rows: number;
  archived_rows: number;
  bytes: number;
  last_write_at: string | null;
}

export interface JwtIssuerConfig {
  issuer: string;
  jwks_uri: string;
  audience: string;
  algorithms: JwtAlgorithm[];
}

/** Asymmetric algorithms only (HS* and `none` are never accepted). */
export const JWT_ALGORITHMS = [
  "RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA",
] as const;
export type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number];

export interface DataStatus {
  /** Dark launch gate: false means hide the feature entirely. */
  available: boolean;
  entitled: boolean;
  entitlement_source: "paid" | "comped" | "admin" | null;
  /** True while the entitlement may not have propagated to the edge yet (up to ~60 s). */
  activating: boolean;
  billing: {
    item_present: boolean;
    interval: BillingInterval | null;
    past_due: boolean;
    enabled_at: string | null;
    disabled_at: string | null;
    wipe_after: string | null;
    wiped_at: string | null;
    /** Enabling now would add a paid Stripe item (paid Pro/Max owner, not yet entitled). false for admin-role owners and already-entitled spaces. */
    would_charge: boolean;
  };
  price: { month_cents: number | null; year_cents: number | null };
  collections: Record<string, { config: CollectionConfig; stats: CollectionStats | null }>;
  stats_state: "ok" | "unavailable";
  kv: { drift: "none" | "missing" | "stale" | "unknown"; checked_at: string | null };
  wipe_job: { last_run_at: string | null; last_result: "ok" | "error" | null };
  jwt_issuer: JwtIssuerConfig | null;
}

export interface EnableResponse {
  entitled: true;
  activating: boolean;
  /** What was charged now (prorated); null when comped/admin. */
  charge: { interval: BillingInterval; price_cents: number } | null;
}

export interface DisableResponse {
  entitled: false;
  /** Data is kept until this time, then wiped by a daily job. */
  wipe_after: string;
}

export interface WipeResponse { collections: number; rows: number }

// ─── Rows ─────────────────────────────────────────────────────────────────────

export type JsonObject = Record<string, unknown>;

export interface RowAuthor {
  kind: "anonymous" | "passcode" | "jwt" | "owner";
  subject: string;
  label?: string;
}

/** A stored row as the owner/admin sees it. */
export interface AdminRow {
  id: string;
  author: RowAuthor;
  data: JsonObject;
  created_at: string;
  updated_at: string;
  /** null = active. */
  archived_at: string | null;
}

export interface RowList { rows: AdminRow[]; next_cursor: string | null }

/** Row for the import route: explicit author and timestamps. */
export interface ImportRow {
  id: string;
  author: RowAuthor;
  data: JsonObject;
  created_at: string;
  updated_at?: string;
  archived_at?: string | null;
}

export interface ImportResponse { imported: number; skipped: number }
