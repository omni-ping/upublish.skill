/**
 * DW-6.1: every `api.*` route fixture from the frozen contract is replayed
 * against the skill's lib functions through an injected fetch.
 *
 * For each fixture response (success AND error) the test asserts that the
 * request the skill sends equals the fixture's request (method, path incl.
 * query encoding, JSON body), then that a success parses into the tool's
 * result and an error becomes a SiteDataError carrying the fixture's `code`
 * and status. Fixtures are a read-only snapshot (tests/fixtures/site-data).
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient } from "./api-client.ts";
import { runData, runDataJwt } from "./site-data.ts";
import { runDataCollection } from "./site-data-collections.ts";
import { runDataRows } from "./site-data-rows.ts";
import { SiteDataError } from "./site-data-errors.ts";
import type { DataStatus, ImportRow, JsonObject, SiteDataErrorCode } from "./site-data-types.ts";
import {
  NS, fixtureResponse, fromFixture, jsonResponse, loadRoute, makeClient, withAccount, withSites,
  type Handler, type RouteFixture,
} from "../tests/helpers/site-data.ts";

const tmp = mkdtempSync(join(tmpdir(), "site-data-fixtures-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Case {
  route: string;
  call: (client: ApiClient) => Promise<unknown>;
  /** Answers requests other than the fixture's own (status pre-read, PATCH-before-POST, ...). */
  prelude?: Handler;
  /** Extra assertions on a successful result. */
  onSuccess?: (result: unknown, fixtureBody: unknown) => void;
  /** Overrides the default "SiteDataError with the fixture code" expectation for a named response. */
  onError?: Record<string, (err: unknown) => void>;
}

const statusFixture = loadRoute("api.status");
const enabledFixture = fixtureResponse(statusFixture, "enabled").body as { billing: object };
const unentitledStatus = { ...enabledFixture, entitled: false, billing: { ...enabledFixture.billing, item_present: false } };

const importRequest = loadRoute("api.import").request.body as { rows: ImportRow[] };
const exportPath = join(tmp, "votes.ndjson");

