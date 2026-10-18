/**
 * DW-6.1: `data` and `data_jwt` operations (status, enable consent flow,
 * disable, wipe, JWT issuer) including error paths.
 */

import { describe, it, expect } from "bun:test";
import { parseDataStatus, runData, runDataJwt } from "./site-data.ts";
import { SiteDataError } from "./site-data-errors.ts";
import type { DataStatus } from "./site-data-types.ts";
import { NS, fixtureResponse, jsonResponse, loadRoute, makeClient, withAccount, withSites, type Account } from "../tests/helpers/site-data.ts";

const statusFx = loadRoute("api.status");
const enabledStatus = fixtureResponse(statusFx, "enabled").body as DataStatus;
const wouldCharge = fixtureResponse(statusFx, "not entitled: enabling would charge").body as DataStatus;
const darkLaunch = fixtureResponse(statusFx, "dark launch: hidden").body as DataStatus;
const unentitled: DataStatus = { ...enabledStatus, entitled: false, billing: { ...enabledStatus.billing, item_present: false } };
const STATUS_PATH = `/api/ns/${NS.id}/data`;

const serveStatus = (body: unknown) =>
  withSites((req) => (req.method === "GET" && req.path === STATUS_PATH ? jsonResponse(200, body) : undefined));

describe("DW-6.1: parseDataStatus", () => {
  it("test_DW_6_1_parse_status_accepts_fixtures", () => {
    expect(parseDataStatus(enabledStatus).entitled).toBe(true);
    expect(parseDataStatus(darkLaunch).available).toBe(false);
  });

  it("test_DW_6_1_parse_status_rejects_unexpected_shapes", () => {
    for (const bad of [null, "x", {}, { available: true }, { available: true, entitled: true, price: {} }, { ...enabledStatus, collections: null }]) {
      expect(() => parseDataStatus(bad)).toThrow("Unexpected response from the site data status endpoint.");
    }
  });
});

describe("DW-6.1: parseDataStatus full shape", () => {
  const without = (path: string): unknown => {
    const copy = structuredClone(enabledStatus) as unknown as Record<string, any>;
    const keys = path.split(".");
    const last = keys.pop()!;
    delete keys.reduce((o, k) => o[k], copy)[last];
    return copy;
  };

  it("test_DW_6_1_parse_status_rejects_each_missing_field_naming_it", () => {
    for (const field of [
      "entitlement_source", "activating", "billing", "billing.interval", "billing.would_charge", "billing.past_due",
      "price.month_cents", "stats_state", "kv", "kv.drift", "wipe_job", "wipe_job.last_result", "jwt_issuer",
    ]) {
      expect(() => parseDataStatus(without(field))).toThrow(`Missing or invalid field: ${field}.`);
    }
  });

  it("test_DW_6_1_parse_status_rejects_wrong_types_and_enums", () => {
    const patched = (patch: Record<string, unknown>) => ({ ...enabledStatus, ...patch });
    expect(() => parseDataStatus(patched({ billing: { ...enabledStatus.billing, would_charge: "yes" } }))).toThrow("billing.would_charge");
    expect(() => parseDataStatus(patched({ billing: { ...enabledStatus.billing, interval: "week" } }))).toThrow("billing.interval");
    expect(() => parseDataStatus(patched({ stats_state: "slow" }))).toThrow("stats_state");
    expect(() => parseDataStatus(patched({ kv: { drift: "weird", checked_at: null } }))).toThrow("kv.drift");
    expect(() => parseDataStatus(patched({ price: { month_cents: 2.5, year_cents: null } }))).toThrow("price.month_cents");
    expect(() => parseDataStatus(patched({ jwt_issuer: [] }))).toThrow("jwt_issuer");
    expect(() => parseDataStatus(patched({ collections: [] }))).toThrow("collections");
  });

  it("test_DW_6_1_parse_status_rejects_malformed_collection_entries", () => {
    const votes = enabledStatus.collections["votes"]!;
    expect(() => parseDataStatus({ ...enabledStatus, collections: { votes: { config: { ...votes.config, sites: "x" }, stats: null } } })).toThrow("collections.votes.config.sites");
    expect(() => parseDataStatus({ ...enabledStatus, collections: { votes: { stats: null } } })).toThrow("collections.votes.config");
    expect(() => parseDataStatus({ ...enabledStatus, collections: { votes: { config: votes.config } } })).toThrow("collections.votes.stats");
  });

  it("test_DW_6_3_parse_status_accepts_would_charge_fixture_and_reads_flag", () => {
    expect(parseDataStatus(wouldCharge).billing.would_charge).toBe(true);
    expect(parseDataStatus(enabledStatus).billing.would_charge).toBe(false);
  });

  it("test_DW_6_1_status_malformed_body_fails_with_clear_error_not_typeerror", async () => {
    const { client } = makeClient(serveStatus(without("billing")));
    await expect(runData(client, NS, { action: "status" })).rejects.toThrow("Unexpected response from the site data status endpoint. Missing or invalid field: billing.");
  });
});

