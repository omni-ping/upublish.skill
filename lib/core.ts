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
 *   listSiteVersions()  — list a site's deploy versions
 *   deleteSiteVersion() — delete one archived version (returns freed bytes + usage)
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
import type { PublishResult, UploadProgress } from "./publish.ts";
import { deleteSite } from "./delete.ts";
import { log } from "./log.ts";
import type { DeleteResult } from "./delete.ts";
import { promote as domainPromote } from "./promote.ts";
import type { PromoteResult } from "./promote.ts";
import {
  listVersions as domainListVersions,
  deleteVersion as domainDeleteVersion,
  setVersionsLimit as domainSetVersionsLimit,
} from "./versions.ts";
import type {
  ListVersionsResult,
  DeleteVersionResult,
  SetVersionsLimitResult,
  SiteVersion,
} from "./versions.ts";
import { setAnalyticsEnabled as domainSetAnalyticsEnabled } from "./analytics.ts";
import type { SetAnalyticsResult } from "./analytics.ts";
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
import {
  listMembers as domainListMembers,
  addMember as domainAddMember,
  removeMember as domainRemoveMember,
  changeMemberRole as domainChangeMemberRole,
} from "./members.ts";
import type {
  Member,
  ListMembersResult,
  AddMemberResult,
  RemoveMemberResult,
  ChangeMemberRoleResult,
} from "./members.ts";
import { qrCode as domainQrCode } from "./qrcode.ts";
import type { QrCodeArgs, QrCodeResult } from "./qrcode.ts";
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
import { resolveNamespace, resolveNamespaceRef, namespaceCreate as domainNamespaceCreate, OverageApprovalError } from "./namespace.ts";
import type { NamespaceCreateResult } from "./namespace.ts";
import { domain as domainDomain } from "./domain.ts";
import type {
  DomainArgs,
  DomainResult,
  DomainAddResult,
  DomainStatusResult,
  DomainListResult,
  DomainRemoveResult,
  CustomDomain,
  DnsRecord,
} from "./domain.ts";
import { renameSite, renameNamespace } from "./rename.ts";
import type { RedirectMode } from "./rename.ts";
import type { FetchFn, Namespace, Site, Visibility, GateConfig, GateSubmission, TokenProvider } from "./types.ts";
import { displayMsg } from "./display-msg.ts";

// ─── Re-exports for adapters ──────────────────────────────────────────────────

// Adapters import only from core.ts — re-export types they need so they
// don't have to reach into lib/auth.ts or other submodules.
export type { LoginDeps, LoginResult, CallbackServer, TokenResponse };
export type { PublishResult, UploadProgress };
export type { DeleteResult };
export type { PromoteResult };
export type { ListVersionsResult, DeleteVersionResult, SetVersionsLimitResult, SiteVersion };
export type { SetAnalyticsResult };
export type { AddPasscodeResult, ListPasscodesResult, RevokePasscodeResult, SitePasscode };
export type { GetGateResult, SetGateResult, RemoveGateResult, GetSubmissionsResult, ClearSubmissionsResult };
export type { Member, ListMembersResult, AddMemberResult, RemoveMemberResult, ChangeMemberRoleResult };
export type { QrCodeArgs, QrCodeResult };
export type { Namespace, Site, Visibility, GateConfig, GateSubmission };
export type { NamespaceCreateResult };
export { OverageApprovalError };
export type {
  DomainArgs,
  DomainResult,
  DomainAddResult,
  DomainStatusResult,
  DomainListResult,
  DomainRemoveResult,
  CustomDomain,
  DnsRecord,
};
export type { NamespaceRole, TokenProvider } from "./types.ts";
export type { RedirectMode };
export { displayMsg };
export type {
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
};

// ─── Constants ────────────────────────────────────────────────────────────────

const API_BASE_URL = process.env.UPUBLISH_API_URL ?? "https://api.upubli.sh";
const SITE_BASE_URL = (process.env.UPUBLISH_SITE_URL ?? "https://upubli.sh").replace(/\/$/, "");

// ─── Types ───────────────────────────────────────────────────────────────────

