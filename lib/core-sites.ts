/**
 * Site operations: list, publish, delete, promote, versions, analytics, QR code,
 * export and rename. Re-exported through core.ts.
 */

import type { ApiClient } from "./api-client.ts";
import { listSites } from "./list.ts";
import { publish as domainPublish } from "./publish.ts";
import type { PublishResult, UploadProgress, HashProgress } from "./publish.ts";
import { deleteSite } from "./delete.ts";
import { log } from "./log.ts";
import type { DeleteResult } from "./delete.ts";
import { promote as domainPromote } from "./promote.ts";
import type { PromoteResult } from "./promote.ts";
import {
  listVersions as domainListVersions,
  deleteVersion as domainDeleteVersion,
  restoreVersion as domainRestoreVersion,
  setVersionsLimit as domainSetVersionsLimit,
} from "./versions.ts";
import type {
  ListVersionsResult,
  DeleteVersionResult,
  RestoreVersionResult,
  SetVersionsLimitResult,
} from "./versions.ts";
import { setAnalyticsEnabled as domainSetAnalyticsEnabled } from "./analytics.ts";
import type { SetAnalyticsResult } from "./analytics.ts";
import { qrCode as domainQrCode } from "./qrcode.ts";
import type { QrCodeArgs, QrCodeResult } from "./qrcode.ts";
import { runSiteExport } from "./site-export.ts";
import type { ExportArgs, ExportResult } from "./site-export.ts";
import { resolveNamespaceRef } from "./namespace.ts";
import { renameSite, renameNamespace } from "./rename.ts";
import type { RedirectMode } from "./rename.ts";
import type { Namespace, Site, Visibility } from "./types.ts";
import { buildApiClient, withNamespace } from "./core-deps.ts";
import type { CoreDeps } from "./core-deps.ts";

export interface PublishArgs {
  /** Path to the directory to publish. */
  directory: string;
  /** URL-safe slug for the site. */
  slug: string;
  /**
   * Optional multi-segment path prefix — the site publishes at
   * `{pathPrefix}/{slug}` instead of the namespace root. Omitting this
   * field leaves publish behavior byte-identical to before nested-path
   * publishing existed. Threaded straight through to the manifest request;
   * validated server-side (400/422/409 on malformed/reserved/shadowing).
   */
  pathPrefix?: string | null;
  /**
   * Optional human-readable title. When omitted, a normal slug defaults to
   * the slug itself; the reserved `_root` slug (address root) preserves the
   * site's existing stored title when there is a meaningful one to keep,
   * otherwise defaults to the resolved namespace's name instead of the
   * literal slug `"_root"` — see `lib/publish.ts`'s `resolveDefaultTitle`.
   */
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
  /** When true, the server re-checks every stored file and re-uploads any that are missing or corrupt; healthy files are never re-uploaded. */
  force?: boolean;
  /**
   * Per-site analytics opt-out (Phase 3). false ⇒ publish with the analytics
   * script disabled ("publish … no analytics"). Omit to keep the default ON.
   */
  analyticsEnabled?: boolean;
  /** Publish as a single-page app. Pass on every publish of an SPA. */
  spa?: boolean;
  /** Publish even without a top-level index.html. */
  allowNoIndex?: boolean;
  /** Publish even when the folder looks like a project root. */
  allowProjectFiles?: boolean;
  /** Keep `*.map` source maps (excluded by default). */
  includeSourcemaps?: boolean;
  /**
   * Optional synchronous progress callback fired during the upload phase.
   * Threaded down to uploadChangedFiles(). Must be synchronous and
   * non-throwing — adapters wrap any async notification behind it. Omitting
   * it is a no-op with identical publish behavior.
   */
  onProgress?: (progress: UploadProgress) => void;
  /**
   * Optional synchronous progress callback fired during the hashing phase.
   * Must be synchronous and non-throwing — adapters wrap any async
   * notification behind it. Omitting it is a no-op with identical behavior.
   */
  onHashProgress?: (progress: HashProgress) => void;
}

export interface ListResult {
  /** Array of published sites. Empty array if none exist. */
  sites: Site[];
  /** The namespace these sites belong to. */
  namespace: Namespace;
}

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
   * Optional path prefix change — SITE renames only (ignored for a namespace
   * rename). Three-way semantics mirroring the backend:
   *   - omitted (`undefined`) — leave the site's current prefix unchanged; the
   *     rename request body is byte-identical to before nested-path publishing.
   *   - `null` or `""` — clear the prefix (move the site to the address root).
   *   - a string (e.g. "2026/q3/code-report") — set/change the prefix.
   * Validated server-side (400/422/409 on malformed/reserved/shadowing).
   */
  pathPrefix?: string | null;
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

/**
 * Fetches all published sites in the default (or named) namespace.
 * Throws "Not authenticated" if no credentials are stored.
 *
 * @param namespaceName - Optional namespace name. Defaults to the user's default namespace.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function list(namespaceName?: string, deps?: CoreDeps): Promise<ListResult> {
  return withNamespace(deps, namespaceName, async (apiClient, ns) => {
    const result = await listSites(apiClient, ns.id);
    return { ...result, namespace: ns };
  });
}

/**
 * Looks up the `_root` site's currently-stored title within a namespace, so
 * `publish()` can thread it into `resolveDefaultTitle()` (see
 * `lib/publish.ts`) and preserve a user's hand-set `_root` title instead of
 * resetting it to the namespace name on every re-publish.
 *
 * There is no single-site GET endpoint — the backend only exposes the
 * namespace-scoped list (`GET /api/ns/:nsId/sites`), so this reuses
 * `listSites()` (already used by `list()` above) rather than adding a new
 * API surface, and finds the `_root` entry within it.
 *
 * Never throws: a lookup failure (network error, non-2xx, malformed
 * response) degrades to `null`, same as "no existing `_root` site found".
 * `resolveDefaultTitle()` treats `null` as "nothing usable to preserve" and
 * falls back to the namespace name — strictly better than the pre-fix
 * behavior (which stored the literal `"_root"`) and never worse than simply
 * not knowing. A failed lookup must never fail the publish itself.
 */
