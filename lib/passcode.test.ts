/**
 * Tests for lib/passcode.ts — core passcode management logic.
 *
 * Covers DW-5.3: addPasscode posts to the correct API endpoint with code + label
 * Covers DW-5.4: listPasscodes returns array of { id, label, created_at }
 * Covers DW-5.5: revokePasscode sends DELETE to the correct endpoint
 * Covers DW-5.7: functions exist with correct signatures (ApiClient + nsId + slug)
 */

import { describe, it, expect } from "bun:test";
import { addPasscode, createPasscode, withPaidPlanHint, listPasscodes, revokePasscode } from "./passcode.ts";
import { ApiClient, ApiError } from "./api-client.ts";

const BASE_URL = "https://api.example.com";
const TOKEN = "test-token";
const staticTokenProvider = async () => TOKEN;
const NS_ID = "ns-test";
const SLUG = "my-site";

/** Routes by method+path; records every call so order and absence can be asserted. */
function routedFetch(
  routes: Record<string, { status: number; body: unknown }>,
  calls: string[] = [],
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(BASE_URL, "")}`;
    calls.push(key);
    const r = routes[key] ?? { status: 404, body: { error: `unrouted ${key}` } };
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const LIST_KEY = `GET /api/ns/${NS_ID}/sites`;
const POST_KEY = `POST /api/ns/${NS_ID}/sites/${SLUG}/passcodes`;
const siteList = (visibility: unknown) => ({
  status: 200,
  body: { sites: [{ slug: SLUG, ...(visibility === undefined ? {} : { visibility }) }] },
});

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

// ─── DW-5.3: addPasscode ─────────────────────────────────────────────────────

describe("DW-5.3: addPasscode", () => {
  it("test_DW_5_3_add_passcode_posts_to_api", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: unknown = null;

    const fetchFn = async (url: string, init?: RequestInit) => {
      // New flow: the site's visibility is read (GET /sites) before the POST.
      if (url.endsWith(`/api/ns/${NS_ID}/sites`)) {
        return new Response(
          JSON.stringify({ sites: [{ slug: SLUG, visibility: "passcode" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(
        JSON.stringify({ id: "pc-1", label: "Client A", created_at: "2026-01-01T00:00:00Z" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await addPasscode(apiClient, NS_ID, SLUG, "mycode", "Client A");

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/${SLUG}/passcodes`);
    expect(capturedMethod).toBe("POST");
    expect(capturedBody).toMatchObject({ code: "mycode", label: "Client A" });
    expect(result.passcode.id).toBe("pc-1");
    expect(result.passcode.label).toBe("Client A");
  });

  it("test_DW_5_3_add_passcode_propagates_api_errors", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      routedFetch({
        [LIST_KEY]: siteList("passcode"),
        [POST_KEY]: { status: 403, body: { error: "Tier limit reached" } },
      }),
    );

    await expect(addPasscode(apiClient, NS_ID, SLUG, "code", "label")).rejects.toThrow("API error 403");
  });

  it("test_DW_5_3_add_passcode_requires_code", async () => {
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, {}));
    await expect(addPasscode(apiClient, NS_ID, SLUG, "", "label")).rejects.toThrow("code is required");
  });

  it("test_DW_5_3_add_passcode_requires_label", async () => {
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, {}));
    await expect(addPasscode(apiClient, NS_ID, SLUG, "code", "")).rejects.toThrow("label is required");
  });
});

// ─── DW-5.4: listPasscodes ───────────────────────────────────────────────────

describe("DW-5.4: listPasscodes", () => {
  it("test_DW_5_4_list_passcodes_returns_array", async () => {
    const passcodes = [
      { id: "pc-1", label: "Client A", created_at: "2026-01-01T00:00:00Z" },
      { id: "pc-2", label: "Client B", created_at: "2026-02-01T00:00:00Z" },
    ];

    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, { passcodes }),
    );

    const result = await listPasscodes(apiClient, NS_ID, SLUG);

    expect(result.passcodes).toHaveLength(2);
    expect(result.passcodes[0].id).toBe("pc-1");
    expect(result.passcodes[1].label).toBe("Client B");
  });

  it("test_DW_5_4_list_passcodes_sends_get_to_correct_url", async () => {
    let capturedUrl = "";
    let capturedMethod = "";

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return new Response(JSON.stringify({ passcodes: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await listPasscodes(apiClient, NS_ID, SLUG);

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/${SLUG}/passcodes`);
    expect(capturedMethod).toBe("GET");
  });

  it("test_DW_5_4_list_passcodes_returns_empty_array", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, { passcodes: [] }),
    );

    const result = await listPasscodes(apiClient, NS_ID, SLUG);
    expect(result.passcodes).toHaveLength(0);
  });

  it("test_DW_5_4_list_passcodes_propagates_api_errors", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(500, { error: "Internal server error" }),
    );

    await expect(listPasscodes(apiClient, NS_ID, SLUG)).rejects.toThrow("API error 500");
  });
});

// ─── DW-5.5: revokePasscode ──────────────────────────────────────────────────

describe("DW-5.5: revokePasscode", () => {
  it("test_DW_5_5_revoke_passcode_by_id", async () => {
    let capturedUrl = "";
    let capturedMethod = "";

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return new Response(JSON.stringify({ message: "Passcode revoked" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await revokePasscode(apiClient, NS_ID, SLUG, "pc-1");

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/${SLUG}/passcodes/pc-1`);
    expect(capturedMethod).toBe("DELETE");
    expect(result.message).toBe("Passcode revoked");
  });

  it("test_DW_5_5_revoke_passcode_requires_id", async () => {
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, {}));
    await expect(revokePasscode(apiClient, NS_ID, SLUG, "")).rejects.toThrow("id is required");
  });

  it("test_DW_5_5_revoke_passcode_propagates_api_errors", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(404, { error: "Passcode not found" }),
    );

    await expect(revokePasscode(apiClient, NS_ID, SLUG, "pc-99")).rejects.toThrow("API error 404");
  });
});

