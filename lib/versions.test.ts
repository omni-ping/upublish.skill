/**
 * Tests for lib/versions.ts — core version list + delete logic.
 *
 * Covers DW-4.1: lib/versions.ts exports listVersions / deleteVersion that
 * accept ONLY (apiClient, nsId, slug, [versionNumber]) and return structured
 * Results. Verifies exact request paths (GET …/versions, DELETE …/versions/:v)
 * including encodeURIComponent. Tested with an injectable mock ApiClient (no
 * real network calls).
 */

import { describe, it, expect } from "bun:test";
import { listVersions, deleteVersion, setVersionsLimit } from "./versions.ts";
import { ApiClient } from "./api-client.ts";

const BASE_URL = "https://api.example.com";
const TOKEN = "test-token";
const staticTokenProvider = async () => TOKEN;
const NS_ID = "ns-test";

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

// ─── DW-4.1: listVersions ─────────────────────────────────────────────────────

describe("DW-4.1: listVersions", () => {
  it("test_DW_4_1_list_versions_returns_versions", async () => {
    const apiBody = {
      versions: [
        { version_number: 3, status: "live", is_live: true },
        { version_number: 2, status: "archived", is_live: false },
        { version_number: 1, status: "archived", is_live: false },
      ],
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, apiBody));
    const result = await listVersions(apiClient, NS_ID, "my-portfolio");

    expect(result.versions).toHaveLength(3);
    expect(result.versions[0]).toEqual({ version_number: 3, status: "live", is_live: true });
    // status + is_live preserved per version
    expect(result.versions[1].status).toBe("archived");
    expect(result.versions[1].is_live).toBe(false);
  });

  it("test_DW_4_1_list_versions_request_path", async () => {
    let capturedUrl = "";
    let capturedMethod = "";

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return new Response(JSON.stringify({ versions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    // slug with a space exercises encodeURIComponent
    await listVersions(apiClient, NS_ID, "my site");

    expect(capturedMethod).toBe("GET");
    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/my%20site/versions`);
  });

  it("test_DW_4_1_list_versions_validates_slug", async () => {
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, { versions: [] }));
    await expect(listVersions(apiClient, NS_ID, "")).rejects.toThrow("slug is required");
    await expect(listVersions(apiClient, NS_ID, "   ")).rejects.toThrow("slug is required");
  });
});

// ─── DW-4.1: deleteVersion ────────────────────────────────────────────────────

describe("DW-4.1: deleteVersion", () => {
  it("test_DW_4_1_delete_version_returns_usage", async () => {
    const apiBody = {
      version_number: 2,
      freed_bytes: 1048576,
      usage: { used_bytes: 5242880, limit_bytes: 104857600 },
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, apiBody));
    const result = await deleteVersion(apiClient, NS_ID, "my-portfolio", 2);

    expect(result.version_number).toBe(2);
    expect(result.freed_bytes).toBe(1048576);
    expect(result.usage).toEqual({ used_bytes: 5242880, limit_bytes: 104857600 });
  });

  it("test_DW_4_1_delete_version_request_path_encodes", async () => {
    let capturedUrl = "";
    let capturedMethod = "";

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return new Response(
        JSON.stringify({ version_number: 5, freed_bytes: 0, usage: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await deleteVersion(apiClient, NS_ID, "my site", 5);

    expect(capturedMethod).toBe("DELETE");
    // slug AND version are encodeURIComponent'd; version is stringified
    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/my%20site/versions/5`);
  });

  it("test_DW_4_1_delete_version_validates_slug", async () => {
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, {}));
    await expect(deleteVersion(apiClient, NS_ID, "", 1)).rejects.toThrow("slug is required");
    await expect(deleteVersion(apiClient, NS_ID, "   ", 1)).rejects.toThrow("slug is required");
  });

  it("test_DW_4_1_delete_version_validates_version_number", async () => {
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, {}));
    await expect(deleteVersion(apiClient, NS_ID, "site", 0)).rejects.toThrow(
      "versionNumber must be a positive integer",
    );
    await expect(deleteVersion(apiClient, NS_ID, "site", -3)).rejects.toThrow(
      "versionNumber must be a positive integer",
    );
    await expect(deleteVersion(apiClient, NS_ID, "site", 1.5)).rejects.toThrow(
      "versionNumber must be a positive integer",
    );
  });

  it("test_DW_4_1_propagates_api_errors", async () => {
    const listClient = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(404, { error: "Site not found" }));
    await expect(listVersions(listClient, NS_ID, "missing")).rejects.toThrow("API error 404");

    const delClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(409, { error: "Cannot delete the live version" }),
    );
    await expect(deleteVersion(delClient, NS_ID, "site", 3)).rejects.toThrow("API error 409");
  });
});

