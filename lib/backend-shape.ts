/**
 * User backends: wire types, limits and validating parsers.
 *
 * Mirrored by hand from the frozen contract (`@upublish/shared/backend`:
 * `api.ts`, `errors.ts`, `limits.ts`, `upload.ts`; docs/backend/contract.md)
 * so the skill repo stays self-contained, like `site-data-types.ts`. The
 * contract fixtures vendored in `tests/fixtures/backend/` are the oracle
 * (`backend-fixtures.test.ts` replays every route and fails on drift).
 *
 * Every server body is external input, even though we own the server: a body
 * that drifts from the contract fails here naming the first bad field, rather
 * than surfacing as `undefined` in text an AI reads. Only shapes are checked,
 * not size ceilings.
 */

import {
  arrOf, firstInvalid, intMin, isBool, isObj, isStr, isoTime, nullable, oneOf, type Check, type Shape,
} from "./site-data-shape.ts";

// ─── Limits (contract section 11) ────────────────────────────────────────────

export const BACKEND_LIMITS = {
  /** Deploy source cap, in UTF-8 bytes of the bundled module. */
  bundleBytes: 1_048_576,
  backendsPerNamespace: 5,
  secretsPerBackend: 64,
  varsPerBackend: 32,
  bindingNameLength: 64,
  /** Cloudflare caps one secret / var at 5 KB. */
  bindingValueBytes: 5_120,
  logLines: 100,
  retentionDays: 30,
  archivedVersionsPerBackend: 10,
} as const;

/** Names allowed for secrets and plain-text vars (`BINDING_NAME_RE` in upload.ts). */
export const BINDING_NAME_RE = new RegExp(`^[A-Za-z_][A-Za-z0-9_]{0,${BACKEND_LIMITS.bindingNameLength - 1}}$`);

export const BACKEND_ACCESS = ["site", "public"] as const;
export type BackendAccess = (typeof BACKEND_ACCESS)[number];
export type BillingInterval = "month" | "year";
export type BackendTier = "pro" | "max";

/** Machine-readable `code` of every REST error body `{ error, code }` (contract section 10, REST + shared rows). */
export type BackendErrorCode =
  | "unauthenticated" | "forbidden" | "not_available" | "not_found" | "invalid_request" | "upgrade_required"
  | "no_subscription" | "consent_required" | "addon_not_enabled" | "backend_limit_exceeded" | "deploy_rate_limited"
  | "bundle_too_large" | "bundle_rejected" | "version_not_found" | "conflict" | "upstream_failed" | "unavailable";

/** Role the failing route requires (contract section 9). */
export type BackendRole = "member" | "admin" | "owner";

// ─── Wire types ──────────────────────────────────────────────────────────────

export interface BackendAddonStatus {
  available: boolean;
  entitled: boolean;
  entitlement_source: "paid" | "comped" | "admin" | null;
  activating: boolean;
  billing: {
    item_present: boolean;
    interval: BillingInterval | null;
    past_due: boolean;
    enabled_at: string | null;
    disabled_at: string | null;
    delete_after: string | null;
    deleted_at: string | null;
    would_charge: boolean;
    converts_data_addon: boolean;
    paused?: boolean;
    /** What a bodyless disable does with Site data: true = keeps it (billed at the Site data price), false = it would answer 409 or there is nothing to keep. Absent = older server. */
    disable_keeps_site_data?: boolean;
  };
  price: { month_cents: number | null; year_cents: number | null };
  includes_site_data: true;
  backends: { count: number; max: number };
}

export interface BackendEnableResponse {
  entitled: true;
  activating: boolean;
  /** `basis`: "invoice" = prorated amount invoiced now, "list_price" = an estimate; `recurring_cents` = the item's price per `interval`. Both absent on an older server. */
  charge: { interval: BillingInterval; price_cents: number; basis?: "invoice" | "list_price"; recurring_cents?: number } | null;
  converted_data_addon: boolean;
}

export interface BackendDisableResponse {
  entitled: false;
  delete_after: string;
  /** Site data survived this disable (no wipe clock). Absent = older server, whose disable deleted it. */
  site_data_kept?: boolean;
}

