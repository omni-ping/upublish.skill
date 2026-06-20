/**
 * Phase 5 tests — namespaceCreate (POST /api/ns) core function.
 *
 * Covers:
 *   DW-5.3 — namespaceCreate returns {namespace_id, domain} on success; taken,
 *            invalid, and tier-limit errors surface as actionable messages
 *            (the tier-limit case names the plan limit + upgrade guidance).
 */

import { describe, it, expect } from "bun:test";
import { namespaceCreate } from "./namespace.ts";
import { ApiClient } from "./api-client.ts";

const BASE_URL = "https://api.example.com";
const TOKEN = "test-token";
const staticTokenProvider = async () => TOKEN;

/** Returns a fetch that responds once with the given status + JSON body. */
function mockFetch(status: number, body: unknown, capture?: { url?: string; body?: Record<string, unknown> }) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (capture) {
      capture.url = url;
      if (init?.body) capture.body = JSON.parse(init.body as string) as Record<string, unknown>;
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function clientWith(fetchFn: (url: string, init?: RequestInit) => Promise<Response>): ApiClient {
  return new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
}

// ─── DW-5.3: success ──────────────────────────────────────────────────────────

describe("DW-5.3: namespaceCreate success", () => {
  it("test_DW_5_3_create_success", async () => {
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    const client = clientWith(
      mockFetch(201, { namespace: { id: "ns-new-1", name: "alice", domain: "upubli.sh" } }, capture),
    );

    const result = await namespaceCreate(client, "alice", "upubli.sh");

    expect(capture.url).toBe(`${BASE_URL}/api/ns`);
    expect(capture.body).toEqual({ name: "alice", domain: "upubli.sh" });
    expect(result).toEqual({ namespace_id: "ns-new-1", domain: "upubli.sh" });
  });

  it("test_DW_5_3_defaults_platform_domain", async () => {
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    const client = clientWith(
      mockFetch(201, { namespace: { id: "ns-2", name: "bob", domain: "upubli.sh" } }, capture),
    );

    const result = await namespaceCreate(client, "bob");

    expect(capture.body?.domain).toBe("upubli.sh");
    expect(result.domain).toBe("upubli.sh");
  });
});

// ─── DW-5.3: structured, actionable errors ────────────────────────────────────

describe("DW-5.3: namespaceCreate error mapping", () => {
  it("test_DW_5_3_taken_error", async () => {
    const client = clientWith(
      mockFetch(409, { error: "Namespace 'alice' on domain 'upubli.sh' is already taken" }),
    );
    await expect(namespaceCreate(client, "alice")).rejects.toThrow(/already taken/i);
  });

  it("test_DW_5_3_invalid_name_error", async () => {
    const client = clientWith(
      mockFetch(400, { error: "Invalid namespace name format. Must be 3–63 characters: lowercase letters, numbers, and hyphens only. Cannot start or end with a hyphen." }),
    );
    await expect(namespaceCreate(client, "-bad-")).rejects.toThrow(/Invalid namespace name/i);
  });

  it("test_DW_5_3_reserved_name_error", async () => {
    const client = clientWith(
      mockFetch(422, { error: "This namespace name is reserved and cannot be used." }),
    );
    await expect(namespaceCreate(client, "admin")).rejects.toThrow(/reserved/i);
  });

  it("test_DW_5_3_tier_limit_actionable", async () => {
    const client = clientWith(
      mockFetch(403, {
        error: "Root namespace limit reached. Your plan allows 1 root namespace(s).",
        limit: 1,
        usage: 1,
      }),
    );

    // The message must name the limit AND point at the upgrade path.
    let caught: Error | null = null;
    try {
      await namespaceCreate(client, "second-ns");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/limit/i);
    expect(caught!.message).toMatch(/upgrade/i);
    expect(caught!.message).toMatch(/upubli\.sh\/pricing/i);
  });

  it("test_DW_5_3_generic_error_propagated", async () => {
    // A non-classified status still surfaces the backend's error text.
    const client = clientWith(mockFetch(404, { error: "Space not found for user" }));
    await expect(namespaceCreate(client, "x")).rejects.toThrow(/Space not found/i);
  });
});

// ─── DW-2.4: namespace_create tier-limit 403 → run-`upgrade` hint ─────────────

describe("DW-2.4: namespaceCreate tier-limit 403 includes the upgrade-tool hint", () => {
  it("test_DW_2_4_namespace_create_tier_limit_403_adds_upgrade_hint", async () => {
    const client = clientWith(
      mockFetch(403, {
        error: "Root namespace limit reached. Your plan allows 1 root namespace(s).",
        limit: 1,
        usage: 1,
      }),
    );

    let caught: Error | null = null;
    try {
      await namespaceCreate(client, "second-ns");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    // The hint must tell the agent to run the `upgrade` tool (DW-2.4).
    expect(caught!.message).toMatch(/run the `upgrade` tool/i);
  });

  it("test_DW_2_4_namespace_create_hard_max_403_no_hint", async () => {
    // A hard_max 403 (1 TiB ceiling) carries `code: "hard_max"`; an upgrade
    // cannot lift it, so neither the pricing line nor the tool hint applies.
    const client = clientWith(
      mockFetch(403, {
        error: "Storage ceiling reached. limit exceeded.",
        code: "hard_max",
        limit: 1,
        usage: 2,
      }),
    );

    let caught: Error | null = null;
    try {
      await namespaceCreate(client, "second-ns");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    // Even though the text contains "limit", the hard_max code excludes the hints.
    expect(caught!.message).not.toMatch(/run the `upgrade` tool/i);
    expect(caught!.message).not.toMatch(/upubli\.sh\/pricing/i);
  });
});
