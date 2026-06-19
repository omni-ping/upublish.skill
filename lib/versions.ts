/**
 * Core site-version logic — list a site's versions and delete an archived one.
 *
 * Returns structured data — formatting is the adapter's job. Throws on
 * validation failures and API errors (propagated from ApiClient).
 *
 * Mirrors lib/delete.ts: domain functions take an injectable ApiClient and the
 * namespace ID; they never read credentials or build a client.
 */

import type { ApiClient } from "./api-client.ts";
import { ApiError } from "./api-client.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single deploy version of a site, as returned by the versions endpoint. */
export interface SiteVersion {
  /** Monotonic per-site version identifier. */
  version_number: number;
  /** Lifecycle status, e.g. "live", "archived", "active", "staging". */
  status: string;
  /** True for the version currently served at the site's public URL. */
  is_live: boolean;
  /** ISO-8601 timestamp the version was created. Optional — older payloads may omit it. */
  created_at?: string;
  /** Number of files in the version. Optional — older payloads may omit it. */
  file_count?: number;
  /** Total uncompressed bytes for the version. Optional — older payloads may omit it. */
  total_size?: number;
}

/**
 * Namespace/space storage figure echoed back after a version delete so the
 * caller can show reclaimed space. Fields mirror the API verbatim; all are
 * optional because the domain only passes this through to the adapter — it
 * does not interpret it, and the API may include additional fields.
 */
export interface StorageUsage {
  /** Bytes currently used after the delete. */
  used_bytes?: number;
  /** Storage quota in bytes for the tier. */
  limit_bytes?: number;
  /** Any additional usage fields returned by the API, passed through. */
  [key: string]: number | undefined;
}

/** Result of listing a site's versions. */
export interface ListVersionsResult {
  /** All versions for the site, newest first (order as returned by the API). */
  versions: SiteVersion[];
}

/** Result of restoring (rolling back to) a previous version. */
export interface RestoreVersionResult {
  /**
   * The version number that is now live. Echoed from the request: the backend
   * rollback response carries only `url`, and the caller already knows which
   * version it asked to restore.
   */
  version_number: number;
  /** The live public URL of the restored site (from the rollback response). */
  url: string;
}

/** Result of deleting one archived version. */
export interface DeleteVersionResult {
  /** The version number that was deleted. */
  version_number: number;
  /** Bytes reclaimed by deleting this version. */
  freed_bytes: number;
  /** Storage usage after the delete (for reclaimed-space feedback). */
  usage: StorageUsage;
}

/** Result of setting (or clearing) a site's version retention limit. */
export interface SetVersionsLimitResult {
  /** The updated site record, including the new max_versions value. */
  site: {
    /** The retention limit after the update. null means unlimited. */
    max_versions: number | null;
    /** Additional site fields returned by the API, passed through. */
    [key: string]: unknown;
  };
  /** Version numbers that were pruned as a result of setting the limit. */
  pruned: number[];
  /** Bytes freed by pruning. 0 when no versions were pruned. */
  freed_bytes: number;
  /** Storage usage after the operation (for reclaimed-space feedback). */
  usage: StorageUsage;
}

interface ListVersionsResponse {
  versions: SiteVersion[];
}

interface DeleteVersionResponse {
  version_number: number;
  freed_bytes: number;
  usage: StorageUsage;
}

/** Backend rollback response — carries only the live URL. */
interface RestoreVersionResponse {
  url: string;
}

interface SetVersionsLimitResponse {
  site: { max_versions: number | null; [key: string]: unknown };
  pruned: number[];
  freed_bytes: number;
  usage: StorageUsage;
}

// ─── List ────────────────────────────────────────────────────────────────────