async function lookupExistingRootTitle(
  apiClient: ApiClient,
  nsId: string,
): Promise<string | null> {
  try {
    const { sites } = await listSites(apiClient, nsId);
    return sites.find((s) => s.slug === "_root")?.title ?? null;
  } catch {
    return null;
  }
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
  return withNamespace(deps, args.namespace, async (apiClient, ns) => {

    // Scoped lookup: only a _root publish with no explicit title needs the
    // existing title (an explicit title always wins and would discard it
    // anyway; a non-_root publish never consults it) — so ordinary publishes
    // never pay for the extra request.
    const existingTitle =
      args.slug === "_root" && args.title === undefined
        ? await lookupExistingRootTitle(apiClient, ns.id)
        : undefined;

    log(`[publish] slug=${args.slug} dir=${args.directory} namespace=${ns.name}`);

    return domainPublish({
      apiClient,
      nsId: ns.id,
      directory: args.directory,
      slug: args.slug,
      pathPrefix: args.pathPrefix,
      title: args.title,
      namespaceName: ns.name,
      existingTitle,
      visibility: args.visibility,
      passcode: args.passcode,
      passcodeLabel: args.passcodeLabel,
      preview: args.preview,
      force: args.force,
      analyticsEnabled: args.analyticsEnabled,
      spa: args.spa,
      allowNoIndex: args.allowNoIndex,
      allowProjectFiles: args.allowProjectFiles,
      includeSourcemaps: args.includeSourcemaps,
      namespaceRole: ns.role,
      // Pass fetchFn so presigned R2 uploads use the injected fetch in tests
      fetchFn: deps?.fetchFn,
      // Thread progress callbacks down (adapter supplies them)
      onProgress: args.onProgress,
      onHashProgress: args.onHashProgress,
    });
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
  return withNamespace(deps, namespaceName, async (apiClient, ns) => {
    return deleteSite(apiClient, ns.id, slug);
  });
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
  return withNamespace(deps, namespaceName, async (apiClient, ns) => {
    return domainPromote(apiClient, ns.id, slug);
  });
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
  return withNamespace(deps, namespaceName, async (apiClient, ns) => {
    return domainListVersions(apiClient, ns.id, slug);
  });
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
  return withNamespace(deps, namespaceName, async (apiClient, ns) => {
    return domainDeleteVersion(apiClient, ns.id, slug, versionNumber);
  });
}

/**
 * Restores a previous version of a site, making it live again (rollback).
 *
 * Resolves the namespace, then delegates to the rollback route. Returns the
 * now-live version number and the live URL. A 404 (unknown version) or 403
 * (paid-plan gate) is converted to a clear message by the domain layer.
 * Throws "Not authenticated" if no credentials are stored.
 *
 * @param slug - The URL-safe identifier of the site.
 * @param versionNumber - The version number to restore (positive integer).
 * @param namespaceName - Optional namespace name. Defaults to the user's default namespace.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function restoreSiteVersion(
  slug: string,
  versionNumber: number,
  namespaceName?: string,
  deps?: CoreDeps,
): Promise<RestoreVersionResult> {
  return withNamespace(deps, namespaceName, async (apiClient, ns) => {
    return domainRestoreVersion(apiClient, ns.id, slug, versionNumber);
  });
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
  return withNamespace(deps, namespaceName, async (apiClient, ns) => {
    return domainSetVersionsLimit(apiClient, ns.id, slug, limit);
  });
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
  return withNamespace(deps, namespaceName, async (apiClient, ns) => {
    return domainSetAnalyticsEnabled(apiClient, ns.id, slug, enabled);
  });
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
  return withNamespace(deps, args.namespace, async (apiClient, ns) => {
    return domainQrCode(
      { slug: args.slug, namespace: args.namespace, outputDir: args.outputDir },
      {
        listFn: async () => {
          const result = await listSites(apiClient, ns.id);
          return { ...result, namespace: ns };
        },
      },
    );
  });
}

// ─── Site export ──────────────────────────────────────────────────────────────

/**
 * Downloads a version's published files into a local directory (local-only: it writes to this machine).
 * Pages the export API, verifies every file's size + MD5 and writes only inside `args.directory`.
 * Throws on a refused export (unsafe path, collision, non-empty directory) and on API errors; per-file
 * download failures are returned in `result.failed`.
 *
 * @param args - slug, directory, optional version / namespace / overwrite.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function exportSite(args: ExportArgs & { namespace?: string }, deps?: CoreDeps): Promise<ExportResult> {
  return withNamespace(deps, args.namespace, async (apiClient, ns) => {
    return runSiteExport(apiClient, ns.id, args, { fetchFn: deps?.fetchFn ?? fetch });
  });
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
      // Site rename. opts.pathPrefix is passed straight through: undefined ⇒
      // renameSite omits the field (byte-identical body); null/"" ⇒ clear;
      // string ⇒ set. Only site renames carry a prefix (namespace renames don't).
      const result = await renameSite(apiClient, ns.id, opts.site, opts.newName, redirect, opts.pathPrefix);
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
