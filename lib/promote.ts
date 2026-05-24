/**
 * Core promote logic — promotes a staging version of a site to live.
 *
 * Returns structured data ({ url }) — formatting is the adapter's job.
 * Throws on API errors (propagated from ApiClient).
 */

import type { ApiClient } from "./api-client.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PromoteResult {
  /** Public URL where the newly promoted site is live. */
  url: string;
}

interface PromoteResponse {
  url: string;
}

// ─── Promote ─────────────────────────────────────────────────────────────────

/**
 * Promotes the staging version of a site to live.
 *
 * Calls POST /api/ns/{nsId}/sites/{slug}/promote. The server finds the staging
 * version, sets it as live_version, and syncs KV. Returns the live URL.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID the site belongs to.
 * @param slug - The URL-safe identifier of the site to promote.
 * @returns Object containing the live URL after promotion.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function promote(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
): Promise<PromoteResult> {
  const result = await apiClient.post<PromoteResponse>(
    `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/promote`,
    {},
  );

  return { url: result.url };
}
