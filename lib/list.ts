/**
 * Core site listing logic.
 *
 * Returns structured data ({ sites: Site[] }) — formatting is the adapter's job.
 * Throws on API errors (propagated from ApiClient).
 */

import type { ApiClient } from "./api-client.ts";
import type { Site, Visibility } from "./types.ts";
import { asVisibility } from "./types.ts";

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

// ─── Read one site's visibility ──────────────────────────────────────────────

/**
 * Reads a site's CURRENT visibility. There is no single-site GET, so this
 * filters the namespace list. It never guesses: a missing site, a missing
 * `visibility` field, or an unrecognised value all throw, so callers can
 * refuse to mutate access control on an unknown starting state.
 *
 * @throws Error naming the problem and stating nothing was changed.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function readSiteVisibility(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
): Promise<Visibility> {
  const { sites } = await listSites(apiClient, nsId);
  const site = (sites ?? []).find((s) => s.slug === slug);
  if (!site) {
    throw new Error(
      `Nothing was changed: site "${slug}" not found in this address, so I couldn't read the site's current visibility.`,
    );
  }
  const visibility = asVisibility((site as { visibility?: unknown }).visibility);
  if (!visibility) {
    throw new Error(
      `Nothing was changed: couldn't read the site's current visibility for "${slug}" (the site list had no recognised visibility).`,
    );
  }
  return visibility;
}
