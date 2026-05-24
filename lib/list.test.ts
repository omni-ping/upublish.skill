/**
 * Tests for lib/list.ts — core site listing logic.
 *
 * Covers DW-1.3: lib/list.ts exports listSites() that returns { sites: Site[] }.
 * Covers DW-1.9: tested with injectable deps (no real network calls).
 */

import { describe, it, expect } from "bun:test";
import { listSites } from "./list.ts";
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
