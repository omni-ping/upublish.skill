/**
 * Tests for lib/analytics.ts — per-site analytics opt-out (toggle without republish).
 *
 * Maps the plain-language intents
 *   "turn off analytics for X" / "turn analytics back on for X"
 * to the site-settings PATCH. The setting flips WITHOUT a republish: the function
 * reads the site's current visibility, then PATCHes
 *   /api/ns/:nsId/sites/:slug/visibility { visibility, analytics_enabled }.
 *
 * Also asserts the publish path threads analytics_enabled into the manifest body
 * ("publish … no analytics").
 *
 * Tested with an injectable mock ApiClient — no real network.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setAnalyticsEnabled, enrichAnalyticsError } from "./analytics.ts";
import { publish, enrichPublishError, StorageApprovalError } from "./publish.ts";
import { ApiClient, ApiError } from "./api-client.ts";

const BASE_URL = "https://api.example.com";
const NS_ID = "ns-test";
const staticTokenProvider = async () => "test-token";

/** Captures method/url/body across a multi-request flow (GET sites, then PATCH). */
function recordingFetch(
  routes: Array<{ status: number; body: unknown }>,
): {
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; method: string; body: unknown }>;
} {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let i = 0;
  const fetchFn = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    const route = routes[Math.min(i, routes.length - 1)];
    i += 1;
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchFn, calls };
}

