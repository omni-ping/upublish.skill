/**
 * DW-6.1: backend error mapping: server text + [code] + next step, per code,
 * with secret values stripped.
 */

import { describe, it, expect } from "bun:test";
import { ApiError } from "./api-client.ts";
import { BackendError, guard, redactValues, toBackendError, withRedaction } from "./backend-errors.ts";
import type { BackendErrorCode } from "./backend-shape.ts";

const api = (status: number, code: string | null, error = "server text") =>
  new ApiError(status, code === null ? null : { error, code }, `API error ${status}: ${error}`);

describe("DW-6.1: toBackendError", () => {
  const CODES: Array<[BackendErrorCode, RegExp]> = [
    ["unauthenticated", /login tool/],
    ["not_found", /must already be published/],
    ["forbidden", /admin role on the address \(owner or admin member\)/],
    ["not_available", /not available for this account/],
    ["upgrade_required", /Pro or Max plan.*upgrade tool/],
    ["no_subscription", /Stripe subscription/],
    ["consent_required", /WITHOUT accept_charge/],
    ["addon_not_enabled", /addon_enable/],
    ["backend_limit_exceeded", /5 backends per address, 64 secrets and 32 vars/],
    ["deploy_rate_limited", /per address per hour/],
    ["bundle_too_large", /1048576 bytes/],
    ["bundle_rejected", /ONE ES module with a default export/],
    ["version_not_found", /10 most recent archived versions/],
    ["conflict", /Another change is in flight/],
    ["upstream_failed", /previous version stays live/],
    ["unavailable", /temporary failure/],
  ];
  for (const [code, hint] of CODES) {
    it(`test_DW_6_1_error_${code}_carries_text_code_and_hint`, () => {
      const e = toBackendError(api(400, code), "admin") as BackendError;
      expect(e).toBeInstanceOf(BackendError);
      expect(e.code).toBe(code);
      if (code !== "not_available") expect(e.message).toContain("server text");
      expect(e.message).toContain(`[${code}]`);
      expect(e.message).toMatch(hint);
    });
  }

  it("a code without a hint keeps just the server text and the code", () => {
    const e = toBackendError(api(400, "invalid_request"), "admin") as BackendError;
    expect(e.message).toBe("server text [invalid_request]");
  });

  it("not_available ignores the server text (never leaks which gate hid it)", () => {
    expect((toBackendError(api(404, "not_available", "internal detail"), "member") as BackendError).message).not.toContain("internal detail");
  });

  it("forbidden for the owner role names the role", () => {
    expect((toBackendError(api(403, "forbidden"), "owner") as BackendError).message).toContain("owner role on the address.");
  });

  it("conflict and unavailable depend on the billing context", () => {
    expect((toBackendError(api(409, "conflict"), "owner", "billing_enable") as BackendError).message).toContain("subscription schedule");
    expect((toBackendError(api(503, "unavailable"), "owner", "billing_enable") as BackendError).message).toContain("WITHOUT accept_charge");
    expect((toBackendError(api(503, "unavailable"), "owner", "billing_disable") as BackendError).message).toContain("then retry");
  });

  it("control characters in server text are escaped (no forged lines)", () => {
    const e = toBackendError(api(400, "invalid_request", "bad\nSTATUS: ok"), "admin") as BackendError;
    expect(e.message).not.toContain("\n");
    expect(e.message).toContain("\\n");
  });

  it("an unstructured error passes through, unless it carries control characters or a secret", () => {
    const plain = new ApiError(502, null, "API error 502: Bad Gateway");
    expect(toBackendError(plain, "admin")).toBe(plain);
    const forged = new ApiError(502, null, "API error 502: x\nforged");
    expect((toBackendError(forged, "admin") as BackendError).message).not.toContain("\n");
    const leaky = new ApiError(502, null, "API error 502: echoed hunter22-secret");
    const cleaned = toBackendError(leaky, "admin", undefined, ["hunter22-secret"]) as BackendError;
    expect(cleaned).toBeInstanceOf(BackendError);
    expect(cleaned.message).not.toContain("hunter22-secret");
  });

  it("a non-API error is returned unchanged", () => {
    const e = new Error("fetch failed");
    expect(toBackendError(e, "admin")).toBe(e);
  });

  it("redacts a secret value from a structured error message", () => {
    const e = toBackendError(api(400, "invalid_request", "bad value sk-live-123 rejected"), "admin", undefined, ["sk-live-123"]) as BackendError;
    expect(e.message).not.toContain("sk-live-123");
    expect(e.message).toContain("[redacted]");
  });
});

