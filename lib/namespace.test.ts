/**
 * Tests for lib/namespace.ts — default namespace resolution.
 *
 * Covers DW-6.2: When no namespace specified, default namespace resolved from GET /api/space
 * Covers DW-6.5: API client uses new endpoint paths (/api/ns/:nsId/sites)
 * Covers DW-1.1: Namespace type exported from lib/types.ts
 * Covers DW-1.2: resolveNamespace() returns Namespace object
 */

import { describe, it, expect } from "bun:test";
import { ApiClient } from "./api-client.ts";
import { resolveNamespace, resolveNamespaceRef } from "./namespace.ts";
import type { Namespace } from "./types.ts";

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

// ─── DW-1.1: Namespace type exported from lib/types.ts ──────────────────────

describe("DW-1.1: Namespace type", () => {
  it("test_DW_1_1_namespace_type_exported_from_types", () => {
    // Compile-time verification: Namespace type can be used as a type annotation.
    // If Namespace is not exported from types.ts, this file will fail to compile.
    const ns: Namespace = { id: "ns-1", name: "test", domain: "test.upubli.sh" };
    expect(ns.id).toBe("ns-1");
    expect(ns.name).toBe("test");
    expect(ns.domain).toBe("test.upubli.sh");
  });
});

// ─── DW-1.2: resolveNamespace returns Namespace object ──────────────────────

describe("DW-1.2: resolveNamespace returns Namespace object", () => {
  it("test_DW_1_2_resolveNamespace_default_returns_namespace_object", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      makeFetch({
        "/api/space": { space: { id: "sp1", default_namespace_id: "ns-abc", tier: "free" } },
        "/api/ns": { namespaces: [{ id: "ns-abc", name: "default", domain: "user.upubli.sh" }] },
      }),
    );

    const ns = await resolveNamespace(apiClient);
    expect(ns).toEqual({ id: "ns-abc", name: "default", domain: "user.upubli.sh" });
  });

  it("test_DW_1_2_resolveNamespace_by_name_returns_namespace_object", async () => {
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

    const ns = await resolveNamespace(apiClient, "team");
    expect(ns).toEqual({ id: "ns-xyz", name: "team", domain: "team.upubli.sh" });
  });

  it("test_DW_1_2_resolveDefault_fallback_returns_namespace_object", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      makeFetch({
        "/api/space": { space: { id: "sp1", default_namespace_id: null, tier: "free" } },
        "/api/ns": { namespaces: [{ id: "ns-first", name: "my-space", domain: "my.upubli.sh" }] },
      }),
    );

    const ns = await resolveNamespace(apiClient);
    expect(ns).toEqual({ id: "ns-first", name: "my-space", domain: "my.upubli.sh" });
  });
});

// ─── DW-6.2: default namespace resolution (updated for Namespace return) ────

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

    const ns = await resolveNamespace(apiClient);
    expect(ns.id).toBe("ns-abc");
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

    const ns = await resolveNamespace(apiClient);
    expect(ns.id).toBe("ns-first");
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

    const ns = await resolveNamespace(apiClient, "team");
    expect(ns.id).toBe("ns-xyz");
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

// ─── DW-1.1: resolveNamespaceRef — name-or-UUID resolution ──────────────────

describe("DW-1.1: resolveNamespaceRef resolves by name, then by id", () => {
  const TWO_NAMESPACES = {
    "/api/ns": {
      namespaces: [
        { id: "ns-abc", name: "ryan", domain: "ryan.upubli.sh" },
        { id: "ns-xyz", name: "team", domain: "team.upubli.sh" },
      ],
    },
  };

  it("test_DW_1_1_resolveNamespaceRef_resolves_by_name", async () => {
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, makeFetch(TWO_NAMESPACES));

    const ns = await resolveNamespaceRef(apiClient, "ryan");
    expect(ns).toEqual({ id: "ns-abc", name: "ryan", domain: "ryan.upubli.sh" });
  });

  it("test_DW_1_1_resolveNamespaceRef_resolves_by_id_when_uuid_passed", async () => {
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, makeFetch(TWO_NAMESPACES));

    // Passing the UUID (the historically-documented usage) must still resolve.
    const ns = await resolveNamespaceRef(apiClient, "ns-xyz");
    expect(ns).toEqual({ id: "ns-xyz", name: "team", domain: "team.upubli.sh" });
  });

  it("test_DW_1_1_resolveNamespaceRef_name_match_wins_over_id_match", async () => {
    // Edge case: a ref that is some namespace's name AND another's id → name wins
    // (name is tried first). "alias" is ns-2's name and also ns-1's literal id.
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      makeFetch({
        "/api/ns": {
          namespaces: [
            { id: "alias", name: "first", domain: "first.upubli.sh" },
            { id: "ns-2", name: "alias", domain: "alias.upubli.sh" },
          ],
        },
      }),
    );

    const ns = await resolveNamespaceRef(apiClient, "alias");
    expect(ns.id).toBe("ns-2"); // matched by name, not by the id "alias"
  });

  it("test_DW_1_1_resolveNamespaceRef_throws_actionable_when_unknown", async () => {
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, makeFetch(TWO_NAMESPACES));

    await expect(resolveNamespaceRef(apiClient, "nope")).rejects.toThrow(
      "Namespace 'nope' not found. Available namespaces: ryan, team",
    );
  });

  it("test_DW_1_1_resolveNamespaceRef_throws_none_hint_when_no_namespaces", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      makeFetch({ "/api/ns": { namespaces: [] } }),
    );

    await expect(resolveNamespaceRef(apiClient, "ryan")).rejects.toThrow(
      "Namespace 'ryan' not found. Available namespaces: (none)",
    );
  });
});