describe("setAnalyticsEnabled — toggle without republish", () => {
  it("test_turn_off_patches_visibility_with_analytics_false", async () => {
    // GET sites → finds the site's current visibility; PATCH flips analytics off.
    const { fetchFn, calls } = recordingFetch([
      { status: 200, body: { sites: [{ id: "s1", slug: "my-portfolio", visibility: "passcode", analytics_enabled: true }] } },
      { status: 200, body: { site: { id: "s1", slug: "my-portfolio", visibility: "passcode", analytics_enabled: false } } },
    ]);
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);

    const result = await setAnalyticsEnabled(apiClient, NS_ID, "my-portfolio", false);

    // The PATCH carries the CURRENT visibility plus analytics_enabled:false.
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch!.url).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/my-portfolio/visibility`);
    expect(patch!.body).toEqual({ visibility: "passcode", analytics_enabled: false });
    expect(result.site.analytics_enabled).toBe(false);
  });

  it("test_turn_on_patches_visibility_with_analytics_true", async () => {
    const { fetchFn, calls } = recordingFetch([
      { status: 200, body: { sites: [{ id: "s1", slug: "blog", visibility: "public", analytics_enabled: false }] } },
      { status: 200, body: { site: { id: "s1", slug: "blog", visibility: "public", analytics_enabled: true } } },
    ]);
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);

    await setAnalyticsEnabled(apiClient, NS_ID, "blog", true);

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch!.body).toEqual({ visibility: "public", analytics_enabled: true });
  });

  it("test_no_republish_no_manifest_call", async () => {
    const { fetchFn, calls } = recordingFetch([
      { status: 200, body: { sites: [{ id: "s1", slug: "blog", visibility: "public", analytics_enabled: true }] } },
      { status: 200, body: { site: { id: "s1", slug: "blog", visibility: "public", analytics_enabled: false } } },
    ]);
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await setAnalyticsEnabled(apiClient, NS_ID, "blog", false);
    // No /manifest or /finalize call — this is a settings toggle, not a republish.
    expect(calls.some((c) => c.url.includes("/manifest") || c.url.includes("/finalize"))).toBe(false);
  });

  it("test_unknown_slug_throws", async () => {
    const { fetchFn } = recordingFetch([
      { status: 200, body: { sites: [{ id: "s1", slug: "other", visibility: "public", analytics_enabled: true }] } },
    ]);
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await expect(setAnalyticsEnabled(apiClient, NS_ID, "missing", false)).rejects.toThrow(/not found/i);
  });

  it("test_empty_slug_throws", async () => {
    const { fetchFn } = recordingFetch([{ status: 200, body: { sites: [] } }]);
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await expect(setAnalyticsEnabled(apiClient, NS_ID, "", false)).rejects.toThrow(/slug is required/i);
  });
});

// ─── Publish-time field: "publish … no analytics" ───────────────────────────

describe("publish threads analytics_enabled into the manifest body", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-analytics-publish-"));
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  function fetchCapturingManifest(captured: { body?: Record<string, unknown> }) {
    return async (url: string, init?: RequestInit) => {
      if (url.includes("/manifest")) {
        captured.body = init?.body ? JSON.parse(init.body as string) : {};
        return new Response(
          JSON.stringify({
            needed: [{ path: "index.html", upload_url: "https://r2.example.com/1" }],
            version: 1,
            session_id: "sess-1",
            base_version: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("r2.example.com") && init?.method === "PUT") {
        return new Response("", { status: 200 });
      }
      if (url.includes("/finalize")) {
        return new Response(
          JSON.stringify({ site: { id: "s1", slug: "my-site", visibility: "public", analytics_enabled: false }, url: "https://x/" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };
  }

  it("test_publish_with_analytics_off_sends_false", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    const fetchFn = fetchCapturingManifest(captured);
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await publish({
      apiClient,
      nsId: "ns-1",
      directory: tmpDir,
      slug: "my-site",
      analyticsEnabled: false,
      fetchFn,
    });
    expect(captured.body?.analytics_enabled).toBe(false);
  });

  it("test_publish_default_omits_analytics_field", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    const fetchFn = fetchCapturingManifest(captured);
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await publish({
      apiClient,
      nsId: "ns-1",
      directory: tmpDir,
      slug: "my-site",
      fetchFn,
    });
    // Default publish: no analytics_enabled in the body (server defaults ON).
    expect("analytics_enabled" in (captured.body ?? {})).toBe(false);
  });
});

// ─── DW-3.1: enrichAnalyticsError — analytics-disable 403 → friendly message ─

describe("enrichAnalyticsError — analytics-disable 403 enrichment", () => {
  it("test_DW_3_1_disable_403_gives_friendly_upgrade_message", () => {
    const err = new ApiError(
      403,
      { error: "Disabling analytics requires a paid plan" },
      "API error 403: Disabling analytics requires a paid plan",
    );
    const enriched = enrichAnalyticsError(err, false);
    expect(enriched).toBeInstanceOf(Error);
    // Must NOT be the raw ApiError string
    expect(enriched.message).not.toMatch(/^API error 403:/);
    // Must be friendly and mention upgrade
    expect(enriched.message).toMatch(/upgrade/i);
    expect(enriched.message).toMatch(/analytics/i);
    expect(enriched.message).toMatch(/upubli\.sh\/pricing/);
    // Preserve the server's own message as the lead
    expect(enriched.message).toMatch(/Disabling analytics requires a paid plan/);
  });

  it("test_DW_3_3_enable_true_403_propagates_unchanged", () => {
    // A 403 on a re-enable attempt is not the analytics gate — pass through.
    const err = new ApiError(
      403,
      { error: "Disabling analytics requires a paid plan" },
      "API error 403: Disabling analytics requires a paid plan",
    );
    const result = enrichAnalyticsError(err, true);
    // Same object — not rewritten
    expect(result).toBe(err);
  });

  it("test_DW_3_3_non_403_propagates_unchanged", () => {
    const err = new ApiError(500, { error: "internal server error" }, "API error 500: internal server error");
    const result = enrichAnalyticsError(err, false);
    expect(result).toBe(err);
  });

  it("test_DW_3_3_suspended_user_403_propagates_unchanged", () => {
    // Suspended-user 403 has a different body — must NOT be rewritten as analytics upsell.
    const err = new ApiError(
      403,
      { error: "account_suspended" },
      "API error 403: account_suspended",
    );
    const result = enrichAnalyticsError(err, false);
    // Must be the original error, not the upsell message
    expect(result).toBe(err);
    expect(result.message).not.toMatch(/upgrade/i);
    expect(result.message).not.toMatch(/upubli\.sh\/pricing/);
  });

  it("test_non_api_error_propagates_unchanged", () => {
    // A plain Error (e.g. network failure) is not an ApiError — pass through.
    const err = new Error("fetch failed");
    const result = enrichAnalyticsError(err, false);
    expect(result).toBe(err);
  });
});

// ─── DW-3.1 integration: setAnalyticsEnabled 403 surfaces friendly message ───

describe("setAnalyticsEnabled — 403 analytics gate surfaces friendly message", () => {
  it("test_DW_3_1_setAnalyticsEnabled_disable_403_friendly_throw", async () => {
    const { fetchFn } = recordingFetch([
      // GET sites: success
      { status: 200, body: { sites: [{ id: "s1", slug: "blog", visibility: "public", analytics_enabled: true }] } },
      // PATCH: 403 analytics gate
      { status: 403, body: { error: "Disabling analytics requires a paid plan" } },
    ]);
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const err = await setAnalyticsEnabled(apiClient, NS_ID, "blog", false).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toMatch(/^API error 403:/);
    expect(err.message).toMatch(/upgrade/i);
    expect(err.message).toMatch(/analytics/i);
  });
});

// ─── DW-3.2: enrichPublishError — 403 analytics gate on publish path ─────────

describe("enrichPublishError — 403 analytics gate on publish path", () => {
  it("test_DW_3_2_publish_analytics_disable_403_friendly_message", () => {
    const err = new ApiError(
      403,
      { error: "Disabling analytics requires a paid plan" },
      "API error 403: Disabling analytics requires a paid plan",
    );
    const enriched = enrichPublishError(err);
    expect(enriched).toBeInstanceOf(Error);
    expect(enriched.message).not.toMatch(/^API error 403:/);
    expect(enriched.message).toMatch(/upgrade/i);
    expect(enriched.message).toMatch(/analytics/i);
    expect(enriched.message).toMatch(/upubli\.sh\/pricing/);
  });

  it("test_DW_3_2_publish_402_overage_still_throws_StorageApprovalError", () => {
    // The 402 path must be untouched by the 403 changes.
    const err = new ApiError(
      402,
      {
        code: "needs_storage_approval",
        approval_url: "https://upubli.sh/profile/settings?storage_request=1",
        price: 1.0,
        block_gb: 10,
        blocks_needed: 1,
        interval: "month",
      },
      "API error 402: needs_storage_approval",
    );
    const enriched = enrichPublishError(err);
    expect(enriched).toBeInstanceOf(StorageApprovalError);
    const sae = enriched as StorageApprovalError;
    expect(sae.price).toBe(1.0);
    expect(sae.block_gb).toBe(10);
  });

  it("test_DW_3_3_publish_suspended_user_403_propagates_unchanged", () => {
    // Suspended-user 403 must not be rewritten as analytics upsell.
    const err = new ApiError(
      403,
      { error: "account_suspended" },
      "API error 403: account_suspended",
    );
    const result = enrichPublishError(err);
    expect(result).toBe(err);
    expect(result.message).not.toMatch(/analytics/i);
    expect(result.message).not.toMatch(/upgrade/i);
  });

  it("test_DW_3_3_publish_non_403_propagates_unchanged", () => {
    const err = new ApiError(500, { error: "internal" }, "API error 500: internal");
    const result = enrichPublishError(err);
    expect(result).toBe(err);
  });

  it("test_DW_3_3_publish_403_null_body_propagates_unchanged", () => {
    // 403 with null/missing body (no "analytics" in message) — pass through.
    const err = new ApiError(403, null, "API error 403: Forbidden");
    const result = enrichPublishError(err);
    expect(result).toBe(err);
  });
});