describe("DW-6.1: redactValues and guard", () => {
  it("replaces every occurrence and ignores empty values", () => {
    expect(redactValues("a SECRET b SECRET", ["SECRET"])).toBe("a [redacted] b [redacted]");
    expect(redactValues("unchanged", [""])).toBe("unchanged");
  });

  it("guard rethrows API errors as BackendError and passes success through", async () => {
    expect(await guard("admin", async () => 7)).toBe(7);
    await expect(guard("admin", async () => { throw api(402, "addon_not_enabled"); })).rejects.toMatchObject({ name: "BackendError", code: "addon_not_enabled", status: 402 });
  });
});

describe("DW-6.1: redaction covers every spelling of a secret", () => {
  const PEM = "-----BEGIN KEY-----\nabc123def456\nsecondLine789\n-----END KEY-----";
  const TABS = "col1value\tcol2value\tcol3value";
  const redacted = (error: string, code: string, value: string) =>
    (toBackendError(api(400, code, error), "admin", undefined, [value]) as BackendError).message;
  const leaks = (text: string, value: string) =>
    [value, ...value.split(/[\r\n\t]/).filter((p) => p.length >= 4), JSON.stringify(value).slice(1, -1)].filter((f) => text.includes(f));

  const CASES: Array<[string, string, (v: string) => string]> = [
    ["multi-line PEM echoed raw", PEM, (v) => `bad ${v} rejected`],
    ["value with tabs echoed raw", TABS, (v) => `bad ${v} rejected`],
    ["only one line of the PEM echoed", PEM, () => "line was abc123def456 exactly"],
    ["one tab segment echoed", TABS, () => "saw col2value here"],
    ["JSON-escaped echo", PEM, (v) => `body ${JSON.stringify({ value: v })}`],
    ["control-escaped echo", PEM, (v) => `body ${JSON.stringify(v).slice(1, -1)}`],
  ];
  for (const [label, value, makeError] of CASES) {
    it(`test_DW_6_1_redaction_${label.replace(/[^a-z0-9]+/gi, "_")}`, () => {
      const message = redacted(makeError(value), "invalid_request", value);
      expect(leaks(message, value)).toEqual([]);
      expect(message).toContain("[redacted]");
    });
  }

  it("a secret echoed in the error `code` is never surfaced (the code becomes unknown)", () => {
    const e = toBackendError(api(400, PEM, "text"), "admin", undefined, [PEM]) as BackendError;
    expect(e.code).toBeNull();
    expect(leaks(e.message, PEM)).toEqual([]);
    const partial = toBackendError(api(400, "abc123def456", "text"), "admin", undefined, [PEM]) as BackendError;
    expect(partial.code).toBeNull();
    expect(partial.message).not.toContain("abc123def456");
  });

  it("an unstructured error carrying a multi-line secret is cleaned too", () => {
    const e = toBackendError(new ApiError(502, null, `API error 502: ${PEM}`), "admin", undefined, [PEM]) as BackendError;
    expect(leaks(e.message, PEM)).toEqual([]);
  });

  it("short segments are not redacted on their own (they would mangle ordinary text) but the whole value is", () => {
    expect(redactValues("a b c and a\nb", ["a\nb"])).toBe("a b c and [redacted]");
    expect(redactValues("xyz", ["a\nb"])).toBe("xyz");
  });
});

