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

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single deploy version of a site, as returned by the versions endpoint. */
export interface SiteVersion {
  /** Monotonic per-site version identifier. */
  version_number: number;
  /** Lifecycle status, e.g. "live", "archived", "active", "staging". */
  status: string;
  /** True for the version currently served at the site's public URL. */
  is_live: boolean;
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
