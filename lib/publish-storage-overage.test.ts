/**
 * Phase 5 tests — storage-pack overage surfacing in the publish flow.
 *
 * Tests the full stack from ApiError → StorageApprovalError → lib/publish.ts
 * → core.publish → MCP publish tool. All network calls are replaced by an
 * injected `fetchFn`; no real HTTP is made.
 *
 * DW items covered:
 *   DW-5.1 — 402 needs_storage_approval → StorageApprovalError with pack language
 *            + server price + approval URL; MCP tool surfaces the same.
 *   DW-5.2 — success-with-storage_overage → PublishResult.storage_overage present;
 *            MCP tool success text is block-denominated.
 *   DW-5.3 — malformed/missing 402 body → pack-language fallback + canonical URL,
 *            no hardcoded price.
 *   DW-5.4 — publish manifest body never contains accept_overage.
 *   DW-5.5 — no stale per-GB / hardcoded-price copy in tool output.
 *
 * Additional edge cases:
 *   - Annual 402 → interval-aware "/yr" suffix in output
 *   - Annual success → interval-aware "/yr" suffix
 *   - 402 with unexpected code → passes through unchanged (not a StorageApprovalError)
 *   - 200 success without storage_overage → no block note in output
 *   - StorageApprovalError carries all nullable fields correctly
 *   - enrichPublishError passes through non-402 errors unchanged
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { StorageApprovalError, enrichPublishError } from "./publish.ts";
import { ApiError } from "./api-client.ts";
import { publish as corePublish } from "./core.ts";
import { createServer } from "../mcp/index.ts";
import type { CoreDeps } from "./core.ts";

// ─── MCP adapter test helpers (mirrors tests/mcp.test.ts pattern) ─────────────

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
const tmpDirs: string[] = [];

afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

function writeTempCreds(token: string): string {
  const p = path.join(os.tmpdir(), `publish-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, token, { mode: 0o600 });
  tmpFiles.push(p);
  return p;
}

function makeTmpSiteDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "publish-storage-site-"));
  tmpDirs.push(dir);
  writeFileSync(path.join(dir, "index.html"), "<h1>Hello</h1>");
  return dir;
}

function makeDeps(fetchFn: CoreDeps["fetchFn"]): CoreDeps {
  return { credentialsPath: writeTempCreds(REFRESH_TOKEN), fetchFn };
}

/**
 * Builds a fetchFn that:
 *   1. Handles token refresh.
 *   2. Handles GET /api/space (default namespace resolution).
 *   3. Handles GET /api/ns (namespace list).
 *   4. Returns `manifestStatus`/`manifestBody` for the manifest call.
 *   5. Returns `finalizeBody` (200) for finalize when supplied.
 * Any presigned PUT calls (upload_url) return 200 immediately.
 */
