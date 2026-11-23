/**
 * Account operations: login, status, logout, namespace creation, domains,
 * upgrade and the admin tools. Re-exported through core.ts.
 */

import * as fs from "node:fs";
import {
  readCredentials,
  defaultCredentialsPath,
  createTokenProvider,
  login as authLogin,
} from "./auth.ts";
import type { LoginDeps, LoginResult } from "./auth.ts";
import { ApiClient, clientHeader } from "./api-client.ts";
import {
  adminUser as domainAdminUser,
  adminSite as domainAdminSite,
  adminStats as domainAdminStats,
  adminStorage as domainAdminStorage,
  adminDomains as domainAdminDomains,
} from "./admin.ts";
import type {
  AdminUserArgs,
  AdminSiteArgs,
  AdminStorageArgs,
  AdminDomainsArgs,
  AdminUserSummary,
  AdminUserInspect,
  AdminStatusResult,
  AdminRoleResult,
  AdminSiteBlockResult,
  AdminStats,
  AdminSweepReport,
  AdminResyncReport,
  AdminDomain,
} from "./admin.ts";
import { namespaceCreate as domainNamespaceCreate } from "./namespace.ts";
import type { NamespaceCreateResult } from "./namespace.ts";
import { domain as domainDomain } from "./domain.ts";
import type { DomainArgs, DomainResult } from "./domain.ts";
import { startUpgrade as domainStartUpgrade } from "./upgrade.ts";
import type { UpgradeArgs, UpgradeResult } from "./upgrade.ts";
import type { FetchFn, Namespace } from "./types.ts";
import { API_BASE_URL, buildApiClient } from "./core-deps.ts";
import type { CoreDeps } from "./core-deps.ts";

export type StatusResult =
  | { authenticated: true; username: string; namespaces: Namespace[] }
  | { authenticated: false; error?: string };

export type LogoutResult =
  | { loggedOut: true }
  | { loggedOut: false; error: string };

// ─── Admin operations ─────────────────────────────────────────────────────────

/**
 * Dispatches user admin operations (lookup/inspect/role/suspend/ban/reinstate).
 * Requires admin role on the authenticated user — non-admin callers receive 403.
 * Throws "Not authenticated" if no credentials are stored.
 *
 * @param args - Discriminated union of user admin arguments.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function adminUser(
  args: AdminUserArgs,
  deps?: CoreDeps,
): Promise<AdminUserSummary | AdminUserInspect | AdminStatusResult | AdminRoleResult> {
  const apiClient = await buildApiClient(deps);
  return domainAdminUser(apiClient, args);
}

/**
 * Dispatches site admin operations (block/unblock).
 * Requires admin role on the authenticated user — non-admin callers receive 403.
 * Throws "Not authenticated" if no credentials are stored.
 *
 * @param args - Discriminated union of site admin arguments.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function adminSite(
  args: AdminSiteArgs,
  deps?: CoreDeps,
): Promise<AdminSiteBlockResult> {
  const apiClient = await buildApiClient(deps);
  return domainAdminSite(apiClient, args);
}

/**
 * Fetches platform-wide statistics.
 * Requires admin role on the authenticated user — non-admin callers receive 403.
 * Throws "Not authenticated" if no credentials are stored.
 *
 * @param deps - Optional CoreDeps for test injection.
 */
export async function adminStats(deps?: CoreDeps): Promise<AdminStats> {
  const apiClient = await buildApiClient(deps);
  return domainAdminStats(apiClient);
}

/**
 * Dispatches storage admin operations (sweep/resync).
 * sweep defaults to dryRun=true. Pass dryRun=false explicitly for live runs.
 * Requires admin role on the authenticated user — non-admin callers receive 403.
 * Throws "Not authenticated" if no credentials are stored.
 *
 * @param args - Discriminated union of storage admin arguments.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function adminStorage(
  args: AdminStorageArgs,
  deps?: CoreDeps,
): Promise<AdminSweepReport | AdminResyncReport> {
  const apiClient = await buildApiClient(deps);
  return domainAdminStorage(apiClient, args);
}

/**
 * Dispatches domain admin operations (list/add/remove).
 * Requires admin role on the authenticated user — non-admin callers receive 403.
 * Throws "Not authenticated" if no credentials are stored.
 *
 * @param args - Discriminated union of domain admin arguments.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function adminDomains(
  args: AdminDomainsArgs,
  deps?: CoreDeps,
): Promise<AdminDomain[] | AdminDomain | { ok: true }> {
  const apiClient = await buildApiClient(deps);
  return domainAdminDomains(apiClient, args);
}

/**
 * Creates a new root namespace and returns its id + domain.
 *
 * When `domain` is omitted the namespace is created on the hosted platform
 * domain (`upubli.sh`). Tier-limit, taken, and invalid-name failures surface as
 * thrown Errors with actionable messages (the tier-limit case names the upgrade
 * path), which adapters render directly.
 *
 * @param name - The namespace name to create.
 * @param domain - Optional hosted/custom domain; defaults to the platform domain.
 * @param deps - Optional CoreDeps for test injection.
 * @throws Error "Not authenticated" if no credentials are stored.
 * @throws Error with an actionable message on any API failure.
 */
export async function namespaceCreate(
  name: string,
  domain?: string,
  deps?: CoreDeps,
): Promise<NamespaceCreateResult> {
  const apiClient = await buildApiClient(deps);
  return domainNamespaceCreate(apiClient, name, domain);
}

