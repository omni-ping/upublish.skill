/**
 * Core site listing logic.
 *
 * Returns structured data ({ sites: Site[] }) — formatting is the adapter's job.
 * Throws on API errors (propagated from ApiClient).
 */

import type { ApiClient } from "./api-client.ts";
import type { Site } from "./types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ListResult {
  /** Array of published sites. Empty array if none exist. */
  sites: Site[];
}

interface ListSitesResponse {
  sites: Site[];
}

// ─── List ────────────────────────────────────────────────────────────────────

/**
 * Fetches all published sites for the authenticated user.
 *
 * @param apiClient - Authenticated API client.
 * @returns Object containing an array of sites.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function listSites(apiClient: ApiClient): Promise<ListResult> {
  const response = await apiClient.get<ListSitesResponse>("/api/sites");
  return { sites: response.sites };
}
