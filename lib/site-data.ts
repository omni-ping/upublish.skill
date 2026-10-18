/**
 * Site data add-on: account-level operations (the `data` and `data_jwt` tools).
 *
 *   data      status | enable | disable | wipe
 *   data_jwt  set | clear   (bring-your-own JWT issuer for visitor identity)
 *
 * Enabling is a paid action, so `enable` never charges on its own. It reads
 * the status first and, without `accept_charge: true`, returns the price for
 * the AI to confirm with the user (or, when the server says this account would
 * not be charged, that fact). The POST still needs an explicit
 * `accept_charge: true`.
 *
 * Every function takes an authenticated ApiClient and a resolved Namespace
 * (core.ts wires both) and throws `SiteDataError` on API failure.
 */

import type { ApiClient } from "./api-client.ts";
import { guard, requireArg, SiteDataError } from "./site-data-errors.ts";
import { parseDataStatus, parseDisableResponse, parseEnableResponse, parseJwtIssuerResponse, parseWipeResponse } from "./site-data-shape.ts";
import { safeText } from "./site-data-text.ts";
import { loadSiteDirectoryForDisplay, slugifyConfig } from "./site-data-sites.ts";
import type {
  BillingInterval, DataStatus, DisableResponse, EnableResponse, JwtAlgorithm, JwtIssuerConfig, WipeResponse,
} from "./site-data-types.ts";
import type { Namespace } from "./types.ts";

/** Re-exported: the status parser lives in site-data-shape.ts with the other contract validators. */
export { parseDataStatus };

/** Base path of every site-data route for a namespace. */
export const dataBase = (nsId: string): string => `/api/ns/${nsId}/data`;

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
  const res = await guard("owner", async () => parseEnableResponse(await apiClient.post<unknown>(`${dataBase(ns.id)}/enable`, { accept_charge: true })), "billing");
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
      const res = await guard("owner", async () => parseDisableResponse(await apiClient.post<unknown>(`${dataBase(ns.id)}/disable`, {})), "billing");
      return { action: "disable", ...res };
    }
    case "wipe": {
      const confirm = requireArg(args.confirm_namespace, "confirm_namespace", "wipe");
      if (confirm !== ns.name) {
        throw new Error(`confirm_namespace '${safeText(confirm)}' does not match the address name '${safeText(ns.name)}'. Nothing was deleted.`);
      }
      const res = await guard("owner", async () => parseWipeResponse(await apiClient.post<unknown>(`${dataBase(ns.id)}/wipe`, { confirm_namespace: confirm }), "wipe"));
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
    const res = await guard("owner", async () => parseJwtIssuerResponse(await apiClient.delete<unknown>(path)));
    return { action: "clear", jwt_issuer: res.jwt_issuer };
  }
  const body: JwtIssuerConfig = {
    issuer: requireArg(args.issuer, "issuer", "set"),
    jwks_uri: requireArg(args.jwks_uri, "jwks_uri", "set"),
    audience: requireArg(args.audience, "audience", "set"),
    algorithms: requireArg(args.algorithms, "algorithms", "set"),
  };
  const res = await guard("owner", async () => parseJwtIssuerResponse(await apiClient.put<unknown>(path, body)));
  return { action: "set", jwt_issuer: res.jwt_issuer };
}
