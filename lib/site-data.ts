/**
 * Site data add-on: account-level operations (the `data` and `data_jwt` tools).
 *
 *   data      status | enable | disable | wipe
 *   data_jwt  set | clear   (bring-your-own JWT issuer for visitor identity)
 *
 * Enabling is a paid action, so `enable` never charges on its own: it reads
 * the status first and, without `accept_charge: true`, returns the price for
 * the AI to confirm with the user (or, when the server says this account would
 * not be charged, that fact). The POST still needs an explicit `accept_charge: true`. Every function takes an authenticated
 * ApiClient and a resolved Namespace (core.ts wires both) and throws
 * `SiteDataError` on API failure.
 */

import type { ApiClient } from "./api-client.ts";
import { guard, requireArg, SiteDataError } from "./site-data-errors.ts";
import { loadSiteDirectoryForDisplay, slugifyConfig } from "./site-data-sites.ts";
import type {
  BillingInterval, DataStatus, DisableResponse, EnableResponse, JwtAlgorithm, JwtIssuerConfig, WipeResponse,
} from "./site-data-types.ts";
import type { Namespace } from "./types.ts";

/** Base path of every site-data route for a namespace. */
export const dataBase = (nsId: string): string => `/api/ns/${nsId}/data`;

// ─── Status parser ───────────────────────────────────────────────────────────

type Check = (v: unknown) => boolean;
const isObj: Check = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isBool: Check = (v) => typeof v === "boolean";
const isStr: Check = (v) => typeof v === "string";
const isInt: Check = (v) => Number.isInteger(v);
const isArr: Check = (v) => Array.isArray(v);
const nullable = (c: Check): Check => (v) => v === null || c(v);
const oneOf = (...allowed: unknown[]): Check => (v) => allowed.includes(v);

/** Every field of `DataStatus` that formatters and the enable flow read, parents before children. */
const STATUS_SHAPE: Array<[path: string, check: Check]> = [
  ["available", isBool], ["entitled", isBool], ["entitlement_source", nullable(oneOf("paid", "comped", "admin"))],
  ["activating", isBool],
  ["billing", isObj], ["billing.item_present", isBool], ["billing.interval", nullable(oneOf("month", "year"))],
  ["billing.past_due", isBool], ["billing.enabled_at", nullable(isStr)], ["billing.disabled_at", nullable(isStr)],
  ["billing.wipe_after", nullable(isStr)], ["billing.wiped_at", nullable(isStr)], ["billing.would_charge", isBool],
  ["price", isObj], ["price.month_cents", nullable(isInt)], ["price.year_cents", nullable(isInt)],
  ["collections", isObj],
  ["stats_state", oneOf("ok", "unavailable")],
  ["kv", isObj], ["kv.drift", oneOf("none", "missing", "stale", "unknown")], ["kv.checked_at", nullable(isStr)],
  ["wipe_job", isObj], ["wipe_job.last_run_at", nullable(isStr)], ["wipe_job.last_result", nullable(oneOf("ok", "error"))],
  ["jwt_issuer", nullable(isObj)],
];

/** Per-collection fields read when rendering or resolving site slugs. */
const COLLECTION_SHAPE: Array<[path: string, check: Check]> = [
  ["config", isObj], ["config.rule", isStr], ["config.sites", isArr], ["config.writers", isArr],
  ["config.write_claims", isArr], ["config.admin_claims", isArr], ["stats", nullable(isObj)],
];

const at = (root: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (isObj(v) ? (v as Record<string, unknown>)[k] : undefined), root);

/**
 * Validates the whole `DataStatus` shape that this module and the formatters
 * rely on and returns the body typed. A server that answers with something
 * else (an older/newer contract) fails here, naming the first bad field,
 * instead of producing `undefined` deep in a formatter.
 */
export function parseDataStatus(raw: unknown): DataStatus {
  const bad = (field: string): never => {
    throw new Error(`Unexpected response from the site data status endpoint. Missing or invalid field: ${field}.`);
  };
  if (!isObj(raw)) return bad("(body)");
  for (const [path, check] of STATUS_SHAPE) if (!check(at(raw, path))) bad(path);
  for (const [name, entry] of Object.entries((raw as { collections: object }).collections)) {
    for (const [path, check] of COLLECTION_SHAPE) if (!check(at(entry, path))) bad(`collections.${name}.${path}`);
  }
  return raw as unknown as DataStatus;
}

// ─── Args / results ──────────────────────────────────────────────────────────

export interface DataArgs {
  action: "status" | "enable" | "disable" | "wipe";
  /** Address name; defaults to the account's default address. */
  namespace?: string;
  /** enable: explicit user approval of the charge. */
  accept_charge?: boolean;
  /** wipe: must equal the address name exactly. */
  confirm_namespace?: string;
}