const CASES: Case[] = [
  {
    route: "api.status",
    call: (c) => runData(c, NS, { action: "status" }),
    prelude: withSites(() => undefined),
    onSuccess: (r, body) => {
      expect(r).toHaveProperty("action", "status");
      const b = body as DataStatus;
      if (b.available) expect((r as { status: DataStatus }).status.billing.would_charge).toBe(b.billing.would_charge);
    },
  },
  {
    route: "api.enable",
    call: (c) => runData(c, NS, { action: "enable", accept_charge: true, expected: { tier: "pro", would_charge: false, price_cents: null, interval: "month", month_cents: 200, year_cents: 2000 } }),
    prelude: withAccount({ tier: "pro", role: "user" }, (req) => (req.method === "GET" && req.path === `/api/ns/${NS.id}/data` ? jsonResponse(200, unentitledStatus) : undefined)),
    onSuccess: (r) => expect(r).toMatchObject({ action: "enable", state: "enabled" }),
  },
  {
    route: "api.disable",
    call: (c) => runData(c, NS, { action: "disable" }),
    onSuccess: (r) => expect(r).toMatchObject({ action: "disable", wipe_after: "2026-11-17T12:00:00.000Z" }),
  },
  {
    route: "api.list_collections",
    call: (c) => runDataCollection(c, NS, { action: "list" }),
    prelude: withSites(() => undefined),
    onSuccess: (r) => {
      const first = (r as { collections: Array<{ sites: string[] }> }).collections[0]!;
      expect(first.sites).toEqual(["for-her", "results"]); // ids rendered back as slugs
    },
  },
  {
    route: "api.create_collection",
    call: (c) =>
      runDataCollection(c, NS, {
        action: "set",
        collection: "votes",
        rule: "own-rows",
        sites: ["for-her", "results"],
        writers: ["passcode"],
        write_claims: [{ kind: "passcode", claims: { site: "for-her", label: "her" } }],
        admin_claims: [{ kind: "passcode", claims: { site: "results", label: "founder" } }],
      }),
    // The skill tries PATCH first; the collection does not exist yet.
    prelude: withSites((req) =>
      req.method === "PATCH" ? jsonResponse(404, { error: "No such collection.", code: "collection_not_found" }) : undefined,
    ),
    onSuccess: (r) => expect(r).toMatchObject({ action: "set", created: true }),
  },
  {
    route: "api.get_collection",
    call: (c) => runDataCollection(c, NS, { action: "get", collection: "votes" }),
    prelude: withSites(() => undefined),
    onSuccess: (r) => expect(r).toMatchObject({ action: "get", collection: { name: "votes" } }),
  },
  {
    route: "api.update_collection",
    call: (c) => runDataCollection(c, NS, { action: "set", collection: "votes", max_rows: 5000 }),
    prelude: withSites(() => undefined),
    onSuccess: (r) => expect(r).toMatchObject({ action: "set", created: false, collection: { max_rows: 5000 } }),
    // Missing collection + a partial patch cannot become a create: the skill says what is missing.
    onError: { missing: (e) => expect((e as Error).message).toMatch(/requires rule, sites, writers/) },
  },
  {
    route: "api.delete_collection",
    call: (c) => runDataCollection(c, NS, { action: "delete", collection: "votes" }),
    onSuccess: (r) => expect(r).toMatchObject({ action: "delete", name: "votes", rows: 49 }),
  },
  {
    route: "api.list_rows",
    call: (c) => runDataRows(c, NS, { action: "list", collection: "votes", limit: 50 }),
    onSuccess: (r) => expect((r as { rows: unknown[] }).rows).toHaveLength(1),
  },
  {
    route: "api.export",
    call: (c) => runDataRows(c, NS, { action: "export", collection: "votes", path: exportPath }),
    onSuccess: (r, body) => {
      expect(r).toMatchObject({ action: "export", rows: 1, path: exportPath });
      expect(body).toBeUndefined();
    },
  },
  {
    route: "api.create_row",
    call: (c) => runDataRows(c, NS, { action: "create", collection: "notes", data: { title: "Hello" } }),
    onSuccess: (r) => expect(r).toMatchObject({ action: "create", row: { author: { kind: "owner" } } }),
  },
  {
    route: "api.put_row",
    call: (c) => runDataRows(c, NS, { action: "put", collection: "notes", id: "post-1", data: { title: "Hello" } }),
    onSuccess: (r) => expect(r).toMatchObject({ action: "put", row: { id: "post-1" } }),
  },
  {
    route: "api.archive",
    call: (c) => runDataRows(c, NS, { action: "archive", collection: "votes" }),
    onSuccess: (r) => expect(r).toMatchObject({ action: "archive", archived: 42 }),
  },
  {
    route: "api.delete_row",
    call: (c) =>
      runDataRows(c, NS, {
        action: "delete",
        collection: "votes",
        id: "item-17",
        author: "passcode:5b0e3c1a-0000-4000-8000-00000000c001",
        archived: true,
      }),
    onSuccess: (r) => expect(r).toMatchObject({ action: "delete", id: "item-17", archived: true }),
  },
  {
    route: "api.import",
    call: (c) => runDataRows(c, NS, { action: "import", collection: "votes", rows: importRequest.rows as ImportRow[] }),
    onSuccess: (r) => expect(r).toMatchObject({ action: "import", imported: 1, skipped: 0 }),
  },
  {
    route: "api.set_jwt_issuer",
    call: (c) => {
      const body = loadRoute("api.set_jwt_issuer").request.body as Record<string, unknown>;
      return runDataJwt(c, NS, { action: "set", ...body } as Parameters<typeof runDataJwt>[2]);
    },
    onSuccess: (r) => expect(r).toMatchObject({ action: "set", jwt_issuer: { audience: "authenticated" } }),
  },
  {
    route: "api.clear_jwt_issuer",
    call: (c) => runDataJwt(c, NS, { action: "clear" }),
    onSuccess: (r) => expect(r).toEqual({ action: "clear", jwt_issuer: null }),
  },
  {
    route: "api.wipe",
    call: (c) => runData(c, NS, { action: "wipe", confirm_namespace: "ryan" }),
    onSuccess: (r) => expect(r).toMatchObject({ action: "wipe", namespace: "ryan", rows: 49 }),
  },
];

