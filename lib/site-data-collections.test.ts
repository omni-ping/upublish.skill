/**
 * DW-6.1: `data_collection` — list/get/set/delete, the set create-vs-update
 * logic, slug resolution and validation.
 */

import { describe, it, expect } from "bun:test";
import { runDataCollection } from "./site-data-collections.ts";
import { SiteDataError } from "./site-data-errors.ts";
import type { CollectionView } from "./site-data-types.ts";
import { NS, SITE_FOR_HER, SITE_RESULTS, fixtureResponse, jsonResponse, loadRoute, makeClient, withSites, type Handler } from "../tests/helpers/site-data.ts";

const BASE = `/api/ns/${NS.id}/data/collections`;
const view = fixtureResponse(loadRoute("api.get_collection"), "found").body as CollectionView;
const notFound = () => jsonResponse(404, { error: "No such collection.", code: "collection_not_found" });

describe("DW-6.1: data_collection list/get/delete", () => {
  it("test_DW_6_1_collection_list_returns_slugged_views", async () => {
    const { client } = makeClient(withSites((req) => (req.path === BASE ? jsonResponse(200, { collections: [view] }) : undefined)));
    const r = await runDataCollection(client, NS, { action: "list" });
    expect(r).toMatchObject({ action: "list", collections: [{ name: "votes", sites: ["for-her", "results"] }] });
  });

  it("test_DW_6_1_collection_list_addon_not_enabled_is_actionable", async () => {
    const { client } = makeClient(() => jsonResponse(402, { error: "Enable site data first.", code: "addon_not_enabled" }));
    await expect(runDataCollection(client, NS, { action: "list" })).rejects.toThrow("data action 'enable'");
  });

  it("test_DW_6_1_collection_get_requires_valid_name", async () => {
    const { client, calls } = makeClient(() => undefined);
    await expect(runDataCollection(client, NS, { action: "get" })).rejects.toThrow("collection is required when action is 'get'");
    await expect(runDataCollection(client, NS, { action: "get", collection: "../x" })).rejects.toThrow("Invalid collection name '../x'");
    await expect(runDataCollection(client, NS, { action: "delete", collection: "_me" })).rejects.toThrow("Invalid collection name");
    expect(calls).toHaveLength(0);
  });

  it("test_DW_6_1_collection_get_missing_is_collection_not_found", async () => {
    const { client } = makeClient(notFound);
    await expect(runDataCollection(client, NS, { action: "get", collection: "nope" })).rejects.toMatchObject({ code: "collection_not_found" });
  });

  it("test_DW_6_1_collection_delete_reports_rows_removed", async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { collections: 1, rows: 49 }));
    expect(await runDataCollection(client, NS, { action: "delete", collection: "votes" })).toEqual({ action: "delete", name: "votes", collections: 1, rows: 49 });
    expect(calls[0]).toMatchObject({ method: "DELETE", path: `${BASE}/votes` });
  });
});

describe("DW-6.1: data_collection set", () => {
  const patched = { ...view, max_rows: 5000 };

  it("test_DW_6_1_collection_set_updates_existing_with_patch_of_passed_fields_only", async () => {
    const { client, calls } = makeClient(withSites((req) => (req.method === "PATCH" ? jsonResponse(200, patched) : undefined)));
    const r = await runDataCollection(client, NS, { action: "set", collection: "votes", max_rows: 5000, per_identity_limit: null });
    expect(r).toMatchObject({ action: "set", created: false, collection: { max_rows: 5000 } });
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe(`${BASE}/votes`);
    expect(patch.body).toEqual({ max_rows: 5000, per_identity_limit: null }); // null is a value, not "absent"
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("test_DW_6_1_collection_set_resolves_slugs_to_ids_in_patch", async () => {
    const { client, calls } = makeClient(withSites((req) => (req.method === "PATCH" ? jsonResponse(200, patched) : undefined)));
    await runDataCollection(client, NS, {
      action: "set",
      collection: "votes",
      sites: ["results", SITE_FOR_HER],
      admin_claims: [{ kind: "passcode", claims: { site: "results", label: "founder" } }],
    });
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({
      sites: [SITE_RESULTS, SITE_FOR_HER],
      admin_claims: [{ kind: "passcode", claims: { site: SITE_RESULTS, label: "founder" } }],
    });
  });

  it("test_DW_6_1_collection_set_creates_via_post_when_patch_says_not_found", async () => {
    const created: Handler = (req) => (req.method === "PATCH" ? notFound() : req.method === "POST" ? jsonResponse(201, view) : undefined);
    const { client, calls } = makeClient(withSites(created));
    const r = await runDataCollection(client, NS, {
      action: "set", collection: "votes", rule: "own-rows", sites: ["for-her"], writers: ["passcode"], max_rows: 100,
    });
    expect(r).toMatchObject({ action: "set", created: true, collection: { sites: ["for-her", "results"] } });
    expect(calls.find((c) => c.method === "POST")).toMatchObject({
      path: BASE,
      body: { name: "votes", rule: "own-rows", sites: [SITE_FOR_HER], writers: ["passcode"], max_rows: 100 },
    });
  });

  it("test_DW_6_1_collection_set_create_missing_required_fields_names_them_and_posts_nothing", async () => {
    const { client, calls } = makeClient(withSites((req) => (req.method === "PATCH" ? notFound() : undefined)));
    await expect(runDataCollection(client, NS, { action: "set", collection: "votes", rule: "inbox" })).rejects.toThrow(
      "Collection 'votes' does not exist; creating it requires sites, writers.",
    );
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("test_DW_6_1_collection_set_other_patch_errors_do_not_fall_back_to_create", async () => {
    const { client, calls } = makeClient(
      withSites((req) => (req.method === "PATCH" ? jsonResponse(402, { error: "Enable first.", code: "addon_not_enabled" }) : undefined)),
    );
    const err = await runDataCollection(client, NS, {
      action: "set", collection: "votes", rule: "inbox", sites: ["for-her"], writers: ["anonymous"],
    }).catch((e: unknown) => e);
    expect((err as SiteDataError).code).toBe("addon_not_enabled");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("test_DW_6_1_collection_set_create_conflict_is_collection_exists", async () => {
    const { client } = makeClient(
      withSites((req) =>
        req.method === "PATCH" ? notFound() : jsonResponse(409, { error: "exists", code: "collection_exists" }),
      ),
    );
    await expect(
      runDataCollection(client, NS, { action: "set", collection: "votes", rule: "inbox", sites: ["for-her"], writers: ["anonymous"] }),
    ).rejects.toMatchObject({ code: "collection_exists" });
  });

  it("test_DW_6_1_collection_set_with_no_fields_is_rejected_before_any_request", async () => {
    const { client, calls } = makeClient(() => undefined);
    await expect(runDataCollection(client, NS, { action: "set", collection: "votes" })).rejects.toThrow("Nothing to set");
    expect(calls).toHaveLength(0);
  });

  it("test_DW_6_1_collection_set_unknown_site_slug_fails_before_patch", async () => {
    const { client, calls } = makeClient(withSites(() => undefined));
    await expect(runDataCollection(client, NS, { action: "set", collection: "votes", sites: ["ghost"] })).rejects.toThrow("Unknown site 'ghost'");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});