// ─── Phase 2 (skill-refresh): addPasscode refuses to "protect" a non-passcode site ──

describe("DW-2.3: addPasscode guards on current visibility", () => {
  it("test_DW_2_3_public_site_refused_with_exact_text_and_no_post", async () => {
    const calls: string[] = [];
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, routedFetch({ [LIST_KEY]: siteList("public") }, calls));
    await expect(addPasscode(apiClient, NS_ID, SLUG, "abcd", "x")).rejects.toThrow(
      `Site "${SLUG}" is PUBLIC — adding a passcode does not protect it. ` +
      `To make it private, call visibility(slug, "passcode", passcode: "<code>").`,
    );
    expect(calls).toEqual([LIST_KEY]);
  });

  it("test_DW_2_3_gated_site_refused_explains_form_gate_replaces_passcodes_no_post", async () => {
    const calls: string[] = [];
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, routedFetch({ [LIST_KEY]: siteList("gated") }, calls));
    const err = await addPasscode(apiClient, NS_ID, SLUG, "abcd", "x").catch((e: Error) => e);
    expect((err as Error).message).toContain("GATED");
    expect((err as Error).message).toContain("form gate replaces passcodes");
    expect(calls).toEqual([LIST_KEY]);
  });

  it("test_DW_2_3_signed_and_identity_sites_refused_no_post", async () => {
    for (const v of ["signed", "identity"]) {
      const calls: string[] = [];
      const apiClient = new ApiClient(BASE_URL, staticTokenProvider, routedFetch({ [LIST_KEY]: siteList(v) }, calls));
      await expect(addPasscode(apiClient, NS_ID, SLUG, "abcd", "x")).rejects.toThrow(v.toUpperCase());
      expect(calls).toEqual([LIST_KEY]);
    }
  });

  it("test_DW_2_3_passcode_site_still_posts_after_one_site_read", async () => {
    const calls: string[] = [];
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      routedFetch(
        {
          [LIST_KEY]: siteList("passcode"),
          [POST_KEY]: { status: 201, body: { id: "pc-9", label: "x", created_at: "t" } },
        },
        calls,
      ),
    );
    const r = await addPasscode(apiClient, NS_ID, SLUG, "abcd", "x");
    expect(r.passcode.id).toBe("pc-9");
    expect(calls).toEqual([LIST_KEY, POST_KEY]);
  });

  it("test_DW_2_8_missing_visibility_field_refused_no_post", async () => {
    const calls: string[] = [];
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, routedFetch({ [LIST_KEY]: siteList(undefined) }, calls));
    await expect(addPasscode(apiClient, NS_ID, SLUG, "abcd", "x")).rejects.toThrow(
      "couldn't read the site's current visibility",
    );
    expect(calls).toEqual([LIST_KEY]);
  });

  it("test_DW_2_3_unrecognised_visibility_value_refused_not_guessed", async () => {
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, routedFetch({ [LIST_KEY]: siteList("weird") }));
    await expect(addPasscode(apiClient, NS_ID, SLUG, "abcd", "x")).rejects.toThrow(
      "couldn't read the site's current visibility",
    );
  });

  it("test_DW_2_3_unknown_slug_says_not_found_no_post", async () => {
    const calls: string[] = [];
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      routedFetch({ [LIST_KEY]: { status: 200, body: { sites: [{ slug: "other", visibility: "passcode" }] } } }, calls),
    );
    await expect(addPasscode(apiClient, NS_ID, SLUG, "abcd", "x")).rejects.toThrow("not found");
    expect(calls).toEqual([LIST_KEY]);
  });

  it("test_DW_2_3_empty_code_rejected_before_any_request", async () => {
    const calls: string[] = [];
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, routedFetch({}, calls));
    await expect(addPasscode(apiClient, NS_ID, SLUG, "", "x")).rejects.toThrow("code is required");
    expect(calls).toEqual([]);
  });
});

describe("DW-2.2: createPasscode / withPaidPlanHint", () => {
  it("test_DW_2_2_create_passcode_posts_without_reading_visibility", async () => {
    const calls: string[] = [];
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      routedFetch({ [POST_KEY]: { status: 201, body: { id: "p", label: "l", created_at: "t" } } }, calls),
    );
    await createPasscode(apiClient, NS_ID, SLUG, "abcd", "l");
    expect(calls).toEqual([POST_KEY]);
  });

  it("test_DW_2_2_free_tier_403_carries_upgrade_hint_and_stays_an_ApiError", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      routedFetch({ [POST_KEY]: { status: 403, body: { error: "Passcode-protected sites require a paid plan" } } }),
    );
    const err = await createPasscode(apiClient, NS_ID, SLUG, "abcd", "l").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as Error).message).toContain("paid plan");
    expect((err as Error).message).toContain("`upgrade`");
  });

  it("test_DW_2_2_non_tier_errors_get_no_hint", () => {
    const other = new ApiError(403, { error: "Insufficient permissions" }, "API error 403: Insufficient permissions");
    expect(withPaidPlanHint(other)).toBe(other);
    const notFound = new ApiError(404, null, "API error 404: paid plan");
    expect(withPaidPlanHint(notFound)).toBe(notFound);
    const plain = new Error("boom");
    expect(withPaidPlanHint(plain)).toBe(plain);
  });
});