describe("DW-6.1: data status", () => {
  it("test_DW_6_1_status_enabled_renders_collection_sites_as_slugs", async () => {
    const { client } = makeClient(serveStatus(enabledStatus));
    const r = await runData(client, NS, { action: "status" });
    if (r.action !== "status" || !r.available) throw new Error("expected available status");
    expect(r.namespace).toBe("ryan");
    expect(r.status.collections["votes"]!.config.sites).toEqual(["for-her", "results"]);
    expect(r.status.collections["votes"]!.config.write_claims[0]!.claims["site"]).toBe("for-her");
  });

  it("test_DW_6_1_status_dark_launch_reports_unavailable_without_listing_sites", async () => {
    const { client, calls } = makeClient(serveStatus(darkLaunch));
    expect(await runData(client, NS, { action: "status" })).toEqual({ action: "status", available: false });
    expect(calls.map((c) => c.path)).toEqual([STATUS_PATH]);
  });

  it("test_DW_6_1_status_without_collections_skips_site_listing", async () => {
    const { client, calls } = makeClient(serveStatus({ ...enabledStatus, collections: {} }));
    await runData(client, NS, { action: "status" });
    expect(calls).toHaveLength(1);
  });

  it("test_DW_6_1_status_falls_back_to_ids_when_site_listing_fails", async () => {
    const { client } = makeClient((req) =>
      req.path === STATUS_PATH ? jsonResponse(200, enabledStatus) : jsonResponse(500, { error: "x", code: "unavailable" }),
    );
    const r = await runData(client, NS, { action: "status" });
    if (r.action !== "status" || !r.available) throw new Error("expected available status");
    expect(r.status.collections["votes"]!.config.sites[0]).toMatch(/^5b0e3c1a/);
  });

  it("test_DW_6_1_status_not_a_member_is_not_found_error", async () => {
    const { client } = makeClient(() => jsonResponse(404, { error: "Not found.", code: "not_found" }));
    await expect(runData(client, NS, { action: "status" })).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});

const asAccount = (account: Account, status: unknown) => withAccount(account, serveStatus(status));
const PRO: Account = { tier: "pro", role: "user" };
const posts = (calls: Array<{ method: string }>) => calls.filter((c) => c.method === "POST");

describe("DW-6.4: data enable (consent bound to what was shown)", () => {
  const chargingMonth: DataStatus = { ...unentitled, billing: { ...unentitled.billing, item_present: false, would_charge: true, interval: "month" } };
  const chargingYear: DataStatus = { ...chargingMonth, billing: { ...chargingMonth.billing, interval: "year" } };
  const goodExpected = { tier: "pro" as const, would_charge: true, price_cents: 200, interval: "month" as const, month_cents: 200, year_cents: 2000 };
  const enableFx = loadRoute("api.enable");
  const enabledReply = () => jsonResponse(200, fixtureResponse(enableFx, "enabled").body);
  const serveEnable = (account: Account, status: unknown) => withAccount(account, (req) => (req.method === "POST" ? enabledReply() : serveStatus(status)(req)));

  it("test_DW_6_4_enable_reads_status_space_and_me_fresh_on_every_call", async () => {
    const { client, calls } = makeClient(asAccount(PRO, unentitled));
    await runData(client, NS, { action: "enable" });
    const paths = calls.map((c) => c.path);
    expect(paths).toContain(STATUS_PATH);
    expect(paths).toContain("/api/space");
    expect(paths).toContain("/auth/me");
    await runData(client, NS, { action: "enable" });
    expect(calls.filter((c) => c.path === "/api/space")).toHaveLength(2);
  });

  it("test_DW_6_4_enable_dark_launch_is_not_available_error", async () => {
    const { client, calls } = makeClient(asAccount(PRO, darkLaunch));
    const err = await runData(client, NS, { action: "enable", accept_charge: true, expected: goodExpected }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteDataError);
    expect((err as SiteDataError).code).toBe("not_available");
    expect(posts(calls)).toHaveLength(0);
  });

  it("test_DW_6_4_enable_when_already_entitled_never_posts", async () => {
    const { client, calls } = makeClient(asAccount(PRO, enabledStatus));
    expect(await runData(client, NS, { action: "enable", accept_charge: true, expected: goodExpected })).toEqual({ action: "enable", state: "already_enabled" });
    expect(posts(calls)).toHaveLength(0);
  });

  it("test_DW_6_4_enable_item_present_but_not_entitled_is_in_progress_and_never_posts", async () => {
    const pending: DataStatus = { ...chargingMonth, billing: { ...chargingMonth.billing, item_present: true } };
    for (const accept of [false, true]) {
      const { client, calls } = makeClient(asAccount(PRO, pending));
      expect(await runData(client, NS, { action: "enable", accept_charge: accept, expected: goodExpected })).toEqual({ action: "enable", state: "in_progress" });
      expect(posts(calls)).toHaveLength(0);
    }
  });

  it("test_DW_6_4_enable_free_tier_needs_paid_plan_and_refuses_accept_even_with_matching_looking_expected", async () => {
    const { client, calls } = makeClient(asAccount({ tier: "free", role: "user" }, chargingMonth));
    expect(await runData(client, NS, { action: "enable" })).toEqual({ action: "enable", state: "needs_paid_plan" });
    for (const expected of [undefined, goodExpected, { ...goodExpected, tier: "free" as const }]) {
      expect(await runData(client, NS, { action: "enable", accept_charge: true, expected })).toEqual({ action: "enable", state: "needs_paid_plan" });
    }
    expect(posts(calls)).toHaveLength(0);
  });

  it("test_DW_6_4_enable_without_accept_returns_consent_with_expected_and_never_posts", async () => {
    const { client, calls } = makeClient(asAccount(PRO, chargingMonth));
    expect(await runData(client, NS, { action: "enable" })).toEqual({
      action: "enable", state: "consent_needed", expected: goodExpected, price: { month_cents: 200, year_cents: 2000 }, changed: false, admin: false,
    });
    expect(await runData(client, NS, { action: "enable", accept_charge: false, expected: goodExpected })).toMatchObject({ state: "consent_needed", changed: false });
    expect(posts(calls)).toHaveLength(0);
  });

  it("test_DW_6_4_expected_price_follows_interval_and_is_null_when_unknown_or_not_charging", async () => {
    const run = async (status: DataStatus) => ((await runData(makeClient(asAccount(PRO, status)).client, NS, { action: "enable" })) as { expected: unknown }).expected;
    expect(await run(chargingYear)).toEqual({ tier: "pro", would_charge: true, price_cents: 2000, interval: "year", month_cents: 200, year_cents: 2000 });
    expect(await run(wouldCharge)).toEqual({ tier: "pro", would_charge: true, price_cents: null, interval: null, month_cents: 200, year_cents: 2000 });
    expect(await run(unentitled)).toEqual({ tier: "pro", would_charge: false, price_cents: null, interval: "month", month_cents: 200, year_cents: 2000 });
    expect(await run({ ...chargingYear, price: { month_cents: 200, year_cents: null } })).toMatchObject({ price_cents: null, interval: "year" });
  });

  it("test_DW_6_4_accept_without_expected_is_refused_and_never_posts", async () => {
    const { client, calls } = makeClient(asAccount(PRO, chargingMonth));
    expect(await runData(client, NS, { action: "enable", accept_charge: true })).toEqual({ action: "enable", state: "expected_missing" });
    expect(posts(calls)).toHaveLength(0);
  });

  it("test_DW_6_4_accept_with_matching_expected_posts_once_and_reports_amount_charged_now", async () => {
    const { client, calls } = makeClient(serveEnable(PRO, chargingMonth));
    const r = await runData(client, NS, { action: "enable", accept_charge: true, expected: goodExpected });
    expect(r).toEqual({ action: "enable", state: "enabled", activating: true, charge: { interval: "month", price_cents: 140 } });
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0]).toMatchObject({ path: `${STATUS_PATH}/enable`, body: { accept_charge: true } });
  });

  it("test_DW_6_4_accept_with_each_mismatched_expected_field_refuses_prints_new_consent_and_never_posts", async () => {
    const cases: Array<[string, DataStatus, Account, Record<string, unknown>]> = [
      ["tier changed after upgrade", chargingMonth, { tier: "max", role: "user" }, goodExpected],
      ["would_charge", chargingMonth, PRO, { ...goodExpected, would_charge: false }],
      ["price", chargingMonth, PRO, { ...goodExpected, price_cents: 199 }],
      ["interval", chargingMonth, PRO, { ...goodExpected, interval: "year" }],
      ["status now yearly", chargingYear, PRO, goodExpected],
      ["null price vs known", wouldCharge, PRO, goodExpected],
    ];
    for (const [name, status, account, expected] of cases) {
      const { client, calls } = makeClient(serveEnable(account, status));
      const r = await runData(client, NS, { action: "enable", accept_charge: true, expected: expected as never });
      expect({ name, state: (r as { state: string }).state, changed: (r as { changed?: boolean }).changed }).toEqual({ name, state: "consent_needed", changed: true });
      expect(posts(calls)).toHaveLength(0);
    }
  });

  it("test_DW_6_7_N1_month_or_year_list_price_change_alone_refuses_with_new_consent_and_never_posts", async () => {
    const cases: Array<[string, DataStatus, Record<string, number | null>]> = [
      ["month list price", { ...chargingMonth, price: { month_cents: 250, year_cents: 2000 } }, { price_cents: 250, month_cents: 250, year_cents: 2000 }],
      ["year list price (billing monthly)", { ...chargingMonth, price: { month_cents: 200, year_cents: 2500 } }, { price_cents: 200, month_cents: 200, year_cents: 2500 }],
      ["year list price withdrawn", { ...chargingMonth, price: { month_cents: 200, year_cents: null } }, { price_cents: 200, month_cents: 200, year_cents: null }],
    ];
    for (const [name, status, fresh] of cases) {
      const { client, calls } = makeClient(serveEnable(PRO, status));
      const r = await runData(client, NS, { action: "enable", accept_charge: true, expected: goodExpected });
      expect({ name, state: (r as { state: string }).state, changed: (r as { changed?: boolean }).changed }).toEqual({ name, state: "consent_needed", changed: true });
      expect(r).toMatchObject({ expected: fresh });
      expect(posts(calls)).toHaveLength(0);
    }
  });

  it("test_DW_6_7_N1_month_price_alone_changing_is_refused_even_when_interval_and_price_cents_are_null", async () => {
    const unknownInterval = { tier: "pro" as const, would_charge: true, price_cents: null, interval: null, month_cents: 200, year_cents: 2000 };
    const { client: same, calls: sameCalls } = makeClient(serveEnable(PRO, wouldCharge));
    expect(await runData(same, NS, { action: "enable", accept_charge: true, expected: unknownInterval })).toMatchObject({ state: "enabled" });
    expect(posts(sameCalls)).toHaveLength(1);
    const { client, calls } = makeClient(serveEnable(PRO, { ...wouldCharge, price: { month_cents: 250, year_cents: 2000 } }));
    const r = await runData(client, NS, { action: "enable", accept_charge: true, expected: unknownInterval });
    expect(r).toMatchObject({ state: "consent_needed", changed: true, expected: { ...unknownInterval, month_cents: 250 } });
    expect(posts(calls)).toHaveLength(0);
  });

  it("test_DW_6_7_N1_expected_carries_list_prices_even_when_nothing_is_charged", async () => {
    const { client } = makeClient(asAccount(PRO, unentitled));
    expect(await runData(client, NS, { action: "enable" })).toMatchObject({
      expected: { would_charge: false, price_cents: null, month_cents: 200, year_cents: 2000 },
    });
  });

  it("test_DW_6_4_mismatch_consent_carries_the_new_expected", async () => {
    const { client } = makeClient(serveEnable({ tier: "max", role: "user" }, chargingMonth));
    const r = await runData(client, NS, { action: "enable", accept_charge: true, expected: goodExpected });
    expect(r).toMatchObject({ expected: { tier: "max", would_charge: true, price_cents: 200, interval: "month", month_cents: 200, year_cents: 2000 } });
  });

  it("test_DW_6_4_paid_tier_not_charging_consents_then_posts_on_matching_expected", async () => {
    const expected = { tier: "pro" as const, would_charge: false, price_cents: null, interval: "month" as const, month_cents: 200, year_cents: 2000 };
    const { client, calls } = makeClient(serveEnable(PRO, unentitled));
    expect(await runData(client, NS, { action: "enable" })).toMatchObject({ state: "consent_needed", expected, admin: false });
    expect(await runData(client, NS, { action: "enable", accept_charge: true, expected })).toMatchObject({ state: "enabled" });
    expect(posts(calls)).toHaveLength(1);
  });

  it("test_DW_6_4_admin_on_free_tier_gets_no_charge_consent_and_posts_on_matching_expected", async () => {
    const adminFree: Account = { tier: "free", role: "admin" };
    const expected = { tier: "free" as const, would_charge: false, price_cents: null, interval: "month" as const, month_cents: 200, year_cents: 2000 };
    const { client, calls } = makeClient(serveEnable(adminFree, unentitled));
    expect(await runData(client, NS, { action: "enable" })).toMatchObject({ state: "consent_needed", admin: true, expected });
    expect(posts(calls)).toHaveLength(0);
    expect(await runData(client, NS, { action: "enable", accept_charge: true, expected })).toMatchObject({ state: "enabled" });
    expect(posts(calls)).toHaveLength(1);
  });

  it("test_DW_6_4_comped_enable_has_null_charge", async () => {
    const expected = { tier: "pro" as const, would_charge: false, price_cents: null, interval: "month" as const, month_cents: 200, year_cents: 2000 };
    const { client } = makeClient(
      withAccount(PRO, (req) => (req.method === "POST" ? jsonResponse(200, fixtureResponse(enableFx, "comped").body) : serveStatus(unentitled)(req))),
    );
    expect(await runData(client, NS, { action: "enable", accept_charge: true, expected })).toMatchObject({ state: "enabled", charge: null });
  });

  it("test_DW_6_4_space_or_me_failure_is_a_clear_error_and_never_posts", async () => {
    for (const account of [{ ...PRO, spaceStatus: 500 }, { ...PRO, meStatus: 500 }, { ...PRO, spaceStatus: 401 }]) {
      const { client, calls } = makeClient(serveEnable(account, chargingMonth));
      const err = await runData(client, NS, { action: "enable", accept_charge: true, expected: goodExpected }).catch((e: unknown) => e);
      expect((err as Error).message).toContain("so the charge cannot be confirmed. Nothing was charged.");
      expect(posts(calls)).toHaveLength(0);
    }
  });

  it("test_DW_6_4_unexpected_tier_value_is_an_error_not_a_guess", async () => {
    const { client, calls } = makeClient(serveEnable({ tier: "enterprise" as never }, chargingMonth));
    await expect(runData(client, NS, { action: "enable" })).rejects.toThrow("unexpected tier");
    expect(posts(calls)).toHaveLength(0);
  });

  it("test_DW_6_4_server_402_codes_are_still_mapped", async () => {
    const reply = (code: string) => withAccount(PRO, (req) => (req.method === "POST" ? jsonResponse(402, { error: "x", code }) : serveStatus(chargingMonth)(req)));
    for (const code of ["consent_required", "upgrade_required", "no_subscription"]) {
      const { client } = makeClient(reply(code));
      await expect(runData(client, NS, { action: "enable", accept_charge: true, expected: goodExpected })).rejects.toMatchObject({ code, status: 402 });
    }
  });
});

