/**
 * DW-6.1: core facade for site data — credential wiring, namespace
 * resolution (default and named), and the four dispatchers end to end over an
 * injected fetch.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { data, dataCollection, dataJwt, dataRows, SiteDataError } from "./core.ts";
import type { CoreDeps } from "./core.ts";
import { NS, SITES_BODY, fixtureResponse, jsonResponse, loadRoute, stackFetch, type Handler } from "../tests/helpers/site-data.ts";

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true });
});

function deps(handler: Handler): { deps: CoreDeps; calls: ReturnType<typeof stackFetch>["calls"] } {
  const file = path.join(os.tmpdir(), `core-site-data-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, "refresh-token", { mode: 0o600 });
  tmpFiles.push(file);
  const { fetchFn, calls } = stackFetch(handler);
  return { deps: { credentialsPath: file, fetchFn }, calls };
}

const status = fixtureResponse(loadRoute("api.status"), "enabled").body;

describe("DW-6.1: core site data wiring", () => {
  it("test_DW_6_1_core_not_authenticated_points_to_login_for_every_tool", async () => {
    const missing: CoreDeps = { credentialsPath: path.join(os.tmpdir(), "does-not-exist-site-data"), fetchFn: async () => { throw new Error("no network"); } };
    for (const call of [
      () => data({ action: "status" }, missing),
      () => dataCollection({ action: "list" }, missing),
      () => dataRows({ action: "list", collection: "votes" }, missing),
      () => dataJwt({ action: "clear" }, missing),
    ]) {
      await expect(call()).rejects.toThrow("Not authenticated. Use the login tool to sign in.");
    }
  });

  it("test_DW_6_1_core_data_status_uses_default_namespace", async () => {
    const { deps: d, calls } = deps((req) => (req.path === `/api/ns/${NS.id}/data` ? jsonResponse(200, status) : jsonResponse(200, SITES_BODY)));
    const r = await data({ action: "status" }, d);
    expect(r).toMatchObject({ action: "status", available: true, namespace: "ryan" });
    expect(calls[0]!.path).toBe(`/api/ns/${NS.id}/data`);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer mock-access");
  });

  it("test_DW_6_1_core_named_namespace_is_resolved_to_its_id", async () => {
    const { deps: d, calls } = deps(() => jsonResponse(200, { jwt_issuer: null }));
    await dataJwt({ action: "clear", namespace: "other" }, d);
    expect(calls[0]!.path).toBe("/api/ns/ns-other/data/jwt-issuer");
  });

  it("test_DW_6_1_core_unknown_namespace_fails_before_any_data_call", async () => {
    const { deps: d, calls } = deps(() => undefined);
    await expect(dataRows({ action: "list", collection: "votes", namespace: "ghost" }, d)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("test_DW_6_1_core_wipe_confirmation_is_checked_against_the_named_namespace", async () => {
    const { deps: d, calls } = deps(() => jsonResponse(200, { collections: 0, rows: 0 }));
    await expect(data({ action: "wipe", namespace: "other", confirm_namespace: "ryan" }, d)).rejects.toThrow("does not match the address name 'other'");
    expect(calls).toHaveLength(0);
    await data({ action: "wipe", namespace: "other", confirm_namespace: "other" }, d);
    expect(calls[0]!.path).toBe("/api/ns/ns-other/data/wipe");
  });

  it("test_DW_6_1_core_collection_and_rows_dispatch", async () => {
    const view = fixtureResponse(loadRoute("api.get_collection"), "found").body;
    const row = { id: "a", author: { kind: "owner", subject: "u" }, data: {}, created_at: "2026-10-18T12:00:00.000Z", updated_at: "2026-10-18T12:00:00.000Z", archived_at: null };
    const { deps: d } = deps((req) =>
      req.path.endsWith("/sites") ? jsonResponse(200, SITES_BODY)
      : req.path.includes("/rows") ? jsonResponse(200, { rows: [row], next_cursor: null })
      : jsonResponse(200, view),
    );
    expect(await dataCollection({ action: "get", collection: "votes" }, d)).toMatchObject({ collection: { sites: ["for-her", "results"] } });
    expect(await dataRows({ action: "list", collection: "votes" }, d)).toMatchObject({ rows: [{ id: "a" }] });
  });

  it("test_DW_6_1_core_errors_are_site_data_errors_and_exported", async () => {
    const { deps: d } = deps(() => jsonResponse(402, { error: "Enable site data first.", code: "addon_not_enabled" }));
    const err = await dataCollection({ action: "list" }, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteDataError);
    expect((err as SiteDataError).status).toBe(402);
  });
});
