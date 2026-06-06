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
 * Renames a site (slug) within a namespace.
 *
 * @param apiClient  - Authenticated API client.
 * @param nsId       - Namespace ID.
 * @param oldSlug    - Current site slug.
 * @param newSlug    - New site slug.
 * @param redirect   - Redirect mode for the old URL.
 * @returns RenameSuccess with the new URL and redirect expiry.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function renameSite(
  apiClient: ApiClient,
  nsId: string,
  oldSlug: string,
  newSlug: string,
  redirect: RedirectMode,
): Promise<RenameSuccess> {
  const result = await apiClient.post<SiteRenameResponse>(
    `/api/ns/${encodeURIComponent(nsId)}/sites/${encodeURIComponent(oldSlug)}/rename`,
    { new_slug: newSlug, redirect },
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
