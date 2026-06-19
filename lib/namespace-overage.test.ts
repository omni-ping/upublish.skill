/**
 * Phase 5 tests — overage surfacing (pack language) in namespace_create.
 *
 * Tests the full stack from ApiError → OverageApprovalError → core.namespaceCreate
 * → MCP namespace_create tool. All network calls are replaced by an injected
 * `fetchFn`; no real HTTP is made.
 *
 * DW items covered:
 *   DW-5.1 — 402 needs_overage_approval → tool text uses pack language + server price + approval URL
 *   DW-5.2 — 201 overage.charged → tool success text is pack-denominated
 *   DW-5.3 — malformed/partial 402 body → pack wording + canonical URL, no $0.20
 *   DW-5.4 — request body never contains accept_overage
 *   DW-5.5 — no $0.20/per-address string in tool output
 *
 * Additional edge cases:
 *   - Annual 402 → interval-aware "/yr" suffix in output
 *   - Annual 201 success → interval-aware "/yr" suffix
 *   - 402 with unexpected code → passed through unchanged
 *   - 201 without overage field → normal success, no pack note
 *   - ApiError preserves status + rawBodyData
 *   - Free-tier 403 regression: upgrade message preserved
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
  it("carries approval_url, price, pack_size, interval — extends Error", () => {
    const err = new OverageApprovalError(
      "https://upubli.sh/profile/settings?overage_request=1",
      1,
      5,
      "month",
      "pack approval required",
    );
    expect(err.approval_url).toBe("https://upubli.sh/profile/settings?overage_request=1");
    expect(err.price).toBe(1);
    expect(err.pack_size).toBe(5);
    expect(err.interval).toBe("month");
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe("OverageApprovalError");
  });

  it("accepts null for price, pack_size, and interval (malformed-body fallback)", () => {
    const err = new OverageApprovalError(
      "https://upubli.sh/profile/settings?overage_request=1",
      null,
      null,
      null,
      "pack approval required",
    );
    expect(err.price).toBeNull();
    expect(err.pack_size).toBeNull();
    expect(err.interval).toBeNull();
  });
});

// ─── DW-5.1: 402 needs_overage_approval — pack language + server price + URL ──

describe("DW-5.1: 402 needs_overage_approval throws OverageApprovalError with pack fields", () => {
  it("test_DW_5_1_monthly_402_carries_pack_fields", async () => {
    const body402 = {
      code: "needs_overage_approval",
      error: "Address limit reached",
      limit: 1,
      usage: 1,
      pack_size: 5,
      price: 1,
      interval: "month",
      approval_url: "https://upubli.sh/profile/settings?overage_request=1",
    };
    const deps = makeDeps(mockFetch(402, body402));

    try {
      await namespaceCreate("myns", undefined, deps);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OverageApprovalError);
      const overageErr = err as OverageApprovalError;
      expect(overageErr.approval_url).toBe("https://upubli.sh/profile/settings?overage_request=1");
      expect(overageErr.price).toBe(1);
      expect(overageErr.pack_size).toBe(5);
      expect(overageErr.interval).toBe("month");
    }
  });

  it("test_DW_5_1_annual_402_carries_pack_fields_interval_year", async () => {
    const body402 = {
      code: "needs_overage_approval",
      error: "Address limit reached",
      limit: 1,
      usage: 1,
      pack_size: 5,
      price: 10,
      interval: "year",
      approval_url: "https://upubli.sh/profile/settings?overage_request=1",
    };
    const deps = makeDeps(mockFetch(402, body402));

    try {
      await namespaceCreate("myns", undefined, deps);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OverageApprovalError);
      const overageErr = err as OverageApprovalError;
      expect(overageErr.price).toBe(10);
      expect(overageErr.pack_size).toBe(5);
      expect(overageErr.interval).toBe("year");
    }
  });
});

// ─── DW-5.2: success-with-overage is pack-denominated ─────────────────────────

describe("DW-5.2: 201 with overage.charged carries pack fields", () => {
  it("test_DW_5_2_201_overage_charged_carries_pack_fields_monthly", async () => {
    const body201 = {
      namespace: { id: "ns-overage-1", name: "myns", domain: "upubli.sh" },
      overage: { charged: true, price: 1, pack_size: 5, interval: "month" },
    };
    const deps = makeDeps(mockFetch(201, body201));

    const result = await namespaceCreate("myns", undefined, deps);
    expect(result.namespace_id).toBe("ns-overage-1");
    expect(result.overage).toEqual({ charged: true, price: 1, pack_size: 5, interval: "month" });
  });

  it("test_DW_5_2_201_overage_charged_carries_pack_fields_annual", async () => {
    const body201 = {
      namespace: { id: "ns-overage-2", name: "myns", domain: "upubli.sh" },
      overage: { charged: true, price: 10, pack_size: 5, interval: "year" },
    };
    const deps = makeDeps(mockFetch(201, body201));

    const result = await namespaceCreate("myns", undefined, deps);
    expect(result.overage).toEqual({ charged: true, price: 10, pack_size: 5, interval: "year" });
  });

  it("test_DW_5_2_201_no_overage_field_returns_no_overage", async () => {
    const body201 = {
      namespace: { id: "ns-normal-1", name: "myns", domain: "upubli.sh" },
      // no overage field
    };
    const deps = makeDeps(mockFetch(201, body201));

    const result = await namespaceCreate("myns", undefined, deps);
    expect(result.overage).toBeUndefined();
  });

  it("test_DW_5_2_201_overage_charged_false_returns_no_overage", async () => {
    // overage present but charged:false → omitted from result
    const body201 = {
      namespace: { id: "ns-4", name: "myns", domain: "upubli.sh" },
      overage: { charged: false, price: 0, pack_size: 5, interval: "month" },
    };
    const deps = makeDeps(mockFetch(201, body201));
    const result = await namespaceCreate("myns", undefined, deps);
    expect(result.overage).toBeUndefined();
  });
});

// ─── DW-5.3: malformed 402 → pack fallback, no $0.20 ─────────────────────────

describe("DW-5.3: malformed/partial 402 body → pack wording + canonical URL, no $0.20", () => {
  it("test_DW_5_3_malformed_402_missing_all_pack_fields_falls_back", async () => {
    // Body has code but no approval_url, price, pack_size, or interval
    const body402 = { code: "needs_overage_approval", error: "cap reached" };
    const deps = makeDeps(mockFetch(402, body402));

    try {
      await namespaceCreate("myns", undefined, deps);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OverageApprovalError);
      const overageErr = err as OverageApprovalError;
      // Canonical fallback URL must be present
      expect(overageErr.approval_url).toMatch(/upubli\.sh/);
      // Pack fields are null — no hardcoded $0.20
      expect(overageErr.price).toBeNull();
      expect(overageErr.pack_size).toBeNull();
      expect(overageErr.interval).toBeNull();
    }
  });

  it("test_DW_5_3_malformed_402_invalid_interval_falls_back_to_null", async () => {
    // interval is an unexpected value
    const body402 = {
      code: "needs_overage_approval",
      price: 1,
      pack_size: 5,
      interval: "quarterly", // invalid
      approval_url: "https://upubli.sh/profile/settings?overage_request=1",
    };
    const deps = makeDeps(mockFetch(402, body402));

    try {
      await namespaceCreate("myns", undefined, deps);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OverageApprovalError);
      const overageErr = err as OverageApprovalError;
      // invalid interval → null (not a string passthrough)
      expect(overageErr.interval).toBeNull();
      // valid price and pack_size still come through
      expect(overageErr.price).toBe(1);
      expect(overageErr.pack_size).toBe(5);
    }
  });

  it("test_DW_5_3_code_in_error_field_still_produces_overage_error", async () => {
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
      expect(overageErr.price).toBeNull();
    }
  });
});

// ─── DW-5.4: request body never contains accept_overage ──────────────────────

describe("DW-5.4: request body never contains accept_overage", () => {
  it("test_DW_5_4_request_body_never_contains_accept_overage_on_normal_create", async () => {
    const body201 = { namespace: { id: "ns-1", name: "alice", domain: "upubli.sh" } };
    const { fetchFn, getCaptured } = mockFetchCapture(201, body201);
    const deps = makeDeps(fetchFn);

    await namespaceCreate("alice", undefined, deps);
    const captured = getCaptured() as Record<string, unknown>;
    expect(captured).not.toHaveProperty("accept_overage");
  });

  it("test_DW_5_4_request_body_never_contains_accept_overage_on_402", async () => {
    const body402 = {
      code: "needs_overage_approval",
      error: "cap",
      price: 1,
      pack_size: 5,
      interval: "month",
      approval_url: "https://upubli.sh/profile/settings?overage_request=1",
    };
    const { fetchFn, getCaptured } = mockFetchCapture(402, body402);
    const deps = makeDeps(fetchFn);

    try { await namespaceCreate("alice", undefined, deps); } catch { /* expected */ }
    const captured = getCaptured() as Record<string, unknown>;
    // DW-5.4: no accept_overage in the request body
    expect(captured).not.toHaveProperty("accept_overage");
    // Sanity: name IS present
    expect(captured).toHaveProperty("name", "alice");
  });
});

