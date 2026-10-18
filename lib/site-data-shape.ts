/**
 * Runtime validation of server bodies against the frozen site data contract
 * (`dataStatusSchema`, `enableResponseSchema`, `disableResponseSchema`,
 * `jwtIssuerResponseSchema` in api.ts; `collectionConfigSchema` in kv.ts;
 * `collectionStatsSchema`, `adminRowSchema`, `adminRowListSchema` in store.ts;
 * the archive/import/wipe/delete-row response schemas in admin.ts).
 *
 * The server is an external input even though we own it: a body that drifts
 * from the contract must fail here, naming the first bad field, rather than
 * surface as `undefined` in text an AI reads. Fields the contract makes
 * optional or nullable are not required; a `null` parent skips its children.
 * Only shapes are checked, not the contract's length/size ceilings.
 */

import { safeText } from "./site-data-text.ts";
import { isValidRowId, JWT_ALGORITHMS } from "./site-data-types.ts";
import type {
  AdminRow, CollectionView, DataStatus, DisableResponse, EnableResponse, ImportResponse, JwtIssuerConfig, RowList, WipeResponse,
} from "./site-data-types.ts";

type Check = (v: unknown) => boolean;
/** `[dotted path, check]` pairs, parents before children. */
type Shape = ReadonlyArray<readonly [path: string, check: Check]>;

const isObj: Check = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isBool: Check = (v) => typeof v === "boolean";
const isStr: Check = (v) => typeof v === "string";
const isArr: Check = (v) => Array.isArray(v);
const intMin = (min: number): Check => (v) => Number.isInteger(v) && (v as number) >= min;
const nullable = (c: Check): Check => (v) => v === null || c(v);
const optionalOf = (c: Check): Check => (v) => v === undefined || c(v);
const oneOf = (...allowed: readonly unknown[]): Check => (v) => allowed.includes(v);
const arrOf = (c: Check): Check => (v) => Array.isArray(v) && v.every(c);

/** Canonical contract timestamp: ISO-8601 UTC with milliseconds (`isoTime` in schema.ts). */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isoTime: Check = (v) => typeof v === "string" && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));

const isClaimMatcher: Check = (v) =>
  isObj(v) &&
  oneOf("passcode", "jwt")((v as { kind: unknown }).kind) &&
  isObj((v as { claims: unknown }).claims) &&
  Object.values((v as { claims: Record<string, unknown> }).claims).every((x) => isStr(x) || isBool(x));

const under = (prefix: string, shape: Shape): Shape => shape.map(([p, c]) => [`${prefix}.${p}`, c] as const);

/** `CollectionConfig`. */
const CONFIG_SHAPE: Shape = [
  ["rule", oneOf("append-only", "own-rows", "inbox", "owner-only")],
  ["sites", arrOf(isStr)],
  ["writers", arrOf(oneOf("anonymous", "passcode", "jwt"))],
  ["per_identity_limit", nullable(intMin(1))],
  ["write_claims", arrOf(isClaimMatcher)],
  ["admin_claims", arrOf(isClaimMatcher)],
  ["max_rows", intMin(1)],
  ["max_row_bytes", intMin(1)],
  ["writes_per_min", intMin(1)],
];

/** `CollectionStats`. */
const STATS_SHAPE: Shape = [
  ["rows", intMin(0)], ["archived_rows", intMin(0)], ["bytes", intMin(0)], ["last_write_at", nullable(isoTime)],
];

const JWT_ISSUER_SHAPE: Shape = [
  ["issuer", isStr], ["jwks_uri", isStr], ["audience", isStr], ["algorithms", arrOf(oneOf(...JWT_ALGORITHMS))],
];

const COLLECTION_STATUS_SHAPE: Shape = [
  ["config", isObj], ...under("config", CONFIG_SHAPE), ["stats", nullable(isObj)], ...under("stats", STATS_SHAPE),
];

