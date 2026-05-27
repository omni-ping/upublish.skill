/**
 * Tests for ApiClient — HTTP wrapper with token provider.
 *
 * Covers DW-1.7: lib/api-client.ts exports ApiClient class (unchanged from current).
 * Covers DW-1.9: tested with injectable deps (no real network calls).
 */

import { describe, it, expect } from "bun:test";
import { ApiClient } from "./api-client.ts";

const BASE_URL = "https://api.example.com";
const TOKEN = "test-token-abc";

const staticTokenProvider = async () => TOKEN;

/** Creates a mock fetch function that returns the given response. */
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

describe("DW-1.7: ApiClient", () => {
  describe("get", () => {
    it("test_DW_1_7_api_client_get", async () => {
      let capturedUrl = "";
      let capturedHeaders: Record<string, string> = {};

      const fetchFn = async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = Object.fromEntries(
          Object.entries((init?.headers as Record<string, string>) ?? {}),
        );
        return new Response(JSON.stringify({ sites: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
      const result = await client.get<{ sites: [] }>("/api/sites");

      expect(capturedUrl).toBe(`${BASE_URL}/api/sites`);
      expect(capturedHeaders["Authorization"]).toBe(`Bearer ${TOKEN}`);
      expect(result).toEqual({ sites: [] });
    });
  });

  describe("post", () => {
    it("test_DW_1_7_api_client_post", async () => {
      let capturedBody = "";
      let capturedMethod = "";
      let capturedContentType = "";

      const fetchFn = async (url: string, init?: RequestInit) => {
        capturedMethod = init?.method ?? "";
        capturedBody = init?.body as string;
        capturedContentType =
          (init?.headers as Record<string, string>)?.["Content-Type"] ?? "";
        return new Response(
          JSON.stringify({ url: "https://x.upubli.sh/foo/" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
      await client.post<{ url: string }>("/api/generate", { context: "hello" });

      expect(capturedMethod).toBe("POST");
      expect(capturedContentType).toBe("application/json");
      expect(JSON.parse(capturedBody)).toEqual({ context: "hello" });
    });
  });

  describe("put", () => {
    it("test_DW_4_1_api_client_put", async () => {
      let capturedBody = "";
      let capturedMethod = "";
      let capturedContentType = "";

      const fetchFn = async (url: string, init?: RequestInit) => {
        capturedMethod = init?.method ?? "";
        capturedBody = init?.body as string;
        capturedContentType =
          (init?.headers as Record<string, string>)?.["Content-Type"] ?? "";
        return new Response(
          JSON.stringify({ gate: { slug: "test", fields: ["email"] } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
      await client.put<{ gate: { slug: string } }>("/api/sites/test/gate", { fields: ["email"] });

      expect(capturedMethod).toBe("PUT");
      expect(capturedContentType).toBe("application/json");
      expect(JSON.parse(capturedBody)).toEqual({ fields: ["email"] });
    });
  });

  describe("delete", () => {
    it("test_DW_1_7_api_client_delete", async () => {
      let capturedMethod = "";
      let capturedUrl = "";

      const fetchFn = async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedMethod = init?.method ?? "";
        return new Response(JSON.stringify({ message: "deleted" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
      const result = await client.delete<{ message: string }>(
        "/api/sites/my-site",
      );

      expect(capturedUrl).toBe(`${BASE_URL}/api/sites/my-site`);
      expect(capturedMethod).toBe("DELETE");
      expect(result).toEqual({ message: "deleted" });
    });
  });

  describe("error parsing", () => {
    it("test_DW_1_7_api_client_error_parsing", async () => {
      const fetchFn = mockFetch(401, { error: "Unauthorized" });
      const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);

      await expect(client.get("/api/sites")).rejects.toThrow(
        "API error 401: Unauthorized",
      );
    });

    it("falls back to statusText when no error field", async () => {
      const fetchFn = async () =>
        new Response("Internal Server Error", {
          status: 500,
          statusText: "Internal Server Error",
        });
      const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);

      await expect(client.get("/api/sites")).rejects.toThrow("API error 500");
    });

    it("calls token provider before each request", async () => {
      let tokenCallCount = 0;

      const tokenProvider = async () => {
        tokenCallCount++;
        return `token-${tokenCallCount}`;
      };

      const fetchFn = async () =>
        new Response(JSON.stringify({ sites: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      const client = new ApiClient(BASE_URL, tokenProvider, fetchFn);
      await client.get("/api/sites");
      await client.get("/api/sites");
      await client.get("/api/sites");

      expect(tokenCallCount).toBe(3);
    });

    it("propagates token provider errors to callers", async () => {
      const tokenProvider = async () => {
        throw new Error("Keychain unavailable");
      };
      const fetchFn = async () =>
        new Response(JSON.stringify({}), { status: 200 });

      const client = new ApiClient(BASE_URL, tokenProvider, fetchFn);

      await expect(client.get("/api/sites")).rejects.toThrow(
        "Keychain unavailable",
      );
    });
  });

  describe("manifest", () => {
    it("sends files as Record<path, {hash, size}> not as Array", async () => {
      let capturedBody = "";

      const fetchFn = async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(
          JSON.stringify({
            needed: [{ path: "index.html", upload_url: "https://r2.example.com/1" }],
            version: 1,
            session_id: "sess-1",
            base_version: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
      await client.manifest("ns-1", "my-site", {
        files: [
          { path: "index.html", hash: "abc123", size: 100 },
          { path: "about/index.html", hash: "def456", size: 200 },
        ],
      });

      const parsed = JSON.parse(capturedBody);
      // Server expects files as Record<string, {hash, size}> keyed by path
      expect(parsed.files).toEqual({
        "index.html": { hash: "abc123", size: 100 },
        "about/index.html": { hash: "def456", size: 200 },
      });
      // Must NOT be an array
      expect(Array.isArray(parsed.files)).toBe(false);
    });
  });
});
