/**
 * Tests for lib/members.ts — core member management logic.
 *
 * Covers DW-4.1: listMembers, addMember, removeMember, changeMemberRole exports
 * Covers DW-4.2: Namespace type carries optional role field
 *
 * Tests inject ApiClient with mock fetch — no real network calls.
 */

import { describe, it, expect } from "bun:test";
import { listMembers, addMember, removeMember, changeMemberRole, leaveMember, createInvite, listInvites, revokeInvite } from "./members.ts";
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

// ─── Phase 4: leaveMember ─────────────────────────────────────────────────────

describe("Phase 4: leaveMember", () => {
  const client = (f: (url: string, init?: RequestInit) => Promise<Response>) =>
    new ApiClient(BASE_URL, staticTokenProvider, f as typeof fetch);

  it("test_DW_4_1_leave_member_sends_delete_to_members_me_without_lookup", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const result = await leaveMember(
      client(async (url, init) => {
        calls.push({ url: String(url), method: init?.method ?? "GET" });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
      NS_ID,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ url: `${BASE_URL}/api/ns/${NS_ID}/members/me`, method: "DELETE" }]);
  });

  it("test_DW_4_2_leave_member_owner_gets_plain_message", async () => {
    const p = leaveMember(
      client(mockFetch(400, { error: "Owner cannot leave", code: "owner_cannot_leave" })),
      NS_ID,
    );
    await expect(p).rejects.toThrow(/own this address.*cannot leave/i);
  });

  it("test_DW_4_2_leave_member_not_a_member_gets_not_found_message", async () => {
    const p = leaveMember(client(mockFetch(404, { error: "Not found" })), NS_ID);
    await expect(p).rejects.toThrow(/not a member of this address/i);
  });

  it("leave_member_rethrows_other_errors_unchanged", async () => {
    const p = leaveMember(client(mockFetch(500, { error: "boom" })), NS_ID);
    await expect(p).rejects.toThrow(/500/);
  });

  it("leave_member_400_without_owner_code_is_not_rewritten", async () => {
    const p = leaveMember(client(mockFetch(400, { error: "bad", code: "other" })), NS_ID);
    await expect(p).rejects.toThrow(/400/);
  });
});

// ─── Invites (plan-11-invites Phase 3) ────────────────────────────────────────

/** A realistic 43-char base64url token and its join URL, as the backend's POST /invites returns them. */
const INVITE_TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const INVITE_URL = `https://upubli.sh/join#${INVITE_TOKEN}`;
/** Any http(s) URL or a 43-char base64url run (the token format) — neither may appear in a listing or error. */
const SECRET_RE = /https?:\/\/|[A-Za-z0-9_-]{43}/;