export interface BackendStatus {
  deployed: boolean;
  site: { id: string; address: string };
  version: number | null;
  access: BackendAccess;
  disabled: boolean;
  tier: BackendTier | null;
  limits: { cpu_ms: number; subrequests: number } | null;
  deployed_at: string | null;
  bundle_bytes: number | null;
  bundle_sha256: string | null;
  vars: string[];
  secrets: string[];
  usage: { period_start: string; calls: number; cap: number } | null;
  kv: { drift: "none" | "missing" | "stale" | "unknown"; checked_at: string | null };
}

export interface DeployResponse {
  version: number;
  deployed_at: string;
  access: BackendAccess;
  bundle_bytes: number;
  bundle_sha256: string;
  warnings: string[];
}

export interface BackendVersion {
  version: number;
  created_at: string;
  bundle_bytes: number;
  bundle_sha256: string;
  access: BackendAccess;
  live: boolean;
}

export interface RollbackResponse { version: number; deployed_at: string }
export interface BackendSecret { name: string; set_at: string }

export type LogLevel = "debug" | "log" | "info" | "warn" | "error";
export interface BackendLogLine {
  timestamp: string;
  level: LogLevel;
  message: string;
  status: number | null;
  outcome: string | null;
}
export interface BackendLogs { lines: BackendLogLine[]; truncated: boolean }

// ─── Shapes ──────────────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
const isName: Check = (v) => isStr(v) && BINDING_NAME_RE.test(v as string);
const isHex64: Check = (v) => isStr(v) && HEX64.test(v as string);
const isAccess: Check = oneOf(...BACKEND_ACCESS);
const optionalBool: Check = (v) => v === undefined || isBool(v);
const version: Check = intMin(1);
/** A check that an object element satisfies a whole shape (for array members). */
const shaped = (shape: Shape): Check => (v) => isObj(v) && firstInvalid(v, shape) === null;

const ADDON_SHAPE: Shape = [
  ["available", isBool], ["entitled", isBool], ["entitlement_source", nullable(oneOf("paid", "comped", "admin"))],
  ["activating", isBool],
  ["billing", isObj], ["billing.item_present", isBool], ["billing.interval", nullable(oneOf("month", "year"))],
  ["billing.past_due", isBool], ["billing.enabled_at", nullable(isoTime)], ["billing.disabled_at", nullable(isoTime)],
  ["billing.delete_after", nullable(isoTime)], ["billing.deleted_at", nullable(isoTime)],
  ["billing.would_charge", isBool], ["billing.converts_data_addon", isBool], ["billing.paused", optionalBool], ["billing.disable_keeps_site_data", optionalBool],
  ["price", isObj], ["price.month_cents", nullable(intMin(0))], ["price.year_cents", nullable(intMin(0))],
  ["includes_site_data", oneOf(true)],
  ["backends", isObj], ["backends.count", intMin(0)], ["backends.max", intMin(1)],
];

const ENABLE_SHAPE: Shape = [
  ["entitled", oneOf(true)], ["activating", isBool], ["converted_data_addon", isBool], ["charge", nullable(isObj)],
  ["charge.interval", oneOf("month", "year")], ["charge.price_cents", intMin(0)],
  ["charge.basis", (v) => v === undefined || v === "invoice" || v === "list_price"], ["charge.recurring_cents", (v) => v === undefined || intMin(0)(v)],
];
const DISABLE_SHAPE: Shape = [["entitled", oneOf(false)], ["delete_after", isoTime], ["site_data_kept", optionalBool]];

const STATUS_SHAPE: Shape = [
  ["deployed", isBool], ["site", isObj], ["site.id", isStr], ["site.address", isStr],
  ["version", nullable(version)], ["access", isAccess], ["disabled", isBool],
  ["tier", nullable(oneOf("pro", "max"))],
  ["limits", nullable(isObj)], ["limits.cpu_ms", intMin(1)], ["limits.subrequests", intMin(1)],
  ["deployed_at", nullable(isoTime)], ["bundle_bytes", nullable(intMin(0))], ["bundle_sha256", nullable(isHex64)],
  ["vars", arrOf(isName)], ["secrets", arrOf(isName)],
  ["usage", nullable(isObj)], ["usage.period_start", isoTime], ["usage.calls", intMin(0)], ["usage.cap", intMin(0)],
  ["kv", isObj], ["kv.drift", oneOf("none", "missing", "stale", "unknown")], ["kv.checked_at", nullable(isoTime)],
];