describe("DW-6.3: Stripe failure (503 unavailable) on enable/disable", () => {
  const stripeDown = () => jsonResponse(503, { error: "Billing is temporarily unavailable. Try again.", code: "unavailable" });
  const charging: DataStatus = { ...unentitled, billing: { ...unentitled.billing, item_present: false, would_charge: true } };
  const expected = { tier: "pro" as const, would_charge: true, price_cents: 200, interval: "month" as const, month_cents: 200, year_cents: 2000 };

  it("test_DW_6_3_enable_503_makes_no_state_guarantee_and_asks_for_a_fresh_consent", async () => {
    const { client } = makeClient(withAccount(PRO, (req) => (req.method === "POST" ? stripeDown() : serveStatus(charging)(req))));
    const err = await runData(client, NS, { action: "enable", accept_charge: true, expected }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unavailable", status: 503 });
    const msg = (err as SiteDataError).message;
    expect(msg).toContain("may not have taken effect");
    expect(msg).toContain("Check `data` status");
    expect(msg).toContain("WITHOUT accept_charge");
    expect(msg).not.toContain("retry with accept");
    expect(msg).not.toContain("Nothing changed");
  });

  it("test_DW_6_3_disable_503_makes_no_state_guarantee_check_status_then_retry", async () => {
    const { client } = makeClient(stripeDown);
    const err = await runData(client, NS, { action: "disable" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unavailable", status: 503 });
    expect((err as SiteDataError).message).toContain("Check `data` status, then retry");
    expect((err as SiteDataError).message).not.toContain("WITHOUT accept_charge");
    expect((err as SiteDataError).message).not.toContain("Nothing changed");
  });

  it("test_DW_6_3_retrying_enable_after_503_cannot_double_charge_when_the_first_attempt_took_effect", async () => {
    // Attempt 1: status says not entitled, POST fails 503 (but Stripe charged). Attempt 2: status now entitled.
    let entitled = false;
    const { client, calls } = makeClient(
      withAccount(PRO, (req) => {
        if (req.method === "POST") { entitled = true; return stripeDown(); }
        return serveStatus(entitled ? enabledStatus : charging)(req);
      }),
    );
    await expect(runData(client, NS, { action: "enable", accept_charge: true, expected })).rejects.toMatchObject({ code: "unavailable" });
    expect(await runData(client, NS, { action: "enable", accept_charge: true, expected })).toEqual({ action: "enable", state: "already_enabled" });
    expect(posts(calls)).toHaveLength(1);
  });
});

describe("DW-6.1: data disable / wipe", () => {
  it("test_DW_6_1_disable_returns_wipe_after", async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { entitled: false, wipe_after: "2026-11-17T12:00:00.000Z" }));
    expect(await runData(client, NS, { action: "disable" })).toEqual({ action: "disable", entitled: false, wipe_after: "2026-11-17T12:00:00.000Z" });
    expect(calls[0]).toMatchObject({ method: "POST", path: `${STATUS_PATH}/disable` });
  });

  it("test_DW_6_1_disable_forbidden_for_non_owner_names_role", async () => {
    const { client } = makeClient(() => jsonResponse(403, { error: "no", code: "forbidden" }));
    await expect(runData(client, NS, { action: "disable" })).rejects.toThrow("needs the owner role");
  });

  it("test_DW_6_1_wipe_requires_confirm_namespace", async () => {
    const { client, calls } = makeClient(() => undefined);
    await expect(runData(client, NS, { action: "wipe" })).rejects.toThrow("confirm_namespace is required when action is 'wipe'");
    expect(calls).toHaveLength(0);
  });

  it("test_DW_6_1_wipe_mismatch_sends_nothing", async () => {
    const { client, calls } = makeClient(() => undefined);
    await expect(runData(client, NS, { action: "wipe", confirm_namespace: "other" })).rejects.toThrow("does not match the address name 'ryan'. Nothing was deleted.");
    expect(calls).toHaveLength(0);
  });

  it("test_DW_6_1_wipe_matching_confirm_posts_and_reports_counts", async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { collections: 1, rows: 49 }));
    expect(await runData(client, NS, { action: "wipe", confirm_namespace: "ryan" })).toEqual({ action: "wipe", namespace: "ryan", collections: 1, rows: 49 });
    expect(calls[0]).toMatchObject({ path: `${STATUS_PATH}/wipe`, body: { confirm_namespace: "ryan" } });
  });
});

