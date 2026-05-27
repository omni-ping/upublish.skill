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
import type { LoginDeps, LoginResult, CallbackServer, TokenResponse } from "./auth.ts";

import { ApiClient } from "./api-client.ts";
import { listSites } from "./list.ts";
import { publish as domainPublish } from "./publish.ts";
import type { PublishResult } from "./publish.ts";
import { deleteSite } from "./delete.ts";
import { log } from "./log.ts";
import type { DeleteResult } from "./delete.ts";
import { promote as domainPromote } from "./promote.ts";
import type { PromoteResult } from "./promote.ts";
import {
  addPasscode as domainAddPasscode,
  listPasscodes as domainListPasscodes,
  revokePasscode as domainRevokePasscode,
} from "./passcode.ts";
import type {
  AddPasscodeResult,
  ListPasscodesResult,
  RevokePasscodeResult,
  SitePasscode,
} from "./passcode.ts";
import {
  getGate as domainGetGate,
  setGate as domainSetGate,
  removeGate as domainRemoveGate,
  getSubmissions as domainGetSubmissions,
  clearSubmissions as domainClearSubmissions,
} from "./gate.ts";
import type {
  GetGateResult,
  SetGateResult,
  RemoveGateResult,
  GetSubmissionsResult,
  ClearSubmissionsResult,
} from "./gate.ts";
import { resolveNamespace } from "./namespace.ts";
import type { FetchFn, Namespace, Site, Visibility, GateConfig, GateSubmission } from "./types.ts";

// ─── Re-exports for adapters ──────────────────────────────────────────────────

// Adapters import only from core.ts — re-export types they need so they
// don't have to reach into lib/auth.ts or other submodules.
export type { LoginDeps, LoginResult, CallbackServer, TokenResponse };
export type { PublishResult };
export type { DeleteResult };
export type { PromoteResult };
export type { AddPasscodeResult, ListPasscodesResult, RevokePasscodeResult, SitePasscode };
export type { GetGateResult, SetGateResult, RemoveGateResult, GetSubmissionsResult, ClearSubmissionsResult };
export type { Namespace, Site, Visibility, GateConfig, GateSubmission };

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
   * Label for the initial passcode. Defaults to "default" when
   * visibility is "passcode" and no label is provided.
   */
  passcodeLabel?: string;
  /**
   * Optional namespace name to publish into. When omitted, the default
   * namespace is resolved from GET /api/space.
   */
  namespace?: string;
  /**
   * When true, creates a staging version instead of going live immediately.
   * Use the promote() function to promote the staging version to live.
   */
  preview?: boolean;
  /** When true, uploads all files regardless of whether they changed. */
  force?: boolean;
}

export interface ListResult {
  /** Array of published sites. Empty array if none exist. */
  sites: Site[];
  /** The namespace these sites belong to. */
  namespace: Namespace;
}

export type StatusResult =
  | { authenticated: true; username: string; namespaces: Namespace[] }
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
    throw new Error("Not authenticated. Use the login tool to sign in.");
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
  const ns = await resolveNamespace(apiClient, namespaceName);
  const result = await listSites(apiClient, ns.id);
  return { ...result, namespace: ns };
}

/**
 * Publishes a directory to upubli.sh via the presigned-URL flow:
 * hashes files, diffs against server manifest, uploads only changed files
 * via presigned R2 URLs, then finalizes.
 *
 * Throws "Not authenticated" if no credentials are stored.
 * Throws on validation failure (bad directory, invalid slug, empty dir).
 * Throws on manifest or upload errors — no fallback path.
 */