const DEPLOY_SHAPE: Shape = [
  ["version", version], ["deployed_at", isoTime], ["access", isAccess], ["bundle_bytes", intMin(0)],
  ["bundle_sha256", isHex64], ["warnings", arrOf(isStr)],
];

const VERSION_SHAPE: Shape = [
  ["version", version], ["created_at", isoTime], ["bundle_bytes", intMin(0)], ["bundle_sha256", isHex64],
  ["access", isAccess], ["live", isBool],
];
const VERSIONS_SHAPE: Shape = [["versions", arrOf(shaped(VERSION_SHAPE))]];

const ROLLBACK_SHAPE: Shape = [["version", version], ["deployed_at", isoTime]];
const SECRET_SHAPE: Shape = [["name", isName], ["set_at", isoTime]];
const SECRETS_SHAPE: Shape = [["secrets", arrOf(shaped(SECRET_SHAPE))]];
const DELETE_SHAPE: Shape = [["deleted", oneOf(true)]];
const SECRET_DELETE_SHAPE: Shape = [["deleted", isName]];

const LOG_LINE_SHAPE: Shape = [
  ["timestamp", isoTime], ["level", oneOf("debug", "log", "info", "warn", "error")], ["message", isStr],
  ["status", nullable(intMin(100))], ["outcome", nullable(isStr)],
];
const LOGS_SHAPE: Shape = [["lines", arrOf(shaped(LOG_LINE_SHAPE))], ["truncated", isBool]];

// ─── Parsers ─────────────────────────────────────────────────────────────────

const invalidBody = (endpoint: string, field: string): Error =>
  new Error(`Unexpected response from the backend ${endpoint} endpoint. Missing or invalid field: ${field}.`);

/** Validates `raw` against `shape` and returns it typed; names the first bad field. */
function parseShape<T>(raw: unknown, endpoint: string, shape: Shape): T {
  if (!isObj(raw)) throw invalidBody(endpoint, "(body)");
  const bad = firstInvalid(raw, shape);
  if (bad !== null) throw invalidBody(endpoint, bad);
  return raw as T;
}

export const parseAddonStatus = (raw: unknown): BackendAddonStatus => parseShape(raw, "add-on status", ADDON_SHAPE);
export const parseEnableResponse = (raw: unknown): BackendEnableResponse => parseShape(raw, "enable", ENABLE_SHAPE);
export const parseDisableResponse = (raw: unknown): BackendDisableResponse => parseShape(raw, "disable", DISABLE_SHAPE);
export const parseBackendStatus = (raw: unknown): BackendStatus => parseShape(raw, "status", STATUS_SHAPE);
export const parseDeployResponse = (raw: unknown): DeployResponse => parseShape(raw, "deploy", DEPLOY_SHAPE);
export const parseRollbackResponse = (raw: unknown): RollbackResponse => parseShape(raw, "rollback", ROLLBACK_SHAPE);
export const parseDeleteResponse = (raw: unknown): { deleted: true } => parseShape(raw, "delete", DELETE_SHAPE);
export const parseSecretSet = (raw: unknown): BackendSecret => parseShape(raw, "secret", SECRET_SHAPE);
export const parseSecretDelete = (raw: unknown): { deleted: string } => parseShape(raw, "secret delete", SECRET_DELETE_SHAPE);

export const parseVersionList = (raw: unknown): BackendVersion[] =>
  parseShape<{ versions: BackendVersion[] }>(raw, "versions", VERSIONS_SHAPE).versions;
export const parseSecretList = (raw: unknown): BackendSecret[] =>
  parseShape<{ secrets: BackendSecret[] }>(raw, "secrets", SECRETS_SHAPE).secrets;
export const parseLogs = (raw: unknown): BackendLogs => parseShape(raw, "logs", LOGS_SHAPE);
