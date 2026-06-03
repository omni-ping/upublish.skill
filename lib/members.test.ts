/**
 * Tests for lib/members.ts — core member management logic.
 *
 * Covers DW-4.1: listMembers, addMember, removeMember, changeMemberRole exports
 * Covers DW-4.2: Namespace type carries optional role field
 *
 * Tests inject ApiClient with mock fetch — no real network calls.
 */

import { describe, it, expect } from "bun:test";
import { listMembers, addMember, removeMember, changeMemberRole } from "./members.ts";
import { ApiClient } from "./api-client.ts";
import type { Namespace } from "./types.ts";

const BASE_URL = "https://api.example.com";
const TOKEN = "test-token";
const staticTokenProvider = async () => TOKEN;
const NS_ID = "ns-test-1";

/** Creates a mock fetch that always returns the given status + body. */
function mockFetch(
  status: number,
  body: unknown,
): (url: string, init?: RequestInit) => Promise<Response> {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

/** Sample members returned by GET /api/ns/:nsId/members */
const MEMBERS = [
  { user_id: "u1", username: "alice", role: "owner" },
  { user_id: "u2", username: "bob", role: "admin" },
  { user_id: "u3", username: "carol", role: "user" },
];

// ─── DW-4.2: Namespace type carries role ─────────────────────────────────────

describe("DW-4.2: Namespace type carries optional role", () => {
  it("test_DW_4_2_namespace_type_accepts_role_field", () => {
    // TypeScript compilation test — if Namespace doesn't have `role`, this fails at compile
    const owned: Namespace = { id: "n1", name: "main", domain: "user.upubli.sh", role: "owner" };
    const shared: Namespace = { id: "n2", name: "team", domain: "team.upubli.sh", role: "admin" };
    const noRole: Namespace = { id: "n3", name: "old", domain: "old.upubli.sh" };

    expect(owned.role).toBe("owner");
    expect(shared.role).toBe("admin");
    expect(noRole.role).toBeUndefined();
  });
});

// ─── DW-4.1: listMembers ─────────────────────────────────────────────────────

describe("DW-4.1: listMembers", () => {
  it("test_DW_4_1_list_members_sends_get_to_correct_url", async () => {
    let capturedUrl = "";
    let capturedMethod = "";

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "GET";
      return new Response(
        JSON.stringify({ members: MEMBERS }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await listMembers(apiClient, NS_ID);

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/members`);
    expect(capturedMethod).toBe("GET");
    expect(result.members).toHaveLength(3);
    expect(result.members[0].username).toBe("alice");
    expect(result.members[1].role).toBe("admin");
  });

  it("test_DW_4_1_list_members_returns_structured_result", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, { members: MEMBERS }),
    );
    const result = await listMembers(apiClient, NS_ID);
    expect(result.members).toHaveLength(3);
    expect(result.members[2]).toMatchObject({ user_id: "u3", username: "carol", role: "user" });
  });

  it("test_DW_4_1_list_members_returns_empty_array_when_no_members", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, { members: [] }),
    );
    const result = await listMembers(apiClient, NS_ID);
    expect(result.members).toHaveLength(0);
  });

  it("test_DW_4_1_list_members_propagates_api_errors", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(404, { error: "Not found" }),
    );
    await expect(listMembers(apiClient, NS_ID)).rejects.toThrow("API error 404");
  });
});

// ─── DW-4.1: addMember ───────────────────────────────────────────────────────

describe("DW-4.1: addMember", () => {
  it("test_DW_4_1_add_member_sends_post_with_username_and_role", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: unknown = null;

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(
        JSON.stringify({ member: { user_id: "u2", username: "bob", role: "admin" } }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await addMember(apiClient, NS_ID, "bob", "admin");

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/members`);
    expect(capturedMethod).toBe("POST");
    expect(capturedBody).toMatchObject({ username: "bob", role: "admin" });
    expect(result.member.username).toBe("bob");
    expect(result.member.role).toBe("admin");
  });

  it("test_DW_4_1_add_member_returns_structured_result", async () => {
    const newMember = { user_id: "u4", username: "dave", role: "user" };
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(201, { member: newMember }),
    );
    const result = await addMember(apiClient, NS_ID, "dave", "user");
    expect(result.member).toMatchObject(newMember);
  });

  it("test_DW_4_1_add_member_propagates_403_error", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(403, { error: "Insufficient role" }),
    );
    await expect(addMember(apiClient, NS_ID, "eve", "admin")).rejects.toThrow("API error 403");
  });

  it("test_DW_4_1_add_member_propagates_409_conflict", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(409, { error: "Member already exists" }),
    );
    await expect(addMember(apiClient, NS_ID, "bob", "user")).rejects.toThrow("API error 409");
  });

  it("test_DW_4_1_add_member_propagates_422_cap_exceeded", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(422, { error: "Collaborator cap exceeded" }),
    );
    await expect(addMember(apiClient, NS_ID, "frank", "user")).rejects.toThrow("API error 422");
  });
});

