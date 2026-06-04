/**
 * MCP server members tool tests.
 *
 * Covers DW-4.3: `members` MCP tool registered with action list/add/remove/role;
 *   errors via errResponse
 * Covers DW-4.4: `list` and `status` tools show role marker for shared namespaces
 * Covers DW-4.5: MCP members tool actions call core; role rendered in list/status
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
const NS_ID = "ns-test-1";
const NS_NAME = "default";

function writeTempCredentials(token: string): string {
  const tmpFile = path.join(
    os.tmpdir(),
    `mcp-members-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(tmpFile, token, { mode: 0o600 });
  return tmpFile;
}

const MEMBERS = [
  { user_id: "u1", username: "alice", role: "owner" },
  { user_id: "u2", username: "bob", role: "admin" },
];

/**
 * Creates a mock fetch that handles:
 *   - Token refresh
 *   - GET /api/space
 *   - GET /api/ns (returns namespaces with given role)
 *   - GET /api/ns/:nsId/members
 *   - Caller-supplied overrides for other routes
 */
function makeMockFetch(
  nsRole: "owner" | "admin" | "user" = "owner",
  extraRoutes: Record<string, { status: number; body: unknown }> = {},
) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";

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
          namespaces: [{ id: NS_ID, name: NS_NAME, domain: "user.upubli.sh", role: nsRole }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (method === "GET" && url.includes(`/api/ns/${NS_ID}/members`)) {
      return new Response(JSON.stringify({ members: MEMBERS }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Extra routes for mutating actions
    for (const [pattern, { status: s, body }] of Object.entries(extraRoutes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(body), {
          status: s,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ sites: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function makeDeps(
  fetchFn = makeMockFetch(),
): { credFile: string; deps: CoreDeps } {
  const credFile = writeTempCredentials(REFRESH_TOKEN);
  return { credFile, deps: { credentialsPath: credFile, fetchFn } };
}

function getTools(server: ReturnType<typeof createServer>): RegisteredTools {
  return (server as unknown as InternalServer)._registeredTools;
}

// ─── DW-4.3: members tool registration ───────────────────────────────────────

describe("DW-4.3: members tool is registered", () => {
  test("test_DW_4_3_members_tool_registered_in_server", () => {
    const { deps } = makeDeps();
    const server = createServer(deps);
    const tools = getTools(server);
    expect(tools["members"]).toBeDefined();
    expect(typeof tools["members"].handler).toBe("function");
  });
});

// ─── DW-4.3: members tool — list action ──────────────────────────────────────

describe("DW-4.3: members tool list action", () => {
  test("test_DW_4_3_list_action_returns_member_list", async () => {
    const { deps } = makeDeps(makeMockFetch("owner"));
    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["members"].handler({ action: "list", namespace: NS_NAME });

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("alice");
    expect(text).toContain("bob");
  });

  test("test_DW_4_3_list_action_shows_roles", async () => {
    const { deps } = makeDeps(makeMockFetch("owner"));
    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["members"].handler({ action: "list", namespace: NS_NAME });
    const text = result.content[0].text;
    expect(text).toContain("owner");
    expect(text).toContain("admin");
  });

  test("test_DW_4_3_list_action_error_returned_via_errResponse", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock", expires_in: 3600 }),
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
          JSON.stringify({ namespaces: [{ id: NS_ID, name: NS_NAME, domain: "user.upubli.sh", role: "owner" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // members endpoint returns 404
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };
    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["members"].handler({ action: "list", namespace: NS_NAME });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("404");
  });
});

// ─── DW-4.3: members tool — add action ───────────────────────────────────────

describe("DW-4.3: members tool add action", () => {
  test("test_DW_4_3_add_action_calls_core_and_returns_result", async () => {
    const { deps } = makeDeps(
      makeMockFetch("owner", {
        [`/api/ns/${NS_ID}/members`]: {
          status: 201,
          body: { member: { user_id: "u3", username: "carol", role: "user" } },
        },
      }),
    );
    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["members"].handler({
      action: "add",
      username: "carol",
      role: "user",
      namespace: NS_NAME,
    });

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("carol");
  });

  test("test_DW_4_3_add_action_error_via_errResponse", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock", expires_in: 3600 }),
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
          JSON.stringify({ namespaces: [{ id: NS_ID, name: NS_NAME, domain: "user.upubli.sh", role: "admin" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "POST") {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ sites: [] }), { status: 200 });
    };
    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["members"].handler({
      action: "add",
      username: "frank",
      role: "user",
      namespace: NS_NAME,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("403");
  });
});

// ─── DW-4.3: members tool — remove action ────────────────────────────────────

describe("DW-4.3: members tool remove action", () => {
  test("test_DW_4_3_remove_action_calls_core_and_returns_result", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock", expires_in: 3600 }),
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
          JSON.stringify({ namespaces: [{ id: NS_ID, name: NS_NAME, domain: "user.upubli.sh", role: "owner" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "GET" && url.includes("/members")) {
        return new Response(JSON.stringify({ members: MEMBERS }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "DELETE") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ sites: [] }), { status: 200 });
    };
    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["members"].handler({
      action: "remove",
      username: "bob",
      namespace: NS_NAME,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("bob");
    expect(text.toLowerCase()).toContain("removed");
  });
});

// ─── DW-4.3: members tool — role action ──────────────────────────────────────

describe("DW-4.3: members tool role action", () => {
  test("test_DW_4_3_role_action_calls_core_and_returns_result", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock", expires_in: 3600 }),
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
          JSON.stringify({ namespaces: [{ id: NS_ID, name: NS_NAME, domain: "user.upubli.sh", role: "owner" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "GET" && url.includes("/members")) {
        return new Response(JSON.stringify({ members: MEMBERS }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "PATCH") {
        return new Response(
          JSON.stringify({ member: { user_id: "u2", role: "admin" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ sites: [] }), { status: 200 });
    };
    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["members"].handler({
      action: "role",
      username: "bob",
      role: "admin",
      namespace: NS_NAME,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("bob");
    expect(text).toContain("admin");
  });
});

// ─── DW-4.4: list tool shows role for shared namespaces ──────────────────────

describe("DW-4.4: list tool role display", () => {
  test("test_DW_4_4_list_tool_shows_role_marker_for_admin_namespace", async () => {
    const { deps } = makeDeps(makeMockFetch("admin"));
    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["list"].handler({ namespace: NS_NAME });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    // Should show [admin] marker since the caller's role is admin (not owner)
    expect(text).toContain("[admin]");
  });

  test("test_DW_4_4_list_tool_shows_role_marker_for_user_namespace", async () => {
    const { deps } = makeDeps(makeMockFetch("user"));
    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["list"].handler({ namespace: NS_NAME });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("[user]");
  });

  test("test_DW_4_4_list_tool_no_role_marker_for_owner_namespace", async () => {
    const { deps } = makeDeps(makeMockFetch("owner"));
    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["list"].handler({ namespace: NS_NAME });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    // Owner is the default state — no role marker shown
    expect(text).not.toContain("[owner]");
    expect(text).not.toContain("[admin]");
    expect(text).not.toContain("[user]");
  });

  test("test_DW_4_4_list_tool_no_role_marker_when_role_absent", async () => {
    // Simulate old API response without role
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    const fetchFn = async (url: string): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock", expires_in: 3600 }),
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
        // No role field — old API shape
        return new Response(
          JSON.stringify({ namespaces: [{ id: NS_ID, name: NS_NAME, domain: "user.upubli.sh" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ sites: [] }), { status: 200 });
    };
    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["list"].handler({ namespace: NS_NAME });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).not.toContain("[");
  });
});

// ─── DW-4.4: status tool shows role for shared namespaces ────────────────────

describe("DW-4.4: status tool role display", () => {
  test("test_DW_4_4_status_tool_shows_role_marker_for_shared_namespace", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    const fetchFn = async (url: string): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/auth/me")) {
        return new Response(
          JSON.stringify({ username: "alice" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url)) {
        return new Response(
          JSON.stringify({
            namespaces: [
              { id: "n1", name: "mine", domain: "mine.upubli.sh", role: "owner" },
              { id: "n2", name: "team", domain: "team.upubli.sh", role: "admin" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };
    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["status"].handler({});
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    // mine (owner) — no marker
    expect(text).not.toContain("mine (mine.upubli.sh) [owner]");
    // team (admin) — shows [admin]
    expect(text).toContain("team (team.upubli.sh) [admin]");
  });

  test("test_DW_4_4_status_tool_no_role_marker_for_owner_namespace", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    const fetchFn = async (url: string): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/auth/me")) {
        return new Response(JSON.stringify({ username: "bob" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (/\/api\/ns$/.test(url)) {
        return new Response(
          JSON.stringify({
            namespaces: [{ id: NS_ID, name: NS_NAME, domain: "user.upubli.sh", role: "owner" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };
    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["status"].handler({});
    const text = result.content[0].text;
    expect(text).not.toContain("[owner]");
    expect(text).not.toContain("[admin]");
    expect(text).not.toContain("[user]");
  });
});
