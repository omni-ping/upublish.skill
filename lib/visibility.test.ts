/**
 * Tests for lib/visibility.ts — setVisibility (public <-> passcode).
 *
 * Covers DW-2.1 (POST-then-PATCH order, result shape), DW-2.2 (zero-code refusal,
 * public PATCH, partial failure, free-tier hint, unknown slug), DW-2.8 (gated
 * previous state, unreadable visibility) and the defensive input checks.
 * Every test records the exact call sequence so an extra or missing mutation fails.
 */

import { describe, it, expect } from "bun:test";
import { setVisibility } from "./visibility.ts";
import { ApiClient, ApiError } from "./api-client.ts";

const BASE_URL = "https://api.example.com";
const NS_ID = "ns-test";
const SLUG = "my-site";
const tokenProvider = async () => "t";

const SITES = `GET /api/ns/${NS_ID}/sites`;
const CODES = `GET /api/ns/${NS_ID}/sites/${SLUG}/passcodes`;
const POST = `POST /api/ns/${NS_ID}/sites/${SLUG}/passcodes`;
const PATCH = `PATCH /api/ns/${NS_ID}/sites/${SLUG}/visibility`;

type Route = { status: number; body: unknown };

function client(routes: Record<string, Route>, calls: string[], bodies: Record<string, unknown> = {}) {
  const fetchFn = async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(BASE_URL, "")}`;
    calls.push(key);
    if (init?.body) bodies[key] = JSON.parse(init.body as string);
    const r = routes[key] ?? { status: 404, body: { error: `unrouted ${key}` } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  };
  return new ApiClient(BASE_URL, tokenProvider, fetchFn);
}

const sites = (visibility?: string, slug = SLUG): Route => ({
  status: 200,
  body: { sites: [{ slug, ...(visibility ? { visibility } : {}) }] },
});
const codes = (n: number): Route => ({
  status: 200,
  body: { passcodes: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, label: `l${i}`, created_at: "t" })) },
});
const created: Route = { status: 201, body: { id: "new-1", label: "Client A", created_at: "t" } };
const patched = (v: string): Route => ({ status: 200, body: { site: { slug: SLUG, visibility: v } } });

describe("DW-2.1: setVisibility passcode + new code", () => {
  it("test_DW_2_1_posts_passcode_then_patches_in_that_order", async () => {
    const calls: string[] = [];
    const bodies: Record<string, unknown> = {};
    const api = client({ [SITES]: sites("public"), [CODES]: codes(0), [POST]: created, [PATCH]: patched("passcode") }, calls, bodies);
    const r = await setVisibility(api, NS_ID, { slug: SLUG, visibility: "passcode", passcode: "abcd", label: "Client A" });

    expect(calls).toEqual([SITES, CODES, POST, PATCH]);
    expect(calls.indexOf(POST)).toBeLessThan(calls.indexOf(PATCH));
    expect(bodies[POST]).toEqual({ code: "abcd", label: "Client A" });
    expect(bodies[PATCH]).toEqual({ visibility: "passcode" });
    expect(r).toMatchObject({ slug: SLUG, visibility: "passcode", previous: "public", activePasscodes: 1 });
    expect(r.addedPasscode?.id).toBe("new-1");
  });

  it("test_DW_2_1_active_count_includes_existing_codes", async () => {
    const calls: string[] = [];
    const api = client({ [SITES]: sites("public"), [CODES]: codes(2), [POST]: created, [PATCH]: patched("passcode") }, calls);
    const r = await setVisibility(api, NS_ID, { slug: SLUG, visibility: "passcode", passcode: "abcd" });
    expect(r.activePasscodes).toBe(3);
  });

  it("test_DW_2_1_label_defaults_to_default", async () => {
    const bodies: Record<string, unknown> = {};
    const api = client({ [SITES]: sites("public"), [CODES]: codes(0), [POST]: created, [PATCH]: patched("passcode") }, [], bodies);
    await setVisibility(api, NS_ID, { slug: SLUG, visibility: "passcode", passcode: "abcd" });
    expect(bodies[POST]).toEqual({ code: "abcd", label: "default" });
  });

  it("test_DW_2_1_existing_codes_no_passcode_given_only_patches", async () => {
    const calls: string[] = [];
    const api = client({ [SITES]: sites("public"), [CODES]: codes(2), [PATCH]: patched("passcode") }, calls);
    const r = await setVisibility(api, NS_ID, { slug: SLUG, visibility: "passcode" });
    expect(calls).toEqual([SITES, CODES, PATCH]);
    expect(r.activePasscodes).toBe(2);
    expect(r.addedPasscode).toBeUndefined();
  });
});

describe("DW-2.2: refusals and failures", () => {
  it("test_DW_2_2_passcode_with_zero_codes_and_none_given_errors_without_patch_or_post", async () => {
    const calls: string[] = [];
    const api = client({ [SITES]: sites("public"), [CODES]: codes(0) }, calls);
    await expect(setVisibility(api, NS_ID, { slug: SLUG, visibility: "passcode" })).rejects.toThrow(/no passcodes/);
    expect(calls).toEqual([SITES, CODES]);
  });

  it("test_DW_2_2_public_patches_public", async () => {
    const calls: string[] = [];
    const bodies: Record<string, unknown> = {};
    const api = client({ [SITES]: sites("passcode"), [PATCH]: patched("public") }, calls, bodies);
    const r = await setVisibility(api, NS_ID, { slug: SLUG, visibility: "public" });
    expect(calls).toEqual([SITES, PATCH]);
    expect(bodies[PATCH]).toEqual({ visibility: "public" });
    expect(r).toMatchObject({ visibility: "public", previous: "passcode", activePasscodes: 0 });
  });

  it("test_DW_2_2_post_ok_then_patch_500_names_added_code_and_unchanged_visibility", async () => {
    const calls: string[] = [];
    const api = client(
      { [SITES]: sites("public"), [CODES]: codes(0), [POST]: created, [PATCH]: { status: 500, body: { error: "boom" } } },
      calls,
    );
    const err = (await setVisibility(api, NS_ID, { slug: SLUG, visibility: "passcode", passcode: "abcd", label: "Client A" }).catch(
      (e: Error) => e,
    )) as Error;
    expect(calls).toEqual([SITES, CODES, POST, PATCH]);
    expect(err.message).toContain('Passcode "Client A"');
    expect(err.message).toContain("WAS added");
    expect(err.message).toContain("is still PUBLIC");
    expect(err.message).toContain("boom");
    expect(err.cause).toBeInstanceOf(ApiError);
  });

  it("test_DW_2_2_patch_failure_without_new_code_says_still_old_visibility", async () => {
    const api = client({ [SITES]: sites("passcode"), [PATCH]: { status: 500, body: { error: "boom" } } }, []);
    const err = (await setVisibility(api, NS_ID, { slug: SLUG, visibility: "public" }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("is still PASSCODE");
    expect(err.message).not.toContain("WAS added");
  });

  it("test_DW_2_2_free_tier_403_on_post_carries_upgrade_hint_and_no_patch", async () => {
    const calls: string[] = [];
    const api = client(
      { [SITES]: sites("public"), [CODES]: codes(0), [POST]: { status: 403, body: { error: "Passcode-protected sites require a paid plan" } } },
      calls,
    );
    const err = (await setVisibility(api, NS_ID, { slug: SLUG, visibility: "passcode", passcode: "abcd" }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("paid plan");
    expect(err.message).toContain("`upgrade`");
    expect(calls).not.toContain(PATCH);
  });

  it("test_DW_2_2_free_tier_403_on_patch_carries_upgrade_hint", async () => {
    const api = client(
      { [SITES]: sites("public"), [CODES]: codes(1), [PATCH]: { status: 403, body: { error: "Passcode-protected sites require a paid plan" } } },
      [],
    );
    const err = (await setVisibility(api, NS_ID, { slug: SLUG, visibility: "passcode" }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("`upgrade`");
    expect(err.message).toContain("is still PUBLIC");
  });

  it("test_DW_2_2_unknown_slug_is_not_found_and_mutates_nothing", async () => {
    const calls: string[] = [];
    const api = client({ [SITES]: sites("public", "other") }, calls);
    await expect(setVisibility(api, NS_ID, { slug: SLUG, visibility: "passcode", passcode: "abcd" })).rejects.toThrow("not found");
    expect(calls).toEqual([SITES]);
  });
});

describe("DW-2.8: gated and unreadable states", () => {
  it("test_DW_2_8_gated_site_switches_and_reports_previous_gated", async () => {
    const api = client({ [SITES]: sites("gated"), [CODES]: codes(1), [PATCH]: patched("passcode") }, []);
    const r = await setVisibility(api, NS_ID, { slug: SLUG, visibility: "passcode" });
    expect(r.previous).toBe("gated");
    expect(r.visibility).toBe("passcode");
  });

  it("test_DW_2_8_missing_visibility_field_refuses_with_no_mutation", async () => {
    const calls: string[] = [];
    const api = client({ [SITES]: sites(undefined) }, calls);
    await expect(setVisibility(api, NS_ID, { slug: SLUG, visibility: "public" })).rejects.toThrow(
      "couldn't read the site's current visibility",
    );
    expect(calls).toEqual([SITES]);
  });
});

describe("setVisibility defensive checks", () => {
  it("test_invalid_target_visibility_rejected_before_any_request", async () => {
    const calls: string[] = [];
    const api = client({}, calls);
    await expect(
      setVisibility(api, NS_ID, { slug: SLUG, visibility: "gated" as unknown as "public" }),
    ).rejects.toThrow('must be "public" or "passcode"');
    expect(calls).toEqual([]);
  });

  it("test_passcode_with_public_rejected_before_any_request", async () => {
    const calls: string[] = [];
    const api = client({}, calls);
    await expect(setVisibility(api, NS_ID, { slug: SLUG, visibility: "public", passcode: "abcd" })).rejects.toThrow(
      "only be supplied with visibility",
    );
    expect(calls).toEqual([]);
  });

  it("test_empty_passcode_rejected_before_any_request", async () => {
    const calls: string[] = [];
    const api = client({}, calls);
    await expect(setVisibility(api, NS_ID, { slug: SLUG, visibility: "passcode", passcode: "  " })).rejects.toThrow(
      "code is required",
    );
    expect(calls).toEqual([]);
  });

  it("test_server_echo_that_disagrees_is_reported_not_trusted", async () => {
    const api = client({ [SITES]: sites("public"), [CODES]: codes(1), [PATCH]: patched("public") }, []);
    await expect(setVisibility(api, NS_ID, { slug: SLUG, visibility: "passcode" })).rejects.toThrow(
      "server reports",
    );
  });

  it("test_patch_response_without_site_falls_back_to_requested", async () => {
    const api = client({ [SITES]: sites("passcode"), [PATCH]: { status: 200, body: {} } }, []);
    const r = await setVisibility(api, NS_ID, { slug: SLUG, visibility: "public" });
    expect(r.visibility).toBe("public");
  });

  it("test_slug_is_url_encoded_in_paths", async () => {
    const calls: string[] = [];
    const sl = "a b";
    const api = client(
      { [SITES]: sites("passcode", sl), [`PATCH /api/ns/${NS_ID}/sites/a%20b/visibility`]: patched("public") },
      calls,
    );
    await setVisibility(api, NS_ID, { slug: sl, visibility: "public" });
    expect(calls[1]).toBe(`PATCH /api/ns/${NS_ID}/sites/a%20b/visibility`);
  });
});

describe("DW-2.2: supplied passcode already exists on the site", () => {
  const existed = (status = 200): Route => ({ status, body: { id: "old-1", label: "Client A", created_at: "t", existed: true } });

  it("test_DW_2_2_existed_true_still_patches_and_reports_the_existing_code_without_counting_it_twice", async () => {
    const calls: string[] = [];
    const api = client({ [SITES]: sites("public"), [CODES]: codes(2), [POST]: existed(), [PATCH]: patched("passcode") }, calls);
    const r = await setVisibility(api, NS_ID, { slug: SLUG, visibility: "passcode", passcode: "abcd", label: "other" });

    expect(calls).toEqual([SITES, CODES, POST, PATCH]);
    expect(r.visibility).toBe("passcode");
    expect(r.activePasscodes).toBe(2);
    expect(r.addedPasscode).toBeUndefined();
    expect(r.existingPasscode).toEqual({ id: "old-1", label: "Client A", created_at: "t" });
  });

  it("test_DW_2_2_patch_failure_after_existed_does_not_claim_a_code_was_added", async () => {
    const api = client(
      { [SITES]: sites("public"), [CODES]: codes(1), [POST]: existed(), [PATCH]: { status: 500, body: { error: "boom" } } },
      [],
    );
    const err = (await setVisibility(api, NS_ID, { slug: SLUG, visibility: "passcode", passcode: "abcd" }).catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain("WAS added");
    expect(err.message).toContain("is still PUBLIC");
  });

  it("test_DW_2_2_older_server_without_existed_keeps_added_behaviour", async () => {
    const api = client({ [SITES]: sites("public"), [CODES]: codes(0), [POST]: created, [PATCH]: patched("passcode") }, []);
    const r = await setVisibility(api, NS_ID, { slug: SLUG, visibility: "passcode", passcode: "abcd" });
    expect(r.addedPasscode?.id).toBe("new-1");
    expect(r.existingPasscode).toBeUndefined();
    expect(r.activePasscodes).toBe(1);
  });
});