// ─── DW-3.1 + DW-3.3: setVersionsLimit ───────────────────────────────────────

describe("DW-3.1: setVersionsLimit — domain function", () => {
  it("test_DW_3_1_set_versions_limit_happy_path", async () => {
    const apiBody = {
      site: { max_versions: 5 },
      pruned: [1, 2, 3],
      freed_bytes: 3145728,
      usage: { used_bytes: 10485760, limit_bytes: 104857600 },
    };

    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: unknown;

    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify(apiBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await setVersionsLimit(apiClient, NS_ID, "my-portfolio", 5);

    // Correct HTTP method and URL
    expect(capturedMethod).toBe("PUT");
    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/my-portfolio/versions/limit`);
    // Correct request body
    expect(capturedBody).toEqual({ limit: 5 });
    // Typed result
    expect(result.site.max_versions).toBe(5);
    expect(result.pruned).toEqual([1, 2, 3]);
    expect(result.freed_bytes).toBe(3145728);
    expect(result.usage.used_bytes).toBe(10485760);
  });

  it("test_DW_3_1_set_versions_limit_clear", async () => {
    // limit=null clears the retention limit
    const apiBody = {
      site: { max_versions: null },
      pruned: [],
      freed_bytes: 0,
      usage: { used_bytes: 10485760, limit_bytes: 104857600 },
    };

    let capturedBody: unknown;
    const fetchFn = async (_url: string, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify(apiBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await setVersionsLimit(apiClient, NS_ID, "my-portfolio", null);

    expect(capturedBody).toEqual({ limit: null });
    expect(result.site.max_versions).toBeNull();
    expect(result.pruned).toEqual([]);
    expect(result.freed_bytes).toBe(0);
  });

  it("test_DW_3_1_set_versions_limit_url_encodes_slug", async () => {
    let capturedUrl = "";
    const fetchFn = async (url: string, _init?: RequestInit): Promise<Response> => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ site: { max_versions: 3 }, pruned: [], freed_bytes: 0, usage: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await setVersionsLimit(apiClient, NS_ID, "my site", 3);

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/my%20site/versions/limit`);
  });

  it("test_DW_3_1_validates_slug", async () => {
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, {}));
    await expect(setVersionsLimit(apiClient, NS_ID, "", 5)).rejects.toThrow("slug is required");
    await expect(setVersionsLimit(apiClient, NS_ID, "   ", 5)).rejects.toThrow("slug is required");
  });

  it("test_DW_3_3_backend_400_passthrough", async () => {
    // Backend 400 (e.g. limit=0) is surfaced as an error, not a crash
    const fetchFn = mockFetch(400, { error: "limit must be a positive integer or null" });
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await expect(setVersionsLimit(apiClient, NS_ID, "my-site", 0)).rejects.toThrow("API error 400");
  });

  it("test_DW_3_3_backend_404_unknown_slug_passthrough", async () => {
    const fetchFn = mockFetch(404, { error: "Site not found" });
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await expect(setVersionsLimit(apiClient, NS_ID, "ghost", 3)).rejects.toThrow("API error 404");
  });
});
