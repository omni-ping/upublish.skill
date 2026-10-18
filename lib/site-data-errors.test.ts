/**
 * DW-6.1: error mapping for site data — every contract code a skill route can
 * return becomes an actionable SiteDataError; everything else passes through.
 */

import { describe, it, expect } from "bun:test";
import { ApiError } from "./api-client.ts";
import { guard, requireArg, SiteDataError, toSiteDataError } from "./site-data-errors.ts";
import type { ApiRole, SiteDataErrorCode } from "./site-data-types.ts";

const apiError = (status: number, code: string, error = "server text"): ApiError =>
  new ApiError(status, { error, code }, `API error ${status}: ${error}`);

const mapped = (code: SiteDataErrorCode, status: number, role: ApiRole = "owner"): SiteDataError => {
  const out = toSiteDataError(apiError(status, code), role);
  expect(out).toBeInstanceOf(SiteDataError);
  return out as SiteDataError;
};

describe("DW-6.1: toSiteDataError", () => {
  const cases: Array<[SiteDataErrorCode, number, RegExp]> = [
    ["unauthenticated", 401, /login tool/],
    ["not_found", 404, /not a member.*address name/],
    ["not_available", 404, /not available for this account/],
    ["upgrade_required", 402, /upgrade tool/],
    ["no_subscription", 402, /Subscribe to a paid plan/],
    ["consent_required", 402, /accept_charge: true/],
    ["addon_not_enabled", 402, /action 'enable'/],
    ["collection_not_found", 404, /action 'list'/],
    ["collection_exists", 409, /action 'set'/],
    ["limit_exceeded", 409, /collection limit/],
    ["collection_full", 409, /max_rows/],
    ["row_too_large", 413, /max_row_bytes/],
    ["admin_channel_failed", 502, /retry shortly/],
    ["conflict", 409, /active rows.*data_rows action 'archive'.*new collection/],
    ["unavailable", 503, /Retry shortly/],
  ];
  for (const [code, status, hint] of cases) {
    it(`test_DW_6_1_error_${code}_is_actionable`, () => {
      const e = mapped(code, status);
      expect(e.code).toBe(code);
      expect(e.status).toBe(status);
      expect(e.message).toContain(`[${code}]`);
      expect(e.message).toMatch(hint);
    });
  }

  it("test_DW_6_1_error_forbidden_names_the_required_role", () => {
    expect(mapped("forbidden", 403, "owner").message).toContain("needs the owner role");
    expect(mapped("forbidden", 403, "admin").message).toContain("owner or admin member");
  });

  it("test_DW_6_1_error_not_available_does_not_advertise", () => {
    // The server text could mention the add-on; the message must stay generic.
    const e = toSiteDataError(apiError(404, "not_available", "Site data add-on is hidden"), "member") as SiteDataError;
    expect(e.message).toBe("Site data is not available for this account. [not_available]");
  });

  it("test_DW_6_1_error_keeps_server_text_for_codes_without_hint", () => {
    const e = mapped("invalid_request", 400);
    expect(e.message).toBe("server text [invalid_request]");
  });

  it("test_DW_6_1_error_unstructured_and_non_api_errors_pass_through", () => {
    const plain = new Error("Not authenticated. Use the login tool to sign in.");
    expect(toSiteDataError(plain, "owner")).toBe(plain);
    const gateway = new ApiError(502, null, "API error 502: Bad Gateway");
    expect(toSiteDataError(gateway, "owner")).toBe(gateway);
    const noCode = new ApiError(500, { error: "boom" }, "API error 500: boom");
    expect(toSiteDataError(noCode, "owner")).toBe(noCode);
  });

  it("test_DW_6_1_error_missing_text_still_yields_code_and_hint", () => {
    const e = toSiteDataError(new ApiError(402, { code: "addon_not_enabled" }, "x"), "admin") as SiteDataError;
    expect(e.message).toMatch(/^\[addon_not_enabled\] Enable site data first/);
  });
});

describe("DW-6.3: conflict and billing unavailable hints", () => {
  it("test_DW_6_3_unavailable_in_billing_context_says_nothing_changed_try_again", () => {
    const e = toSiteDataError(apiError(503, "unavailable", "Billing is temporarily unavailable. Try again."), "owner", "billing") as SiteDataError;
    expect(e.code).toBe("unavailable");
    expect(e.status).toBe(503);
    expect(e.message).toContain("Billing is temporarily unavailable. Nothing changed: try again shortly.");
  });

  it("test_DW_6_3_guard_threads_context_to_the_mapping", async () => {
    const err = await guard("owner", async () => { throw apiError(503, "unavailable"); }, "billing").catch((e: unknown) => e);
    expect((err as SiteDataError).message).toContain("Nothing changed");
  });
});

describe("DW-6.1: guard and requireArg", () => {
  it("test_DW_6_1_guard_returns_value", async () => {
    expect(await guard("owner", async () => 7)).toBe(7);
  });

  it("test_DW_6_1_guard_translates_api_errors_with_role", async () => {
    const err = await guard("admin", async () => { throw apiError(403, "forbidden"); }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteDataError);
    expect((err as SiteDataError).message).toContain("admin role");
  });

  it("test_DW_6_1_requireArg_returns_defined_and_throws_on_undefined", () => {
    expect(requireArg("x", "path", "export")).toBe("x");
    expect(requireArg(0, "n", "a")).toBe(0);
    expect(() => requireArg(undefined, "path", "export")).toThrow("path is required when action is 'export'");
  });
});

describe("review R-2: server error text cannot forge lines", () => {
  it("test_R2_error_text_and_code_with_control_characters_are_escaped", () => {
    const e = toSiteDataError(new ApiError(400, { error: "bad\nauthor: owner:admin", code: "invalid_request" }, "x"), "owner") as SiteDataError;
    expect(e.message.split("\n")).toHaveLength(1);
    expect(e.message).toContain('"bad\\nauthor: owner:admin"');
    const odd = toSiteDataError(new ApiError(400, { error: "x", code: "weird\ncode" }, "x"), "owner") as SiteDataError;
    expect(odd.message.split("\n")).toHaveLength(1);
  });
});