// ─── DW-4.1: removeMember ────────────────────────────────────────────────────

describe("DW-4.1: removeMember", () => {
  it("test_DW_4_1_remove_member_resolves_username_to_user_id_via_list_then_deletes", async () => {
    const requests: { url: string; method: string }[] = [];

    const fetchFn = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push({ url, method });

      // First call: GET /members to resolve username→user_id
      if (method === "GET" && url.includes("/members")) {
        return new Response(
          JSON.stringify({ members: MEMBERS }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Second call: DELETE /members/:userId
      if (method === "DELETE") {
        return new Response(
          JSON.stringify({ ok: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await removeMember(apiClient, NS_ID, "bob");

    // GET members to resolve username, then DELETE
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toContain(`/api/ns/${NS_ID}/members`);
    expect(requests[1].method).toBe("DELETE");
    expect(requests[1].url).toBe(`${BASE_URL}/api/ns/${NS_ID}/members/u2`);
    expect(result.ok).toBe(true);
  });

  it("test_DW_4_1_remove_member_returns_error_when_username_not_found", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, { members: MEMBERS }),
    );
    await expect(removeMember(apiClient, NS_ID, "unknown-user")).rejects.toThrow(
      "Member 'unknown-user' not found",
    );
  });

  it("test_DW_4_1_remove_member_propagates_api_errors", async () => {
    // GET members succeeds but DELETE fails
    let callCount = 0;
    const fetchFn = async (url: string, init?: RequestInit) => {
      callCount++;
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return new Response(JSON.stringify({ members: MEMBERS }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Insufficient role" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    };
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await expect(removeMember(apiClient, NS_ID, "bob")).rejects.toThrow("API error 403");
    expect(callCount).toBe(2);
  });
});

// ─── DW-4.1: changeMemberRole ────────────────────────────────────────────────

describe("DW-4.1: changeMemberRole", () => {
  it("test_DW_4_1_change_member_role_resolves_username_then_patches", async () => {
    const requests: { url: string; method: string; body?: unknown }[] = [];

    const fetchFn = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });

      if (method === "GET" && url.includes("/members")) {
        return new Response(
          JSON.stringify({ members: MEMBERS }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "PATCH") {
        return new Response(
          JSON.stringify({ member: { user_id: "u3", role: "admin" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await changeMemberRole(apiClient, NS_ID, "carol", "admin");

    expect(requests[0].method).toBe("GET");
    expect(requests[1].method).toBe("PATCH");
    expect(requests[1].url).toBe(`${BASE_URL}/api/ns/${NS_ID}/members/u3`);
    expect(requests[1].body).toMatchObject({ role: "admin" });
    expect(result.member.role).toBe("admin");
  });

  it("test_DW_4_1_change_member_role_returns_error_when_username_not_found", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, { members: MEMBERS }),
    );
    await expect(changeMemberRole(apiClient, NS_ID, "ghost", "admin")).rejects.toThrow(
      "Member 'ghost' not found",
    );
  });

  it("test_DW_4_1_change_member_role_propagates_api_errors", async () => {
    let callCount = 0;
    const fetchFn = async (url: string, init?: RequestInit) => {
      callCount++;
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return new Response(JSON.stringify({ members: MEMBERS }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Insufficient role" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    };
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await expect(changeMemberRole(apiClient, NS_ID, "carol", "admin")).rejects.toThrow(
      "API error 403",
    );
    expect(callCount).toBe(2);
  });
});
