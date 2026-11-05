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
 *
 * Gate-contract fix (2026-07-28):
 * Covers DW-1.1: setGate PUTs {type, required} objects — asserted on the captured body
 * Covers DW-1.2: a gate's object fields render as readable text, never "[object Object]"
 * Covers DW-1.3: the field-type union is exactly the four types the backend accepts
 *
 * These tests mock ApiClient, which is how the original bug survived: the suite
 * asserted that a PUT happened, never what it carried. Every setGate test here
 * asserts the exact request body, so a regression to bare strings fails.
 */

import { describe, it, expect } from "bun:test";
import {
  getGate,
  setGate,
  removeGate,
  getSubmissions,
  clearSubmissions,
  formatGateFields,
} from "./gate.ts";
import { ApiClient, ApiError } from "./api-client.ts";
import type { GateConfig, GateFieldType, GateSubmission } from "./types.ts";

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
  fields: [
    { type: "email", required: true },
    { type: "name", required: true },
  ],
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
    expect(result.gate.fields).toEqual([
      { type: "email", required: true },
      { type: "name", required: true },
    ]);
    expect(result.submission_count).toBe(3);
  });

  it("test_DW_4_5_get_gate_returns_config_and_count", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(200, { gate: GATE_CONFIG, submission_count: 7 }),
    );
    const result = await getGate(apiClient, NS_ID, SLUG);
    expect(result.gate).toMatchObject({
      slug: SLUG,
      fields: [
        { type: "email", required: true },
        { type: "name", required: true },
      ],
    });
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
  /** Captures what setGate actually put on the wire. */
  function captureSetGate() {
    const captured: { url: string; method: string; body: unknown; calls: number } = {
      url: "",
      method: "",
      body: null,
      calls: 0,
    };

    const fetchFn = async (url: string, init?: RequestInit) => {
      captured.calls += 1;
      captured.url = url;
      captured.method = init?.method ?? "";
      captured.body = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(
        JSON.stringify({ gate: GATE_CONFIG }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    return { captured, apiClient: new ApiClient(BASE_URL, staticTokenProvider, fetchFn) };
  }

  it("test_DW_4_4_set_gate_sends_put_with_fields", async () => {
    const { captured, apiClient } = captureSetGate();
    const result = await setGate(apiClient, NS_ID, SLUG, ["email", "name"]);

    expect(captured.url).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/${SLUG}/gate`);
    expect(captured.method).toBe("PUT");
    expect(result.gate.fields).toEqual([
      { type: "email", required: true },
      { type: "name", required: true },
    ]);
  });

  // ─── DW-1.1: the exact wire body ───────────────────────────────────────────

  it("test_DW_1_1_set_gate_puts_field_objects", async () => {
    const { captured, apiClient } = captureSetGate();
    await setGate(apiClient, NS_ID, SLUG, ["email", "name"]);

    // Strict equality, not toMatchObject: the server rejects anything that is
    // not an object with a boolean `required` ("each field must be an object").
    expect(captured.body).toEqual({
      fields: [
        { type: "email", required: true },
        { type: "name", required: true },
      ],
    });
  });

  it("test_DW_1_1_set_gate_body_has_no_bare_string_fields", async () => {
    const { captured, apiClient } = captureSetGate();
    await setGate(apiClient, NS_ID, SLUG, ["email", "company", "phone"]);

    // The regression guard for the original defect: fields were sent as bare
    // strings, which the mock happily accepted and the real server 400'd.
    const sent = (captured.body as { fields: unknown[] }).fields;
    expect(Array.isArray(sent)).toBe(true);
    for (const field of sent) {
      expect(typeof field).toBe("object");
      expect(field).not.toBeNull();
      expect(typeof (field as Record<string, unknown>).type).toBe("string");
      expect(typeof (field as Record<string, unknown>).required).toBe("boolean");
    }
  });

  it("test_DW_1_1_set_gate_defaults_every_field_to_required_true", async () => {
    const { captured, apiClient } = captureSetGate();
    await setGate(apiClient, NS_ID, SLUG, ["email", "name", "company", "phone"]);

    const sent = (captured.body as { fields: Array<{ required: boolean }> }).fields;
    expect(sent).toHaveLength(4);
    expect(sent.every((f) => f.required === true)).toBe(true);
  });

  it("test_DW_1_1_set_gate_preserves_field_order", async () => {
    const { captured, apiClient } = captureSetGate();
    await setGate(apiClient, NS_ID, SLUG, ["phone", "email", "company"]);

    const sent = (captured.body as { fields: Array<{ type: string }> }).fields;
    expect(sent.map((f) => f.type)).toEqual(["phone", "email", "company"]);
  });

  it("test_DW_1_1_set_gate_sends_single_field_as_an_array_of_one_object", async () => {
    const { captured, apiClient } = captureSetGate();
    await setGate(apiClient, NS_ID, SLUG, ["email"]);

    expect(captured.body).toEqual({ fields: [{ type: "email", required: true }] });
  });

  it("test_DW_4_4_set_gate_requires_fields", async () => {
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, {}));
    await expect(setGate(apiClient, NS_ID, SLUG, [])).rejects.toThrow("fields is required");
  });

  it("test_DW_1_1_set_gate_issues_no_request_when_fields_is_empty", async () => {
    const { captured, apiClient } = captureSetGate();
    await expect(setGate(apiClient, NS_ID, SLUG, [])).rejects.toThrow("fields is required");
    expect(captured.calls).toBe(0);
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

// ─── DW-1.3: the field-type union matches the backend ────────────────────────

describe("DW-1.3: gate field types", () => {
  it("test_DW_1_3_gate_field_types_match_backend_valid_set", async () => {
    // The backend's VALID_GATE_FIELD_TYPES is exactly these four
    // (upublish-backend packages/server/src/api/gate.ts). "message" was offered
    // by this client and rejected with a 400 by every server that saw it.
    const allFour: GateFieldType[] = ["email", "name", "company", "phone"];

    let capturedBody: unknown = null;
    const fetchFn = async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(
        JSON.stringify({ gate: GATE_CONFIG }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await setGate(apiClient, NS_ID, SLUG, allFour);

    const sent = (capturedBody as { fields: Array<{ type: string }> }).fields;
    expect(sent.map((f) => f.type)).toEqual(["email", "name", "company", "phone"]);
    expect(sent.map((f) => f.type)).not.toContain("message");
  });
});

// ─── DW-1.2: readable rendering of object fields ─────────────────────────────

describe("DW-1.2: formatGateFields", () => {
  it("test_DW_1_2_format_gate_fields_renders_type_list", () => {
    expect(
      formatGateFields([
        { type: "email", required: true },
        { type: "name", required: true },
      ]),
    ).toBe("email, name");
  });

  it("test_DW_1_2_format_gate_fields_marks_optional_fields", () => {
    expect(
      formatGateFields([
        { type: "email", required: true },
        { type: "phone", required: false },
      ]),
    ).toBe("email, phone (optional)");
  });

  it("test_DW_1_2_format_gate_fields_never_renders_object_object", () => {
    // The defect this replaces: fields.join(", ") on objects.
    const rendered = formatGateFields(GATE_CONFIG.fields);
    expect(rendered).not.toContain("[object Object]");
    expect(rendered).toBe("email, name");
  });

  it("test_DW_1_2_format_gate_fields_empty_list", () => {
    expect(formatGateFields([])).toBe("(none)");
  });

  it("test_DW_1_2_format_gate_fields_does_not_mark_optional_on_a_missing_required_flag", () => {
    // A response that omits `required` must not be reported as optional —
    // claiming a required field is optional is worse than saying nothing.
    const degraded = [{ type: "email" }] as unknown as GateConfig["fields"];
    expect(formatGateFields(degraded)).toBe("email");
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
    const result = await removeGate(apiClient, NS_ID, SLUG, "public");

    // The new flow always names the resulting visibility on the wire.
    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/${SLUG}/gate?visibility=public`);
    expect(capturedMethod).toBe("DELETE");
    expect(result.message).toBe("Gate removed");
  });

  it("test_DW_4_6_remove_gate_propagates_api_errors", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(404, { error: "Gate not found" }),
    );
    await expect(removeGate(apiClient, NS_ID, SLUG, "public")).rejects.toThrow("API error 404");
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

// ─── Phase 2 (skill-refresh): truthful gate removal + set ────────────────────

function recordingFetch(status: number, body: unknown, seen: { url?: string; method?: string; n: number }) {
  return async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.method = init?.method;
    seen.n++;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
}

describe("DW-2.4/2.7: removeGate visibility_after", () => {
  it("test_DW_2_4_passcode_sends_query_and_renders_echoed_visibility", async () => {
    const seen = { n: 0 } as { url?: string; method?: string; n: number };
    const api = new ApiClient(BASE_URL, staticTokenProvider, recordingFetch(200, { message: "Gate removed", visibility: "passcode" }, seen));
    const r = await removeGate(api, NS_ID, SLUG, "passcode");
    expect(seen.url).toBe(`${BASE_URL}/api/ns/${NS_ID}/sites/${SLUG}/gate?visibility=passcode`);
    expect(seen.method).toBe("DELETE");
    expect(r).toEqual({ message: "Gate removed", visibility: "passcode" });
  });

  it("test_DW_2_4_public_with_no_visibility_in_response_is_public_old_server", async () => {
    const seen = { n: 0 } as { url?: string; method?: string; n: number };
    const api = new ApiClient(BASE_URL, staticTokenProvider, recordingFetch(200, { message: "Gate removed" }, seen));
    const r = await removeGate(api, NS_ID, SLUG, "public");
    expect(r.visibility).toBe("public");
  });

  it("test_DW_2_7_passcode_requested_but_response_has_no_visibility_throws_exact_text", async () => {
    const api = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, { message: "Gate removed" }));
    await expect(removeGate(api, NS_ID, SLUG, "passcode")).rejects.toThrow(
      `The server did not keep passcode protection — "${SLUG}" is now PUBLIC. Run visibility(slug, "passcode") now.`,
    );
  });

  it("test_DW_2_7_passcode_requested_but_response_says_public_throws", async () => {
    const api = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, { message: "Gate removed", visibility: "public" }));
    await expect(removeGate(api, NS_ID, SLUG, "passcode")).rejects.toThrow("The server did not keep passcode protection");
  });

  it("test_DW_2_4_409_no_passcodes_gives_actionable_guidance_gate_untouched", async () => {
    const api = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      mockFetch(409, { error: "Site has no passcodes; add one before keeping it passcode-protected", code: "no_passcodes" }),
    );
    const err = (await removeGate(api, NS_ID, SLUG, "passcode").catch((e: Error) => e)) as Error;
    expect(err.message).toContain("NOT removed");
    expect(err.message).toContain('visibility(slug, "passcode", passcode: "<code>")');
    expect(err.cause).toBeInstanceOf(ApiError);
  });

  it("test_DW_2_4_other_409_is_not_rewritten", async () => {
    const api = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(409, { error: "conflict" }));
    await expect(removeGate(api, NS_ID, SLUG, "public")).rejects.toThrow("API error 409: conflict");
  });

  it("test_DW_2_4_invalid_visibility_after_throws_without_a_request", async () => {
    const seen = { n: 0 } as { url?: string; method?: string; n: number };
    const api = new ApiClient(BASE_URL, staticTokenProvider, recordingFetch(200, {}, seen));
    await expect(removeGate(api, NS_ID, SLUG, undefined as unknown as "public")).rejects.toThrow("visibility_after must be");
    expect(seen.n).toBe(0);
  });
});

describe("DW-2.5: setGate previous_visibility", () => {
  it("test_DW_2_5_set_gate_returns_previous_visibility_when_present", async () => {
    const api = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, { gate: GATE_CONFIG, previous_visibility: "passcode" }));
    const r = await setGate(api, NS_ID, SLUG, ["email"]);
    expect(r.previous_visibility).toBe("passcode");
  });

  it("test_DW_2_5_set_gate_old_server_or_garbage_previous_visibility_is_undefined", async () => {
    for (const body of [{ gate: GATE_CONFIG }, { gate: GATE_CONFIG, previous_visibility: "banana" }]) {
      const api = new ApiClient(BASE_URL, staticTokenProvider, mockFetch(200, body));
      expect((await setGate(api, NS_ID, SLUG, ["email"])).previous_visibility).toBeUndefined();
    }
  });
});