/** Handler that serves one fixture response for the fixture's own request, after asserting the request matches. */
function serve(fx: RouteFixture, name: string, prelude?: Handler): Handler {
  const resp = fixtureResponse(fx, name);
  return (req) => {
    if (req.method === fx.request.method && req.path === fx.request.path) {
      // A route with no request body (disable) is sent an empty JSON object.
      expect(req.body ?? {}).toEqual(fx.request.body ?? {});
      return fromFixture(resp);
    }
    return prelude?.(req);
  };
}

describe("DW-6.3: contract amendment 45f6dd0 (billing.would_charge)", () => {
  it("test_DW_6_3_status_fixture_has_a_would_charge_true_scenario_and_every_status_body_has_the_flag", () => {
    const responses = statusFixture.responses.filter((r) => r.status === 200);
    expect(responses.some((r) => (r.body as DataStatus).billing.would_charge === true)).toBe(true);
    for (const r of responses) expect(typeof (r.body as DataStatus).billing.would_charge).toBe("boolean");
  });
});

describe("DW-6.1: contract fixtures replayed against every api.* route", () => {
  it("test_DW_6_1_fixture_replay_covers_all_18_api_routes", () => {
    expect(CASES).toHaveLength(18);
    expect(new Set(CASES.map((c) => c.route)).size).toBe(18);
  });

  for (const c of CASES) {
    const fx = loadRoute(c.route);
    for (const resp of fx.responses) {
      it(`test_DW_6_1_fixture_replay_${c.route}_${resp.name.replace(/\W+/g, "_")}`, async () => {
        const { client } = makeClient(serve(fx, resp.name, c.prelude));
        if (resp.status < 400) {
          const result = await c.call(client);
          c.onSuccess?.(result, resp.body);
          if (c.route === "api.export") {
            const lines = readFileSync(exportPath, "utf-8").trimEnd().split("\n");
            expect(lines.map((l) => JSON.parse(l) as JsonObject)).toEqual(resp.bodyLines as JsonObject[]);
          }
          return;
        }
        const err = await c.call(client).then(() => null, (e: unknown) => e);
        const override = c.onError?.[resp.name];
        if (override) return override(err);
        expect(err).toBeInstanceOf(SiteDataError);
        const body = resp.body as { code: SiteDataErrorCode };
        expect((err as SiteDataError).code).toBe(body.code);
        expect((err as SiteDataError).status).toBe(resp.status);
      });
    }
  }
});

describe("DW-6.6: contract amendment 745e2e6 (archived delete, fixture notes)", () => {
  it("test_DW_6_6_fixture_loader_tolerates_top_level_note_and_delete_fixture_requests_archived", () => {
    const f = loadRoute("api.delete_row") as RouteFixture & { note?: string };
    expect(typeof f.note).toBe("string");
    expect(f.request.path).toMatch(/\?author=[^&]+&archived=true$/);
  });

  it("test_DW_6_6_delete_without_archived_differs_from_the_fixture_request_by_exactly_the_param", async () => {
    const f = loadRoute("api.delete_row");
    const { client, calls } = makeClient(() => jsonResponse(200, { deleted: true }));
    await runDataRows(client, NS, { action: "delete", collection: "votes", id: "item-17", author: "passcode:5b0e3c1a-0000-4000-8000-00000000c001" });
    expect(`${calls[0]!.path}&archived=true`).toBe(f.request.path);
  });
});
