/**
 * Core site deletion logic.
 *
 * Returns structured data ({ message }) — formatting is the adapter's job.
 * Throws on validation failures and API errors.
 */

import type { ApiClient } from "./api-client.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DeleteResult {
  /** Confirmation message from the API. */
  message: string;
}

interface DeleteSiteResponse {
  message: string;
}

// ─── Delete ──────────────────────────────────────────────────────────────────

/**
 * Deletes a published site by slug.
 *
 * @param apiClient - Authenticated API client.
 * @param slug - The URL-safe identifier of the site to delete.
 * @returns Object containing the API confirmation message.
 * @throws Error if slug is empty.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function deleteSite(
  apiClient: ApiClient,
  slug: string,
): Promise<DeleteResult> {
  if (!slug || slug.trim().length === 0) {
    throw new Error("slug is required");
  }

  const result = await apiClient.delete<DeleteSiteResponse>(
    `/api/sites/${encodeURIComponent(slug)}`,
  );

  return { message: result.message };
}
