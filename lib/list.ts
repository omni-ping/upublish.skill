/**
 * Core site listing logic.
 *
 * Returns structured data ({ sites: Site[] }) — formatting is the adapter's job.
 * Throws on API errors (propagated from ApiClient).
 */

import type { ApiClient } from "./api-client.ts";
import type { Site } from "./types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ListSitesResult {
  /** Array of published sites. Empty array if none exist. */
  sites: Site[];
}

interface ListSitesResponse {
  sites: Site[];
}

// ─── List ────────────────────────────────────────────────────────────────────

/**
 * Fetches all published sites for the authenticated user within a namespace.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID to list sites within.
 * @returns Object containing an array of sites.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function listSites(apiClient: ApiClient, nsId: string): Promise<ListSitesResult> {
  const response = await apiClient.get<ListSitesResponse>(`/api/ns/${nsId}/sites`);
  return { sites: response.sites };
}
