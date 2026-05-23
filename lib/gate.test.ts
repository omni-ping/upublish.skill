/**
 * Tests for lib/gate.ts — core gate management logic.
 *
 * Covers DW-4.1: getGate, setGate, removeGate, getSubmissions, clearSubmissions exports
 * Covers DW-4.4: setGate sends PUT with fields param, returns gate config
 * Covers DW-4.5: getGate sends GET, returns config + submission count
 * Covers DW-4.6: removeGate sends DELETE, returns confirmation
 * Covers DW-4.7: getSubmissions sends GET to submissions endpoint, returns list
 * Covers DW-4.8: clearSubmissions sends DELETE to submissions endpoint, returns confirmation
 * Covers DW-4.9: All 5 actions covered with mock fetch
 */

import { describe, it, expect } from "bun:test";
import { getGate, setGate, removeGate, getSubmissions, clearSubmissions } from "./gate.ts";
import { ApiClient } from "./api-client.ts";
import type { GateConfig, GateSubmission } from "./types.ts";

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

const GATE_CONFIG: GateConfig = {
  slug: SLUG,
  fields: ["email", "name"],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const SUBMISSION: GateSubmission = {
  id: "sub-1",
  submitted_at: "2026-01-02T00:00:00Z",
  data: { email: "visitor@example.com", name: "Alice" },
};

// ─── DW-4.1 + DW-4.5: getGate ────────────────────────────────────────────────

describe("DW-4.1/4.5: getGate", () => {
  it("test_DW_4_5_get_gate_sends_get_to_correct_url", async () => {
    let capturedUrl = "";
    let capturedMethod = "";

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "GET";
      return new Response(
        JSON.stringify({ gate: GATE_CONFIG, submission_count: 3 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await getGate(apiClient, NS_ID, SLUG);

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/${SLUG}/gate`);
    expect(capturedMethod).toBe("GET");
    expect(result.gate.slug).toBe(SLUG);
    expect(result.gate.fields).toEqual(["email", "name"]);
    expect(result.submission_count).toBe(3);
  });

  it("test_DW_4_5_get_gate_returns_config_and_count", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, { gate: GATE_CONFIG, submission_count: 7 }),
    );
    const result = await getGate(apiClient, NS_ID, SLUG);
    expect(result.gate).toMatchObject({ slug: SLUG, fields: ["email", "name"] });
    expect(result.submission_count).toBe(7);
  });

  it("test_DW_4_5_get_gate_propagates_404_as_error", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(404, { error: "Gate not found" }),
    );
    await expect(getGate(apiClient, NS_ID, SLUG)).rejects.toThrow("API error 404");
  });
});

// ─── DW-4.1 + DW-4.4: setGate ────────────────────────────────────────────────

describe("DW-4.1/4.4: setGate", () => {
  it("test_DW_4_4_set_gate_sends_put_with_fields", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: unknown = null;

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(
        JSON.stringify({ gate: GATE_CONFIG }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await setGate(apiClient, NS_ID, SLUG, ["email", "name"]);

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/${SLUG}/gate`);
    expect(capturedMethod).toBe("PUT");
    expect(capturedBody).toMatchObject({ fields: ["email", "name"] });
    expect(result.gate.fields).toEqual(["email", "name"]);
  });

  it("test_DW_4_4_set_gate_requires_fields", async () => {
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, {}));
    await expect(setGate(apiClient, NS_ID, SLUG, [])).rejects.toThrow("fields is required");
  });

  it("test_DW_4_4_set_gate_propagates_api_errors", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(403, { error: "Tier limit" }),
    );
    await expect(setGate(apiClient, NS_ID, SLUG, ["email"])).rejects.toThrow("API error 403");
  });
});

// ─── DW-4.1 + DW-4.6: removeGate ────────────────────────────────────────────

describe("DW-4.1/4.6: removeGate", () => {
  it("test_DW_4_6_remove_gate_sends_delete_to_correct_url", async () => {
    let capturedUrl = "";
    let capturedMethod = "";

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return new Response(
        JSON.stringify({ message: "Gate removed" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await removeGate(apiClient, NS_ID, SLUG);

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/${SLUG}/gate`);
    expect(capturedMethod).toBe("DELETE");
    expect(result.message).toBe("Gate removed");
  });

  it("test_DW_4_6_remove_gate_propagates_api_errors", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(404, { error: "Gate not found" }),
    );
    await expect(removeGate(apiClient, NS_ID, SLUG)).rejects.toThrow("API error 404");
  });
});

// ─── DW-4.1 + DW-4.7: getSubmissions ─────────────────────────────────────────

describe("DW-4.1/4.7: getSubmissions", () => {
  it("test_DW_4_7_get_submissions_sends_get_to_submissions_url", async () => {
    let capturedUrl = "";
    let capturedMethod = "";

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "GET";
      return new Response(
        JSON.stringify({ submissions: [SUBMISSION] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await getSubmissions(apiClient, NS_ID, SLUG);

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/${SLUG}/gate/submissions`);
    expect(capturedMethod).toBe("GET");
    expect(result.submissions).toHaveLength(1);
    expect(result.submissions[0].id).toBe("sub-1");
  });

  it("test_DW_4_7_get_submissions_returns_list", async () => {
    const submissions = [SUBMISSION, { ...SUBMISSION, id: "sub-2" }];
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, { submissions }),
    );
    const result = await getSubmissions(apiClient, NS_ID, SLUG);
    expect(result.submissions).toHaveLength(2);
    expect(result.submissions[0].data).toMatchObject({ email: "visitor@example.com" });
  });

  it("test_DW_4_7_get_submissions_empty_list", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, { submissions: [] }),
    );
    const result = await getSubmissions(apiClient, NS_ID, SLUG);
    expect(result.submissions).toHaveLength(0);
  });

  it("test_DW_4_7_get_submissions_propagates_api_errors", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(404, { error: "Gate not found" }),
    );
    await expect(getSubmissions(apiClient, NS_ID, SLUG)).rejects.toThrow("API error 404");
  });
});

// ─── DW-4.1 + DW-4.8: clearSubmissions ───────────────────────────────────────

describe("DW-4.1/4.8: clearSubmissions", () => {
  it("test_DW_4_8_clear_submissions_sends_delete_to_submissions_url", async () => {
    let capturedUrl = "";
    let capturedMethod = "";

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return new Response(
        JSON.stringify({ message: "Submissions cleared" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await clearSubmissions(apiClient, NS_ID, SLUG);

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/${SLUG}/gate/submissions`);
    expect(capturedMethod).toBe("DELETE");
    expect(result.message).toBe("Submissions cleared");
  });

  it("test_DW_4_8_clear_submissions_propagates_api_errors", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(404, { error: "Gate not found" }),
    );
    await expect(clearSubmissions(apiClient, NS_ID, SLUG)).rejects.toThrow("API error 404");
  });
});
