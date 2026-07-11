/**
 * Domain functions for renaming sites and namespaces.
 *
 * renameSite()      — POST /api/ns/:nsId/sites/:slug/rename
 * renameNamespace() — POST /api/ns/:nsId/rename
 *
 * Both accept the current ApiClient and return a structured RenameSuccess
 * or throw an Error (propagated from ApiClient.parseResponse) on API errors.
 * The core facade catches API errors and converts them to { success: false }.
 */

import type { ApiClient } from "./api-client.ts";

export interface RenameSuccess {
  url: string;
  redirectExpiresAt: string | null;
}

interface SiteRenameResponse {
  slug: string;
  url: string;
  redirect_expires_at: string | null;
}

interface NsRenameResponse {
  name: string;
  url: string;
  redirect_expires_at: string | null;
}

export type RedirectMode = "off" | "30d" | "permanent";

/**
 * Renames a site (slug) within a namespace, optionally also setting, changing,
 * or clearing its path prefix (the site's address is `{path_prefix}/{slug}`).
 *
 * The `pathPrefix` argument mirrors the backend rename endpoint's three-way
 * semantics EXACTLY:
 *   - `undefined` — the `path_prefix` field is OMITTED from the request body,
 *     so the body is byte-identical to a pre-nested-path-publishing rename and
 *     the server keeps the site's current prefix unchanged.
 *   - `null` or `""` — the field is sent as `null`/`""`, which the server reads
 *     as an explicit "clear the prefix" (publish the site at the address root).
 *   - a non-empty string — sets/changes the prefix to that (possibly
 *     multi-segment) value.
 * The prefix's content rules (charset, depth, reserved segments, shadow) are
 * validated server-side (400/422/409); this client does not replicate them —
 * the structured error propagates via ApiError, matching the publish path.
 *
 * @param apiClient  - Authenticated API client.
 * @param nsId       - Namespace ID.
 * @param oldSlug    - Current site slug.
 * @param newSlug    - New site slug.
 * @param redirect   - Redirect mode for the old URL.
 * @param pathPrefix - See three-way semantics above. Omit to leave unchanged.
 * @returns RenameSuccess with the new URL and redirect expiry.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function renameSite(
  apiClient: ApiClient,
  nsId: string,
  oldSlug: string,
  newSlug: string,
  redirect: RedirectMode,
  pathPrefix?: string | null,
): Promise<RenameSuccess> {
  const body: { new_slug: string; redirect: RedirectMode; path_prefix?: string | null } = {
    new_slug: newSlug,
    redirect,
  };
  // Only attach path_prefix when the caller expressed an intent (set/clear).
  // Leaving it off keeps the request body byte-identical to today — the server
  // then preserves the stored prefix. null/"" are DELIBERATELY forwarded as the
  // explicit "clear" signal (not stripped), which the server distinguishes from
  // an absent field.
  if (pathPrefix !== undefined) {
    body.path_prefix = pathPrefix;
  }
  const result = await apiClient.post<SiteRenameResponse>(
    `/api/ns/${encodeURIComponent(nsId)}/sites/${encodeURIComponent(oldSlug)}/rename`,
    body,
  );
  return {
    url: result.url,
    redirectExpiresAt: result.redirect_expires_at,
  };
}

/**
 * Renames a namespace.
 *
 * @param apiClient  - Authenticated API client.
 * @param nsId       - Namespace ID.
 * @param newName    - New namespace name.
 * @param redirect   - Redirect mode for old namespace URLs.
 * @returns RenameSuccess with the new URL and redirect expiry.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function renameNamespace(
  apiClient: ApiClient,
  nsId: string,
  newName: string,
  redirect: RedirectMode,
): Promise<RenameSuccess> {
  const result = await apiClient.post<NsRenameResponse>(
    `/api/ns/${encodeURIComponent(nsId)}/rename`,
    { new_name: newName, redirect },
  );
  return {
    url: result.url,
    redirectExpiresAt: result.redirect_expires_at,
  };
}
