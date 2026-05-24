/**
 * Tests for lib/promote.ts — domain promote function.
 *
 * Covers DW-3.6: lib/promote.ts exports a promote(apiClient, nsId, slug) function
 * Covers DW-3.7: core.ts exports a promote(slug, namespace?, deps?) function
 */

import { describe, it, expect } from "bun:test";
import { promote, type PromoteResult } from "./promote.ts";
import { ApiClient } from "./api-client.ts";

const BASE_URL = "https://api.example.com";
const TOKEN = "test-token";
const staticTokenProvider = async () => TOKEN;

const LIVE_URL = "https://testuser.upubli.sh/my-site/";

// ─── DW-3.6: promote(apiClient, nsId, slug) ──────────────────────────────────

describe("DW-3.6: promote domain function", () => {
  it("test_DW_3_6_promote_posts_to_correct_endpoint", async () => {
    let capturedUrl = "";
    let capturedMethod = "";

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return new Response(
        JSON.stringify({ url: LIVE_URL }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await promote(apiClient, "ns-test", "my-site");

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/ns-test/sites/my-site/promote`);
    expect(capturedMethod).toBe("POST");
  });

  it("test_DW_3_6_promote_returns_url", async () => {
    const fetchFn = async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ url: LIVE_URL }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result: PromoteResult = await promote(apiClient, "ns-test", "my-site");

    expect(result.url).toBe(LIVE_URL);
  });

  it("test_DW_3_6_promote_encodes_slug_in_url", async () => {
    let capturedUrl = "";

    const fetchFn = async (url: string, _init?: RequestInit) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ url: "https://testuser.upubli.sh/my%20site/" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await promote(apiClient, "ns-test", "my site");

    // Slug must be URL-encoded
    expect(capturedUrl).toContain("my%20site");
  });

  it("test_DW_3_6_promote_throws_on_api_error", async () => {
    const fetchFn = async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ error: "No staging version to promote" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await expect(promote(apiClient, "ns-test", "my-site")).rejects.toThrow(
      "No staging version to promote",
    );
  });
});
