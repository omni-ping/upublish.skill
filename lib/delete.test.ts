/**
 * Tests for lib/delete.ts — core site deletion logic.
 *
 * Covers DW-1.4: lib/delete.ts exports deleteSite(slug) that returns { message }.
 * Covers DW-1.9: tested with injectable deps (no real network calls).
 */

import { describe, it, expect } from "bun:test";
import { deleteSite } from "./delete.ts";
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

const NS_ID = "ns-test";

describe("DW-1.4: deleteSite", () => {
  it("test_DW_1_4_delete_site_returns_message", async () => {
    let capturedUrl = "";
    let capturedMethod = "";

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return new Response(
        JSON.stringify({ message: "Site 'my-portfolio' deleted successfully" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await deleteSite(apiClient, NS_ID, "my-portfolio");

    expect(result.message).toBe("Site 'my-portfolio' deleted successfully");
    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/my-portfolio`);
    expect(capturedMethod).toBe("DELETE");
  });

  it("test_DW_1_4_delete_site_validates_slug", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, {}),
    );

    await expect(deleteSite(apiClient, NS_ID, "")).rejects.toThrow("slug is required");
    await expect(deleteSite(apiClient, NS_ID, "   ")).rejects.toThrow(
      "slug is required",
    );
  });

  it("test_DW_1_4_delete_site_propagates_errors", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(404, { error: "Site not found" }),
    );

    await expect(deleteSite(apiClient, NS_ID, "missing-site")).rejects.toThrow(
      "API error 404",
    );
  });

  it("URL-encodes the slug in the request path", async () => {
    let capturedUrl = "";

    const fetchFn = async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ message: "deleted" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await deleteSite(apiClient, NS_ID, "my site");

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/my%20site`);
  });
});
