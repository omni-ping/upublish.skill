/**
 * DW-6.1: `data` and `data_jwt` operations (status, enable consent flow,
 * disable, wipe, JWT issuer) including error paths.
 */

import { describe, it, expect } from "bun:test";
import { parseDataStatus, runData, runDataJwt } from "./site-data.ts";
import { SiteDataError } from "./site-data-errors.ts";
import type { DataStatus } from "./site-data-types.ts";
import { NS, fixtureResponse, jsonResponse, loadRoute, makeClient, withSites } from "../tests/helpers/site-data.ts";

const statusFx = loadRoute("api.status");
const enabledStatus = fixtureResponse(statusFx, "enabled").body as DataStatus;
const darkLaunch = fixtureResponse(statusFx, "dark launch: hidden").body as DataStatus;
const unentitled: DataStatus = { ...enabledStatus, entitled: false };
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

describe("DW-6.1: data enable (consent gate)", () => {
  it("test_DW_6_1_enable_without_consent_returns_price_and_never_posts", async () => {
    const { client, calls } = makeClient(serveStatus(unentitled));
    const r = await runData(client, NS, { action: "enable" });
    expect(r).toEqual({
      action: "enable",
      state: "consent_needed",
      price: { month_cents: 200, year_cents: 2000 },
      interval: "month",
    });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("test_DW_6_1_enable_accept_charge_false_is_not_consent", async () => {
    const { client, calls } = makeClient(serveStatus(unentitled));
    const r = await runData(client, NS, { action: "enable", accept_charge: false });
    expect(r).toMatchObject({ state: "consent_needed" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("test_DW_6_1_enable_with_consent_posts_accept_charge_true_and_reports_charge", async () => {
    const enableFx = loadRoute("api.enable");
    const { client, calls } = makeClient((req) =>
      req.method === "POST" ? jsonResponse(200, fixtureResponse(enableFx, "enabled").body) : serveStatus(unentitled)(req),
    );
    const r = await runData(client, NS, { action: "enable", accept_charge: true });
    expect(r).toEqual({ action: "enable", state: "enabled", activating: true, charge: { interval: "month", price_cents: 140 } });
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: `${STATUS_PATH}/enable`, body: { accept_charge: true } });
  });

  it("test_DW_6_1_enable_comped_has_null_charge", async () => {
    const enableFx = loadRoute("api.enable");
    const { client } = makeClient((req) =>
      req.method === "POST" ? jsonResponse(200, fixtureResponse(enableFx, "comped").body) : serveStatus(unentitled)(req),
    );
    expect(await runData(client, NS, { action: "enable", accept_charge: true })).toMatchObject({ state: "enabled", charge: null });
  });

  it("test_DW_6_1_enable_when_already_entitled_never_posts", async () => {
    const { client, calls } = makeClient(serveStatus(enabledStatus));
    expect(await runData(client, NS, { action: "enable", accept_charge: true })).toEqual({ action: "enable", state: "already_enabled" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("test_DW_6_1_enable_dark_launch_is_not_available_error", async () => {
    const { client } = makeClient(serveStatus(darkLaunch));
    const err = await runData(client, NS, { action: "enable", accept_charge: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteDataError);
    expect((err as SiteDataError).code).toBe("not_available");
  });

  it("test_DW_6_1_enable_402_consent_required_from_server_is_mapped", async () => {
    const { client } = makeClient((req) =>
      req.method === "POST" ? jsonResponse(402, { error: "Send accept_charge: true", code: "consent_required" }) : serveStatus(unentitled)(req),
    );
    await expect(runData(client, NS, { action: "enable", accept_charge: true })).rejects.toMatchObject({ code: "consent_required", status: 402 });
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
