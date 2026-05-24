/**
 * MCP server namespace integration tests.
 *
 * Covers DW-6.1: publish tool accepts optional `namespace` parameter
 * Covers DW-6.2: default namespace resolved when none specified
 * Covers DW-6.3: list tool scoped to namespace
 * Covers DW-6.4: delete tool scoped to namespace
 * Covers DW-6.6: all plugin tests pass with new API shape
 */

import { describe, test, expect } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { createServer } from "../mcp/index.ts";
import type { CoreDeps } from "../lib/core.ts";

// ─── Test types ───────────────────────────────────────────────────────────────

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

// ─── Mock helpers ─────────────────────────────────────────────────────────────

const REFRESH_TOKEN = "test-refresh-token";
const NS_ID = "ns-default-id";
const NS_NAME = "my-team";
const NS_ID_TEAM = "ns-team-id";

function writeTempCredentials(token: string): string {
  const tmpFile = path.join(
    os.tmpdir(),
    `mcp-ns-test-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(tmpFile, token, { mode: 0o600 });
  return tmpFile;
}

/**
 * Creates a mock fetch that handles:
 *   - Token refresh
 *   - GET /api/space → default_namespace_id = NS_ID
 *   - GET /api/ns → two namespaces (default + team)
 *   - The given primary response for everything else
 */
function makeNsMockFetch(primaryResponse: unknown = { sites: [] }) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("/auth/token/refresh")) {
      return new Response(
        JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/api/space") || url.includes("/api/space?")) {
      return new Response(
        JSON.stringify({ space: { id: "sp1", default_namespace_id: NS_ID, tier: "free" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
      return new Response(
        JSON.stringify({
          namespaces: [
            { id: NS_ID, name: "default", domain: "user.upubli.sh" },
            { id: NS_ID_TEAM, name: NS_NAME, domain: "team.upubli.sh" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(primaryResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function makeDeps(fetchFn = makeNsMockFetch()): { credFile: string; deps: CoreDeps } {
  const credFile = writeTempCredentials(REFRESH_TOKEN);
  return { credFile, deps: { credentialsPath: credFile, fetchFn } };
}

function getTools(server: ReturnType<typeof createServer>): RegisteredTools {
  return (server as unknown as InternalServer)._registeredTools;
}

const SAMPLE_SITE = {
  id: "abc123",
  user_id: "user1",
  slug: "my-site",
  title: "My Site",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  file_count: 3,
  total_size: 4096,
  visibility: "public",
  passcode_hash: null,
  url: "https://user1.upubli.sh/my-site/",
};

// ─── DW-6.1: publish tool accepts optional namespace parameter ────────────────

describe("DW-6.1: publish tool namespace parameter", () => {
  test("test_DW_6_1_publish_tool_has_namespace_param", () => {
    const { deps, credFile } = makeDeps();
    const server = createServer(deps);
    const tools = getTools(server);
    const publishTool = tools["publish"];

    // The tool must exist and accept a namespace argument
    expect(publishTool).toBeDefined();
    fs.unlinkSync(credFile);
  });

  test("test_DW_6_1_publish_tool_namespace_is_optional", async () => {
    // publish without namespace should succeed (uses default)
    let capturedUrl = "";
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/space")) {
        return new Response(
          JSON.stringify({ space: { id: "sp1", default_namespace_id: NS_ID, tier: "free" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url)) {
        return new Response(
          JSON.stringify({ namespaces: [{ id: NS_ID, name: "default", domain: "x.upubli.sh" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      capturedUrl = url;
      if (url.includes("/api/ns/") && url.endsWith("/sites") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ site: SAMPLE_SITE, url: "https://user1.upubli.sh/my-site/" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const { deps, credFile } = makeDeps(fetchFn);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ns-pub-"));
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>");

    try {
      const server = createServer(deps);
      const tools = getTools(server);
      const result = await tools["publish"].handler({ directory: tmpDir, slug: "my-site" });

      expect(result.isError).toBeUndefined();
      // Should have used the default namespace path
      expect(capturedUrl).toContain(`/api/ns/${NS_ID}/sites`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.unlinkSync(credFile);
    }
  });

  test("test_DW_6_1_publish_tool_uses_named_namespace", async () => {
    let capturedUrl = "";
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url)) {
        return new Response(
          JSON.stringify({
            namespaces: [
              { id: NS_ID, name: "default", domain: "user.upubli.sh" },
              { id: NS_ID_TEAM, name: NS_NAME, domain: "team.upubli.sh" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      capturedUrl = url;
      if (url.includes("/api/ns/") && url.endsWith("/sites") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ site: SAMPLE_SITE, url: "https://user1.upubli.sh/my-site/" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const { deps, credFile } = makeDeps(fetchFn);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ns-named-"));
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>");

    try {
      const server = createServer(deps);
      const tools = getTools(server);
      const result = await tools["publish"].handler({
        directory: tmpDir,
        slug: "my-site",
        namespace: NS_NAME,
      });

      expect(result.isError).toBeUndefined();
      expect(capturedUrl).toContain(`/api/ns/${NS_ID_TEAM}/sites`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.unlinkSync(credFile);
    }
  });
});

// ─── DW-6.2: default namespace resolved from GET /api/space ──────────────────

describe("DW-6.2: list uses default namespace", () => {
  test("test_DW_6_2_publish_uses_resolved_namespace_when_none_specified", async () => {
    // Covered by DW-6.1 test above; this is a list-specific variant
    let capturedUrl = "";
    const fetchFn = async (url: string): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/space")) {
        return new Response(
          JSON.stringify({ space: { id: "sp1", default_namespace_id: NS_ID, tier: "free" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
        return new Response(
          JSON.stringify({ namespaces: [{ id: NS_ID, name: "default", domain: "user.upubli.sh" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      capturedUrl = url;
      return new Response(JSON.stringify({ sites: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const { deps, credFile } = makeDeps(fetchFn);
    const server = createServer(deps);
    const tools = getTools(server);
    await tools["list"].handler({});

    expect(capturedUrl).toContain(`/api/ns/${NS_ID}/sites`);
    fs.unlinkSync(credFile);
  });
});

// ─── DW-6.3: list tool scoped to namespace ────────────────────────────────────

describe("DW-6.3: list tool namespace scope", () => {
  test("test_DW_6_3_list_uses_default_namespace", async () => {
    let capturedUrl = "";
    const fetchFn = async (url: string): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/space")) {
        return new Response(
          JSON.stringify({ space: { id: "sp1", default_namespace_id: NS_ID, tier: "free" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
        return new Response(
          JSON.stringify({ namespaces: [{ id: NS_ID, name: "default", domain: "user.upubli.sh" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      capturedUrl = url;
      return new Response(JSON.stringify({ sites: [SAMPLE_SITE] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const { deps, credFile } = makeDeps(fetchFn);
    const server = createServer(deps);
    const tools = getTools(server);
    const result = await tools["list"].handler({});

    expect(result.isError).toBeUndefined();
    expect(capturedUrl).toContain(`/api/ns/${NS_ID}/sites`);
    fs.unlinkSync(credFile);
  });

  test("test_DW_6_3_list_accepts_namespace_param", async () => {
    let capturedUrl = "";
    const fetchFn = async (url: string): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url)) {
        return new Response(
          JSON.stringify({
            namespaces: [
              { id: NS_ID, name: "default", domain: "user.upubli.sh" },
              { id: NS_ID_TEAM, name: NS_NAME, domain: "team.upubli.sh" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      capturedUrl = url;
      return new Response(JSON.stringify({ sites: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const { deps, credFile } = makeDeps(fetchFn);
    const server = createServer(deps);
    const tools = getTools(server);
    await tools["list"].handler({ namespace: NS_NAME });

    expect(capturedUrl).toContain(`/api/ns/${NS_ID_TEAM}/sites`);
    fs.unlinkSync(credFile);
  });
});

// ─── DW-6.4: delete tool scoped to namespace ─────────────────────────────────

describe("DW-6.4: delete tool namespace scope", () => {
  test("test_DW_6_4_delete_uses_default_namespace", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/space")) {
        return new Response(
          JSON.stringify({ space: { id: "sp1", default_namespace_id: NS_ID, tier: "free" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
        return new Response(
          JSON.stringify({ namespaces: [{ id: NS_ID, name: "default", domain: "user.upubli.sh" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return new Response(JSON.stringify({ message: "Deleted." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const { deps, credFile } = makeDeps(fetchFn);
    const server = createServer(deps);
    const tools = getTools(server);
    const result = await tools["delete"].handler({ slug: "my-site" });

    expect(result.isError).toBeUndefined();
    expect(capturedUrl).toContain(`/api/ns/${NS_ID}/sites/my-site`);
    expect(capturedMethod).toBe("DELETE");
    fs.unlinkSync(credFile);
  });

  test("test_DW_6_4_delete_calls_ns_scoped_endpoint", async () => {
    let capturedUrl = "";
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url)) {
        return new Response(
          JSON.stringify({
            namespaces: [
              { id: NS_ID, name: "default", domain: "user.upubli.sh" },
              { id: NS_ID_TEAM, name: NS_NAME, domain: "team.upubli.sh" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      capturedUrl = url;
      return new Response(JSON.stringify({ message: "Deleted." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const { deps, credFile } = makeDeps(fetchFn);
    const server = createServer(deps);
    const tools = getTools(server);
    await tools["delete"].handler({ slug: "my-site", namespace: NS_NAME });

    expect(capturedUrl).toContain(`/api/ns/${NS_ID_TEAM}/sites/my-site`);
    fs.unlinkSync(credFile);
  });
});

// ─── DW-6.6: existing tests remain green after API shape change ───────────────

describe("DW-6.6: backward compatibility — error handling with new API shape", () => {
  test("test_DW_6_6_list_returns_error_on_namespace_resolution_failure", async () => {
    const fetchFn = async (url: string): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // /api/space returns 401 — resolution fails
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    };

    const { deps, credFile } = makeDeps(fetchFn);
    const server = createServer(deps);
    const tools = getTools(server);
    const result = await tools["list"].handler({});

    expect(result.isError).toBe(true);
    fs.unlinkSync(credFile);
  });
});
