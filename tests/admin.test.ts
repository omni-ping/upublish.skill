/**
 * Admin MCP tool tests.
 *
 * Covers DW-7.1: tool count is 16 without UPUBLISH_ADMIN, 21 with it
 * Covers DW-7.2: mcp/index.ts imports only lib/core.ts (no direct lib/admin.ts import)
 * Covers DW-7.4: UPUBLISH_ADMIN=1 unauthenticated → standard "not authenticated" path
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { createServer } from "../mcp/index.ts";
import type { CoreDeps } from "../lib/core.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type RegisteredTool = {
  handler: (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;
};

type RegisteredTools = Record<string, RegisteredTool>;
type InternalServer = { _registeredTools: RegisteredTools };

function getTools(server: ReturnType<typeof createServer>): RegisteredTools {
  return (server as unknown as InternalServer)._registeredTools;
}

function writeTempCredentials(token: string): string {
  const tmpFile = path.join(
    os.tmpdir(),
    `admin-test-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(tmpFile, token, { mode: 0o600 });
  return tmpFile;
}

function makeMockFetch(apiResponse: unknown = {}) {
  return async (url: string, _init?: RequestInit): Promise<Response> => {
    if (url.includes("/auth/token/refresh")) {
      return new Response(
        JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/api/space") || url.includes("/api/space?")) {
      return new Response(
        JSON.stringify({
          space: { id: "sp1", default_namespace_id: "ns-default", tier: "free" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
      return new Response(
        JSON.stringify({
          namespaces: [{ id: "ns-default", name: "default", domain: "user.upubli.sh" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(apiResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function makeDeps(fetchFn = makeMockFetch()): { credFile: string; deps: CoreDeps } {
  const credFile = writeTempCredentials("test-refresh-token");
  return { credFile, deps: { credentialsPath: credFile, fetchFn } };
}

// Save and restore UPUBLISH_ADMIN around each test
let savedAdminEnv: string | undefined;
beforeEach(() => {
  savedAdminEnv = process.env.UPUBLISH_ADMIN;
});
afterEach(() => {
  if (savedAdminEnv === undefined) {
    delete process.env.UPUBLISH_ADMIN;
  } else {
    process.env.UPUBLISH_ADMIN = savedAdminEnv;
  }
});

// ─── DW-7.1: tool count 18 without env var, 23 with ─────────────────────────

describe("DW-7.1: tool count 18 without UPUBLISH_ADMIN, 23 with it", () => {
  test("test_DW_7_1_without_env_var_18_tools", () => {
    delete process.env.UPUBLISH_ADMIN;
    const { deps, credFile } = makeDeps();
    const server = createServer(deps);
    const tools = getTools(server);
    // Base tools: publish, list, delete, versions_list, versions_delete, versions_limit,
    // passcode_add, passcode_list, passcode_revoke, gate, members, qrcode,
    // promote, logout, login, status, namespace_create, rename = 18
    expect(Object.keys(tools).length).toBe(18);
    fs.unlinkSync(credFile);
  });

  test("test_DW_7_1_with_env_var_23_tools", () => {
    process.env.UPUBLISH_ADMIN = "1";
    const { deps, credFile } = makeDeps();
    const server = createServer(deps);
    const tools = getTools(server);
    // 18 base + 5 admin: admin_user, admin_site, admin_stats, admin_storage, admin_domains = 23
    expect(Object.keys(tools).length).toBe(23);
    fs.unlinkSync(credFile);
  });

  test("test_DW_7_1_env_var_not_1_does_not_register_admin_tools", () => {
    process.env.UPUBLISH_ADMIN = "0";
    const { deps, credFile } = makeDeps();
    const server = createServer(deps);
    const tools = getTools(server);
    expect(Object.keys(tools).length).toBe(18);
    fs.unlinkSync(credFile);
  });

  test("test_DW_7_1_with_env_var_admin_tools_present", () => {
    process.env.UPUBLISH_ADMIN = "1";
    const { deps, credFile } = makeDeps();
    const server = createServer(deps);
    const tools = getTools(server);
    expect("admin_user" in tools).toBe(true);
    expect("admin_site" in tools).toBe(true);
    expect("admin_stats" in tools).toBe(true);
    expect("admin_storage" in tools).toBe(true);
    expect("admin_domains" in tools).toBe(true);
    fs.unlinkSync(credFile);
  });

  test("test_DW_7_1_without_env_var_admin_tools_absent", () => {
    delete process.env.UPUBLISH_ADMIN;
    const { deps, credFile } = makeDeps();
    const server = createServer(deps);
    const tools = getTools(server);
    expect("admin_user" in tools).toBe(false);
    expect("admin_site" in tools).toBe(false);
    expect("admin_stats" in tools).toBe(false);
    expect("admin_storage" in tools).toBe(false);
    expect("admin_domains" in tools).toBe(false);
    fs.unlinkSync(credFile);
  });
});

// ─── DW-7.2: mcp/index.ts imports only lib/core.ts ───────────────────────────

describe("DW-7.2: mcp/index.ts imports only lib/core.ts, not lib/admin.ts", () => {
  test("test_DW_7_2_mcp_index_imports_only_core", () => {
    const mcpIndexPath = path.join(import.meta.dir, "../mcp/index.ts");
    const source = fs.readFileSync(mcpIndexPath, "utf-8");
    // Must not import from lib/admin.ts directly
    expect(source).not.toMatch(/from ['"]\.\.\/lib\/admin\.ts['"]/);
    expect(source).not.toMatch(/from ['"]\.\.\/lib\/admin['"]/);
    // Must import from lib/core.ts
    expect(source).toMatch(/from ['"]\.\.\/lib\/core\.ts['"]/);
  });
});

// ─── DW-7.4: UPUBLISH_ADMIN=1 unauthenticated → standard not-authenticated path

describe("DW-7.4: UPUBLISH_ADMIN=1 unauthenticated uses standard not-authenticated path", () => {
  test("test_DW_7_4_upublish_admin_unauthenticated_standard_path", async () => {
    process.env.UPUBLISH_ADMIN = "1";

    // No credentials on disk — just pass a nonexistent credFile
    const noCredFile = path.join(os.tmpdir(), `no-cred-${Date.now()}`);
    const deps: CoreDeps = {
      credentialsPath: noCredFile,
      fetchFn: makeMockFetch(),
    };
    const server = createServer(deps);
    const tools = getTools(server);
    expect("admin_stats" in tools).toBe(true);

    // Call admin_stats with no credentials — should return "not authenticated" style error
    const handler = tools.admin_stats.handler;
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not authenticated/i);
  });

  test("test_DW_7_4_admin_user_unauthenticated_returns_error_message", async () => {
    process.env.UPUBLISH_ADMIN = "1";
    const noCredFile = path.join(os.tmpdir(), `no-cred-${Date.now()}`);
    const deps: CoreDeps = {
      credentialsPath: noCredFile,
      fetchFn: makeMockFetch(),
    };
    const server = createServer(deps);
    const tools = getTools(server);

    const handler = tools.admin_user.handler;
    const result = await handler({ action: "lookup", email: "test@example.com" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not authenticated/i);
  });
});

// ─── DW-7.4: 403 from admin API surfaces as clean error message ───────────────

describe("DW-7.4: 403 from API in MCP tool handler surfaces as isError response", () => {
  test("test_DW_7_4_admin_stats_403_via_mcp_surfaces_cleanly", async () => {
    process.env.UPUBLISH_ADMIN = "1";

    // Provide credentials, but mock fetch returns 403 for admin endpoints
    const mock403Fetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/space") || url.includes("/api/space?")) {
        return new Response(
          JSON.stringify({
            space: { id: "sp1", default_namespace_id: "ns-default", tier: "free" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // All admin routes return 403
      return new Response(
        JSON.stringify({ error: "Admin access required" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    };

    const { deps, credFile } = makeDeps(mock403Fetch);
    const server = createServer(deps);
    const tools = getTools(server);

    const handler = tools.admin_stats.handler;
    const result = await handler({});
    expect(result.isError).toBe(true);
    // The error message must not be a raw stack trace — it should be a message string
    const text = result.content[0].text;
    expect(text).toBeTruthy();
    expect(text).not.toMatch(/at Object\.|at async/); // no stack trace lines
    fs.unlinkSync(credFile);
  });
});
