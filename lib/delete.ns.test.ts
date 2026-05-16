/**
 * Tests for lib/delete.ts namespace-scoped path.
 *
 * Covers DW-6.4: delete tool scoped to a namespace
 * Covers DW-6.5: API client uses new endpoint paths (/api/ns/:nsId/sites/:slug)
 */

import { describe, it, expect } from "bun:test";
import { deleteSite } from "./delete.ts";
import { ApiClient } from "./api-client.ts";

const BASE_URL = "https://api.example.com";
const TOKEN = "test-token";
const staticTokenProvider = async () => TOKEN;
const NS_ID = "ns-abc123";

// ─── DW-6.4 + DW-6.5: namespace-scoped delete ────────────────────────────────

describe("DW-6.4/6.5: deleteSite with namespace", () => {
  it("test_DW_6_5_delete_uses_ns_path", async () => {
    let capturedUrl = "";
    let capturedMethod = "";

    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return new Response(JSON.stringify({ message: "Site deleted." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await deleteSite(apiClient, NS_ID, "my-site");

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/my-site`);
    expect(capturedMethod).toBe("DELETE");
  });

  it("test_DW_6_4_delete_calls_ns_scoped_endpoint", async () => {
    const fetchFn = async (_url: string, _init?: RequestInit): Promise<Response> =>
      new Response(JSON.stringify({ message: "Site 'my-site' has been deleted." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await deleteSite(apiClient, NS_ID, "my-site");

    expect(result.message).toContain("my-site");
  });

  it("test_DW_6_4_delete_url_encodes_slug", async () => {
    let capturedUrl = "";

    const fetchFn = async (url: string): Promise<Response> => {
      capturedUrl = url;
      return new Response(JSON.stringify({ message: "deleted" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await deleteSite(apiClient, NS_ID, "my site with spaces");

    expect(capturedUrl).toContain("my%20site%20with%20spaces");
  });

  it("test_DW_6_4_delete_propagates_api_errors_with_ns", async () => {
    const fetchFn = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await expect(deleteSite(apiClient, NS_ID, "nonexistent")).rejects.toThrow("API error 404");
  });
});