/**
 * Connect/check/list/remove a custom domain (pro/max).
 *
 * Wraps the space-level /api/domains endpoints — these are NOT namespace-scoped,
 * so no namespace is resolved here (mirrors adminDomains). Errors surface as
 * thrown Errors with friendly, actionable messages the adapter renders directly.
 *
 * @param args - Discriminated union of domain arguments (add/status/list/remove).
 * @param deps - Optional CoreDeps for test injection.
 * @throws Error "Not authenticated" if no credentials are stored.
 * @throws Error with a friendly message on API failure.
 */
export async function domain(
  args: DomainArgs,
  deps?: CoreDeps,
): Promise<DomainResult> {
  const apiClient = await buildApiClient(deps);
  return domainDomain(apiClient, args);
}

/**
 * Opens the Stripe Checkout page for a chosen plan in the user's browser.
 *
 * Builds the authenticated api client (so "Not authenticated" surfaces exactly
 * as it does for every other operation), then delegates to the pure
 * `startUpgrade` orchestrator. The adapter supplies `openBrowser` (the `open`
 * package). Returns a structured result — never throws for expected failures.
 *
 * @param openBrowser - Opens a URL in the default browser (adapter-injected).
 * @param args - Optional `{ plan, interval }`; defaults to pro/month.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function upgrade(
  openBrowser: (url: string) => Promise<void>,
  args?: UpgradeArgs,
  deps?: CoreDeps,
): Promise<UpgradeResult> {
  // Building the client throws "Not authenticated" on the disk path when no
  // credentials exist. Convert it to a structured error so upgrade() upholds
  // the no-throw-for-expected-failures contract (matching startUpgrade).
  let apiClient: ApiClient;
  try {
    apiClient = await buildApiClient(deps);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return domainStartUpgrade({ apiClient, openBrowser }, args);
}

/**
 * Runs the interactive OAuth login flow and stores credentials.
 * The loginDeps bag provides OAuth plumbing (browser, callback server, logger).
 * The optional coreDeps.credentialsPath overrides the default credentials path.
 */
export async function login(
  loginDeps: LoginDeps,
  coreDeps?: CoreDeps,
): Promise<LoginResult> {
  // Thread CoreDeps overrides into the login bag: credentialsPath redirects
  // where the refresh token is written; fetchFn (tests) drives the token
  // exchange. An explicit loginDeps.fetchFn still wins if both are set.
  const resolvedDeps: LoginDeps = {
    ...loginDeps,
    ...(coreDeps?.credentialsPath ? { credentialsFilePath: coreDeps.credentialsPath } : {}),
    fetchFn: loginDeps.fetchFn ?? coreDeps?.fetchFn,
    clientVersion: loginDeps.clientVersion ?? coreDeps?.clientVersion,
  };

  return authLogin(resolvedDeps);
}

/**
 * Checks authentication state against the API.
 * Unlike other operations, status() never throws — it returns
 * { authenticated: false } when credentials are absent or invalid.
 */
export async function status(deps?: CoreDeps): Promise<StatusResult> {
  let apiClient: ApiClient;
  if (deps?.tokenProvider) {
    // Injected provider (hosted use): report the CALLER's identity and never touch
    // the host's credentials file. buildApiClient fails closed on an empty bearer.
    apiClient = await buildApiClient(deps);
  } else {
    const credFile = deps?.credentialsPath ?? defaultCredentialsPath();
    const refreshToken = await readCredentials(credFile);

    if (!refreshToken) {
      return { authenticated: false };
    }

    const fetchFn: FetchFn | undefined = deps?.fetchFn;
    const tokenProvider = createTokenProvider({
      refreshToken,
      apiBaseUrl: API_BASE_URL,
      fetchFn,
      clientVersion: deps?.clientVersion,
    });
    apiClient = new ApiClient(API_BASE_URL, tokenProvider, fetchFn ?? fetch, deps?.clientVersion);
  }

  try {
    const result = await apiClient.get<{ username: string }>("/auth/me");

    // Fetch namespaces — graceful degradation if the call fails
    let namespaces: Namespace[] = [];
    try {
      const nsResult = await apiClient.get<{ namespaces: Namespace[] }>("/api/ns");
      namespaces = nsResult.namespaces ?? [];
    } catch {
      // Namespace fetch failed — return authenticated with empty namespaces
    }

    return { authenticated: true, username: result.username, namespaces };
  } catch (err) {
    return { authenticated: false, error: (err as Error).message };
  }
}

/**
 * Logs out the current user: revokes the refresh token server-side (best-effort)
 * and deletes the local credentials file.
 *
 * - If no credentials file exists, returns { loggedOut: true } immediately (no-op).
 * - Server revocation is best-effort: network failures are silently ignored so
 *   the user can log out while offline.
 * - If the credentials file cannot be deleted, returns { loggedOut: false, error }.
 * - Never throws for expected failures — always returns a structured result.
 */
export async function logout(deps?: CoreDeps): Promise<LogoutResult> {
  const credFile = deps?.credentialsPath ?? defaultCredentialsPath();
  const fetchFn: FetchFn = deps?.fetchFn ?? ((url, init) => fetch(url, init));

  // Read credentials — if none exist, already logged out
  let refreshToken: string | null;
  try {
    refreshToken = await readCredentials(credFile);
  } catch (err) {
    return { loggedOut: false, error: (err as Error).message };
  }

  if (!refreshToken) {
    return { loggedOut: true };
  }

  // Best-effort revoke — ignore all errors (offline logout must still succeed)
  try {
    await fetchFn(`${API_BASE_URL}/auth/token/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...clientHeader(deps?.clientVersion),
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    // Silently ignore network errors — best-effort revoke
  }

  // Delete local credentials file
  try {
    fs.unlinkSync(credFile);
  } catch (err) {
    return { loggedOut: false, error: (err as Error).message };
  }

  return { loggedOut: true };
}