const STATUS_SHAPE: Shape = [
  ["available", isBool], ["entitled", isBool], ["entitlement_source", nullable(oneOf("paid", "comped", "admin"))],
  ["activating", isBool],
  ["billing", isObj], ["billing.item_present", isBool], ["billing.interval", nullable(oneOf("month", "year"))],
  ["billing.past_due", isBool], ["billing.enabled_at", nullable(isoTime)], ["billing.disabled_at", nullable(isoTime)],
  ["billing.wipe_after", nullable(isoTime)], ["billing.wiped_at", nullable(isoTime)], ["billing.would_charge", isBool],
  ["price", isObj], ["price.month_cents", nullable(intMin(0))], ["price.year_cents", nullable(intMin(0))],
  ["collections", isObj],
  ["stats_state", oneOf("ok", "unavailable")],
  ["kv", isObj], ["kv.drift", oneOf("none", "missing", "stale", "unknown")], ["kv.checked_at", nullable(isoTime)],
  ["wipe_job", isObj], ["wipe_job.last_run_at", nullable(isoTime)], ["wipe_job.last_result", nullable(oneOf("ok", "error"))],
  ["jwt_issuer", nullable(isObj)], ...under("jwt_issuer", JWT_ISSUER_SHAPE),
];

const COLLECTION_VIEW_SHAPE: Shape = [
  ...CONFIG_SHAPE, ["name", isStr], ["created_at", isoTime], ["updated_at", isoTime],
];

/** Resolves a dotted path; `undefined` when any step is not an object. */
const at = (root: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (isObj(v) ? (v as Record<string, unknown>)[k] : undefined), root);

/** True when a strict ancestor of `path` is an explicit `null` (an allowed absent subtree). */
function underNull(root: unknown, path: string): boolean {
  const keys = path.split(".");
  return keys.slice(0, -1).some((_, i) => at(root, keys.slice(0, i + 1).join(".")) === null);
}

/** The first path in `shape` whose value fails its check, or null when the whole shape holds. */
function firstInvalid(root: unknown, shape: Shape): string | null {
  for (const [path, check] of shape) {
    if (!underNull(root, path) && !check(at(root, path))) return path;
  }
  return null;
}

const invalidBody = (endpoint: string, field: string): Error =>
  new Error(`Unexpected response from the site data ${endpoint} endpoint. Missing or invalid field: ${field}.`);

/**
 * Validates the whole `DataStatus` the formatters and the enable flow read
 * and returns it typed. Names the first bad field.
 */
export function parseDataStatus(raw: unknown): DataStatus {
  if (!isObj(raw)) throw invalidBody("status", "(body)");
  const top = firstInvalid(raw, STATUS_SHAPE);
  if (top !== null) throw invalidBody("status", top);
  for (const [name, entry] of Object.entries((raw as { collections: object }).collections)) {
    const bad = firstInvalid(entry, COLLECTION_STATUS_SHAPE);
    if (bad !== null) throw invalidBody("status", `collections.${safeText(name)}.${bad}`);
  }
  return raw as unknown as DataStatus;
}

/** Validates a `CollectionView` from a `data_collection` response; `where` prefixes the field in errors (e.g. `collections[2]`; empty for a bare body). */
function parseCollectionView(raw: unknown, where: string): CollectionView {
  if (!isObj(raw)) throw invalidBody("collections", where || "(body)");
  const bad = firstInvalid(raw, COLLECTION_VIEW_SHAPE);
  if (bad !== null) throw invalidBody("collections", where ? `${where}.${bad}` : bad);
  return raw as unknown as CollectionView;
}

/** `GET /collections/:name`, `POST /collections`, `PATCH /collections/:name` response. */
export const parseCollectionBody = (raw: unknown): CollectionView => parseCollectionView(raw, "");