describe("DW-6.1: data_jwt", () => {
  const full = { issuer: "https://a.supabase.co/auth/v1", jwks_uri: "https://a.supabase.co/auth/v1/.well-known/jwks.json", audience: "authenticated", algorithms: ["ES256" as const] };

  it("test_DW_6_1_jwt_set_puts_issuer_config", async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { jwt_issuer: full }));
    expect(await runDataJwt(client, NS, { action: "set", ...full })).toEqual({ action: "set", jwt_issuer: full });
    expect(calls[0]).toMatchObject({ method: "PUT", path: `${STATUS_PATH}/jwt-issuer`, body: full });
  });

  it("test_DW_6_1_jwt_set_requires_every_field", async () => {
    const { client, calls } = makeClient(() => undefined);
    for (const missing of ["issuer", "jwks_uri", "audience", "algorithms"] as const) {
      const args = { action: "set" as const, ...full, [missing]: undefined };
      await expect(runDataJwt(client, NS, args)).rejects.toThrow(`${missing} is required when action is 'set'`);
    }
    expect(calls).toHaveLength(0);
  });

  it("test_DW_6_1_jwt_set_server_rejection_is_invalid_request", async () => {
    const { client } = makeClient(() => jsonResponse(400, { error: "jwks_uri host is not allowed", code: "invalid_request" }));
    await expect(runDataJwt(client, NS, { action: "set", ...full })).rejects.toThrow("jwks_uri host is not allowed [invalid_request]");
  });

  it("test_DW_6_1_jwt_clear_deletes", async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { jwt_issuer: null }));
    expect(await runDataJwt(client, NS, { action: "clear" })).toEqual({ action: "clear", jwt_issuer: null });
    expect(calls[0]).toMatchObject({ method: "DELETE", path: `${STATUS_PATH}/jwt-issuer` });
  });
});

