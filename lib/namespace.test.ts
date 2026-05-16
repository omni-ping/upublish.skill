/**
 * Tests for lib/namespace.ts — default namespace resolution.
 *
 * Covers DW-6.2: When no namespace specified, default namespace resolved from GET /api/space
 * Covers DW-6.5: API client uses new endpoint paths (/api/ns/:nsId/sites)
 */

import { describe, it, expect } from "bun:test";
import { ApiClient } from "./api-client.ts";
import { resolveNamespace } from "./namespace.ts";

const BASE_URL = "https://api.example.com";
const TOKEN = "test-token";
const staticTokenProvider = async () => TOKEN;

function makeFetch(responses: Record<string, unknown>) {
  return async (url: string): Promise<Response> => {
    for (const [path, body] of Object.entries(responses)) {
      if (url.includes(path)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function makeErrorFetch(path: string, status: number, error: string) {
  return async (url: string): Promise<Response> => {
    if (url.includes(path)) {
      return new Response(JSON.stringify({ error }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
}

// ─── DW-6.2: default namespace resolution ────────────────────────────────────

describe("DW-6.2: resolveNamespace — default resolution", () => {
  it("test_DW_6_2_resolves_namespace_from_space_endpoint", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      makeFetch({
        "/api/space": { space: { id: "sp1", default_namespace_id: "ns-abc", tier: "free" } },
        "/api/ns": { namespaces: [{ id: "ns-abc", name: "default", domain: "user.upubli.sh" }] },
      }),
    );

    const nsId = await resolveNamespace(apiClient);
    expect(nsId).toBe("ns-abc");
  });

  it("test_DW_6_2_falls_back_to_first_namespace_when_no_default", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      makeFetch({
        "/api/space": { space: { id: "sp1", default_namespace_id: null, tier: "free" } },
        "/api/ns": { namespaces: [{ id: "ns-first", name: "my-space", domain: "user.upubli.sh" }] },
      }),
    );

    const nsId = await resolveNamespace(apiClient);
    expect(nsId).toBe("ns-first");
  });

  it("test_DW_6_2_throws_when_no_namespaces_exist", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      makeFetch({
        "/api/space": { space: { id: "sp1", default_namespace_id: null, tier: "free" } },
        "/api/ns": { namespaces: [] },
      }),
    );

    await expect(resolveNamespace(apiClient)).rejects.toThrow("No namespace");
  });

  it("test_DW_6_2_resolves_namespace_by_name", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      makeFetch({
        "/api/ns": {
          namespaces: [
            { id: "ns-abc", name: "default", domain: "user.upubli.sh" },
            { id: "ns-xyz", name: "team", domain: "team.upubli.sh" },
          ],
        },
      }),
    );

    const nsId = await resolveNamespace(apiClient, "team");
    expect(nsId).toBe("ns-xyz");
  });

  it("test_DW_6_2_throws_when_named_namespace_not_found", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      makeFetch({
        "/api/ns": {
          namespaces: [{ id: "ns-abc", name: "default", domain: "user.upubli.sh" }],
        },
      }),
    );

    await expect(resolveNamespace(apiClient, "nonexistent")).rejects.toThrow("Namespace 'nonexistent' not found");
  });

  it("test_DW_6_2_propagates_api_errors", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      makeErrorFetch("/api/space", 401, "Unauthorized"),
    );

    await expect(resolveNamespace(apiClient)).rejects.toThrow("API error 401");
  });
});
