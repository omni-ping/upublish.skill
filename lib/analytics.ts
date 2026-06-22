/**
 * Per-site analytics opt-out — toggle WITHOUT a republish.
 *
 * Maps the plain-language intents
 *   "turn off analytics for X" / "turn analytics back on for X"
 * to the site-settings PATCH. The backend's settings PATCH
 * (PATCH /api/ns/:nsId/sites/:slug/visibility) requires `visibility`, so this
 * function first reads the site's CURRENT visibility from the namespace site
 * list, then re-sends it unchanged alongside the new `analytics_enabled` flag.
 * No /manifest or /finalize is called — this never republishes the site.
 *
 * Publish-time opt-out ("publish … no analytics") lives on the publish path
 * (PublishArgs.analyticsEnabled → the manifest body), not here.
 *
 * Hexagonal rule: this module takes an injected ApiClient and is re-exported via
 * lib/core.ts; adapters (mcp/index.ts) import only from core.
 */
import type { ApiClient } from "./api-client.ts";
import { ApiError } from "./api-client.ts";
import type { Site } from "./types.ts";

const ANALYTICS_UPGRADE_URL = "https://upubli.sh/pricing";

export interface SetAnalyticsResult {
  /** The updated site, including the new analytics_enabled value. */
  site: Site;
}

interface ListSitesResponse {
  sites: Site[];
}

interface VisibilityPatchResponse {
  site: Site;
}

/**
 * Enables or disables analytics for an existing site without republishing.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId      - Namespace ID the site belongs to.
 * @param slug      - Site slug.
 * @param enabled   - true ⇒ analytics ON, false ⇒ analytics OFF.
 * @returns The updated site.
 * @throws Error if slug is empty.
 * @throws Error if the site does not exist in the namespace.
 * @throws Error on API failure (propagated from ApiClient).
 */
/**
 * Enriches a PATCH error at the analytics-settings barricade.
 *
 * - 403 when disabling (enabled=false) AND the body identifies the paid-plan
 *   analytics gate (body.error contains "analytics"): rewrites to a friendly
 *   upgrade message. The body check disambiguates from a suspended-user 403
 *   (different body) and from any non-disable call (re-enable never trips the gate).
 * - All other errors: pass through unchanged — never swallow, never mislabel.
 *
 * @param err     - The error thrown by the API call.
 * @param enabled - The value that was attempted (false = disable attempt).
 */
export function enrichAnalyticsError(err: Error, enabled: boolean): Error {
  if (
    enabled === false &&
    err instanceof ApiError &&
    err.status === 403
  ) {
    const body = err.rawBodyData as Record<string, unknown> | null;
    const serverMsg = typeof body?.error === "string" ? body.error : "";
    // Only rewrite when the body identifies the analytics gate.
    // A suspended-user 403 has a different error body and will NOT match here.
    if (serverMsg.toLowerCase().includes("analytics")) {
      return new Error(
        `${serverMsg} Upgrade to a Pro or Max plan at ${ANALYTICS_UPGRADE_URL} to disable analytics.`,
      );
    }
  }
  return err;
}

/**
 * Enables or disables analytics for an existing site without republishing.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId      - Namespace ID the site belongs to.
 * @param slug      - Site slug.
 * @param enabled   - true ⇒ analytics ON, false ⇒ analytics OFF.
 * @returns The updated site.
 * @throws Error if slug is empty.
 * @throws Error if the site does not exist in the namespace.
 * @throws Error on API failure (propagated from ApiClient).
 * @throws Error with friendly upgrade message when disabling against a free-tier account (403).
 */
export async function setAnalyticsEnabled(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
  enabled: boolean,
): Promise<SetAnalyticsResult> {
  if (!slug || slug.trim().length === 0) {
    throw new Error("slug is required");
  }

  // Resolve the site's CURRENT visibility — the settings PATCH requires it and
  // must not change it. (Reading the list avoids guessing/clobbering visibility.)
  const list = await apiClient.get<ListSitesResponse>(`/api/ns/${nsId}/sites`);
  const site = list.sites.find((s) => s.slug === slug);
  if (!site) {
    throw new Error(`Site "${slug}" not found in this namespace.`);
  }

  try {
    const result = await apiClient.patch<VisibilityPatchResponse>(
      `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/visibility`,
      { visibility: site.visibility, analytics_enabled: enabled },
    );
    return { site: result.site };
  } catch (err) {
    throw enrichAnalyticsError(err as Error, enabled);
  }
}