describe("DW-6.1: more spellings and the whole-operation boundary", () => {
  it("test_DW_6_1_redacts_the_trimmed_value_and_trimmed_segments", () => {
    const padded = "  padded-secret-value \n";
    expect(redactValues("echo: padded-secret-value!", [padded])).toBe("echo: [redacted]!");
    const lines = "  first-line-aaa  \n  second-line-bbb  ";
    expect(redactValues("saw first-line-aaa and second-line-bbb", [lines])).toBe("saw [redacted] and [redacted]");
  });

  it("test_DW_6_1_redacts_u_escapes_of_non_ascii_in_lower_and_upper_hex", () => {
    const v = "pässwörd-日本語-😀";
    const lower = "p\\u00e4ssw\\u00f6rd-\\u65e5\\u672c\\u8a9e-\\ud83d\\ude00";
    const upper = lower.replace(/\\u([0-9a-f]{4})/g, (_, h: string) => `\\u${h.toUpperCase()}`);
    for (const echo of [lower, upper, v, JSON.stringify(v)]) expect(redactValues(`x ${echo} y`, [v])).toBe("x [redacted] y");
  });

  it("withRedaction passes a result through", async () => {
    expect(await withRedaction(["s"], async () => 5)).toBe(5);
  });

  it("withRedaction rebuilds a BackendError keeping code and status, redacted again", async () => {
    const e = await withRedaction(["topsecret1"], async () => { throw new BackendError("conflict", 409, "x topsecret1 y"); }).catch((x: BackendError) => x);
    expect(e).toBeInstanceOf(BackendError);
    expect([e.code, e.status, e.message]).toEqual(["conflict", 409, "x [redacted] y"]);
  });

  it("withRedaction replaces a JSON syntax error (it quotes the start of the body) with a fixed sentence", async () => {
    const e = await withRedaction(["topsecret1"], async () => { throw new SyntaxError('JSON Parse error: Unexpected identifier "topsecret1"'); }).catch((x: Error) => x);
    expect(e.message).toContain("not valid JSON");
    expect(e.message).not.toContain("topsecret1");
  });

  it("withRedaction redacts TypeErrors, network errors and non-Error throws and drops cause and stack text", async () => {
    const cause = new Error("inner topsecret1");
    for (const thrown of [new TypeError("bad topsecret1"), new Error("fetch failed", { cause }), "plain topsecret1", Object.assign(new Error("net topsecret1"), { stack: "stack topsecret1" })]) {
      const e = await withRedaction(["topsecret1"], async () => { throw thrown; }).catch((x: Error) => x);
      expect(e).toBeInstanceOf(Error);
      expect(`${e.message}${e.stack ?? ""}`).not.toContain("topsecret1");
      expect((e as { cause?: unknown }).cause).toBeUndefined();
    }
  });
});

describe("DW-6.1: the combined JSON + \\u encoding (Python ensure_ascii style)", () => {
  const V = 'pä"ss\\wörd-ZQX9999';
  const lower = 'p\\u00e4\\"ss\\\\w\\u00f6rd-ZQX9999';
  const upper = lower.replace(/\\u([0-9a-f]{4})/g, (_, h: string) => `\\u${h.toUpperCase()}`);

  it("test_DW_6_1_redacts_every_cross_product_encoding", () => {
    expect(lower).toBe(String.raw`p\u00e4\"ss\\w\u00f6rd-ZQX9999`);
    const forms = [V, lower, upper, JSON.stringify(V), JSON.stringify(V).slice(1, -1), lower.replace(/\\u00e4|\\u00f6/g, (m) => (m === "\\u00e4" ? "ä" : "ö"))];
    for (const form of forms) {
      expect(redactValues(`bad ${form} here`, [V]), form).toBe("bad [redacted] here");
    }
  });

  it("works through toBackendError for the error text and the code", () => {
    for (const echo of [lower, upper]) {
      const e = toBackendError(api(400, "invalid_request", `bad ${echo}`), "admin", undefined, [V]) as BackendError;
      expect(e.message).not.toContain("ZQX9999");
      const c = toBackendError(api(400, echo, "text"), "admin", undefined, [V]) as BackendError;
      expect(c.code).toBeNull();
      expect(c.message).not.toContain("ZQX9999");
    }
  });
});
