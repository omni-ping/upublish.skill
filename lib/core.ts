/**
 * Core module — all user-facing operations with internal credential/API wiring.
 *
 * Each function reads credentials fresh from disk on every call (no module-level
 * cache), creates a token provider and ApiClient, then delegates to the domain
 * function. Callers never construct ApiClient or read credentials directly.
 *
 * Exports:
 *   list()      — fetch all published sites
 *   publish()   — package and upload a directory
 *   deleteOp()  — delete a site by slug
 *   login()     — run the OAuth flow and store credentials
 *   status()    — check authentication state against the API
 *   logout()    — revoke refresh token server-side and delete local credentials
 *
 * All functions accept an optional CoreDeps for test injection:
 *   credentialsPath  — override credentials file location
 *   fetchFn          — override HTTP fetch (avoids real network calls in tests)
 */

import * as fs from "node:fs";
import {
  readCredentials,
  defaultCredentialsPath,
  createTokenProvider,
  login as authLogin,
} from "./auth.ts";
import type { LoginDeps, LoginResult } from "./auth.ts";

import { ApiClient } from "./api-client.ts";
import { listSites } from "./list.ts";
import type { ListResult } from "./list.ts";
import { publish as domainPublish } from "./publish.ts";
import type { PublishResult } from "./publish.ts";
import { deleteSite } from "./delete.ts";
import type { DeleteResult } from "./delete.ts";
import { resolveNamespace } from "./namespace.ts";
import type { FetchFn, Visibility } from "./types.ts";

// ─── Re-exports for adapters ──────────────────────────────────────────────────

// Adapters import only from core.ts — re-export types they need so they
// don't have to reach into lib/auth.ts or other submodules.
export type { LoginDeps, LoginResult };
export type { PublishResult };
export type { ListResult };
export type { DeleteResult };
export type { Visibility };
export type { Site } from "./types.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const API_BASE_URL = process.env.UPUBLISH_API_URL ?? "https://api.upubli.sh";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Optional overrides for test injection. All fields are optional. */
export interface CoreDeps {
  /** Path to credentials file. Defaults to ~/.upublish/credentials. */
  credentialsPath?: string;
  /** HTTP fetch function. Defaults to global fetch. */
  fetchFn?: FetchFn;
}

export interface PublishArgs {
  /** Path to the directory to publish. */
  directory: string;
  /** URL-safe slug for the site. */
  slug: string;
  /** Optional human-readable title. Defaults to slug. */
  title?: string;
  /** Site visibility mode. */
  visibility?: Visibility;
  /** Passcode for passcode-protected sites. */
  passcode?: string;
  /**
   * Optional namespace name to publish into. When omitted, the default
   * namespace is resolved from GET /api/space.
   */
  namespace?: string;
}

export type StatusResult =
  | { authenticated: true; username: string }
  | { authenticated: false; error?: string };

export type LogoutResult =
  | { loggedOut: true }
  | { loggedOut: false; error: string };

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Reads credentials from disk and builds an authenticated ApiClient.
 * Throws "Not authenticated" if no credentials file exists or is empty.
 */
async function buildApiClient(deps?: CoreDeps): Promise<ApiClient> {
  const credFile = deps?.credentialsPath ?? defaultCredentialsPath();
  const refreshToken = await readCredentials(credFile);

  if (!refreshToken) {
    throw new Error("Not authenticated. Run `upublish login` to sign in.");
  }

  const fetchFn: FetchFn | undefined = deps?.fetchFn;

  const tokenProvider = createTokenProvider({
    refreshToken,
    apiBaseUrl: API_BASE_URL,
    fetchFn,
  });

  return new ApiClient(API_BASE_URL, tokenProvider, fetchFn ?? fetch);
}

// ─── Core operations ──────────────────────────────────────────────────────────

/**
 * Fetches all published sites in the default (or named) namespace.
 * Throws "Not authenticated" if no credentials are stored.
 *
 * @param namespaceName - Optional namespace name. Defaults to the user's default namespace.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function list(namespaceName?: string, deps?: CoreDeps): Promise<ListResult> {
  const apiClient = await buildApiClient(deps);
  const nsId = await resolveNamespace(apiClient, namespaceName);
  return listSites(apiClient, nsId);
}

/**
 * Packages a directory into a zip and uploads it to upubli.sh.
 * Throws "Not authenticated" if no credentials are stored.
 * Throws on validation failure (bad directory, invalid slug, empty dir).
 */
export async function publish(
  args: PublishArgs,
  deps?: CoreDeps,
): Promise<PublishResult> {
  const apiClient = await buildApiClient(deps);
  const nsId = await resolveNamespace(apiClient, args.namespace);
  return domainPublish({
    apiClient,
    nsId,
    directory: args.directory,
    slug: args.slug,
    title: args.title,
    visibility: args.visibility,
    passcode: args.passcode,
  });
}

/**
 * Deletes a published site by slug within the default (or named) namespace.
 * Throws "Not authenticated" if no credentials are stored.
 *
 * @param slug - The URL-safe identifier of the site to delete.
 * @param namespaceName - Optional namespace name. Defaults to the user's default namespace.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function deleteOp(
  slug: string,
  namespaceName?: string,
  deps?: CoreDeps,
): Promise<DeleteResult> {
  const apiClient = await buildApiClient(deps);
  const nsId = await resolveNamespace(apiClient, namespaceName);
  return deleteSite(apiClient, nsId, slug);
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
  // Apply credentialsPath override from CoreDeps if provided
  const resolvedDeps: LoginDeps = coreDeps?.credentialsPath
    ? { ...loginDeps, credentialsFilePath: coreDeps.credentialsPath }
    : loginDeps;

  return authLogin(resolvedDeps);
}

/**
 * Checks authentication state against the API.
 * Unlike other operations, status() never throws — it returns
 * { authenticated: false } when credentials are absent or invalid.
 */
export async function status(deps?: CoreDeps): Promise<StatusResult> {
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
  });

  const apiClient = new ApiClient(API_BASE_URL, tokenProvider, fetchFn ?? fetch);

  try {
    const result = await apiClient.get<{ username: string }>("/auth/me");
    return { authenticated: true, username: result.username };
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
