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
 *   generate()  — generate a diagram from context text
 *   login()     — run the OAuth flow and store credentials
 *   status()    — check authentication state against the API
 *
 * All functions accept an optional CoreDeps for test injection:
 *   credentialsPath  — override credentials file location
 *   fetchFn          — override HTTP fetch (avoids real network calls in tests)
 */

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
import { generate as domainGenerate } from "./generate.ts";
import type { GenerateResult } from "./generate.ts";
import type { FetchFn, Visibility } from "./types.ts";

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
}

export interface GenerateArgs {
  /** Text description or context to generate a diagram from. */
  context: string;
  /** Optional hint for diagram type. */
  diagramType?: "flowchart" | "sequence" | "architecture";
  /** Optional slug for the published site. */
  slug?: string;
}

export type StatusResult =
  | { authenticated: true; username: string }
  | { authenticated: false; error?: string };

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
 * Fetches all published sites for the authenticated user.
 * Throws "Not authenticated" if no credentials are stored.
 */
export async function list(deps?: CoreDeps): Promise<ListResult> {
  const apiClient = await buildApiClient(deps);
  return listSites(apiClient);
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
  return domainPublish({
    apiClient,
    directory: args.directory,
    slug: args.slug,
    title: args.title,
    visibility: args.visibility,
    passcode: args.passcode,
  });
}

/**
 * Deletes a published site by slug.
 * Throws "Not authenticated" if no credentials are stored.
 */
export async function deleteOp(
  slug: string,
  deps?: CoreDeps,
): Promise<DeleteResult> {
  const apiClient = await buildApiClient(deps);
  return deleteSite(apiClient, slug);
}

/**
 * Generates an Excalidraw diagram from context text and publishes it.
 * Throws "Not authenticated" if no credentials are stored.
 * Throws if context is empty.
 */
export async function generate(
  args: GenerateArgs,
  deps?: CoreDeps,
): Promise<GenerateResult> {
  const apiClient = await buildApiClient(deps);
  return domainGenerate({
    apiClient,
    context: args.context,
    diagramType: args.diagramType,
    slug: args.slug,
  });
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
