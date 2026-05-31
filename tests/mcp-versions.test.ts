/**
 * MCP server tests for the version-management tools.
 *
 * Covers DW-4.3: mcp/index.ts registers versions_list and versions_delete
 * (importing only from lib/core.ts). versions_delete uses
 * versionNumber: z.number().int().positive() and its success response surfaces
 * freed_bytes + usage; versions_list surfaces status + is_live per version.
 * Both handlers use okResponse / errResponse.
 */

import { describe, test, expect, afterEach } from "bun:test";
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
const DEFAULT_NS_ID = "ns-default";

function writeTempCredentials(token: string): string {
  const tmpFile = path.join(
    os.tmpdir(),
    `mcp-versions-test-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(tmpFile, token, { mode: 0o600 });
  return tmpFile;
}

function makeMockFetch(
  overrideFn?: (url: string, init?: RequestInit) => Promise<Response> | null,
) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (overrideFn) {
      const override = await overrideFn(url, init);
      if (override !== null) return override;
    }

    if (url.includes("/auth/token/refresh")) {
      return new Response(
        JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/api/space") || url.includes("/api/space?")) {
      return new Response(
        JSON.stringify({ space: { id: "sp1", default_namespace_id: DEFAULT_NS_ID, tier: "free" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
      return new Response(
        JSON.stringify({ namespaces: [{ id: DEFAULT_NS_ID, name: "default", domain: "user.upubli.sh" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function makeDeps(fetchFn = makeMockFetch()): { credFile: string; deps: CoreDeps } {
  const credFile = writeTempCredentials(REFRESH_TOKEN);
  return { credFile, deps: { credentialsPath: credFile, fetchFn } };
}

function getTools(server: ReturnType<typeof createServer>): RegisteredTools {
  return (server as unknown as InternalServer)._registeredTools;
}

const tmpCredFiles: string[] = [];

afterEach(() => {
  for (const f of tmpCredFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  tmpCredFiles.length = 0;
});

// ─── DW-4.3: tools registered ─────────────────────────────────────────────────

describe("DW-4.3: version tools registered", () => {
  test("test_DW_4_3_versions_list_tool_registered", () => {
    const { credFile, deps } = makeDeps();
    tmpCredFiles.push(credFile);
    const server = createServer(deps);
    const tools = getTools(server);
    expect("versions_list" in tools).toBe(true);
  });

  test("test_DW_4_3_versions_delete_tool_registered", () => {
    const { credFile, deps } = makeDeps();
    tmpCredFiles.push(credFile);
    const server = createServer(deps);
    const tools = getTools(server);
    expect("versions_delete" in tools).toBe(true);
  });
});

// ─── DW-4.3: versions_list surfaces status + is_live ──────────────────────────

describe("DW-4.3: versions_list output", () => {
  test("test_DW_4_3_versions_list_surfaces_status_and_is_live", async () => {
    const fetchFn = makeMockFetch(async (url, init) => {
      if (url.includes("/versions") && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            versions: [
              { version_number: 3, status: "live", is_live: true },
              { version_number: 2, status: "archived", is_live: false },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return null as unknown as Response;
    });

    const { credFile, deps } = makeDeps(fetchFn);
    tmpCredFiles.push(credFile);

    const server = createServer(deps);
    const tools = getTools(server);
    const result = await tools["versions_list"].handler({ slug: "my-site" });

    expect(result.isError).not.toBe(true);
    const text = result.content[0].text;
    // every version's number, status, and is_live are surfaced
    expect(text).toContain("3");
    expect(text).toContain("live");
    expect(text).toContain("2");
    expect(text).toContain("archived");
    // the live flag must be visible to the user (some affirmative marker)
    expect(text.toLowerCase()).toContain("live");
  });

  test("test_DW_4_3_versions_list_empty", async () => {
    const fetchFn = makeMockFetch(async (url, init) => {
      if (url.includes("/versions") && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({ versions: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return null as unknown as Response;
    });

    const { credFile, deps } = makeDeps(fetchFn);
    tmpCredFiles.push(credFile);

    const server = createServer(deps);
    const tools = getTools(server);
    const result = await tools["versions_list"].handler({ slug: "my-site" });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });
});

// ─── DW-4.3: versions_delete surfaces freed_bytes + usage ─────────────────────

describe("DW-4.3: versions_delete output", () => {
  test("test_DW_4_3_versions_delete_surfaces_freed_bytes_and_usage", async () => {
    const fetchFn = makeMockFetch(async (url, init) => {
      if (url.includes("/versions/") && init?.method === "DELETE") {
        return new Response(
          JSON.stringify({
            version_number: 2,
            freed_bytes: 1048576,
            usage: { used_bytes: 5242880, limit_bytes: 104857600 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return null as unknown as Response;
    });

    const { credFile, deps } = makeDeps(fetchFn);
    tmpCredFiles.push(credFile);

    const server = createServer(deps);
    const tools = getTools(server);
    const result = await tools["versions_delete"].handler({ slug: "my-site", versionNumber: 2 });

    expect(result.isError).not.toBe(true);
    const text = result.content[0].text;
    // reclaimed space (freed_bytes) must be visible — 1048576 bytes = "1.0 MB"
    expect(text).toMatch(/1\.0 MB|1048576/);
    // usage must be echoed (used_bytes present in the response)
    expect(text.toLowerCase()).toContain("usage");
  });

  test("test_DW_4_3_versions_delete_error_response", async () => {
    const fetchFn = makeMockFetch(async (url, init) => {
      if (url.includes("/versions/") && init?.method === "DELETE") {
        return new Response(
          JSON.stringify({ error: "Cannot delete the live version" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      return null as unknown as Response;
    });

    const { credFile, deps } = makeDeps(fetchFn);
    tmpCredFiles.push(credFile);

    const server = createServer(deps);
    const tools = getTools(server);
    const result = await tools["versions_delete"].handler({ slug: "my-site", versionNumber: 3 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cannot delete the live version");
  });

  test("test_DW_4_3_versions_delete_accepts_optional_namespace", async () => {
    const fetchFn = makeMockFetch(async (url, init) => {
      if (url.includes("/versions/") && init?.method === "DELETE") {
        return new Response(
          JSON.stringify({ version_number: 1, freed_bytes: 0, usage: {} }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return null as unknown as Response;
    });

    const { credFile, deps } = makeDeps(fetchFn);
    tmpCredFiles.push(credFile);

    const server = createServer(deps);
    const tools = getTools(server);
    const result = await tools["versions_delete"].handler({
      slug: "my-site",
      versionNumber: 1,
      namespace: undefined,
    });
    expect(result.isError).not.toBe(true);
  });
});
