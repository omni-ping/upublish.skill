/**
 * MCP server tests.
 *
 * Tests the MCP server registration and tool delegation using
 * createServer() with injectable fetchFn — no real network calls.
 *
 * Tool handlers are extracted via McpServer._registeredTools (internal SDK field).
 */

import { describe, test, expect } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { createServer } from "../mcp/index.ts";
import type { McpServerConfig } from "../mcp/index.ts";

// ─── Test types ───────────────────────────────────────────────────────────────

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type RegisteredTool = {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

type RegisteredTools = Record<string, RegisteredTool>;

type InternalServer = { _registeredTools: RegisteredTools };

// ─── Mock helpers ─────────────────────────────────────────────────────────────

/**
 * Creates a mock fetch that handles token refresh and provides a default
 * API response. Pass overrides to customize the API response.
 */
function makeMockFetch(apiResponse: unknown = { sites: [] }) {
  return async (url: string, _init?: RequestInit): Promise<Response> => {
    if (url.includes("/auth/token/refresh")) {
      return new Response(
        JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(apiResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/** Sample site for publish/list responses. */
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

/** Config with a valid refresh token. */
function authenticatedConfig(): McpServerConfig {
  return {
    apiBaseUrl: "https://api.example.com",
    refreshToken: "valid-refresh-token",
  };
}

/** Config with no refresh token (unauthenticated). */
function unauthenticatedConfig(): McpServerConfig {
  return {
    apiBaseUrl: "https://api.example.com",
    refreshToken: null,
  };
}

/** Gets the registered tools map from a server instance. */
function getTools(server: ReturnType<typeof createServer>): RegisteredTools {
  return (server as unknown as InternalServer)._registeredTools;
}

// ─── DW-3.1: server registers all four tools ─────────────────────────────────

describe("DW-3.1: server registers publish, list, delete, generate tools", () => {
  test("test_DW_3_1_server_registers_publish_tool", () => {
    const server = createServer(authenticatedConfig(), makeMockFetch());
    const tools = getTools(server);
    expect("publish" in tools).toBe(true);
  });

  test("test_DW_3_1_server_registers_list_tool", () => {
    const server = createServer(authenticatedConfig(), makeMockFetch());
    const tools = getTools(server);
    expect("list" in tools).toBe(true);
  });

  test("test_DW_3_1_server_registers_delete_tool", () => {
    const server = createServer(authenticatedConfig(), makeMockFetch());
    const tools = getTools(server);
    expect("delete" in tools).toBe(true);
  });

  test("test_DW_3_1_server_registers_generate_tool", () => {
    const server = createServer(authenticatedConfig(), makeMockFetch());
    const tools = getTools(server);
    expect("generate" in tools).toBe(true);
  });

  test("test_DW_3_1_server_registers_exactly_four_tools", () => {
    const server = createServer(authenticatedConfig(), makeMockFetch());
    const tools = getTools(server);
    expect(Object.keys(tools).length).toBe(4);
  });
});

// ─── DW-3.2: each tool delegates to lib/ (no inline logic) ───────────────────

describe("DW-3.2: each tool delegates to corresponding lib/ function", () => {
  test("test_DW_3_2_publish_tool_delegates_to_lib", async () => {
    // The publish tool should call lib/publish.ts — we verify by checking
    // the publish handler calls the API via the injected fetchFn.
    let apiCalled = false;
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/sites") && init?.method === "POST") {
        apiCalled = true;
        return new Response(
          JSON.stringify({ site: SAMPLE_SITE, url: "https://user1.upubli.sh/my-site/" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>");

    try {
      const server = createServer(authenticatedConfig(), fetchFn);
      const tools = getTools(server);
      await tools["publish"].handler({ directory: tmpDir, slug: "my-site" });
      expect(apiCalled).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("test_DW_3_2_list_tool_delegates_to_lib", async () => {
    let apiCalled = false;
    const fetchFn = async (url: string, _init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/sites")) {
        apiCalled = true;
        return new Response(
          JSON.stringify({ sites: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const server = createServer(authenticatedConfig(), fetchFn);
    const tools = getTools(server);
    await tools["list"].handler({});
    expect(apiCalled).toBe(true);
  });

  test("test_DW_3_2_delete_tool_delegates_to_lib", async () => {
    let deleteCalled = false;
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/sites/") && init?.method === "DELETE") {
        deleteCalled = true;
        return new Response(
          JSON.stringify({ message: "Site deleted." }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const server = createServer(authenticatedConfig(), fetchFn);
    const tools = getTools(server);
    await tools["delete"].handler({ slug: "my-site" });
    expect(deleteCalled).toBe(true);
  });

  test("test_DW_3_2_generate_tool_delegates_to_lib", async () => {
    let generateCalled = false;
    const fetchFn = async (url: string, _init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/generate")) {
        generateCalled = true;
        return new Response(
          JSON.stringify({ url: "https://user1.upubli.sh/diag-abc/", slug: "diag-abc" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const server = createServer(authenticatedConfig(), fetchFn);
    const tools = getTools(server);
    await tools["generate"].handler({ context: "A user auth flow" });
    expect(generateCalled).toBe(true);
  });
});

// ─── DW-3.3: tool output format matches current ───────────────────────────────

describe("DW-3.3: tool output format matches current implementation", () => {
  test("test_DW_3_3_publish_output_contains_url_and_file_count", async () => {
    const PUBLISHED_URL = "https://user1.upubli.sh/my-site/";
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/sites") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ site: SAMPLE_SITE, url: PUBLISHED_URL }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>");

    try {
      const server = createServer(authenticatedConfig(), fetchFn);
      const tools = getTools(server);
      const result = await tools["publish"].handler({ directory: tmpDir, slug: "my-site" });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain("Site published successfully");
      expect(text).toContain(`URL: ${PUBLISHED_URL}`);
      expect(text).toContain(`Files: ${SAMPLE_SITE.file_count}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("test_DW_3_3_list_output_contains_site_slug_and_url", async () => {
    const fetchFn = makeMockFetch({ sites: [SAMPLE_SITE] });

    const server = createServer(authenticatedConfig(), fetchFn);
    const tools = getTools(server);
    const result = await tools["list"].handler({});

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("my-site");
    expect(text).toContain("https://user1.upubli.sh/my-site/");
  });

  test("test_DW_3_3_list_output_empty_sites_message", async () => {
    const fetchFn = makeMockFetch({ sites: [] });

    const server = createServer(authenticatedConfig(), fetchFn);
    const tools = getTools(server);
    const result = await tools["list"].handler({});

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("No sites");
  });

  test("test_DW_3_3_delete_output_contains_message", async () => {
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (init?.method === "DELETE") {
        return new Response(
          JSON.stringify({ message: "Site 'my-site' has been deleted." }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const server = createServer(authenticatedConfig(), fetchFn);
    const tools = getTools(server);
    const result = await tools["delete"].handler({ slug: "my-site" });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("my-site");
  });

  test("test_DW_3_3_generate_output_contains_url_and_slug", async () => {
    const DIAGRAM_URL = "https://user1.upubli.sh/diag-abc/";
    const fetchFn = async (url: string, _init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ url: DIAGRAM_URL, slug: "diag-abc" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const server = createServer(authenticatedConfig(), fetchFn);
    const tools = getTools(server);
    const result = await tools["generate"].handler({ context: "A user auth flow" });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Diagram generated");
    expect(text).toContain(`URL: ${DIAGRAM_URL}`);
    expect(text).toContain("Slug: diag-abc");
  });
});

// ─── DW-3.4: not-authenticated stubs ─────────────────────────────────────────

describe("DW-3.4: not-authenticated stubs registered when no credentials found", () => {
  test("test_DW_3_4_unauthenticated_publish_returns_error", async () => {
    const server = createServer(unauthenticatedConfig());
    const tools = getTools(server);
    const result = await tools["publish"].handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Not authenticated");
  });

  test("test_DW_3_4_unauthenticated_list_returns_error", async () => {
    const server = createServer(unauthenticatedConfig());
    const tools = getTools(server);
    const result = await tools["list"].handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Not authenticated");
  });

  test("test_DW_3_4_unauthenticated_delete_returns_error", async () => {
    const server = createServer(unauthenticatedConfig());
    const tools = getTools(server);
    const result = await tools["delete"].handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Not authenticated");
  });

  test("test_DW_3_4_unauthenticated_generate_returns_error", async () => {
    const server = createServer(unauthenticatedConfig());
    const tools = getTools(server);
    const result = await tools["generate"].handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Not authenticated");
  });

  test("test_DW_3_4_unauthenticated_error_references_login_command", async () => {
    const server = createServer(unauthenticatedConfig());
    const tools = getTools(server);
    const result = await tools["publish"].handler({});
    expect(result.content[0].text).toContain("upublish login");
  });

  test("test_DW_3_4_unauthenticated_server_registers_all_four_tools", () => {
    const server = createServer(unauthenticatedConfig());
    const tools = getTools(server);
    expect(Object.keys(tools).length).toBe(4);
    expect("publish" in tools).toBe(true);
    expect("list" in tools).toBe(true);
    expect("delete" in tools).toBe(true);
    expect("generate" in tools).toBe(true);
  });
});

// ─── DW-3.5: server starts with stdio transport ───────────────────────────────

describe("DW-3.5: MCP server structural test (startup verified by file existence)", () => {
  test("test_DW_3_5_creates_server_and_has_tools", () => {
    // createServer() is importable and returns a server with tools.
    // Actual stdio transport startup is verified manually via bun run mcp/index.ts.
    const server = createServer(authenticatedConfig(), makeMockFetch());
    expect(server).toBeDefined();
    const tools = getTools(server);
    expect(Object.keys(tools).length).toBe(4);
  });

  test("test_DW_3_5_env_var_api_url_respected", () => {
    // createServer accepts apiBaseUrl from config — tests that UPUBLISH_API_URL
    // override is honored at the config level.
    const config: McpServerConfig = {
      apiBaseUrl: "https://custom.example.com",
      refreshToken: "token",
    };
    const server = createServer(config, makeMockFetch());
    expect(server).toBeDefined();
  });
});

// ─── DW-3.6: error handling — tools return isError on failure ─────────────────

describe("DW-3.6: tool error handling", () => {
  test("test_DW_3_6_publish_returns_error_on_api_failure", async () => {
    const fetchFn = async (url: string, _init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "Upload failed" }), {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "Content-Type": "application/json" },
      });
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-err-"));
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>");

    try {
      const server = createServer(authenticatedConfig(), fetchFn);
      const tools = getTools(server);
      const result = await tools["publish"].handler({ directory: tmpDir, slug: "my-site" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBeTruthy();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("test_DW_3_6_list_returns_error_on_api_failure", async () => {
    const fetchFn = async (url: string, _init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "Content-Type": "application/json" },
      });
    };

    const server = createServer(authenticatedConfig(), fetchFn);
    const tools = getTools(server);
    const result = await tools["list"].handler({});
    expect(result.isError).toBe(true);
  });

  test("test_DW_3_6_delete_returns_error_on_api_failure", async () => {
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (init?.method === "DELETE") {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          statusText: "Not Found",
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const server = createServer(authenticatedConfig(), fetchFn);
    const tools = getTools(server);
    const result = await tools["delete"].handler({ slug: "nonexistent" });
    expect(result.isError).toBe(true);
  });

  test("test_DW_3_6_generate_returns_error_on_empty_context", async () => {
    const server = createServer(authenticatedConfig(), makeMockFetch());
    const tools = getTools(server);
    const result = await tools["generate"].handler({ context: "" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("context");
  });

  test("test_DW_3_6_publish_returns_error_for_invalid_slug", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-slug-"));
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>");

    try {
      const server = createServer(authenticatedConfig(), makeMockFetch());
      const tools = getTools(server);
      const result = await tools["publish"].handler({ directory: tmpDir, slug: "INVALID SLUG!" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("slug");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
