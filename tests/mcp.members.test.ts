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

// ─── Phase 4: members tool — leave action ────────────────────────────────────

describe("Phase 4: members tool leave action", () => {
  const leaveDeps = (extra: Record<string, { status: number; body: unknown }>) =>
    makeDeps(makeMockFetch("user", extra)).deps;

  test("test_DW_4_1_leave_action_confirms_and_names_address", async () => {
    const tools = getTools(createServer(leaveDeps({ "/members/me": { status: 200, body: { ok: true } } })));
    const result = await tools["members"].handler({ action: "leave", namespace: NS_NAME });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain(NS_NAME);
    expect(result.content[0].text.toLowerCase()).toContain("left");
  });

  test("test_DW_4_2_leave_action_owner_gets_owner_cannot_leave_message", async () => {
    const tools = getTools(createServer(leaveDeps({
      "/members/me": { status: 400, body: { error: "Owner cannot leave", code: "owner_cannot_leave" } },
    })));
    const result = await tools["members"].handler({ action: "leave", namespace: NS_NAME });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/own this address.*cannot leave/i);
  });

  test("test_DW_4_2_leave_action_not_a_member_gets_not_found_message", async () => {
    const tools = getTools(createServer(leaveDeps({ "/members/me": { status: 404, body: { error: "Not found" } } })));
    const result = await tools["members"].handler({ action: "leave", namespace: NS_NAME });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not a member of this address/i);
  });

  test("leave_action_requires_namespace", async () => {
    const tools = getTools(createServer(leaveDeps({})));
    const result = await tools["members"].handler({ action: "leave" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/namespace|address/i);
  });

  test("test_DW_4_2_tool_schema_action_enum_includes_leave", () => {
    const tools = getTools(createServer(leaveDeps({})));
    const schema = tools["members"].inputSchema as unknown as { shape?: Record<string, { safeParse: (v: unknown) => { success: boolean } }> };
    const actionSchema = (schema.shape ?? (tools["members"].inputSchema as never))["action" as never] as { safeParse: (v: unknown) => { success: boolean } };
    expect(actionSchema.safeParse("leave").success).toBe(true);
    expect(actionSchema.safeParse("bogus").success).toBe(false);
  });
});

// ─── plan-11-invites Phase 3: invite / invites / revoke ──────────────────────