export type DataResult =
  | { action: "status"; available: false }
  | { action: "status"; available: true; namespace: string; status: DataStatus }
  | {
      action: "enable"; state: "consent_needed"; price: DataStatus["price"]; interval: BillingInterval | null;
      /** `billing.would_charge`: false means this account is not charged (e.g. an admin-role owner). */
      wouldCharge: boolean;
    }
  | { action: "enable"; state: "already_enabled" }
  | { action: "enable"; state: "enabled"; activating: boolean; charge: EnableResponse["charge"] }
  | ({ action: "disable" } & DisableResponse)
  | ({ action: "wipe"; namespace: string } & WipeResponse);

export interface DataJwtArgs {
  action: "set" | "clear";
  namespace?: string;
  issuer?: string;
  jwks_uri?: string;
  audience?: string;
  algorithms?: JwtAlgorithm[];
}

export type DataJwtResult = { action: "set" | "clear"; jwt_issuer: JwtIssuerConfig | null };

// ─── Operations ──────────────────────────────────────────────────────────────

/**
 * Fetches status. Collection configs are rendered with site slugs. When the
 * add-on is dark-launched for this account, returns `available: false`.
 */
async function getStatus(apiClient: ApiClient, ns: Namespace): Promise<DataStatus> {
  const status = await guard("member", async () => parseDataStatus(await apiClient.get<unknown>(dataBase(ns.id))));
  if (!status.available || Object.keys(status.collections).length === 0) return status;
  const dir = await loadSiteDirectoryForDisplay(apiClient, ns.id);
  const collections = Object.fromEntries(
    Object.entries(status.collections).map(([name, c]) => [name, { ...c, config: slugifyConfig(dir, c.config) }]),
  );
  return { ...status, collections };
}

async function enable(apiClient: ApiClient, ns: Namespace, acceptCharge: boolean): Promise<DataResult> {
  // Read first: never POST (and so never risk a second charge) when already enabled.
  const status = await getStatus(apiClient, ns);
  if (!status.available) {
    throw new SiteDataError("not_available", 404, "Site data is not available for this account. [not_available]");
  }
  if (status.entitled) return { action: "enable", state: "already_enabled" };
  if (!acceptCharge) {
    return {
      action: "enable", state: "consent_needed", price: status.price,
      interval: status.billing.interval, wouldCharge: status.billing.would_charge,
    };
  }
  const res = await guard("owner", () => apiClient.post<EnableResponse>(`${dataBase(ns.id)}/enable`, { accept_charge: true }));
  return { action: "enable", state: "enabled", activating: res.activating, charge: res.charge };
}

/**
 * Runs one `data` action.
 * @throws SiteDataError on API failure; Error when a required argument is
 *   missing or `confirm_namespace` does not match the address name.
 */
export async function runData(apiClient: ApiClient, ns: Namespace, args: DataArgs): Promise<DataResult> {
  switch (args.action) {
    case "status": {
      const status = await getStatus(apiClient, ns);
      return status.available
        ? { action: "status", available: true, namespace: ns.name, status }
        : { action: "status", available: false };
    }
    case "enable":
      return enable(apiClient, ns, args.accept_charge === true);
    case "disable": {
      const res = await guard("owner", () => apiClient.post<DisableResponse>(`${dataBase(ns.id)}/disable`, {}));
      return { action: "disable", ...res };
    }
    case "wipe": {
      const confirm = requireArg(args.confirm_namespace, "confirm_namespace", "wipe");
      if (confirm !== ns.name) {
        throw new Error(`confirm_namespace '${confirm}' does not match the address name '${ns.name}'. Nothing was deleted.`);
      }
      const res = await guard("owner", () => apiClient.post<WipeResponse>(`${dataBase(ns.id)}/wipe`, { confirm_namespace: confirm }));
      return { action: "wipe", namespace: ns.name, ...res };
    }
  }
}

/**
 * Runs one `data_jwt` action.
 * @throws SiteDataError on API failure (the server validates the issuer: https, asymmetric algorithms, allowed JWKS host).
 */
export async function runDataJwt(apiClient: ApiClient, ns: Namespace, args: DataJwtArgs): Promise<DataJwtResult> {
  const path = `${dataBase(ns.id)}/jwt-issuer`;
  if (args.action === "clear") {
    const res = await guard("owner", () => apiClient.delete<{ jwt_issuer: JwtIssuerConfig | null }>(path));
    return { action: "clear", jwt_issuer: res.jwt_issuer };
  }
  const body: JwtIssuerConfig = {
    issuer: requireArg(args.issuer, "issuer", "set"),
    jwks_uri: requireArg(args.jwks_uri, "jwks_uri", "set"),
    audience: requireArg(args.audience, "audience", "set"),
    algorithms: requireArg(args.algorithms, "algorithms", "set"),
  };
  const res = await guard("owner", () => apiClient.put<{ jwt_issuer: JwtIssuerConfig | null }>(path, body));
  return { action: "set", jwt_issuer: res.jwt_issuer };
}