function mockPublishFetch(opts: {
  manifestStatus: number;
  manifestBody: unknown;
  finalizeBody?: unknown;
  captureManifest?: { body?: Record<string, unknown> };
}) {
  const { manifestStatus, manifestBody, finalizeBody, captureManifest } = opts;

  const spaceBody = { space: { id: "sp-1", default_namespace_id: "ns-1", tier: "pro" } };
  const nsListBody = { namespaces: [{ id: "ns-1", name: "alice", domain: "upubli.sh", role: "owner" }] };

  return async (url: string, init?: RequestInit): Promise<Response> => {
    const urlStr = url as string;

    // Token refresh
    if (urlStr.includes("/auth/token/refresh")) {
      return new Response(
        JSON.stringify({ access_token: "mock-access", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Namespace resolution: GET /api/space
    if (urlStr.includes("/api/space") && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify(spaceBody), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Namespace list: GET /api/ns
    if (urlStr.includes("/api/ns") && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify(nsListBody), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Manifest: POST /api/ns/.../manifest
    if (urlStr.includes("/manifest")) {
      if (captureManifest && init?.body) {
        captureManifest.body = JSON.parse(init.body as string) as Record<string, unknown>;
      }
      return new Response(JSON.stringify(manifestBody), {
        status: manifestStatus,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Finalize: POST /api/ns/.../finalize
    if (urlStr.includes("/finalize") && finalizeBody !== undefined) {
      return new Response(JSON.stringify(finalizeBody), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Presigned R2 PUT (upload_url)
    if (init?.method === "PUT") {
      return new Response("", { status: 200 });
    }

    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  };
}

/** Standard finalize response body. */
const FINALIZE_BODY = {
  site: {
    id: "site-1",
    user_id: "user-1",
    slug: "my-site",
    title: "My Site",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    file_count: 1,
    total_size: 13,
    visibility: "public",
    passcode_hash: null,
  },
  url: "https://alice.upubli.sh/my-site/",
};

// ─── StorageApprovalError ──────────────────────────────────────────────────────

describe("StorageApprovalError", () => {
  it("carries all fields and extends Error", () => {
    const err = new StorageApprovalError(
      "https://upubli.sh/profile/settings?storage_request=1",
      1,
      10,
      2,
      "month",
      "storage pack approval required",
    );
    expect(err.approval_url).toBe("https://upubli.sh/profile/settings?storage_request=1");
    expect(err.price).toBe(1);
    expect(err.block_gb).toBe(10);
    expect(err.blocks_needed).toBe(2);
    expect(err.interval).toBe("month");
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe("StorageApprovalError");
  });

  it("accepts null for all nullable fields (malformed-body fallback)", () => {
    const err = new StorageApprovalError(
      "https://upubli.sh/profile/settings?storage_request=1",
      null,
      null,
      null,
      null,
      "fallback",
    );
    expect(err.price).toBeNull();
    expect(err.block_gb).toBeNull();
    expect(err.blocks_needed).toBeNull();
    expect(err.interval).toBeNull();
  });
});

// ─── enrichPublishError ────────────────────────────────────────────────────────

describe("enrichPublishError", () => {
  it("converts 402 needs_storage_approval ApiError to StorageApprovalError (monthly)", () => {
    const body = {
      code: "needs_storage_approval",
      block_gb: 10,
      blocks_needed: 2,
      price: 1,
      interval: "month",
      approval_url: "https://upubli.sh/profile/settings?storage_request=1",
    };
    const apiErr = new ApiError(402, body, "API error 402: storage approval");
    const result = enrichPublishError(apiErr);
    expect(result).toBeInstanceOf(StorageApprovalError);
    const se = result as StorageApprovalError;
    expect(se.approval_url).toBe("https://upubli.sh/profile/settings?storage_request=1");
    expect(se.price).toBe(1);
    expect(se.block_gb).toBe(10);
    expect(se.blocks_needed).toBe(2);
    expect(se.interval).toBe("month");
  });

  it("converts 402 needs_storage_approval ApiError to StorageApprovalError (annual)", () => {
    const body = {
      code: "needs_storage_approval",
      block_gb: 10,
      blocks_needed: 1,
      price: 10,
      interval: "year",
      approval_url: "https://upubli.sh/profile/settings?storage_request=1",
    };
    const apiErr = new ApiError(402, body, "API error 402: storage approval");
    const result = enrichPublishError(apiErr);
    expect(result).toBeInstanceOf(StorageApprovalError);
    const se = result as StorageApprovalError;
    expect(se.price).toBe(10);
    expect(se.interval).toBe("year");
  });

  it("uses canonical fallback URL when approval_url is missing", () => {
    const body = { code: "needs_storage_approval" };
    const apiErr = new ApiError(402, body, "API error 402: storage approval");
    const result = enrichPublishError(apiErr) as StorageApprovalError;
    expect(result).toBeInstanceOf(StorageApprovalError);
    expect(result.approval_url).toMatch(/upubli\.sh/);
    expect(result.approval_url).toContain("storage_request");
  });

  it("sets pack fields to null when body is missing them (DW-5.3)", () => {
    const body = { code: "needs_storage_approval" };
    const apiErr = new ApiError(402, body, "API error 402: storage approval");
    const result = enrichPublishError(apiErr) as StorageApprovalError;
    expect(result.price).toBeNull();
    expect(result.block_gb).toBeNull();
    expect(result.blocks_needed).toBeNull();
    expect(result.interval).toBeNull();
  });

  it("sets interval to null when value is invalid (DW-5.3)", () => {
    const body = {
      code: "needs_storage_approval",
      price: 1,
      block_gb: 10,
      blocks_needed: 1,
      interval: "quarterly", // invalid
      approval_url: "https://upubli.sh/profile/settings?storage_request=1",
    };
    const apiErr = new ApiError(402, body, "API error 402: storage approval");
    const result = enrichPublishError(apiErr) as StorageApprovalError;
    expect(result.interval).toBeNull();
    // valid fields still come through
    expect(result.price).toBe(1);
    expect(result.block_gb).toBe(10);
  });

  it("passes through non-402 errors unchanged", () => {
    const err = new Error("some other error");
    const result = enrichPublishError(err);
    expect(result).toBe(err);
  });

  it("passes through 402 with unexpected code unchanged", () => {
    const body = { code: "some_other_code", error: "cap" };
    const apiErr = new ApiError(402, body, "API error 402: something");
    const result = enrichPublishError(apiErr);
    expect(result).not.toBeInstanceOf(StorageApprovalError);
    expect(result).toBe(apiErr);
  });

  it("passes through null rawBodyData unchanged", () => {
    const apiErr = new ApiError(402, null, "API error 402: no body");
    const result = enrichPublishError(apiErr);
    expect(result).toBe(apiErr);
  });
});

// ─── DW-5.1: publish() throws StorageApprovalError on 402 ────────────────────

describe("DW-5.1: publish() 402 needs_storage_approval → StorageApprovalError", () => {
  it("test_DW_5_1_publish_402_pack_language_monthly", async () => {
    const body402 = {
      code: "needs_storage_approval",
      limit: 10_737_418_240,
      usage: 12_884_901_888,
      block_gb: 10,
      blocks_needed: 1,
      price: 1,
      interval: "month",
      approval_url: "https://upubli.sh/profile/settings?storage_request=1",
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({ manifestStatus: 402, manifestBody: body402 }));

    try {
      await corePublish({ directory: dir, slug: "my-site" }, deps);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StorageApprovalError);
      const se = err as StorageApprovalError;
      expect(se.approval_url).toBe("https://upubli.sh/profile/settings?storage_request=1");
      expect(se.price).toBe(1);
      expect(se.block_gb).toBe(10);
      expect(se.blocks_needed).toBe(1);
      expect(se.interval).toBe("month");
    }
  });

  it("test_DW_5_1_publish_402_pack_language_annual", async () => {
    const body402 = {
      code: "needs_storage_approval",
      block_gb: 10,
      blocks_needed: 2,
      price: 10,
      interval: "year",
      approval_url: "https://upubli.sh/profile/settings?storage_request=1",
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({ manifestStatus: 402, manifestBody: body402 }));

    try {
      await corePublish({ directory: dir, slug: "my-site" }, deps);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StorageApprovalError);
      const se = err as StorageApprovalError;
      expect(se.price).toBe(10);
      expect(se.interval).toBe("year");
      expect(se.blocks_needed).toBe(2);
    }
  });
});

// ─── DW-5.2: publish() success with storage_overage ──────────────────────────

describe("DW-5.2: publish() success with storage_overage → block-denominated result", () => {
  it("test_DW_5_2_publish_success_storage_overage_monthly", async () => {
    const manifestBody = {
      needed: [],
      version: 2,
      session_id: "sess-1",
      base_version: 1,
      storage_overage: { charged: true, block_gb: 10, blocks: 1, price: 1, interval: "month" },
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({
      manifestStatus: 200,
      manifestBody,
      finalizeBody: FINALIZE_BODY,
    }));

    const result = await corePublish({ directory: dir, slug: "my-site" }, deps);
    expect(result.storage_overage).toBeDefined();
    expect(result.storage_overage?.charged).toBe(true);
    expect(result.storage_overage?.block_gb).toBe(10);
    expect(result.storage_overage?.blocks).toBe(1);
    expect(result.storage_overage?.price).toBe(1);
    expect(result.storage_overage?.interval).toBe("month");
  });

  it("test_DW_5_2_publish_success_storage_overage_annual", async () => {
    const manifestBody = {
      needed: [],
      version: 2,
      session_id: "sess-1",
      base_version: 1,
      storage_overage: { charged: true, block_gb: 10, blocks: 2, price: 10, interval: "year" },
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({
      manifestStatus: 200,
      manifestBody,
      finalizeBody: FINALIZE_BODY,
    }));

    const result = await corePublish({ directory: dir, slug: "my-site" }, deps);
    expect(result.storage_overage?.interval).toBe("year");
    expect(result.storage_overage?.price).toBe(10);
    expect(result.storage_overage?.blocks).toBe(2);
  });

  it("publish success without storage_overage → result.storage_overage is undefined", async () => {
    const manifestBody = {
      needed: [],
      version: 2,
      session_id: "sess-1",
      base_version: 1,
      // no storage_overage field
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({
      manifestStatus: 200,
      manifestBody,
      finalizeBody: FINALIZE_BODY,
    }));

    const result = await corePublish({ directory: dir, slug: "my-site" }, deps);
    expect(result.storage_overage).toBeUndefined();
  });

  it("storage_overage.charged=false → result.storage_overage is undefined", async () => {
    const manifestBody = {
      needed: [],
      version: 2,
      session_id: "sess-1",
      base_version: 1,
      storage_overage: { charged: false, block_gb: 10, blocks: 0, price: 0, interval: "month" },
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({
      manifestStatus: 200,
      manifestBody,
      finalizeBody: FINALIZE_BODY,
    }));

    const result = await corePublish({ directory: dir, slug: "my-site" }, deps);
    expect(result.storage_overage).toBeUndefined();
  });
});

// ─── DW-5.3: malformed/missing 402 body → pack fallback, no hardcoded price ──

describe("DW-5.3: malformed/missing 402 → pack fallback + canonical URL, no hardcoded price", () => {
  it("test_DW_5_3_malformed_402_missing_all_fields_falls_back", async () => {
    const body402 = { code: "needs_storage_approval" };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({ manifestStatus: 402, manifestBody: body402 }));

    try {
      await corePublish({ directory: dir, slug: "my-site" }, deps);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StorageApprovalError);
      const se = err as StorageApprovalError;
      expect(se.approval_url).toMatch(/upubli\.sh/);
      expect(se.approval_url).toContain("storage_request");
      expect(se.price).toBeNull();
      expect(se.block_gb).toBeNull();
      expect(se.blocks_needed).toBeNull();
      expect(se.interval).toBeNull();
    }
  });

  it("test_DW_5_3_malformed_402_invalid_interval_falls_back_to_null", async () => {
    const body402 = {
      code: "needs_storage_approval",
      price: 1,
      block_gb: 10,
      blocks_needed: 1,
      interval: "weekly", // invalid
      approval_url: "https://upubli.sh/profile/settings?storage_request=1",
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({ manifestStatus: 402, manifestBody: body402 }));

    try {
      await corePublish({ directory: dir, slug: "my-site" }, deps);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StorageApprovalError);
      const se = err as StorageApprovalError;
      expect(se.interval).toBeNull(); // invalid interval → null
      expect(se.price).toBe(1);
      expect(se.block_gb).toBe(10);
    }
  });
});

// ─── DW-5.4: publish manifest body never contains accept_overage ──────────────

describe("DW-5.4: publish manifest body never contains accept_overage", () => {
  it("test_DW_5_4_publish_manifest_body_never_contains_accept_overage_normal", async () => {
    const captureManifest: { body?: Record<string, unknown> } = {};
    const manifestBody = {
      needed: [],
      version: 1,
      session_id: "sess-1",
      base_version: null,
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({ manifestStatus: 200, manifestBody, finalizeBody: FINALIZE_BODY, captureManifest }));

    await corePublish({ directory: dir, slug: "my-site" }, deps);
    expect(captureManifest.body).toBeDefined();
    expect(captureManifest.body).not.toHaveProperty("accept_overage");
    // Sanity: slug and files are present
    expect(captureManifest.body).toHaveProperty("files");
  });

  it("test_DW_5_4_publish_manifest_body_never_contains_accept_overage_on_402", async () => {
    const captureManifest: { body?: Record<string, unknown> } = {};
    const body402 = {
      code: "needs_storage_approval",
      block_gb: 10,
      blocks_needed: 1,
      price: 1,
      interval: "month",
      approval_url: "https://upubli.sh/profile/settings?storage_request=1",
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({ manifestStatus: 402, manifestBody: body402, captureManifest }));

    try { await corePublish({ directory: dir, slug: "my-site" }, deps); } catch { /* expected */ }
    expect(captureManifest.body).toBeDefined();
    // DW-5.4: the manifest POST must never include accept_overage
    expect(captureManifest.body).not.toHaveProperty("accept_overage");
  });
});

// ─── MCP publish tool — end-to-end via createServer ──────────────────────────

describe("MCP publish tool — storage overage via createServer", () => {
  it("test_DW_5_1_mcp_publish_tool_402_pack_language_monthly", async () => {
    const body402 = {
      code: "needs_storage_approval",
      block_gb: 10,
      blocks_needed: 1,
      price: 1,
      interval: "month",
      approval_url: "https://upubli.sh/profile/settings?storage_request=1",
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({ manifestStatus: 402, manifestBody: body402 }));
    const tools = getTools(createServer(deps));
    const handler = tools["publish"]?.handler;
    expect(handler).toBeDefined();

    const result = await handler({ directory: dir, slug: "my-site" });
    const text = result.content[0]?.text ?? "";

    // DW-5.1: approval URL must appear in the text
    expect(text).toContain("https://upubli.sh/profile/settings?storage_request=1");
    // Pack language: "Storage pack approval" + price from server + /mo suffix
    expect(text).toContain("Storage pack approval");
    expect(text).toContain("$1.00");
    expect(text).toContain("/mo");
    // DW-5.5: no hardcoded per-GB strings
    expect(text).not.toMatch(/\$0\.\d\d\s*\/\s*gb/i);
    // Must be flagged as an error (action is blocked until approved)
    expect(result.isError).toBe(true);
  });

  it("test_DW_5_1_mcp_publish_tool_402_pack_language_annual", async () => {
    const body402 = {
      code: "needs_storage_approval",
      block_gb: 10,
      blocks_needed: 2,
      price: 10,
      interval: "year",
      approval_url: "https://upubli.sh/profile/settings?storage_request=1",
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({ manifestStatus: 402, manifestBody: body402 }));
    const tools = getTools(createServer(deps));
    const handler = tools["publish"]?.handler;
    const result = await handler({ directory: dir, slug: "my-site" });
    const text = result.content[0]?.text ?? "";

    // Annual: $10.00/yr
    expect(text).toContain("Storage pack approval");
    expect(text).toContain("$10.00");
    expect(text).toContain("/yr");
    expect(result.isError).toBe(true);
  });

  it("test_DW_5_2_mcp_publish_tool_success_with_storage_overage_monthly", async () => {
    const manifestBody = {
      needed: [],
      version: 2,
      session_id: "sess-1",
      base_version: 1,
      storage_overage: { charged: true, block_gb: 10, blocks: 1, price: 1, interval: "month" },
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({
      manifestStatus: 200,
      manifestBody,
      finalizeBody: FINALIZE_BODY,
    }));
    const tools = getTools(createServer(deps));
    const handler = tools["publish"]?.handler;
    const result = await handler({ directory: dir, slug: "my-site" });
    const text = result.content[0]?.text ?? "";

    // DW-5.2: block-denominated: "1 x 10GB storage block" + price
    expect(text).toContain("$1.00");
    expect(text).toContain("/mo");
    expect(text).toContain("10GB");
    // Success message present
    expect(text).toContain("Site published successfully");
    // Not an error
    expect(result.isError).not.toBe(true);
  });

  it("test_DW_5_2_mcp_publish_tool_success_with_storage_overage_annual", async () => {
    const manifestBody = {
      needed: [],
      version: 2,
      session_id: "sess-1",
      base_version: 1,
      storage_overage: { charged: true, block_gb: 10, blocks: 2, price: 10, interval: "year" },
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({
      manifestStatus: 200,
      manifestBody,
      finalizeBody: FINALIZE_BODY,
    }));
    const tools = getTools(createServer(deps));
    const handler = tools["publish"]?.handler;
    const result = await handler({ directory: dir, slug: "my-site" });
    const text = result.content[0]?.text ?? "";

    // Annual: $10.00/yr + 2 blocks
    expect(text).toContain("$10.00");
    expect(text).toContain("/yr");
    expect(text).toContain("2 x 10GB");
    expect(result.isError).not.toBe(true);
  });

  it("test_DW_5_2_mcp_publish_tool_success_without_storage_overage_no_block_note", async () => {
    const manifestBody = {
      needed: [],
      version: 1,
      session_id: "sess-1",
      base_version: null,
      // no storage_overage
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({
      manifestStatus: 200,
      manifestBody,
      finalizeBody: FINALIZE_BODY,
    }));
    const tools = getTools(createServer(deps));
    const handler = tools["publish"]?.handler;
    const result = await handler({ directory: dir, slug: "my-site" });
    const text = result.content[0]?.text ?? "";

    // No overage → no block note
    expect(text).not.toContain("storage block");
    expect(text).toContain("Site published successfully");
    expect(result.isError).not.toBe(true);
  });

  it("test_DW_5_3_mcp_publish_tool_partial_body_no_hardcoded_price", async () => {
    // Malformed 402: has code but no price, block_gb, or interval
    const body402 = { code: "needs_storage_approval" };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({ manifestStatus: 402, manifestBody: body402 }));
    const tools = getTools(createServer(deps));
    const handler = tools["publish"]?.handler;
    const result = await handler({ directory: dir, slug: "my-site" });
    const text = result.content[0]?.text ?? "";

    // Fallback URL present
    expect(text).toMatch(/upubli\.sh/);
    expect(text).toContain("Storage pack approval");
    // No hardcoded price literal
    expect(text).not.toMatch(/\$[0-9]+\.[0-9]+\s*\/mo/);
    expect(text).not.toMatch(/\$[0-9]+\.[0-9]+\s*\/yr/);
    expect(result.isError).toBe(true);
  });

  it("test_DW_5_4_mcp_publish_tool_request_body_never_contains_accept_overage", async () => {
    const captureManifest: { body?: Record<string, unknown> } = {};
    const manifestBody = {
      needed: [],
      version: 1,
      session_id: "sess-1",
      base_version: null,
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({
      manifestStatus: 200,
      manifestBody,
      finalizeBody: FINALIZE_BODY,
      captureManifest,
    }));
    const tools = getTools(createServer(deps));
    const handler = tools["publish"]?.handler;
    await handler({ directory: dir, slug: "my-site" });

    // DW-5.4: accept_overage must NOT appear in the manifest POST body
    expect(captureManifest.body).toBeDefined();
    expect(captureManifest.body).not.toHaveProperty("accept_overage");
  });

  it("test_DW_5_5_no_hardcoded_price_in_402_output", async () => {
    // Any well-formed 402 must not output a $0.xx/GB literal
    const body402 = {
      code: "needs_storage_approval",
      block_gb: 10,
      blocks_needed: 1,
      price: 1,
      interval: "month",
      approval_url: "https://upubli.sh/profile/settings?storage_request=1",
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({ manifestStatus: 402, manifestBody: body402 }));
    const tools = getTools(createServer(deps));
    const handler = tools["publish"]?.handler;
    const result = await handler({ directory: dir, slug: "my-site" });
    const text = result.content[0]?.text ?? "";
    // No per-GB copy (hardcoded)
    expect(text).not.toMatch(/per.{0,5}gb/i);
    // No $0.20 (old address-pack per-address price)
    expect(text).not.toContain("0.20");
  });

  it("test_DW_5_5_no_per_gb_copy_in_success_output", async () => {
    const manifestBody = {
      needed: [],
      version: 2,
      session_id: "sess-1",
      base_version: 1,
      storage_overage: { charged: true, block_gb: 10, blocks: 1, price: 1, interval: "month" },
    };
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({
      manifestStatus: 200,
      manifestBody,
      finalizeBody: FINALIZE_BODY,
    }));
    const tools = getTools(createServer(deps));
    const handler = tools["publish"]?.handler;
    const result = await handler({ directory: dir, slug: "my-site" });
    const text = result.content[0]?.text ?? "";
    // No per-GB copy (hardcoded)
    expect(text).not.toMatch(/per.{0,5}gb/i);
    // No $0.20
    expect(text).not.toContain("0.20");
  });

  it("non-402 publish error passes through unchanged", async () => {
    // 500 error should surface as a generic error, not StorageApprovalError
    const dir = makeTmpSiteDir();
    const deps = makeDeps(mockPublishFetch({
      manifestStatus: 500,
      manifestBody: { error: "internal server error" },
    }));
    const tools = getTools(createServer(deps));
    const handler = tools["publish"]?.handler;
    const result = await handler({ directory: dir, slug: "my-site" });
    const text = result.content[0]?.text ?? "";
    expect(result.isError).toBe(true);
    // Must NOT contain storage-pack copy
    expect(text).not.toContain("Storage pack approval");
    expect(text).not.toContain("storage_request");
  });
});