describe("Phase 3: invites in lib/members.ts", () => {
  type Call = { url: string; method: string; body?: string };
  const recording = (status: number, body: unknown) => {
    const calls: Call[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    };
    return { calls, api: new ApiClient(BASE_URL, staticTokenProvider, fetchFn as typeof fetch) };
  };
  const CREATED = {
    invite: { id: "inv-1", role: "user", created_at: "2026-11-08T00:00:00.000Z", expires_at: "2026-11-15T00:00:00.000Z" },
    token: INVITE_TOKEN,
    url: INVITE_URL,
  };

  it("test_DW_3_1_create_invite_posts_role_user_by_default_and_returns_url_without_token", async () => {
    const { calls, api } = recording(201, CREATED);
    const result = await createInvite(api, NS_ID);
    expect(calls).toEqual([{ url: `${BASE_URL}/api/ns/${NS_ID}/invites`, method: "POST", body: JSON.stringify({ role: "user" }) }]);
    expect(result).toEqual({ invite: CREATED.invite as never, url: INVITE_URL });
    expect("token" in result).toBe(false);
  });

  it("test_DW_3_1_create_invite_sends_admin_role", async () => {
    const { calls, api } = recording(201, { ...CREATED, invite: { ...CREATED.invite, role: "admin" } });
    const result = await createInvite(api, NS_ID, "admin");
    expect(JSON.parse(calls[0].body!)).toEqual({ role: "admin" });
    expect(result.invite.role).toBe("admin");
  });

  it("test_DW_3_2_create_invite_rejects_owner_role_before_any_request", async () => {
    const { calls, api } = recording(201, CREATED);
    await expect(createInvite(api, NS_ID, "owner" as never)).rejects.toThrow(/never an owner/i);
    expect(calls).toHaveLength(0);
  });

  it("test_DW_3_1_list_invites_whitelists_fields_and_never_carries_url_or_token", async () => {
    const { calls, api } = recording(200, {
      invites: [
        { id: "inv-1", role: "admin", created_by_username: "bob@example.com", created_at: "c", expires_at: "e", paused: false, url: INVITE_URL, token: INVITE_TOKEN },
        { id: "inv-2", role: "user", created_by_username: null, created_at: "c2", expires_at: "e2", paused: true },
      ],
    });
    const result = await listInvites(api, NS_ID);
    expect(calls).toEqual([{ url: `${BASE_URL}/api/ns/${NS_ID}/invites`, method: "GET", body: undefined }]);
    expect(result.invites).toEqual([
      { id: "inv-1", role: "admin", created_by_username: "bob@example.com", created_at: "c", expires_at: "e", paused: false },
      { id: "inv-2", role: "user", created_by_username: null, created_at: "c2", expires_at: "e2", paused: true },
    ]);
    expect(JSON.stringify(result)).not.toMatch(SECRET_RE);
  });

  it("test_DW_3_1_revoke_invite_sends_delete_with_encoded_id", async () => {
    const { calls, api } = recording(200, { ok: true });
    expect(await revokeInvite(api, NS_ID, "inv/1")).toEqual({ ok: true });
    expect(calls).toEqual([{ url: `${BASE_URL}/api/ns/${NS_ID}/invites/inv%2F1`, method: "DELETE", body: undefined }]);
  });

  it("revoke_invite_requires_an_id_before_any_request", async () => {
    const { calls, api } = recording(200, { ok: true });
    await expect(revokeInvite(api, NS_ID, "  ")).rejects.toThrow(/invite id is required/i);
    expect(calls).toHaveLength(0);
  });

  // Every mapped server error: plain message, and never a URL or token even when the server body carries one.
  const ERROR_CASES: Array<[string, number, string | undefined, RegExp]> = [
    ["teams_unavailable", 403, "teams_unavailable", /Max plan/],
    ["account_restricted", 403, "account_restricted", /can't manage invite links/],
    ["forbidden", 403, "forbidden", /owner or an admin/],
    ["not_found", 404, "not_found", /not found, or you are not a member/],
    ["invite_not_found", 404, "invite_not_found", /No pending invite with that id/],
    ["collaborator_limit", 422, "collaborator_limit", /no free seats/],
    ["invalid_request", 400, "invalid_request", /not valid/],
    ["unauthorized", 401, undefined, /login tool/],
    ["server error", 500, undefined, /error 500/],
  ];
  for (const [name, status, code, expected] of ERROR_CASES) {
    it(`test_DW_3_2_invite_error_${name}_is_plain_and_leaks_no_url_or_token`, async () => {
      const body = { error: `bad ${INVITE_URL} ${INVITE_TOKEN}`, code, url: INVITE_URL, token: INVITE_TOKEN };
      for (const run of [
        (api: ApiClient) => createInvite(api, NS_ID),
        (api: ApiClient) => listInvites(api, NS_ID),
        (api: ApiClient) => revokeInvite(api, NS_ID, "inv-1"),
      ]) {
        const err = await run(recording(status, body).api).then(() => null, (e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err!.message).toMatch(expected);
        expect(err!.message).not.toMatch(SECRET_RE);
      }
    });
  }

  it("invite_auth_failure_passes_through_not_masked_as_network", async () => {
    const api = new ApiClient(BASE_URL, async () => {
      throw new Error("Token refresh failed: 401 Unauthorized — invalid refresh token");
    }, (async () => new Response("{}")) as unknown as typeof fetch);
    for (const run of [() => createInvite(api, NS_ID), () => listInvites(api, NS_ID), () => revokeInvite(api, NS_ID, "inv-1")]) {
      await expect(run()).rejects.toThrow("Token refresh failed: 401 Unauthorized — invalid refresh token");
    }
  });

  it("invite_system_error_with_code_is_plain_and_leaks_no_url", async () => {
    const api = new ApiClient(BASE_URL, staticTokenProvider, (async () => {
      throw Object.assign(new Error(`connect ECONNREFUSED ${BASE_URL}`), { code: "ConnectionRefused" });
    }) as unknown as typeof fetch);
    const err = await createInvite(api, NS_ID).then(() => null, (e: Error) => e);
    expect(err!.message).toMatch(/could not be reached/);
    expect(err!.message).not.toMatch(SECRET_RE);
  });

  it("test_DW_3_2_invite_network_failure_is_plain_and_leaks_no_url", async () => {
    const api = new ApiClient(BASE_URL, staticTokenProvider, (async () => {
      throw new TypeError(`fetch failed for ${BASE_URL}/api/ns/${NS_ID}/invites`);
    }) as unknown as typeof fetch);
    for (const run of [() => createInvite(api, NS_ID), () => listInvites(api, NS_ID), () => revokeInvite(api, NS_ID, "inv-1")]) {
      const err = await run().then(() => null, (e: Error) => e);
      expect(err!.message).toMatch(/could not be reached/);
      expect(err!.message).not.toMatch(SECRET_RE);
    }
  });
});
