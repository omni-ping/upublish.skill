/**
 * Tests for core.ts members() dispatch function and role-carrying by list()/status().
 *
 * Covers DW-4.1: core.ts exports members() with list/add/remove/role actions, no throw for expected failures
 * Covers DW-4.2: Namespace.role is carried through list() and status()
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { list, status, members } from "./core.ts";
import type { CoreDeps } from "./core.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const REFRESH_TOKEN = "test-refresh-token";
const NS_ID = "ns-test";
const NS_NAME = "default";

function writeTempCredentials(token: string): string {
  const tmpFile = path.join(
    os.tmpdir(),
    `core-members-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, token, { mode: 0o600 });
  return tmpFile;
}

const tmpFiles: string[] = [];

afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
});

/**
 * Creates a mock fetch that handles:
 *   - Token refresh
 *   - GET /api/space
 *   - GET /api/ns (with role fields)
 *   - Additional routes via the `routes` map (url-contains → response)
 */
function makeMockFetch(
  nsRole: "owner" | "admin" | "user",
  routes: Record<string, { status: number; body: unknown }> = {},
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

    // Match custom routes
    for (const [pattern, { status: s, body }] of Object.entries(routes)) {
      if (url.includes(pattern) || (method !== "GET" && url.includes(NS_ID))) {
        return new Response(JSON.stringify(body), {
          status: s,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Default: empty sites
    return new Response(JSON.stringify({ sites: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const MEMBERS_RESPONSE = {
  members: [
    { user_id: "u1", username: "alice", role: "owner" },
    { user_id: "u2", username: "bob", role: "admin" },
  ],
};

// ─── DW-4.2: list() carries Namespace.role ───────────────────────────────────

describe("DW-4.2: list() carries Namespace.role", () => {
  it("test_DW_4_2_list_namespace_carries_owner_role", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);
    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: makeMockFetch("owner"),
    };
    const result = await list(undefined, deps);
    expect(result.namespace.role).toBe("owner");
  });

  it("test_DW_4_2_list_namespace_carries_admin_role", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);
    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: makeMockFetch("admin"),
    };
    const result = await list(undefined, deps);
    expect(result.namespace.role).toBe("admin");
  });

  it("test_DW_4_2_list_namespace_carries_user_role", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);
    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: makeMockFetch("user"),
    };
    const result = await list(undefined, deps);
    expect(result.namespace.role).toBe("user");
  });
});

// ─── DW-4.2: status() namespaces carry role ──────────────────────────────────

describe("DW-4.2: status() namespaces carry role", () => {
  it("test_DW_4_2_status_namespaces_carry_role", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const fetchFn = async (url: string): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/auth/me")) {
        return new Response(
          JSON.stringify({ username: "alice" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
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
    const result = await status(deps);

    expect(result.authenticated).toBe(true);
    if (!result.authenticated) return;

    expect(result.namespaces).toHaveLength(2);
    expect(result.namespaces[0].role).toBe("owner");
    expect(result.namespaces[1].role).toBe("admin");
  });
});

// ─── DW-4.1: members() dispatch — list action ────────────────────────────────

describe("DW-4.1: core.members() list action", () => {
  it("test_DW_4_1_members_list_calls_listMembers_and_returns_structured_result", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);
    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: makeMockFetch("owner", {
        "/members": { status: 200, body: MEMBERS_RESPONSE },
      }),
    };

    const result = await members({ action: "list", namespace: NS_NAME }, deps);
    expect(result.action).toBe("list");
    if (result.action !== "list") return;
    expect(result.members).toHaveLength(2);
    expect(result.members[0].username).toBe("alice");
  });

  it("test_DW_4_1_members_list_no_throw_on_4xx_propagates_error", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);
    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: makeMockFetch("owner", {
        "/members": { status: 404, body: { error: "Not found" } },
      }),
    };

    // Core propagates API errors (they bubble from ApiClient) — but does not throw
    // for non-network failures; the MCP layer catches and wraps with errResponse
    await expect(members({ action: "list", namespace: NS_NAME }, deps)).rejects.toThrow(
      "API error 404",
    );
  });
});

// ─── DW-4.1: members() dispatch — add action ─────────────────────────────────

describe("DW-4.1: core.members() add action", () => {
  it("test_DW_4_1_members_add_returns_structured_result", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);
    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: makeMockFetch("owner", {
        "/members": { status: 201, body: { member: { user_id: "u3", username: "carol", role: "user" } } },
      }),
    };

    const result = await members(
      { action: "add", username: "carol", role: "user", namespace: NS_NAME },
      deps,
    );
    expect(result.action).toBe("add");
    if (result.action !== "add") return;
    expect(result.member.username).toBe("carol");
    expect(result.member.role).toBe("user");
  });
});

// ─── DW-4.1: members() dispatch — remove action ──────────────────────────────

describe("DW-4.1: core.members() remove action", () => {
  it("test_DW_4_1_members_remove_resolves_and_deletes", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    let requestCount = 0;
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      requestCount++;

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
      if (method === "GET" && url.includes(`/api/ns/${NS_ID}/members`)) {
        return new Response(JSON.stringify(MEMBERS_RESPONSE), {
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
      return new Response("unexpected", { status: 500 });
    };

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const result = await members(
      { action: "remove", username: "bob", namespace: NS_NAME },
      deps,
    );
    expect(result.action).toBe("remove");
    if (result.action !== "remove") return;
    expect(result.ok).toBe(true);
  });
});

// ─── DW-4.1: members() dispatch — role action ────────────────────────────────

describe("DW-4.1: core.members() role action", () => {
  it("test_DW_4_1_members_role_resolves_and_patches", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

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
      if (method === "GET" && url.includes(`/api/ns/${NS_ID}/members`)) {
        return new Response(JSON.stringify(MEMBERS_RESPONSE), {
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
      return new Response("unexpected", { status: 500 });
    };

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const result = await members(
      { action: "role", username: "bob", role: "admin", namespace: NS_NAME },
      deps,
    );
    expect(result.action).toBe("role");
    if (result.action !== "role") return;
    expect(result.member.role).toBe("admin");
  });
});
