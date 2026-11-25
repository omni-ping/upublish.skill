/**
 * Shared wiring for the core-*.ts operation files: the CoreDeps injection bag,
 * the API base URL, and the two client builders every operation starts from.
 * core-*.ts files import from here, never from core.ts (core.ts is the barrel).
 */

import {
  readCredentials,
  defaultCredentialsPath,
  createTokenProvider,
} from "./auth.ts";
import { ApiClient } from "./api-client.ts";
import { resolveNamespace } from "./namespace.ts";
import type { FetchFn, Namespace, TokenProvider } from "./types.ts";

export const API_BASE_URL = process.env.UPUBLISH_API_URL ?? "https://api.upubli.sh";

/** Optional overrides for test injection. All fields are optional. */
export interface CoreDeps {
  /** Path to credentials file. Defaults to ~/.upublish/credentials. */
  credentialsPath?: string;
  /** HTTP fetch function. Defaults to global fetch. */
  fetchFn?: FetchFn;
  /**
   * Injected token provider (tests / a future host).
   *
   * When supplied, this provider is used AS-IS instead of the disk-backed
   * refresh flow — the caller supplies a
   * closure that returns the validated per-request bearer token.
   *
   * Invoked on every API call (no caching) so per-request injection holds.
   * Takes precedence over credentialsPath when both are given.
   *
   * When omitted, the stdio/disk default path is used unchanged.
   */
  tokenProvider?: TokenProvider;
  /**
   * Client build version. When set, every request to API_BASE_URL (ApiClient,
   * token refresh/exchange, logout revoke) carries
   * `X-Upublish-Client: upublish-mcp/<clientVersion>`. When absent, no header
   * is sent (no default). Never applied to presigned R2 uploads or GitHub.
   */
  clientVersion?: string;
}

/**
 * Builds an authenticated ApiClient.
 *
 * Two paths:
 *
 * 1. Injected provider (tests / a future host): when `deps.tokenProvider` is
 *    supplied, it is used directly — no credential file is read. The caller
 *    is responsible for supplying a provider that returns a valid bearer on
 *    every invocation. Takes precedence over `credentialsPath`.
 *
 * 2. Disk-backed default (stdio/CLI use): reads a refresh token from the
 *    credentials file and creates a refresh-backed TokenProvider. Throws
 *    "Not authenticated" if no credentials file exists or is empty.
 */
export async function buildApiClient(deps?: CoreDeps): Promise<ApiClient> {
  const fetchFn: FetchFn | undefined = deps?.fetchFn;

  // Injected provider wins — skip disk entirely.
  if (deps?.tokenProvider) {
    const rawProvider = deps.tokenProvider;
    // Wrap to fail closed on empty/whitespace-only bearer — mirrors the
    // "Not authenticated" error the disk path throws when unauthenticated.
    const guardedProvider: TokenProvider = async () => {
      const token = await rawProvider();
      if (!token || !token.trim()) {
        throw new Error("Not authenticated. Use the login tool to sign in.");
      }
      return token;
    };
    return new ApiClient(API_BASE_URL, guardedProvider, fetchFn ?? fetch, deps.clientVersion);
  }

  // Disk-backed default path (stdio adapter, unchanged behavior).
  const credFile = deps?.credentialsPath ?? defaultCredentialsPath();
  const refreshToken = await readCredentials(credFile);

  if (!refreshToken) {
    throw new Error("Not authenticated. Use the login tool to sign in.");
  }

  const tokenProvider = createTokenProvider({
    refreshToken,
    apiBaseUrl: API_BASE_URL,
    fetchFn,
    clientVersion: deps?.clientVersion,
  });

  return new ApiClient(API_BASE_URL, tokenProvider, fetchFn ?? fetch, deps?.clientVersion);
}

/**
 * Opens a namespace-scoped op: builds the client first (so "Not authenticated"
 * wins over any namespace error), then resolves the namespace, then runs `fn`.
 */
export async function withNamespace<T>(
  deps: CoreDeps | undefined,
  namespaceName: string | undefined,
  fn: (apiClient: ApiClient, ns: Namespace) => Promise<T>,
): Promise<T> {
  const apiClient = await buildApiClient(deps);
  return fn(apiClient, await resolveNamespace(apiClient, namespaceName));
}
