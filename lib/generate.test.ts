/**
 * Tests for lib/generate.ts — core diagram generation logic.
 *
 * Covers DW-1.5: lib/generate.ts exports generate(opts) that returns { url, slug }.
 * Covers DW-1.9: tested with injectable deps (no real network calls).
 */

import { describe, it, expect } from "bun:test";
import { generate } from "./generate.ts";
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

describe("DW-1.5: generate", () => {
  it("test_DW_1_5_generate_returns_url_and_slug", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: Record<string, unknown> = {};

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      capturedBody = JSON.parse(init?.body as string) as Record<
        string,
        unknown
      >;
      return new Response(
        JSON.stringify({
          url: "https://upubli.sh/my-diagram/",
          slug: "my-diagram",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await generate({
      apiClient,
      context: "A user authentication flow",
    });

    expect(result.url).toBe("https://upubli.sh/my-diagram/");
    expect(result.slug).toBe("my-diagram");
    expect(capturedUrl).toBe(`${BASE_URL}/api/generate`);
    expect(capturedMethod).toBe("POST");
    expect(capturedBody.context).toBe("A user authentication flow");
  });

  it("test_DW_1_5_generate_validates_context", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, {}),
    );

    await expect(
      generate({ apiClient, context: "" }),
    ).rejects.toThrow("context is required");

    await expect(
      generate({ apiClient, context: "   " }),
    ).rejects.toThrow("context is required");
  });

  it("test_DW_1_5_generate_passes_optional_params", async () => {
    let capturedBody: Record<string, unknown> = {};

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as Record<
        string,
        unknown
      >;
      return new Response(
        JSON.stringify({
          url: "https://upubli.sh/seq-diag/",
          slug: "seq-diag",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await generate({
      apiClient,
      context: "Login flow",
      diagramType: "sequence",
      slug: "seq-diag",
    });

    expect(capturedBody.diagramType).toBe("sequence");
    expect(capturedBody.slug).toBe("seq-diag");
    expect(capturedBody.context).toBe("Login flow");
  });

  it("test_DW_1_5_generate_propagates_errors", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(500, { error: "AI service unavailable" }),
    );

    await expect(
      generate({ apiClient, context: "A flowchart" }),
    ).rejects.toThrow("API error 500");
  });

  it("omits optional fields from request body when not provided", async () => {
    let capturedBody: Record<string, unknown> = {};

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as Record<
        string,
        unknown
      >;
      return new Response(
        JSON.stringify({ url: "https://upubli.sh/auto/", slug: "auto" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await generate({ apiClient, context: "A simple flowchart" });

    expect(capturedBody.diagramType).toBeUndefined();
    expect(capturedBody.slug).toBeUndefined();
  });
});