describe("Phase 3: members tool invite actions", () => {
  const TOKEN43 = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
  const JOIN_URL = `https://upubli.sh/join#${TOKEN43}`;
  const SECRET_RE = /https?:\/\/|[A-Za-z0-9_-]{43}/;
  const WARNING = "Admin links give full control of this address's team to whoever opens them first.";
  const ONCE_NOTE = "This link works once and expires in 7 days.";

  type Reply = { status: number; body: unknown };
  /** Method-aware stub for the invite routes; everything else goes to the shared mock. */
  function inviteTools(replies: { POST?: Reply; GET?: Reply; DELETE?: Reply }, calls: string[] = []) {
    const base = makeMockFetch("admin");
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? "GET") as "POST" | "GET" | "DELETE";
      if (!url.includes(`/api/ns/${NS_ID}/invites`)) return base(url, init);
      calls.push(`${method} ${url.slice(url.indexOf("/api/"))} ${init?.body ?? ""}`.trim());
      const r = replies[method] ?? { status: 500, body: { error: "unexpected" } };
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    };
    return getTools(createServer(makeDeps(fetchFn).deps));
  }
  const created = (role: "user" | "admin"): Reply => ({
    status: 201,
    body: { invite: { id: "inv-1", role, created_at: "2026-11-08T00:00:00.000Z", expires_at: "2026-11-15T00:00:00.000Z" }, token: TOKEN43, url: JOIN_URL },
  });

  test("test_DW_3_1_invite_defaults_to_member_and_returns_url_with_once_note", async () => {
    const calls: string[] = [];
    const tools = inviteTools({ POST: created("user") }, calls);
    const result = await tools["members"].handler({ action: "invite" });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(calls).toEqual([`POST /api/ns/${NS_ID}/invites {"role":"user"}`]);
    expect(text).toContain(JOIN_URL);
    expect(text).toContain(ONCE_NOTE);
    expect(text).toContain("Member");
    expect(text).toContain("inv-1");
    expect(text).not.toContain(WARNING);
  });

  test("test_DW_3_2_admin_invite_carries_full_control_warning", async () => {
    const calls: string[] = [];
    const tools = inviteTools({ POST: created("admin") }, calls);
    const result = await tools["members"].handler({ action: "invite", role: "admin" });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([`POST /api/ns/${NS_ID}/invites {"role":"admin"}`]);
    expect(result.content[0].text).toContain(ONCE_NOTE);
    expect(result.content[0].text).toContain(WARNING);
  });

  test("test_DW_3_2_owner_role_rejected_client_side_without_a_request", async () => {
    const calls: string[] = [];
    const tools = inviteTools({ POST: created("user") }, calls);
    const result = await tools["members"].handler({ action: "invite", role: "owner" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/never an owner/i);
    expect(calls).toHaveLength(0);
  });

  test("test_DW_3_2_tool_schema_accepts_invite_actions_rejects_owner_role", () => {
    const tools = inviteTools({});
    type S = { safeParse: (v: unknown) => { success: boolean } };
    const shape = ((tools["members"].inputSchema as unknown as { shape?: Record<string, S> }).shape ??
      (tools["members"].inputSchema as unknown as Record<string, S>));
    for (const a of ["invite", "invites", "revoke"]) expect(shape["action"].safeParse(a).success).toBe(true);
    expect(shape["role"].safeParse("owner").success).toBe(false);
    expect(shape["invite_id"].safeParse("inv-1").success).toBe(true);
  });

  test("test_DW_3_1_invites_lists_pending_with_paused_marker_and_never_a_url_or_token", async () => {
    const tools = inviteTools({
      GET: {
        status: 200,
        body: {
          invites: [
            { id: "inv-1", role: "admin", created_by_username: "bob@example.com", created_at: "c", expires_at: "2026-11-15T00:00:00.000Z", paused: true, url: JOIN_URL, token: TOKEN43 },
            { id: "inv-2", role: "user", created_by_username: null, created_at: "c", expires_at: "2026-11-16T00:00:00.000Z", paused: false, token: TOKEN43 },
          ],
        },
      },
    });
    const result = await tools["members"].handler({ action: "invites" });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("inv-1 — Admin, created by bob@example.com, expires 2026-11-15T00:00:00.000Z — paused until the owner is on Max");
    expect(text).toContain("inv-2 — Member, created by a deleted account, expires 2026-11-16T00:00:00.000Z");
    expect(text.split("\n").find((l) => l.includes("inv-2"))).not.toContain("paused");
    expect(text).not.toMatch(SECRET_RE);
  });

  test("invites_empty_list_says_so", async () => {
    const tools = inviteTools({ GET: { status: 200, body: { invites: [] } } });
    const result = await tools["members"].handler({ action: "invites" });
    expect(result.content[0].text).toMatch(/No pending invite links/);
  });

  test("test_DW_3_1_revoke_by_invite_id", async () => {
    const calls: string[] = [];
    const tools = inviteTools({ DELETE: { status: 200, body: { ok: true } } }, calls);
    const result = await tools["members"].handler({ action: "revoke", invite_id: "inv-1" });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([`DELETE /api/ns/${NS_ID}/invites/inv-1`]);
    expect(result.content[0].text).toMatch(/Revoked invite inv-1/);
  });

  test("revoke_requires_invite_id", async () => {
    const calls: string[] = [];
    const tools = inviteTools({ DELETE: { status: 200, body: { ok: true } } }, calls);
    const result = await tools["members"].handler({ action: "revoke" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invite_id is required/);
    expect(calls).toHaveLength(0);
  });

  // Every mapped server error, on every invite action: plain language, never a URL or token —
  // even when the error body itself carries one.
  const ERRORS: Array<[number, string | undefined, RegExp]> = [
    [403, "teams_unavailable", /Max plan/],
    [403, "account_restricted", /can't manage invite links/],
    [403, "forbidden", /owner or an admin/],
    [404, "not_found", /not found, or you are not a member/],
    [404, "invite_not_found", /No pending invite with that id/],
    [422, "collaborator_limit", /no free seats/],
    [400, "invalid_request", /not valid/],
    [500, undefined, /error 500/],
  ];
  for (const [status, code, expected] of ERRORS) {
    test(`test_DW_3_2_error_${status}_${code ?? "none"}_mapped_and_leaks_nothing`, async () => {
      const reply = { status, body: { error: `leak ${JOIN_URL}`, code, url: JOIN_URL, token: TOKEN43 } };
      const tools = inviteTools({ POST: reply, GET: reply, DELETE: reply });
      for (const args of [{ action: "invite" }, { action: "invites" }, { action: "revoke", invite_id: "inv-1" }]) {
        const result = await tools["members"].handler(args);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(expected);
        expect(result.content[0].text).not.toMatch(SECRET_RE);
      }
    });
  }
});