/** `GET /collections` response. */
export function parseCollectionList(raw: unknown): CollectionView[] {
  if (!isObj(raw) || !isArr((raw as { collections: unknown }).collections)) throw invalidBody("collections", "collections");
  return (raw as { collections: unknown[] }).collections.map((c, i) => parseCollectionView(c, `collections[${i}]`));
}

// ─── Action responses (enable/disable/jwt/wipe/archive/import/delete) and rows ───

/** Validates `raw` against one flat shape; the body must be an object. */
function parseShape<T>(raw: unknown, endpoint: string, shape: Shape): T {
  if (!isObj(raw)) throw invalidBody(endpoint, "(body)");
  const bad = firstInvalid(raw, shape);
  if (bad !== null) throw invalidBody(endpoint, bad);
  return raw as T;
}

const counts = (...keys: string[]): Shape => keys.map((k) => [k, intMin(0)] as const);

const ENABLE_SHAPE: Shape = [
  ["entitled", oneOf(true)], ["activating", isBool], ["charge", nullable(isObj)],
  ["charge.interval", oneOf("month", "year")], ["charge.price_cents", intMin(0)],
];
const DISABLE_SHAPE: Shape = [["entitled", oneOf(false)], ["wipe_after", isoTime]];
const JWT_RESPONSE_SHAPE: Shape = [["jwt_issuer", nullable(isObj)], ...under("jwt_issuer", JWT_ISSUER_SHAPE)];

const ROW_SHAPE: Shape = [
  ["id", (v) => isStr(v) && isValidRowId(v as string)],
  ["author", isObj],
  ["author.kind", oneOf("anonymous", "passcode", "jwt", "owner")],
  ["author.subject", (v) => isStr(v) && (v as string).length > 0],
  ["author.label", optionalOf(isStr)],
  ["data", isObj], ["created_at", isoTime], ["updated_at", isoTime], ["archived_at", nullable(isoTime)],
];

export const parseEnableResponse = (raw: unknown): EnableResponse => parseShape(raw, "enable", ENABLE_SHAPE);
export const parseDisableResponse = (raw: unknown): DisableResponse => parseShape(raw, "disable", DISABLE_SHAPE);
export const parseJwtIssuerResponse = (raw: unknown): { jwt_issuer: JwtIssuerConfig | null } =>
  parseShape(raw, "jwt-issuer", JWT_RESPONSE_SHAPE);

/** `POST /wipe` and `DELETE /collections/:name` response; `endpoint` names which in errors. */
export const parseWipeResponse = (raw: unknown, endpoint: string): WipeResponse =>
  parseShape(raw, endpoint, counts("collections", "rows"));
export const parseArchiveResponse = (raw: unknown): { archived: number } =>
  parseShape(raw, "archive", counts("archived"));
export const parseImportResponse = (raw: unknown): ImportResponse =>
  parseShape(raw, "import", counts("imported", "skipped"));
export const parseDeleteRowResponse = (raw: unknown): { deleted: true } =>
  parseShape(raw, "delete row", [["deleted", oneOf(true)]]);

/** A single `AdminRow` (create/put response); `where` prefixes the field in errors (empty for a bare body). */
export function parseAdminRow(raw: unknown, where = ""): AdminRow {
  if (!isObj(raw)) throw invalidBody("rows", where || "(body)");
  const bad = firstInvalid(raw, ROW_SHAPE);
  if (bad !== null) throw invalidBody("rows", where ? `${where}.${bad}` : bad);
  return raw as unknown as AdminRow;
}

/** `GET /collections/:name/rows` response. */
export function parseRowList(raw: unknown): RowList {
  const o = raw as Record<string, unknown>;
  if (!isObj(raw)) throw invalidBody("rows", "(body)");
  if (!isArr(o["rows"])) throw invalidBody("rows", "rows");
  if (!nullable(isStr)(o["next_cursor"])) throw invalidBody("rows", "next_cursor");
  (o["rows"] as unknown[]).forEach((r, i) => parseAdminRow(r, `rows[${i}]`));
  return raw as unknown as RowList;
}
