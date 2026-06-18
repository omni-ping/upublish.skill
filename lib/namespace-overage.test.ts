/**
 * Phase 3 tests — overage surfacing in namespace_create.
 *
 * Tests the full stack from ApiError → OverageApprovalError → core.namespaceCreate
 * → MCP namespace_create tool. All network calls are replaced by an injected
 * `fetchFn`; no real HTTP is made.
 *
 * DW items covered:
 *   DW-3.1 — 402 needs_overage_approval → tool text includes approval URL + $0.20/mo
 *   DW-3.2 — 201 overage.charged → tool success text includes cost note
 *   DW-3.3 — request body never contains accept_overage
 *   DW-3.4 — free-tier 403 regression: upgrade message preserved
 *
 * Additional edge cases:
 *   - Malformed/partial 402 body → still returns usable approval message
 *   - 201 without overage field → normal success, no cost note
 *   - ApiError preserves status + rawBodyData
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { namespaceCreate } from "./core.ts";
import { OverageApprovalError } from "./core.ts";
import type { CoreDeps } from "./core.ts";
import { ApiError } from "./api-client.ts";
import { createServer } from "../mcp/index.ts";

// ─── Adapter test helpers (matches tests/ pattern) ────────────────────────────

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type RegisteredTool = {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  inputSchema?: Record<string, unknown>;
};

type RegisteredTools = Record<string, RegisteredTool>;
type InternalServer = { _registeredTools: RegisteredTools };

function getTools(server: ReturnType<typeof createServer>): RegisteredTools {
  return (server as unknown as InternalServer)._registeredTools;
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

const REFRESH_TOKEN = "test-refresh-token";
const tmpFiles: string[] = [];

afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
});

function writeTempCreds(token: string): string {
  const p = path.join(os.tmpdir(), `ns-overage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, token, { mode: 0o600 });
  tmpFiles.push(p);
  return p;
}

/** Builds a fetchFn that handles the token-refresh first, then returns the given status/body. */
function mockFetch(status: number, body: unknown) {
  return async (url: string): Promise<Response> => {
    if ((url as string).includes("/auth/token/refresh")) {
      return new Response(
        JSON.stringify({ access_token: "mock-access", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/**
 * Builds a fetchFn that captures the POST /api/ns request body for inspection,
 * then returns the given status/body.
 */
function mockFetchCapture(status: number, responseBody: unknown) {
  let capturedBody: unknown = undefined;
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    if ((url as string).includes("/auth/token/refresh")) {
      return new Response(
        JSON.stringify({ access_token: "mock-access", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (init?.body) {
      capturedBody = JSON.parse(init.body as string) as unknown;
    }
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchFn, getCaptured: () => capturedBody };
}

function makeDeps(fetchFn: CoreDeps["fetchFn"]): CoreDeps {
  return { credentialsPath: writeTempCreds(REFRESH_TOKEN), fetchFn };
}

// ─── ApiError ─────────────────────────────────────────────────────────────────

describe("ApiError", () => {
  it("preserves status and rawBodyData", () => {
    const body = { code: "needs_overage_approval", approval_url: "https://example.com" };
    const err = new ApiError(402, body, "API error 402: needs approval");
    expect(err.status).toBe(402);
    expect(err.rawBodyData).toBe(body);
    expect(err.message).toBe("API error 402: needs approval");
    expect(err instanceof Error).toBe(true);
  });

  it("ApiError is an instanceof Error", () => {
    const err = new ApiError(500, null, "API error 500: internal");
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe("ApiError");
  });
});

// ─── OverageApprovalError ──────────────────────────────────────────────────────

describe("OverageApprovalError", () => {
  it("carries approval_url and price, extends Error", () => {
    const err = new OverageApprovalError("https://upubli.sh/profile/settings?overage_request=1", 0.2, "needs approval");
    expect(err.approval_url).toBe("https://upubli.sh/profile/settings?overage_request=1");
    expect(err.price).toBe(0.2);
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe("OverageApprovalError");
  });
});

// ─── DW-3.1: 402 needs_overage_approval ───────────────────────────────────────

describe("DW-3.1: 402 needs_overage_approval", () => {
  it("test_DW_3_1_402_throws_OverageApprovalError_with_approval_url_and_price", async () => {
    const body402 = {
      code: "needs_overage_approval",
      error: "Namespace limit reached",
      limit: 1,
      usage: 1,
      price: 0.2,
      approval_url: "https://upubli.sh/profile/settings?overage_request=1",
    };
    const deps = makeDeps(mockFetch(402, body402));

    await expect(namespaceCreate("myns", undefined, deps)).rejects.toThrow(OverageApprovalError);

    // Second call to inspect fields
    const deps2 = makeDeps(mockFetch(402, body402));
    try {
      await namespaceCreate("myns", undefined, deps2);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OverageApprovalError);
      const overageErr = err as OverageApprovalError;
      expect(overageErr.approval_url).toBe("https://upubli.sh/profile/settings?overage_request=1");
      expect(overageErr.price).toBe(0.2);
    }
  });

  it("test_DW_3_1_402_malformed_body_missing_approval_url_falls_back", async () => {
    // Malformed: code present but missing approval_url and price
    const body402 = { code: "needs_overage_approval", error: "cap reached" };
    const deps = makeDeps(mockFetch(402, body402));

    try {
      await namespaceCreate("myns", undefined, deps);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OverageApprovalError);
      const overageErr = err as OverageApprovalError;
      // Must fall back to a usable URL, not empty/undefined
      expect(overageErr.approval_url).toMatch(/upubli\.sh/);
      expect(overageErr.price).toBe(0.2); // default
    }
  });

  it("test_DW_3_1_402_code_in_error_field_still_produces_overage_error", async () => {
    // Alternate form: code not present but error message contains the code string
    const body402 = { error: "needs_overage_approval" };
    const deps = makeDeps(mockFetch(402, body402));

    try {
      await namespaceCreate("myns", undefined, deps);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OverageApprovalError);
      const overageErr = err as OverageApprovalError;
      expect(overageErr.approval_url).toBeTruthy();
    }
  });
});

// ─── DW-3.2: 201 overage.charged ──────────────────────────────────────────────

describe("DW-3.2: 201 with overage.charged", () => {
  it("test_DW_3_2_201_overage_charged_result_carries_overage_field", async () => {
    const body201 = {
      namespace: { id: "ns-overage-1", name: "myns", domain: "upubli.sh" },
      overage: { charged: true, price: 0.2 },
    };
    const deps = makeDeps(mockFetch(201, body201));

    const result = await namespaceCreate("myns", undefined, deps);
    expect(result.namespace_id).toBe("ns-overage-1");
    expect(result.domain).toBe("upubli.sh");
    expect(result.overage).toEqual({ charged: true, price: 0.2 });
  });

  it("test_DW_3_2_201_no_overage_field_returns_no_overage", async () => {
    const body201 = {
      namespace: { id: "ns-normal-1", name: "myns", domain: "upubli.sh" },
      // no overage field
    };
    const deps = makeDeps(mockFetch(201, body201));

    const result = await namespaceCreate("myns", undefined, deps);
    expect(result.overage).toBeUndefined();
  });

  it("test_DW_3_2_201_overage_charged_false_returns_no_overage", async () => {
    // overage present but charged:false → should NOT include the overage field in result
    const body201 = {
      namespace: { id: "ns-4", name: "myns", domain: "upubli.sh" },
      overage: { charged: false, price: 0 },
    };
    const deps = makeDeps(mockFetch(201, body201));
    const result = await namespaceCreate("myns", undefined, deps);
    // charged: false → the condition `overage?.charged === true` is false, so omitted
    expect(result.overage).toBeUndefined();
  });
});

// ─── DW-3.3: request body never contains accept_overage ───────────────────────

describe("DW-3.3: request body never contains accept_overage", () => {
  it("test_DW_3_3_request_body_never_contains_accept_overage_on_normal_create", async () => {
    const body201 = { namespace: { id: "ns-1", name: "alice", domain: "upubli.sh" } };
    const { fetchFn, getCaptured } = mockFetchCapture(201, body201);
    const deps = makeDeps(fetchFn);

    await namespaceCreate("alice", undefined, deps);
    const captured = getCaptured() as Record<string, unknown>;
    expect(captured).not.toHaveProperty("accept_overage");
  });

  it("test_DW_3_3_request_body_never_contains_accept_overage_on_402", async () => {
    const body402 = {
      code: "needs_overage_approval",
      error: "cap",
      price: 0.2,
      approval_url: "https://upubli.sh/profile/settings?overage_request=1",
    };
    const { fetchFn, getCaptured } = mockFetchCapture(402, body402);
    const deps = makeDeps(fetchFn);

    try { await namespaceCreate("alice", undefined, deps); } catch { /* expected */ }
    const captured = getCaptured() as Record<string, unknown>;
    // DW-3.3: no accept_overage in the request body
    expect(captured).not.toHaveProperty("accept_overage");
    // Sanity: name IS present
    expect(captured).toHaveProperty("name", "alice");
  });
});

// ─── DW-3.4: free-tier 403 regression ─────────────────────────────────────────

describe("DW-3.4: free-tier 403 regression", () => {
  it("test_DW_3_4_regression_free_tier_403_includes_upgrade_url", async () => {
    // Match the real backend message format (contains "limit")
    const body403 = { error: "Namespace limit reached. Your plan allows 1 namespace(s)." };
    const deps = makeDeps(mockFetch(403, body403));

    try {
      await namespaceCreate("alice", undefined, deps);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).not.toBeInstanceOf(OverageApprovalError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/403/);
      expect(msg).toMatch(/limit/i);
      expect(msg).toMatch(/upubli\.sh\/pricing/);
    }
  });

  it("test_DW_3_4_regression_403_non_limit_passes_through_unchanged", async () => {
    // 403 that is NOT a tier limit (cert gate, admin block, etc.)
    const body403 = { error: "Access denied" };
    const deps = makeDeps(mockFetch(403, body403));

    try {
      await namespaceCreate("alice", undefined, deps);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).not.toBeInstanceOf(OverageApprovalError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/403/);
      // Should NOT append the upgrade URL — it's not a tier-limit error
      expect(msg).not.toMatch(/Upgrade at/);
    }
  });
});

// ─── MCP tool handler — end-to-end via createServer ───────────────────────────
// Uses the `_registeredTools` pattern from tests/mcp.ns.test.ts.

describe("MCP namespace_create tool — overage via createServer", () => {
  it("test_DW_3_1_mcp_tool_402_text_contains_approval_url_and_price", async () => {
    const body402 = {
      code: "needs_overage_approval",
      error: "Namespace limit reached",
      limit: 1,
      usage: 1,
      price: 0.2,
      approval_url: "https://upubli.sh/profile/settings?overage_request=1",
    };
    const deps = makeDeps(mockFetch(402, body402));
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;
    expect(handler).toBeDefined();

    const result = await handler({ name: "myns" });
    const text = result.content[0]?.text ?? "";

    // DW-3.1: approval URL must appear in the text
    expect(text).toContain("https://upubli.sh/profile/settings?overage_request=1");
    // DW-3.1: $0.20/mo must appear in the text
    expect(text).toMatch(/\$0\.20\/mo/);
    // Must be flagged as an error (action is blocked until approved)
    expect(result.isError).toBe(true);
  });

  it("test_DW_3_1_mcp_tool_402_partial_body_still_returns_usable_message", async () => {
    // Malformed body — no approval_url, no price
    const body402 = { code: "needs_overage_approval", error: "cap reached" };
    const deps = makeDeps(mockFetch(402, body402));
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;
    expect(handler).toBeDefined();

    const result = await handler({ name: "myns" });
    const text = result.content[0]?.text ?? "";

    // Must include a URL (the fallback) and a price (the default)
    expect(text).toMatch(/upubli\.sh/);
    expect(text).toMatch(/\$0\.20\/mo/);
    expect(result.isError).toBe(true);
  });

  it("test_DW_3_2_mcp_tool_201_overage_charged_text_includes_cost_note", async () => {
    const body201 = {
      namespace: { id: "ns-overage-2", name: "myns", domain: "upubli.sh" },
      overage: { charged: true, price: 0.2 },
    };
    const deps = makeDeps(mockFetch(201, body201));
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;
    expect(handler).toBeDefined();

    const result = await handler({ name: "myns" });
    const text = result.content[0]?.text ?? "";

    // DW-3.2: cost note must appear in success text
    expect(text).toContain("+$0.20/mo");
    expect(text).toContain("Address created.");
    expect(result.isError).not.toBe(true);
  });

  it("test_DW_3_2_mcp_tool_201_no_overage_no_cost_note", async () => {
    const body201 = { namespace: { id: "ns-2", name: "myns", domain: "upubli.sh" } };
    const deps = makeDeps(mockFetch(201, body201));
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;
    expect(handler).toBeDefined();

    const result = await handler({ name: "myns" });
    const text = result.content[0]?.text ?? "";

    // Normal create: no cost note
    expect(text).not.toMatch(/\/mo/);
    expect(text).toContain("Address created.");
  });

  it("test_DW_3_3_mcp_tool_request_body_never_contains_accept_overage", async () => {
    const body201 = { namespace: { id: "ns-3", name: "bob", domain: "upubli.sh" } };
    const { fetchFn, getCaptured } = mockFetchCapture(201, body201);
    const deps = makeDeps(fetchFn);
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;
    expect(handler).toBeDefined();

    await handler({ name: "bob" });
    const captured = getCaptured() as Record<string, unknown>;

    // DW-3.3: accept_overage must NOT appear in the captured POST body
    expect(captured).not.toHaveProperty("accept_overage");
    expect(captured).toHaveProperty("name", "bob");
  });

  it("test_DW_3_4_mcp_tool_free_tier_403_yields_upgrade_message", async () => {
    const body403 = { error: "Namespace limit reached. Your plan allows 1 namespace(s)." };
    const deps = makeDeps(mockFetch(403, body403));
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;
    expect(handler).toBeDefined();

    const result = await handler({ name: "alice" });
    const text = result.content[0]?.text ?? "";

    // DW-3.4: upgrade path must appear; NOT an overage-approval message
    expect(text).toMatch(/pricing|upgrade/i);
    expect(text).not.toContain("approval_url");
    // The text is the error message with the upgrade URL appended
    expect(text).toContain("upubli.sh/pricing");
    expect(result.isError).toBe(true);
  });
});