/** Optional overrides for test injection. All fields are optional. */
export interface CoreDeps {
  /** Path to credentials file. Defaults to ~/.upublish/credentials. */
  credentialsPath?: string;
  /** HTTP fetch function. Defaults to global fetch. */
  fetchFn?: FetchFn;
  /**
   * Injected token provider for hosted/remote use.
   *
   * When supplied, this provider is used AS-IS instead of the disk-backed
   * refresh flow — the host (e.g. the backend's /mcp router) supplies a
   * closure that returns the validated per-request bearer token.
   *
   * Invoked on every API call (no caching) so per-request injection holds.
   * Takes precedence over credentialsPath when both are given.
   *
   * When omitted, the stdio/disk default path is used unchanged.
   */
  tokenProvider?: TokenProvider;
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
  /**
   * Per-site analytics opt-out (Phase 3). false ⇒ publish with the analytics
   * script disabled ("publish … no analytics"). Omit to keep the default ON.
   */
  analyticsEnabled?: boolean;
  /**
   * Optional synchronous progress callback fired during the upload phase.
   * Threaded down to uploadChangedFiles(). Must be synchronous and
   * non-throwing — adapters wrap any async notification behind it. Omitting
   * it is a no-op with identical publish behavior.
   */
  onProgress?: (progress: UploadProgress) => void;
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

export interface RenameArgs {
  /** Namespace ID. */
  nsId: string;
  /**
   * Slug of the site to rename. When provided, a site rename is performed.
   * When omitted, a namespace rename is performed.
   */
  site?: string;
  /** New slug (site rename) or new namespace name (namespace rename). */
  newName: string;
  /**
   * Redirect mode for old URLs. Defaults to '30d' when not specified.
   * - 'off'       — no redirect, old name immediately released
   * - '30d'       — 301 redirect for 30 days (default, safest)
   * - 'permanent' — permanent 301 redirect (no expiry)
   */
  redirect?: RedirectMode;
}

export type RenameResult =
  | { success: true; url: string; redirectExpiresAt: string | null }
  | { success: false; error: string };

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Builds an authenticated ApiClient.
 *
 * Two paths:
 *
 * 1. Injected provider (hosted/remote use): when `deps.tokenProvider` is
 *    supplied, it is used directly — no credential file is read. The caller
 *    is responsible for supplying a provider that returns a valid bearer on
 *    every invocation. Takes precedence over `credentialsPath`.
 *
 * 2. Disk-backed default (stdio/CLI use): reads a refresh token from the
 *    credentials file and creates a refresh-backed TokenProvider. Throws
 *    "Not authenticated" if no credentials file exists or is empty.
 */
async function buildApiClient(deps?: CoreDeps): Promise<ApiClient> {
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
    return new ApiClient(API_BASE_URL, guardedProvider, fetchFn ?? fetch);
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
    analyticsEnabled: args.analyticsEnabled,
    // Pass fetchFn so presigned R2 uploads use the injected fetch in tests
    fetchFn: deps?.fetchFn,
    // Thread the progress callback down to the upload loop (adapter supplies it)
    onProgress: args.onProgress,
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
 * Lists all versions of a site within the default (or named) namespace.
 * Throws "Not authenticated" if no credentials are stored.
 *
 * @param slug - The URL-safe identifier of the site.
 * @param namespaceName - Optional namespace name. Defaults to the user's default namespace.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function listSiteVersions(
  slug: string,
  namespaceName?: string,
  deps?: CoreDeps,
): Promise<ListVersionsResult> {
  const apiClient = await buildApiClient(deps);
  const ns = await resolveNamespace(apiClient, namespaceName);
  return domainListVersions(apiClient, ns.id, slug);
}

/**
 * Deletes a single archived version of a site within the default (or named)
 * namespace. Returns the bytes freed and post-delete usage so callers can
 * surface reclaimed storage. Throws "Not authenticated" if no credentials are stored.
 *
 * @param slug - The URL-safe identifier of the site.
 * @param versionNumber - The version number to delete (positive integer).
 * @param namespaceName - Optional namespace name. Defaults to the user's default namespace.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function deleteSiteVersion(
  slug: string,
  versionNumber: number,
  namespaceName?: string,
  deps?: CoreDeps,
): Promise<DeleteVersionResult> {
  const apiClient = await buildApiClient(deps);
  const ns = await resolveNamespace(apiClient, namespaceName);
  return domainDeleteVersion(apiClient, ns.id, slug, versionNumber);
}

/**
 * Sets or clears the retention limit for a site within the default (or named) namespace.
 *
 * When `limit` is a positive integer, the backend persists it and immediately prunes
 * excess archived versions (oldest-first). When `limit` is null the limit is cleared.
 * Returns the updated site record, pruned version numbers, bytes freed, and post-operation
 * storage usage so callers can surface reclaimed storage.
 *
 * Throws "Not authenticated" if no credentials are stored.
 *
 * @param slug - The URL-safe identifier of the site.
 * @param limit - Positive integer (≥ 1) to set, or null to clear.
 * @param namespaceName - Optional namespace name. Defaults to the user's default namespace.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function setSiteVersionsLimit(
  slug: string,
  limit: number | null,
  namespaceName?: string,
  deps?: CoreDeps,
): Promise<SetVersionsLimitResult> {
  const apiClient = await buildApiClient(deps);
  const ns = await resolveNamespace(apiClient, namespaceName);
  return domainSetVersionsLimit(apiClient, ns.id, slug, limit);
}

/**
 * Turns per-site analytics on or off WITHOUT republishing.
 *
 * Maps "turn off analytics for X" / "turn analytics back on for X" to the
 * site-settings PATCH. Throws "Not authenticated" if no credentials are stored.
 *
 * @param slug - The site slug.
 * @param enabled - true ⇒ analytics ON, false ⇒ OFF.
 * @param namespaceName - Optional namespace name. Defaults to the user's default namespace.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function analytics(
  slug: string,
  enabled: boolean,
  namespaceName?: string,
  deps?: CoreDeps,
): Promise<SetAnalyticsResult> {
  const apiClient = await buildApiClient(deps);
  const ns = await resolveNamespace(apiClient, namespaceName);
  return domainSetAnalyticsEnabled(apiClient, ns.id, slug, enabled);
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

// ─── Members ──────────────────────────────────────────────────────────────────

/**
 * Discriminated union of arguments for the members() dispatch function.
 * The `action` field determines which domain operation is invoked.
 */
export type MembersArgs =
  | { action: "list"; namespace?: string }
  | { action: "add"; username: string; role: "admin" | "user"; namespace?: string }
  | { action: "remove"; username: string; namespace?: string }
  | { action: "role"; username: string; role: "admin" | "user"; namespace?: string };

/**
 * Discriminated union of results returned by members().
 * The `action` field identifies which operation produced this result.
 */
export type MembersResult =
  | ({ action: "list" } & ListMembersResult)
  | ({ action: "add" } & AddMemberResult)
  | ({ action: "remove" } & RemoveMemberResult)
  | ({ action: "role" } & ChangeMemberRoleResult);

/**
 * Single dispatch function for all member management operations.
 * Dispatches to the appropriate domain function based on the `action` field.
 *
 * The `namespace` field controls which namespace is targeted. When omitted,
 * the default namespace is resolved from GET /api/space.
 *
 * For `remove` and `role` actions, the username is resolved to a user_id
 * internally by the domain function — callers always think in usernames.
 *
 * @param args - Discriminated union of member arguments.
 * @param deps - Optional CoreDeps for test injection.
 * @returns Discriminated result carrying the action field for easy narrowing.
 * @throws Error if not authenticated.
 * @throws Error on API failure (propagated from ApiClient).
 * @throws Error if a username cannot be resolved for remove/role actions.
 */
export async function members(args: MembersArgs, deps?: CoreDeps): Promise<MembersResult> {
  const apiClient = await buildApiClient(deps);
  const ns = await resolveNamespace(apiClient, args.namespace);

  switch (args.action) {
    case "list": {
      const result = await domainListMembers(apiClient, ns.id);
      return { action: "list", ...result };
    }
    case "add": {
      const result = await domainAddMember(apiClient, ns.id, args.username, args.role);
      return { action: "add", ...result };
    }
    case "remove": {
      const result = await domainRemoveMember(apiClient, ns.id, args.username);
      return { action: "remove", ...result };
    }
    case "role": {
      const result = await domainChangeMemberRole(apiClient, ns.id, args.username, args.role);
      return { action: "role", ...result };
    }
  }
}

/**
 * Generates a QR code for a published site, encoding the canonical URL + ?ref=qr
 * per the QR contract. Writes qr.svg and qr.png to the output dir (default cwd)
 * and returns the encoded URL and a unicode terminal QR string.
 *
 * @param args - Slug, optional namespace, optional output dir.
 * @param deps - Optional CoreDeps for test injection.
 * @throws Error if not authenticated.
 * @throws Error if the slug is not found in the namespace.
 * @throws Error if the site has no canonical URL.
 */
export async function qrCode(args: QrCodeArgs, deps?: CoreDeps): Promise<QrCodeResult> {
  const apiClient = await buildApiClient(deps);
  const ns = await resolveNamespace(apiClient, args.namespace);
  return domainQrCode(
    { slug: args.slug, namespace: args.namespace, outputDir: args.outputDir },
    {
      listFn: async () => {
        const result = await listSites(apiClient, ns.id);
        return { ...result, namespace: ns };
      },
    },
  );
}

// ─── Rename ───────────────────────────────────────────────────────────────────

/**
 * Renames a site or namespace.
 *
 * When `opts.site` is provided, renames that site's slug within the given namespace.
 * When `opts.site` is omitted, renames the namespace itself.
 *
 * Redirect mode defaults to '30d' (safest — preserves old URLs for 30 days).
 * API error messages are surfaced verbatim in the returned error string.
 *
 * Unlike other core functions, this never throws for expected failures — it
 * returns { success: false, error } so callers can surface the message
 * without try/catch. Authentication failures (no credentials) are still
 * surfaced as { success: false } rather than thrown.
 *
 * @param opts - Rename arguments: nsId, optional site slug, newName, optional redirect mode.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function rename(opts: RenameArgs, deps?: CoreDeps): Promise<RenameResult> {
  let apiClient;
  try {
    apiClient = await buildApiClient(deps);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }

  const redirect: RedirectMode = opts.redirect ?? "30d";

  try {
    // Resolve nsId (a namespace name OR a UUID) to the real namespace UUID before
    // building the request URL — the backend resolves :nsId by UUID only, so a raw
    // name would 404. A resolution failure is caught below and returned as
    // { success: false, error } with the available-namespaces hint.
    const ns = await resolveNamespaceRef(apiClient, opts.nsId);

    if (opts.site !== undefined) {
      // Site rename
      const result = await renameSite(apiClient, ns.id, opts.site, opts.newName, redirect);
      return { success: true, url: result.url, redirectExpiresAt: result.redirectExpiresAt };
    } else {
      // Namespace rename
      const result = await renameNamespace(apiClient, ns.id, opts.newName, redirect);
      return { success: true, url: result.url, redirectExpiresAt: result.redirectExpiresAt };
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

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
  };

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
