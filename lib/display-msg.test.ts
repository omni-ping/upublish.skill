/**
 * Unit tests for displayMsg — the display-boundary translator (skill repo).
 *
 * DW-3.3: Standalone "Namespace"/"namespace" → "Address"/"address"
 * DW-3.4: Hyphenated slug like `namespace-1` is byte-preserved
 */
import { describe, it, expect } from "bun:test";
import { displayMsg } from "./display-msg.js";

// ─── DW-3.3: Standalone word replacement (both cases) ────────────────────────

describe("DW-3.3: displayMsg replaces standalone 'namespace' with 'address'", () => {
  it("test_DW_3_3_uppercase_Namespace_becomes_Address", () => {
    expect(displayMsg("Namespace not found")).toBe("Address not found");
  });

  it("test_DW_3_3_lowercase_namespace_becomes_address", () => {
    expect(displayMsg("namespace not found")).toBe("address not found");
  });

  it("test_DW_3_3_mixed_sentence", () => {
    expect(displayMsg("Failed to create namespace")).toBe(
      "Failed to create address"
    );
  });

  it("test_DW_3_3_plural_namespaces", () => {
    expect(displayMsg("Failed to load namespaces")).toBe(
      "Failed to load addresses"
    );
  });
});

// ─── DW-3.4: Hyphenated slug is byte-preserved ───────────────────────────────

describe("DW-3.4: displayMsg preserves hyphenated slug values", () => {
  it("test_DW_3_4_hyphenated_slug_preserved", () => {
    // EXACT expected string — "namespace-1" must NOT become "address-1"
    expect(displayMsg("Namespace 'namespace-1' not found")).toBe(
      "Address 'namespace-1' not found"
    );
  });

  it("test_DW_3_4_mid_hyphenated_namespace_preserved", () => {
    expect(displayMsg("namespace 'my-namespace-project' already taken")).toBe(
      "address 'my-namespace-project' already taken"
    );
  });

  it("test_DW_3_4_naive_global_replace_would_fail", () => {
    // Confirm naive /namespace/gi would corrupt namespace-1 → address-1
    const naive = "Namespace 'namespace-1' not found".replace(
      /namespace/gi,
      "address"
    );
    expect(naive).toBe("address 'address-1' not found"); // naive IS wrong
    // Our implementation must give the correct result
    const ours = displayMsg("Namespace 'namespace-1' not found");
    expect(ours).not.toBe("address 'address-1' not found");
    expect(ours).toBe("Address 'namespace-1' not found");
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe("displayMsg idempotency", () => {
  it("re-applying produces same result as single application", () => {
    const input = "Namespace not found";
    const once = displayMsg(input);
    const twice = displayMsg(once);
    expect(twice).toBe(once);
  });

  it("already-translated string is unchanged", () => {
    expect(displayMsg("Address not found")).toBe("Address not found");
  });
});

// ─── No "namespace" passthrough ──────────────────────────────────────────────

describe("displayMsg passthrough for strings without 'namespace'", () => {
  it("string with no namespace is unchanged", () => {
    expect(displayMsg("Something went wrong. Please try again.")).toBe(
      "Something went wrong. Please try again."
    );
  });

  it("empty string is unchanged", () => {
    expect(displayMsg("")).toBe("");
  });

  it("unrelated error text is unchanged", () => {
    expect(displayMsg("Failed to add member")).toBe("Failed to add member");
  });
});

// ─── Lib error strings (raw) pass through displayMsg correctly ────────────────

describe("displayMsg with real lib error strings", () => {
  it("namespace.ts error becomes address error", () => {
    // Typical lib error: "Namespace 'foo' not found" (from lib/namespace.ts)
    expect(displayMsg("Namespace 'foo' not found")).toBe(
      "Address 'foo' not found"
    );
  });

  it("rate limit error with no namespace is unchanged", () => {
    expect(displayMsg("Rate limit exceeded. Please try again later.")).toBe(
      "Rate limit exceeded. Please try again later."
    );
  });
});
