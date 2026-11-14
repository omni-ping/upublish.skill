/**
 * Tests for ApiClient — HTTP wrapper with token provider.
 *
 * Covers DW-1.7: lib/api-client.ts exports ApiClient class (unchanged from current).
 * Covers DW-1.9: tested with injectable deps (no real network calls).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient, ApiError } from "./api-client.ts";

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

  describe("put with a sensitive body", () => {
    // The client logs to ~/.upublish/publish.log: use a temp HOME so this never touches the real one.
    const realHome = process.env.HOME;
    let tempHome = "";
    beforeAll(() => {
      tempHome = mkdtempSync(join(tmpdir(), "api-client-home-"));
      process.env.HOME = tempHome;
    });
    afterAll(() => {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      rmSync(tempHome, { recursive: true, force: true });
    });
    const logFile = () => join(process.env.HOME!, ".upublish", "publish.log");
    const size = () => (existsSync(logFile()) ? statSync(logFile()).size : 0);
    const tail = (from: number) => (existsSync(logFile()) ? readFileSync(logFile()).subarray(from).toString("utf-8") : "");

    it("test_DW_6_1_sensitive_put_error_body_is_not_logged_but_the_error_still_carries_it", async () => {
      const MARK = "SENSITIVE-ECHO-7c2d";
      const client = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(400, { error: MARK, code: "invalid_request" }));
      const from = size();
      const err = await client.put("/x", { value: "v" }, { sensitive: true }).catch((e: ApiError) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).message).toContain(MARK); // callers redact; the client only withholds the log
      expect(tail(from)).toContain("[api] status=400 body=<omitted: request carried a secret>");
      expect(tail(from)).not.toContain(MARK);
    });

    it("a default put still logs the error body", async () => {
      const MARK = "DEFAULT-LOGGED-3f9a";
      const client = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(400, { error: MARK }));
      const from = size();
      await client.put("/x", {}).catch(() => undefined);
      expect(tail(from)).toContain(MARK);
    });
  });

  describe("patch", () => {
    it("test_DW_4_1_api_client_patch_sends_patch_with_json_body", async () => {
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody = "";
      let capturedContentType = "";

      const fetchFn = async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedMethod = init?.method ?? "";
        capturedBody = init?.body as string;
        capturedContentType =
          (init?.headers as Record<string, string>)?.["Content-Type"] ?? "";
        return new Response(
          JSON.stringify({ member: { user_id: "u1", role: "admin" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
      const result = await client.patch<{ member: { user_id: string; role: string } }>(
        "/api/ns/ns1/members/u1",
        { role: "admin" },
      );

      expect(capturedUrl).toBe(`${BASE_URL}/api/ns/ns1/members/u1`);
      expect(capturedMethod).toBe("PATCH");
      expect(capturedContentType).toBe("application/json");
      expect(JSON.parse(capturedBody)).toEqual({ role: "admin" });
      expect(result.member.role).toBe("admin");
    });

    it("test_DW_4_1_api_client_patch_propagates_non_2xx", async () => {
      const fetchFn = mockFetch(403, { error: "Forbidden" });
      const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
      await expect(
        client.patch("/api/ns/ns1/members/u1", { role: "user" }),
      ).rejects.toThrow("API error 403");
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

// ─── getRaw (streaming GET) ──────────────────────────────────────────────────

describe("ApiClient.getRaw", () => {
  it("test_DW_6_1_get_raw_returns_unconsumed_response_with_bearer", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fetchFn = async (url: string, init?: RequestInit) => {
      seen = { url, headers: init?.headers as Record<string, string> };
      return new Response("line1\nline2\n", { status: 200 });
    };
    const res = await new ApiClient(BASE_URL, staticTokenProvider, fetchFn).getRaw("/export");
    expect(seen!.url).toBe(`${BASE_URL}/export`);
    expect(seen!.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(res.bodyUsed).toBe(false);
    expect(await res.text()).toBe("line1\nline2\n");
  });

  it("test_DW_6_1_get_raw_throws_api_error_with_status_and_parsed_body_on_non_2xx", async () => {
    const client = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(403, { error: "no", code: "forbidden" }));
    const err = await client.getRaw("/export").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).rawBodyData).toEqual({ error: "no", code: "forbidden" });
    expect((err as ApiError).message).toBe("API error 403: no");
  });

  it("test_DW_6_1_get_raw_non_json_error_body_falls_back_to_status_text", async () => {
    const client = new ApiClient(BASE_URL, staticTokenProvider, async () => new Response("<html>", { status: 502, statusText: "Bad Gateway" }));
    const err = await client.getRaw("/export").catch((e: unknown) => e);
    expect((err as ApiError).message).toBe("API error 502: Bad Gateway");
    expect((err as ApiError).rawBodyData).toBeNull();
  });
});

describe("ApiError.retryAfterSeconds (site export 429 handling)", () => {
  const failWith = (headers: Record<string, string>): Promise<ApiError> =>
    new ApiClient(BASE_URL, staticTokenProvider, async () => new Response(JSON.stringify({ error: "slow" }), { status: 429, headers }))
      .get("/x")
      .then(() => { throw new Error("expected a 429"); }, (e: unknown) => e as ApiError);

  it("parses a numeric Retry-After header", async () => {
    expect((await failWith({ "Retry-After": "7" })).retryAfterSeconds).toBe(7);
  });

  it("is undefined when the header is absent, blank, negative or not a number", async () => {
    for (const h of [{} as Record<string, string>, { "Retry-After": "  " }, { "Retry-After": "-3" }, { "Retry-After": "soon" }]) {
      expect((await failWith(h)).retryAfterSeconds).toBeUndefined();
    }
  });
});
