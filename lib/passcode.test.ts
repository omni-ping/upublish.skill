/**
 * Tests for lib/passcode.ts — core passcode management logic.
 *
 * Covers DW-5.3: addPasscode posts to the correct API endpoint with code + label
 * Covers DW-5.4: listPasscodes returns array of { id, label, created_at }
 * Covers DW-5.5: revokePasscode sends DELETE to the correct endpoint
 * Covers DW-5.7: functions exist with correct signatures (ApiClient + nsId + slug)
 */

import { describe, it, expect } from "bun:test";
import { addPasscode, listPasscodes, revokePasscode } from "./passcode.ts";
import { ApiClient } from "./api-client.ts";

const BASE_URL = "https://api.example.com";
const TOKEN = "test-token";
const staticTokenProvider = async () => TOKEN;
const NS_ID = "ns-test";
const SLUG = "my-site";

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
      mockFetch(403, { error: "Tier limit reached" }),
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
