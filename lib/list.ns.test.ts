/**
 * Tests for lib/list.ts namespace-scoped path.
 *
 * Covers DW-6.3: list tool scoped to a namespace
 * Covers DW-6.5: API client uses new endpoint paths (/api/ns/:nsId/sites)
 */

import { describe, it, expect } from "bun:test";
import { listSites } from "./list.ts";
import { ApiClient } from "./api-client.ts";

const BASE_URL = "https://api.example.com";
const TOKEN = "test-token";
const staticTokenProvider = async () => TOKEN;
const NS_ID = "ns-abc123";

function mockFetch(status: number, body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

// ─── DW-6.3 + DW-6.5: namespace-scoped list ──────────────────────────────────

describe("DW-6.3/6.5: listSites with namespace", () => {
  it("test_DW_6_5_list_uses_ns_path", async () => {
    let capturedUrl = "";

    const fetchFn = async (url: string): Promise<Response> => {
      capturedUrl = url;
      return new Response(JSON.stringify({ sites: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await listSites(apiClient, NS_ID);

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites`);
  });

  it("test_DW_6_3_list_calls_ns_scoped_endpoint", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, { sites: [{ id: "1", slug: "test", title: "Test",
        user_id: "u", created_at: "", updated_at: "", file_count: 1,
        total_size: 100, visibility: "public", passcode_hash: null }] }),
    );

    const result = await listSites(apiClient, NS_ID);
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0].slug).toBe("test");
  });

  it("test_DW_6_3_list_propagates_api_errors_with_ns", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(403, { error: "Forbidden" }),
    );

    await expect(listSites(apiClient, NS_ID)).rejects.toThrow("API error 403");
  });
});
