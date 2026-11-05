/**
 * Tests for lib/list.ts — core site listing logic.
 *
 * Covers DW-1.3: lib/list.ts exports listSites() that returns { sites: Site[] }.
 * Covers DW-1.9: tested with injectable deps (no real network calls).
 */

import { describe, it, expect } from "bun:test";
import { listSites, readSiteVisibility } from "./list.ts";
import { ApiClient } from "./api-client.ts";

const BASE_URL = "https://api.example.com";
const TOKEN = "test-token";
const staticTokenProvider = async () => TOKEN;

function mockFetch(
  status: number,
  body: unknown,
): (url: string, init?: RequestInit) => Promise<Response> {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

const SITE_A = {
  id: "uuid-a",
  user_id: "user-1",
  slug: "portfolio",
  title: "My Portfolio",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-03-15T00:00:00Z",
  file_count: 5,
  total_size: 10240,
  visibility: "public" as const,
  passcode_hash: null,
  url: "https://user.upubli.sh/portfolio/",
};

const SITE_B = {
  id: "uuid-b",
  user_id: "user-1",
  slug: "project-docs",
  title: "Project Docs",
  created_at: "2026-02-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
  file_count: 12,
  total_size: 2097152,
  visibility: "public" as const,
  passcode_hash: null,
  url: "https://user.upubli.sh/project-docs/",
};

describe("DW-1.3: listSites", () => {
  it("test_DW_1_3_list_sites_returns_sites_array", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, { sites: [SITE_A, SITE_B] }),
    );

    const result = await listSites(apiClient, "ns-test");

    expect(result.sites).toHaveLength(2);
    expect(result.sites[0].slug).toBe("portfolio");
    expect(result.sites[1].slug).toBe("project-docs");
  });

  it("test_DW_1_3_list_sites_returns_empty_array", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, { sites: [] }),
    );

    const result = await listSites(apiClient, "ns-test");
    expect(result.sites).toHaveLength(0);
  });

  it("test_DW_1_3_list_sites_propagates_api_errors", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(500, { error: "Internal server error" }),
    );

    await expect(listSites(apiClient, "ns-test")).rejects.toThrow("API error 500");
  });

  it("sends GET to /api/ns/:nsId/sites", async () => {
    let capturedUrl = "";
    let capturedMethod = "";

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return new Response(JSON.stringify({ sites: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await listSites(apiClient, "ns-test");

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/ns-test/sites`);
    expect(capturedMethod).toBe("GET");
  });

  it("preserves site visibility in response", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, { sites: [SITE_B] }),
    );

    const result = await listSites(apiClient, "ns-test");
    expect(result.sites[0].visibility).toBe("public");
  });
});

describe("readSiteVisibility", () => {
  it("test_DW_2_8_returns_the_named_sites_visibility_among_several", async () => {
    const api = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, { sites: [{ slug: "a", visibility: "public" }, { slug: "b", visibility: "gated" }] }),
    );
    expect(await readSiteVisibility(api, "ns-test", "b")).toBe("gated");
  });

  it("test_DW_2_8_missing_slug_says_not_found_and_couldnt_read", async () => {
    const api = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, { sites: [] }));
    const err = (await readSiteVisibility(api, "ns-test", "x").catch((e: Error) => e)) as Error;
    expect(err.message).toContain("not found");
    expect(err.message).toContain("couldn't read the site's current visibility");
  });

  it("test_DW_2_8_missing_or_unknown_visibility_field_refuses_instead_of_guessing", async () => {
    for (const site of [{ slug: "x" }, { slug: "x", visibility: "banana" }, { slug: "x", visibility: null }]) {
      const api = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, { sites: [site] }));
      await expect(readSiteVisibility(api, "ns-test", "x")).rejects.toThrow("couldn't read the site's current visibility");
    }
  });

  it("test_response_without_sites_array_is_treated_as_not_found", async () => {
    const api = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, {}));
    await expect(readSiteVisibility(api, "ns-test", "x")).rejects.toThrow("not found");
  });

  it("test_api_failure_propagates", async () => {
    const api = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(500, { error: "down" }));
    await expect(readSiteVisibility(api, "ns-test", "x")).rejects.toThrow("API error 500");
  });
});
