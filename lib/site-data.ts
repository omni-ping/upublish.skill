/**
 * Site data add-on: account-level operations (the `data` and `data_jwt` tools).
 *
 *   data      status | enable | disable | wipe
 *   data_jwt  set | clear   (bring-your-own JWT issuer for visitor identity)
 *
 * Enabling is a paid action, so `enable` never charges on its own, and consent
 * is bound to what the user was shown. Every enable re-reads the status, the
 * plan tier (`GET /api/space`) and the role (`GET /auth/me`), derives an
 * `expected` {tier, would_charge, price_cents, interval, month_cents, year_cents} from them, and only
 * POSTs when the caller passes `accept_charge: true` together with an
 * `expected` equal to the freshly derived one. Anything that changed since the
 * consent was shown (an upgrade, a new interval, a new price) yields a new
 * consent instead of a charge.
 *
 * Every function takes an authenticated ApiClient and a resolved Namespace
 * (core.ts wires both) and throws `SiteDataError` on API failure.
 */

import type { ApiClient } from "./api-client.ts";
import { ApiError } from "./api-client.ts";
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

/**
 * What a user consents to when enabling: the plan tier, whether this enable
 * charges, and the list price at the billing interval. `price_cents` and
 * `interval` are null when nothing is charged (or the interval is unknown).
 * `month_cents` / `year_cents` are ALWAYS the status list prices (null when
 * unpublished), so a change to either price alone invalidates a consent.
 */
export interface EnableExpectation {
  tier: PlanTier;
  would_charge: boolean;
  price_cents: number | null;
  interval: BillingInterval | null;
  month_cents: number | null;
  year_cents: number | null;
}

export type PlanTier = "free" | "pro" | "max";

export interface DataArgs {
  action: "status" | "enable" | "disable" | "wipe";
  /** Address name; defaults to the account's default address. */
  namespace?: string;
  /** enable: explicit user approval of the charge. Honoured only together with a matching `expected`. */
  accept_charge?: boolean;
  /** enable: the `expected` object a previous consent result printed, echoed back unchanged. */
  expected?: EnableExpectation;
  /** wipe: must equal the address name exactly. */
  confirm_namespace?: string;
}

export type DataResult =
  | { action: "status"; available: false }
  | { action: "status"; available: true; namespace: string; status: DataStatus }
  | {
      action: "enable"; state: "consent_needed"; expected: EnableExpectation; price: DataStatus["price"];
      /** True when the caller echoed an `expected` that no longer matches (or asked to accept without one that does). */
      changed: boolean;
      /** The account's role is platform admin: enabling is free. */
      admin: boolean;
    }
  | { action: "enable"; state: "already_enabled" }
  | { action: "enable"; state: "in_progress" }
  | { action: "enable"; state: "needs_paid_plan" }
  | { action: "enable"; state: "expected_missing" }
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

/** Reads the plan tier and role the consent depends on; a failed read refuses the enable (nothing is posted). */
async function readAccount(apiClient: ApiClient): Promise<{ tier: PlanTier; admin: boolean }> {
  const read = async <T>(path: string, what: string): Promise<T> => {
    try {
      return await apiClient.get<T>(path);
    } catch (err) {
      const detail = err instanceof ApiError || err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read ${what} (${path}), so the charge cannot be confirmed. Nothing was charged. ${detail}`);
    }
  };
  const space = await read<{ space?: { tier?: unknown } }>("/api/space", "the account plan");
  const me = await read<{ role?: unknown }>("/auth/me", "the account role");
  const tier = space?.space?.tier;
  if (tier !== "free" && tier !== "pro" && tier !== "max") {
    throw new Error("Could not read the account plan (/api/space): unexpected tier. Nothing was charged.");
  }
  return { tier, admin: me?.role === "admin" };
}

/** The list price at the billing interval, only when this enable charges; null otherwise or when the interval is unknown. */
function expectedFor(status: DataStatus, tier: PlanTier): EnableExpectation {
  const { interval, would_charge } = status.billing;
  const price = interval === "month" ? status.price.month_cents : interval === "year" ? status.price.year_cents : null;
  return { tier, would_charge, price_cents: would_charge ? price : null, interval, month_cents: status.price.month_cents, year_cents: status.price.year_cents };
}

const sameExpectation = (a: EnableExpectation | undefined, b: EnableExpectation): boolean =>
  a !== undefined && a !== null && a.tier === b.tier && a.would_charge === b.would_charge && a.price_cents === b.price_cents && a.interval === b.interval &&
  a.month_cents === b.month_cents && a.year_cents === b.year_cents;

async function enable(apiClient: ApiClient, ns: Namespace, acceptCharge: boolean, given: EnableExpectation | undefined): Promise<DataResult> {
  // Read first: never POST (and so never risk a second charge) when already enabled.
  const status = await getStatus(apiClient, ns);
  if (!status.available) {
    throw new SiteDataError("not_available", 404, "Site data is not available for this account. [not_available]");
  }
  if (status.entitled) return { action: "enable", state: "already_enabled" };
  if (status.billing.item_present) return { action: "enable", state: "in_progress" };

  const { tier, admin } = await readAccount(apiClient);
  // Free accounts cannot buy the add-on; platform admins are exempt (they are not charged).
  if (tier === "free" && !admin) return { action: "enable", state: "needs_paid_plan" };

  const expected = expectedFor(status, tier);
  const consent = (changed: boolean): DataResult => ({ action: "enable", state: "consent_needed", expected, price: status.price, changed, admin });
  if (!acceptCharge) return consent(false);
  if (given === undefined) return { action: "enable", state: "expected_missing" };
  if (!sameExpectation(given, expected)) return consent(true);

  const res = await guard("owner", async () => parseEnableResponse(await apiClient.post<unknown>(`${dataBase(ns.id)}/enable`, { accept_charge: true })), "billing_enable");
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
      return enable(apiClient, ns, args.accept_charge === true, args.expected);
    case "disable": {
      const res = await guard("owner", async () => parseDisableResponse(await apiClient.post<unknown>(`${dataBase(ns.id)}/disable`, {})), "billing_disable");
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