describe("review R-1: parseDataStatus enforces the contract's nested shapes", () => {
  const votes = enabledStatus.collections["votes"]!;
  const withCollection = (patch: { config?: Record<string, unknown>; stats?: unknown }) => ({
    ...enabledStatus,
    collections: { votes: { config: { ...votes.config, ...patch.config }, stats: "stats" in patch ? patch.stats : votes.stats } },
  });
  const dropConfig = (field: string) => {
    const config: Record<string, unknown> = { ...votes.config };
    delete config[field];
    return { ...enabledStatus, collections: { votes: { config, stats: votes.stats } } };
  };
  const issuer = { issuer: "https://i", jwks_uri: "https://i/jwks", audience: "a", algorithms: ["ES256"] };
  const rejects = (body: unknown, field: string) =>
    expect(() => parseDataStatus(body)).toThrow(`Missing or invalid field: ${field}.`);

  it("test_R1_stats_object_must_carry_its_counters", () => {
    rejects(withCollection({ stats: {} }), "collections.votes.stats.rows");
    rejects(withCollection({ stats: { rows: 1, archived_rows: 0, bytes: "9", last_write_at: null } }), "collections.votes.stats.bytes");
    rejects(withCollection({ stats: { rows: 1, archived_rows: 0, bytes: 9, last_write_at: "yesterday" } }), "collections.votes.stats.last_write_at");
    expect(parseDataStatus(withCollection({ stats: { rows: 1, archived_rows: 0, bytes: 9, last_write_at: null } })).collections["votes"]!.stats!.rows).toBe(1);
  });

  it("test_R1_jwt_issuer_object_must_carry_its_fields", () => {
    rejects({ ...enabledStatus, jwt_issuer: {} }, "jwt_issuer.issuer");
    rejects({ ...enabledStatus, jwt_issuer: { ...issuer, audience: 5 } }, "jwt_issuer.audience");
    rejects({ ...enabledStatus, jwt_issuer: { ...issuer, algorithms: "ES256" } }, "jwt_issuer.algorithms");
    rejects({ ...enabledStatus, jwt_issuer: { ...issuer, algorithms: [1] } }, "jwt_issuer.algorithms");
    expect(parseDataStatus({ ...enabledStatus, jwt_issuer: issuer }).jwt_issuer!.issuer).toBe("https://i");
    expect(parseDataStatus({ ...enabledStatus, jwt_issuer: null }).jwt_issuer).toBeNull();
  });

  it("test_R1_config_enums_and_element_types", () => {
    rejects(withCollection({ config: { rule: "bogus" } }), "collections.votes.config.rule");
    rejects(withCollection({ config: { writers: ["everyone"] } }), "collections.votes.config.writers");
    rejects(withCollection({ config: { sites: [1] } }), "collections.votes.config.sites");
    rejects(withCollection({ config: { write_claims: [5] } }), "collections.votes.config.write_claims");
    rejects(withCollection({ config: { admin_claims: [{ kind: "cookie", claims: {} }] } }), "collections.votes.config.admin_claims");
    rejects(withCollection({ config: { admin_claims: [{ kind: "jwt", claims: { a: 1 } }] } }), "collections.votes.config.admin_claims");
    rejects(withCollection({ config: { admin_claims: [{ kind: "jwt" }] } }), "collections.votes.config.admin_claims");
    expect(parseDataStatus(withCollection({ config: { admin_claims: [{ kind: "jwt", claims: { admin: true, team: "x" } }] } })).entitled).toBe(true);
  });

  it("test_R1_config_limit_fields", () => {
    for (const f of ["max_rows", "max_row_bytes", "writes_per_min", "per_identity_limit"]) rejects(dropConfig(f), `collections.votes.config.${f}`);
    rejects(withCollection({ config: { max_rows: "100" } }), "collections.votes.config.max_rows");
    rejects(withCollection({ config: { writes_per_min: 1.5 } }), "collections.votes.config.writes_per_min");
    rejects(withCollection({ config: { per_identity_limit: "1" } }), "collections.votes.config.per_identity_limit");
    expect(parseDataStatus(withCollection({ config: { per_identity_limit: null } })).entitled).toBe(true);
  });

  it("test_R1_every_timestamp_field_must_be_iso", () => {
    const bill = (f: string) => ({ ...enabledStatus, billing: { ...enabledStatus.billing, [f]: "garbage" } });
    for (const f of ["enabled_at", "disabled_at", "wipe_after", "wiped_at"]) rejects(bill(f), `billing.${f}`);
    rejects({ ...enabledStatus, kv: { drift: "none", checked_at: "2026-10-18" } }, "kv.checked_at");
    rejects({ ...enabledStatus, wipe_job: { last_run_at: "soon", last_result: null } }, "wipe_job.last_run_at");
    expect(parseDataStatus({ ...enabledStatus, billing: { ...enabledStatus.billing, wipe_after: "2026-11-17T00:00:00.000Z" } }).billing.wipe_after).toBe("2026-11-17T00:00:00.000Z");
  });

  it("test_R1_status_flow_rejects_drifted_body_before_any_formatting", async () => {
    const { client } = makeClient(serveStatus({ ...enabledStatus, jwt_issuer: {} }));
    await expect(runData(client, NS, { action: "status" })).rejects.toThrow("jwt_issuer.issuer");
  });
});
