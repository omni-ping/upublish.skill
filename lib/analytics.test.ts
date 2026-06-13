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
import { setAnalyticsEnabled } from "./analytics.ts";
import { publish } from "./publish.ts";
import { ApiClient } from "./api-client.ts";

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