/**
 * Lists all versions for a site within a namespace.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID the site belongs to.
 * @param slug - The URL-safe identifier of the site.
 * @returns Object containing the site's versions (each with status + is_live).
 * @throws Error if slug is empty.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function listVersions(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
): Promise<ListVersionsResult> {
  if (!slug || slug.trim().length === 0) {
    throw new Error("slug is required");
  }

  const result = await apiClient.get<ListVersionsResponse>(
    `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/versions`,
  );

  return { versions: result.versions };
}

// ─── Delete ──────────────────────────────────────────────────────────────────

/**
 * Deletes a single archived version of a site.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID the site belongs to.
 * @param slug - The URL-safe identifier of the site.
 * @param versionNumber - The version number to delete. Must be a positive integer.
 * @returns The deleted version number, bytes freed, and post-delete usage.
 * @throws Error if slug is empty or versionNumber is not a positive integer.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function deleteVersion(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
  versionNumber: number,
): Promise<DeleteVersionResult> {
  if (!slug || slug.trim().length === 0) {
    throw new Error("slug is required");
  }
  if (!Number.isInteger(versionNumber) || versionNumber <= 0) {
    throw new Error("versionNumber must be a positive integer");
  }

  const result = await apiClient.delete<DeleteVersionResponse>(
    `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/versions/${encodeURIComponent(String(versionNumber))}`,
  );

  return {
    version_number: result.version_number,
    freed_bytes: result.freed_bytes,
    usage: result.usage,
  };
}

// ─── Restore (roll back to a previous version) ────────────────────────────────

/**
 * Restores a previous version of a site, making it live again.
 *
 * Calls the backend rollback route (`POST …/versions/:version/rollback`), which
 * activates + promotes the target version server-side. The tool name
 * (`versions_restore`) intentionally differs from the backend route (`…/rollback`).
 *
 * The backend response carries only the live `url`; the now-live version number
 * is echoed from the request so the adapter can confirm what was restored.
 *
 * Errors the adapter would otherwise render as a raw `API error N:` string are
 * converted here (mirroring lib/namespace.ts enrichNamespaceError) into clear,
 * human-readable messages:
 *   - 404 → "version N not found, see versions_list"
 *   - 403 → paid-plan message (rollback gates on max_active_versions on free tier)
 * All other errors (e.g. a 409 no-op when restoring the already-live version)
 * pass through verbatim — backend text is already actionable.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID the site belongs to.
 * @param slug - The URL-safe identifier of the site.
 * @param versionNumber - The version number to restore. Must be a positive integer.
 * @returns The now-live version number (echoed) and the live URL.
 * @throws Error if slug is empty or versionNumber is not a positive integer.
 * @throws Error on API failure (enriched for 403/404, otherwise propagated).
 */
export async function restoreVersion(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
  versionNumber: number,
): Promise<RestoreVersionResult> {
  if (!slug || slug.trim().length === 0) {
    throw new Error("slug is required");
  }
  if (!Number.isInteger(versionNumber) || versionNumber <= 0) {
    throw new Error("versionNumber must be a positive integer");
  }

  try {
    const result = await apiClient.post<RestoreVersionResponse>(
      // Backend route is …/rollback; the MCP tool is versions_restore (names differ by design).
      `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/versions/${encodeURIComponent(String(versionNumber))}/rollback`,
      {},
    );
    return { version_number: versionNumber, url: result.url };
  } catch (err) {
    if (err instanceof Error) throw enrichRestoreError(err, versionNumber);
    throw err;
  }
}

/**
 * Converts a typed ApiError from the rollback route into a clear, human-readable
 * message for the two cases the user can act on. Other errors pass through
 * unchanged so already-actionable backend text (e.g. a 409 on the live version)
 * reaches the user verbatim.
 */
function enrichRestoreError(err: Error, versionNumber: number): Error {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return new Error(`Version ${versionNumber} not found. Use versions_list to see available versions.`);
    }
    if (err.status === 403) {
      return new Error("Restoring a previous version requires a paid plan.");
    }
  }
  return err;
}

// ─── Set / clear retention limit ──────────────────────────────────────────────

/**
 * Sets or clears the retention limit for a site.
 *
 * When `limit` is a positive integer, the backend persists it and immediately
 * prunes excess archived versions (oldest-first). When `limit` is null the
 * limit is cleared and no future automatic pruning occurs.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID the site belongs to.
 * @param slug - The URL-safe identifier of the site.
 * @param limit - Positive integer (≥ 1) to set, or null to clear.
 * @returns Updated site (including max_versions), pruned version numbers,
 *          bytes freed, and post-operation storage usage.
 * @throws Error if slug is empty.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function setVersionsLimit(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
  limit: number | null,
): Promise<SetVersionsLimitResult> {
  if (!slug || slug.trim().length === 0) {
    throw new Error("slug is required");
  }

  const result = await apiClient.put<SetVersionsLimitResponse>(
    `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/versions/limit`,
    { limit },
  );

  return {
    site: result.site,
    pruned: result.pruned,
    freed_bytes: result.freed_bytes,
    usage: result.usage,
  };
}