// ─── Free-tier 403 regression ─────────────────────────────────────────────────

describe("Free-tier 403 regression", () => {
  it("regression_free_tier_403_includes_upgrade_url", async () => {
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

  it("regression_403_non_limit_passes_through_unchanged", async () => {
    const body403 = { error: "Access denied" };
    const deps = makeDeps(mockFetch(403, body403));

    try {
      await namespaceCreate("alice", undefined, deps);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).not.toBeInstanceOf(OverageApprovalError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/403/);
      expect(msg).not.toMatch(/Upgrade at/);
    }
  });
});

// ─── MCP tool handler — end-to-end via createServer ───────────────────────────
// Uses the `_registeredTools` pattern from tests/mcp.ns.test.ts.

describe("MCP namespace_create tool — overage via createServer", () => {
  it("test_DW_5_1_mcp_tool_402_pack_language_monthly", async () => {
    const body402 = {
      code: "needs_overage_approval",
      error: "Address limit reached",
      limit: 1,
      usage: 1,
      pack_size: 5,
      price: 1,
      interval: "month",
      approval_url: "https://upubli.sh/profile/settings?overage_request=1",
    };
    const deps = makeDeps(mockFetch(402, body402));
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;
    expect(handler).toBeDefined();

    const result = await handler({ name: "myns" });
    const text = result.content[0]?.text ?? "";

    // DW-5.1: approval URL must appear in the text
    expect(text).toContain("https://upubli.sh/profile/settings?overage_request=1");
    // DW-5.1: pack language — "pack" must appear; price from server; /mo suffix
    expect(text).toContain("pack");
    expect(text).toContain("$1.00");
    expect(text).toContain("/mo");
    // DW-5.5: no $0.20 in output
    expect(text).not.toContain("0.20");
    // Must be flagged as an error (action is blocked until approved)
    expect(result.isError).toBe(true);
  });

  it("test_DW_5_1_mcp_tool_402_pack_language_annual", async () => {
    const body402 = {
      code: "needs_overage_approval",
      error: "Address limit reached",
      limit: 1,
      usage: 1,
      pack_size: 5,
      price: 10,
      interval: "year",
      approval_url: "https://upubli.sh/profile/settings?overage_request=1",
    };
    const deps = makeDeps(mockFetch(402, body402));
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;
    expect(handler).toBeDefined();

    const result = await handler({ name: "myns" });
    const text = result.content[0]?.text ?? "";

    // DW-5.1: pack language with annual price
    expect(text).toContain("pack");
    expect(text).toContain("$10.00");
    expect(text).toContain("/yr");
    // DW-5.5: no $0.20 in output
    expect(text).not.toContain("0.20");
    expect(result.isError).toBe(true);
  });

  it("test_DW_5_3_mcp_tool_402_partial_body_pack_wording_no_0_20", async () => {
    // Malformed body — no approval_url, no price, no pack_size, no interval
    const body402 = { code: "needs_overage_approval", error: "cap reached" };
    const deps = makeDeps(mockFetch(402, body402));
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;
    expect(handler).toBeDefined();

    const result = await handler({ name: "myns" });
    const text = result.content[0]?.text ?? "";

    // Must include a URL (the fallback) and pack wording
    expect(text).toMatch(/upubli\.sh/);
    expect(text).toContain("pack");
    // DW-5.3/5.5: no hardcoded $0.20
    expect(text).not.toContain("0.20");
    expect(result.isError).toBe(true);
  });

  it("test_DW_5_5_no_0_20_string_in_mcp_output_402", async () => {
    // Any well-formed 402 must not output $0.20
    const body402 = {
      code: "needs_overage_approval",
      pack_size: 5,
      price: 1,
      interval: "month",
      approval_url: "https://upubli.sh/profile/settings?overage_request=1",
    };
    const deps = makeDeps(mockFetch(402, body402));
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;
    const result = await handler({ name: "myns" });
    const text = result.content[0]?.text ?? "";
    expect(text).not.toContain("0.20");
    expect(text).not.toMatch(/per.*address/i);
  });

  it("test_DW_5_2_mcp_tool_success_overage_pack_monthly", async () => {
    const body201 = {
      namespace: { id: "ns-overage-2", name: "myns", domain: "upubli.sh" },
      overage: { charged: true, price: 1, pack_size: 5, interval: "month" },
    };
    const deps = makeDeps(mockFetch(201, body201));
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;
    expect(handler).toBeDefined();

    const result = await handler({ name: "myns" });
    const text = result.content[0]?.text ?? "";

    // DW-5.2: pack-denominated success — pack language and server-returned price
    expect(text).toContain("pack");
    expect(text).toContain("$1.00");
    expect(text).toContain("/mo");
    expect(text).toContain("Address created.");
    // DW-5.5: no $0.20
    expect(text).not.toContain("0.20");
    expect(result.isError).not.toBe(true);
  });

  it("test_DW_5_2_mcp_tool_success_overage_pack_annual", async () => {
    const body201 = {
      namespace: { id: "ns-overage-3", name: "myns", domain: "upubli.sh" },
      overage: { charged: true, price: 10, pack_size: 5, interval: "year" },
    };
    const deps = makeDeps(mockFetch(201, body201));
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;
    const result = await handler({ name: "myns" });
    const text = result.content[0]?.text ?? "";

    // Annual: /yr suffix, server-returned price
    expect(text).toContain("$10.00");
    expect(text).toContain("/yr");
    expect(text).not.toContain("0.20");
    expect(result.isError).not.toBe(true);
  });

  it("test_DW_5_5_no_0_20_string_in_success", async () => {
    // A successful overage create must not output $0.20
    const body201 = {
      namespace: { id: "ns-5", name: "myns", domain: "upubli.sh" },
      overage: { charged: true, price: 1, pack_size: 5, interval: "month" },
    };
    const deps = makeDeps(mockFetch(201, body201));
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;
    const result = await handler({ name: "myns" });
    const text = result.content[0]?.text ?? "";
    expect(text).not.toContain("0.20");
    expect(text).not.toMatch(/per.*address/i);
  });

  it("test_DW_5_2_mcp_tool_201_no_overage_no_pack_note", async () => {
    const body201 = { namespace: { id: "ns-2", name: "myns", domain: "upubli.sh" } };
    const deps = makeDeps(mockFetch(201, body201));
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;
    const result = await handler({ name: "myns" });
    const text = result.content[0]?.text ?? "";

    // Normal create: no pack note, no cost
    expect(text).not.toContain("pack");
    expect(text).not.toMatch(/\/mo|\/yr/);
    expect(text).toContain("Address created.");
  });

  it("test_DW_5_4_mcp_tool_request_body_never_contains_accept_overage", async () => {
    const body201 = { namespace: { id: "ns-3", name: "bob", domain: "upubli.sh" } };
    const { fetchFn, getCaptured } = mockFetchCapture(201, body201);
    const deps = makeDeps(fetchFn);
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;
    expect(handler).toBeDefined();

    await handler({ name: "bob" });
    const captured = getCaptured() as Record<string, unknown>;

    // DW-5.4: accept_overage must NOT appear in the captured POST body
    expect(captured).not.toHaveProperty("accept_overage");
    expect(captured).toHaveProperty("name", "bob");
  });

  it("test_DW_5_4_mcp_tool_402_request_body_never_contains_accept_overage", async () => {
    const body402 = {
      code: "needs_overage_approval",
      price: 1,
      pack_size: 5,
      interval: "month",
      approval_url: "https://upubli.sh/profile/settings?overage_request=1",
    };
    const { fetchFn, getCaptured } = mockFetchCapture(402, body402);
    const deps = makeDeps(fetchFn);
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;

    await handler({ name: "myns" });
    const captured = getCaptured() as Record<string, unknown>;
    expect(captured).not.toHaveProperty("accept_overage");
  });

  it("regression_mcp_tool_free_tier_403_yields_upgrade_message", async () => {
    const body403 = { error: "Namespace limit reached. Your plan allows 1 namespace(s)." };
    const deps = makeDeps(mockFetch(403, body403));
    const tools = getTools(createServer(deps));
    const handler = tools["namespace_create"]?.handler;
    expect(handler).toBeDefined();

    const result = await handler({ name: "alice" });
    const text = result.content[0]?.text ?? "";

    expect(text).toMatch(/pricing|upgrade/i);
    expect(text).toContain("upubli.sh/pricing");
    expect(text).not.toContain("approval_url");
    expect(result.isError).toBe(true);
  });
});