export async function publish(
  args: PublishArgs,
  deps?: CoreDeps,
): Promise<PublishResult> {
  const apiClient = await buildApiClient(deps);
  const ns = await resolveNamespace(apiClient, args.namespace);

  log(`[publish] slug=${args.slug} dir=${args.directory} namespace=${ns.name}`);

  return domainPublish({
    apiClient,
    nsId: ns.id,
    directory: args.directory,
    slug: args.slug,
    title: args.title,
    visibility: args.visibility,
    passcode: args.passcode,
    passcodeLabel: args.passcodeLabel,
    preview: args.preview,
    force: args.force,
    // Pass fetchFn so presigned R2 uploads use the injected fetch in tests
    fetchFn: deps?.fetchFn,
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
  const ns = await resolveNamespace(apiClient, namespaceName);
  return deleteSite(apiClient, ns.id, slug);
}

/**
 * Promotes the staging version of a site to live.
 * Throws "Not authenticated" if no credentials are stored.
 *
 * @param slug - The URL-safe identifier of the site to promote.
 * @param namespaceName - Optional namespace name. Defaults to the user's default namespace.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function promote(
  slug: string,
  namespaceName?: string,
  deps?: CoreDeps,
): Promise<PromoteResult> {
  const apiClient = await buildApiClient(deps);
  const ns = await resolveNamespace(apiClient, namespaceName);
  return domainPromote(apiClient, ns.id, slug);
}

/**
 * Adds a passcode to a site.
 * Throws "Not authenticated" if no credentials are stored.
 *
 * @param slug - The site slug.
 * @param code - The passcode string.
 * @param label - Human-readable label for the passcode.
 * @param namespaceName - Optional namespace name. Defaults to the user's default namespace.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function addPasscode(
  slug: string,
  code: string,
  label: string,
  namespaceName?: string,
  deps?: CoreDeps,
): Promise<AddPasscodeResult> {
  const apiClient = await buildApiClient(deps);
  const ns = await resolveNamespace(apiClient, namespaceName);
  return domainAddPasscode(apiClient, ns.id, slug, code, label);
}

/**
 * Lists all passcodes for a site.
 * Throws "Not authenticated" if no credentials are stored.
 *
 * @param slug - The site slug.
 * @param namespaceName - Optional namespace name. Defaults to the user's default namespace.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function listPasscodes(
  slug: string,
  namespaceName?: string,
  deps?: CoreDeps,
): Promise<ListPasscodesResult> {
  const apiClient = await buildApiClient(deps);
  const ns = await resolveNamespace(apiClient, namespaceName);
  return domainListPasscodes(apiClient, ns.id, slug);
}

/**
 * Revokes a passcode by ID, or by label (resolved via list).
 * Throws "Not authenticated" if no credentials are stored.
 * Throws if the label does not match any passcode.
 *
 * @param slug - The site slug.
 * @param id - The passcode ID to revoke. Takes precedence over label.
 * @param label - The passcode label to revoke (resolved to ID via list). Used only when id is omitted.
 * @param namespaceName - Optional namespace name. Defaults to the user's default namespace.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function revokePasscode(
  slug: string,
  opts: { id?: string; label?: string },
  namespaceName?: string,
  deps?: CoreDeps,
): Promise<RevokePasscodeResult> {
  const apiClient = await buildApiClient(deps);
  const ns = await resolveNamespace(apiClient, namespaceName);

  if (opts.id) {
    return domainRevokePasscode(apiClient, ns.id, slug, opts.id);
  }

  if (opts.label) {
    // Resolve label to ID
    const { passcodes } = await domainListPasscodes(apiClient, ns.id, slug);
    const found = passcodes.find((p) => p.label === opts.label);
    if (!found) {
      const available = passcodes.map((p) => `"${p.label}"`).join(", ") || "(none)";
      throw new Error(
        `No passcode with label "${opts.label}" found. Available labels: ${available}`,
      );
    }
    return domainRevokePasscode(apiClient, ns.id, slug, found.id);
  }

  throw new Error("Either id or label must be provided to revoke a passcode.");
}

// ─── Gate ─────────────────────────────────────────────────────────────────────

/**
 * Discriminated union of arguments for the gate() dispatch function.
 * The `action` field determines which domain operation is invoked.
 */
export type GateArgs =
  | { action: "get"; slug: string; namespace?: string }
  | { action: "set"; slug: string; fields: string[]; namespace?: string }
  | { action: "remove"; slug: string; namespace?: string }
  | { action: "submissions"; slug: string; namespace?: string }
  | { action: "clear"; slug: string; namespace?: string };

/**
 * Discriminated union of results returned by gate().
 * The `action` field identifies which operation produced this result.
 */
export type GateResult =
  | ({ action: "get" } & GetGateResult)
  | ({ action: "set" } & SetGateResult)
  | ({ action: "remove" } & RemoveGateResult)
  | ({ action: "submissions" } & GetSubmissionsResult)
  | ({ action: "clear" } & ClearSubmissionsResult);

/**
 * Single dispatch function for all gate operations.
 * Dispatches to the appropriate domain function based on the `action` field.
 *
 * @param args - Discriminated union of gate arguments (action + slug + optional params).
 * @param deps - Optional CoreDeps for test injection.
 * @returns Discriminated result carrying the action field for easy narrowing.
 * @throws Error if not authenticated.
 * @throws Error on API failure.
 */
export async function gate(args: GateArgs, deps?: CoreDeps): Promise<GateResult> {
  const apiClient = await buildApiClient(deps);
  const ns = await resolveNamespace(apiClient, args.namespace);

  switch (args.action) {
    case "get": {
      const result = await domainGetGate(apiClient, ns.id, args.slug);
      return { action: "get", ...result };
    }
    case "set": {
      const result = await domainSetGate(apiClient, ns.id, args.slug, args.fields);
      return { action: "set", ...result };
    }
    case "remove": {
      const result = await domainRemoveGate(apiClient, ns.id, args.slug);
      return { action: "remove", ...result };
    }
    case "submissions": {
      const result = await domainGetSubmissions(apiClient, ns.id, args.slug);
      return { action: "submissions", ...result };
    }
    case "clear": {
      const result = await domainClearSubmissions(apiClient, ns.id, args.slug);
      return { action: "clear", ...result };
    }
  }
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
