/**
 * Review fix-forward for phase 6: the output boundary (every formatter result
 * and every error message), raw-error mapping, and validation of every
 * response the skill prints.
 */

import { describe, it, expect } from "bun:test";
import { ApiError } from "./api-client.ts";
import { runData, runDataJwt } from "./site-data.ts";
import { runDataCollection } from "./site-data-collections.ts";
import { runDataRows } from "./site-data-rows.ts";
import { SiteDataError, sanitizeErrors, toSiteDataError } from "./site-data-errors.ts";
import { formatCollectionResult, formatDataResult, formatJwtResult, formatRowsResult } from "./site-data-format.ts";
import { parseDataStatus } from "./site-data-shape.ts";
import { sanitizeErrorText, sanitizeOutput } from "./site-data-text.ts";
import type { CollectionView, DataStatus } from "./site-data-types.ts";
import { NS, fixtureResponse, jsonResponse, loadRoute, makeClient, withAccount, withSites } from "../tests/helpers/site-data.ts";

/** What a line-splitting reader (JS regex line terminators plus NEL) would see. */
const lines = (s: string): string[] => s.split(/\r\n|[\n\r\u0085\u2028\u2029]/);
const NASTY = ["\n", "\r", "\u0085", "\u2028", "\u2029"] as const;
const label = (c: string): string => `U+${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
const ts = "2026-10-18T12:00:00.000Z";
const mkRow = (over: Record<string, unknown> = {}, author: Record<string, unknown> = {}) => ({
  id: "item-1", author: { kind: "passcode" as const, subject: "p1", ...author }, data: { msg: "hi" }, created_at: ts, updated_at: ts, archived_at: null, ...over,
});

describe("finding 1: sanitizeOutput", () => {
  it("test_F1_sanitize_escapes_every_control_but_newline", () => {
    expect(sanitizeOutput("a\nb")).toBe("a\nb");
    expect(sanitizeOutput("a\rb\tc\u0000d\u007fe\u0085f\u009fg\u2028h\u2029i")).toBe(
      "a\\u000db\\u0009c\\u0000d\\u007fe\\u0085f\\u009fg\\u2028h\\u2029i",
    );
    expect(sanitizeOutput("plain   text é")).toBe("plain   text é");
  });
});

describe("finding 1: formatters keep the line count of a clean input", () => {
  for (const c of NASTY) {
    const dirty = `hi${c}  author: passcode:victim`;

    it(`test_F1_rows_data_${label(c)}_list_create_put`, () => {
      const clean = mkRow({ data: { msg: "hi  author: passcode:victim" } });
      const bad = mkRow({ data: { msg: dirty, [`k${c}`]: [dirty] } });
      const list = (r: unknown) => formatRowsResult({ action: "list", collection: "votes", rows: [r] as never, next_cursor: null });
      expect(lines(list(bad))).toHaveLength(lines(list(clean)).length);
      for (const action of ["create", "put"] as const) {
        const f = (r: unknown) => formatRowsResult({ action, collection: "votes", row: r as never });
        expect(lines(f(bad))).toHaveLength(lines(f(clean)).length);
      }
    });

    it(`test_F1_label_subject_id_cursor_${label(c)}`, () => {
      const f = (r: unknown, cursor: string) => formatRowsResult({ action: "list", collection: "votes", rows: [r] as never, next_cursor: cursor });
      const clean = f(mkRow({}, { label: "l" }), "cur");
      const bad = f(mkRow({ id: `a${c}b` }, { label: dirty, subject: `s${c}x` }), `cur${c}x`);
      expect(lines(bad)).toHaveLength(lines(clean).length);
    });

    it(`test_F1_collection_and_status_text_${label(c)}`, () => {
      const view = fixtureResponse(loadRoute("api.get_collection"), "found").body as CollectionView;
      const f = (name: string) => formatCollectionResult({ action: "get", collection: { ...view, name, sites: [`s${name}`], writers: view.writers } });
      expect(lines(f(`v${c}x`))).toHaveLength(lines(f("vx")).length);
      const st = fixtureResponse(loadRoute("api.status"), "enabled").body as DataStatus;
      const g = (n: string) => formatDataResult({ action: "status", available: true, namespace: n, status: { ...st, kv: { drift: "stale", checked_at: null } } });
      expect(lines(g(`ry${c}an`))).toHaveLength(lines(g("ryan")).length);
      const j = (i: string) => formatJwtResult({ action: "set", jwt_issuer: { issuer: i, jwks_uri: "u", audience: "a", algorithms: ["ES256"] } });
      expect(lines(j(`i${c}x`))).toHaveLength(lines(j("ix")).length);
    });

    it(`test_F1_error_text_${label(c)}`, () => {
      const e = toSiteDataError(new ApiError(400, { error: dirty, code: "invalid_request" }, "x"), "owner") as SiteDataError;
      expect(lines(e.message)).toHaveLength(1);
    });
  }

  it("test_F1_row_data_with_nel_is_escaped_not_raw", () => {
    const out = formatRowsResult({ action: "create", collection: "votes", row: mkRow({ data: { m: "a\u0085b\u2028c\u2029d\u007f" } }) as never });
    expect(out).not.toMatch(/[\u0085\u2028\u2029\u007f]/);
    expect(out).toContain("a\\u0085b\\u2028c\\u2029d\\u007f");
  });

  it("test_F1_other_formatters_pass_boundary_for_disable_wipe_export", () => {
    expect(formatDataResult({ action: "wipe", namespace: "r\u2028x", collections: 1, rows: 2 } as never)).not.toMatch(/\u2028/);
    expect(formatRowsResult({ action: "export", collection: "v", path: "/tmp/a\u0085b", rows: 1, bytes: 2 })).not.toMatch(/\u0085/);
  });
});

describe("finding 1/2: error boundary", () => {
  it("test_F1_sanitizeErrors_escapes_message_and_keeps_error_object", async () => {
    const original = new SiteDataError("forbidden", 403, "bad\r\u2028line");
    const caught = await sanitizeErrors(async () => { throw original; }).catch((e: unknown) => e);
    expect(caught).toBe(original);
    expect((caught as Error).message).toBe("bad\\u000d\\u2028line");
    expect((caught as SiteDataError).status).toBe(403);
    const nonError = await sanitizeErrors(async () => { throw "x\u0085y"; }).catch((e: unknown) => e);
    expect((nonError as Error).message).toBe("x\\u0085y");
    expect(await sanitizeErrors(async () => 5)).toBe(5);
  });

  it("test_R_J_sanitizeErrors_escapes_newline_but_sanitizeOutput_keeps_it", async () => {
    const caught = await sanitizeErrors(async () => { throw new Error("a\nb"); }).catch((e: unknown) => e);
    expect((caught as Error).message).toBe("a\\u000ab");
    const nonError = await sanitizeErrors(async () => { throw "x\ny"; }).catch((e: unknown) => e);
    expect((nonError as Error).message).toBe("x\\u000ay");
    expect(sanitizeErrorText("p\tq\r\n")).toBe("p\\u0009q\\u000d\\u000a");
    expect(sanitizeOutput("a\nb")).toBe("a\nb");
  });
});

describe("finding 2: raw error text", () => {
  it("test_F2_uncoded_api_error_with_control_chars_is_wrapped_and_escaped", () => {
    const raw = new ApiError(502, { error: "bad\n  author: forged" }, "API error 502: bad\n  author: forged");
    const out = toSiteDataError(raw, "owner") as SiteDataError;
    expect(out).toBeInstanceOf(SiteDataError);
    expect(out.status).toBe(502);
    expect(out.code).toBeNull();
    expect(lines(out.message)).toHaveLength(1);
    expect(out.message).toContain("author: forged");
  });

  it("test_F2_clean_uncoded_api_error_still_passes_through", () => {
    const raw = new ApiError(502, null, "API error 502: Bad Gateway");
    expect(toSiteDataError(raw, "owner")).toBe(raw);
  });

  it("test_F2_status_collection_key_in_shape_error_is_escaped", () => {
    const st = structuredClone(fixtureResponse(loadRoute("api.status"), "enabled").body) as DataStatus & { collections: Record<string, unknown> };
    st.collections = { "bad\u2028name\n  author: x": { config: {}, stats: null } } as never;
    const err = (() => { try { parseDataStatus(st); } catch (e) { return e as Error; } })()!;
    expect(lines(err.message)).toHaveLength(1);
    expect(err.message).toContain("collections.");
  });

  it("test_F2_set_collection_site_listing_failure_is_mapped_and_escaped", async () => {
    const { client } = makeClient((req) =>
      req.path.endsWith("/sites") ? jsonResponse(500, { error: "bad\n  author: forged" }) : undefined,
    );
    const err = await runDataCollection(client, NS, { action: "set", collection: "votes", max_rows: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteDataError);
    expect((err as SiteDataError).status).toBe(500);
    expect(lines((err as Error).message)).toHaveLength(1);
  });

  it("test_F2_set_collection_site_listing_coded_error_gets_a_hint", async () => {
    const { client } = makeClient((req) =>
      req.path.endsWith("/sites") ? jsonResponse(403, { error: "no", code: "forbidden" }) : undefined,
    );
    const err = await runDataCollection(client, NS, { action: "set", collection: "votes", max_rows: 5 }).catch((e: unknown) => e);
    expect((err as SiteDataError).code).toBe("forbidden");
  });

  it("test_F2_argument_echoes_in_errors_are_single_line", async () => {
    const { client } = makeClient(withSites(() => undefined));
    await expect(runDataRows(client, NS, { action: "delete", collection: "votes", id: "a\nb" })).rejects.toThrow(/Invalid row id '"a\\nb"'/);
    await expect(runDataCollection(client, NS, { action: "get", collection: "a\nb" })).rejects.toThrow(/Invalid collection name '"a\\nb"'/);
    await expect(runDataCollection(client, NS, { action: "set", collection: "votes", sites: ["x\ny"], rule: "inbox", writers: ["anonymous"] })).rejects.toThrow(/Unknown site '"x\\ny"'/);
    await expect(runData(client, NS, { action: "wipe", confirm_namespace: "a\nb" })).rejects.toThrow(/confirm_namespace '"a\\nb"'/);
  });
});

describe("finding 3: malformed response bodies are rejected", () => {
  const field = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
  const bad = (body: unknown) => makeClient(() => jsonResponse(200, body)).client;

  it("test_F3_archive_requires_archived_count", async () => {
    expect(await field(runDataRows(bad({}), NS, { action: "archive", collection: "votes" }))).toMatch(/archive endpoint.*archived/);
    expect(await field(runDataRows(bad({ archived: -1 }), NS, { action: "archive", collection: "votes" }))).toMatch(/archived/);
  });

  it("test_F3_import_requires_counts", async () => {
    const rows = [{ id: "a", author: { kind: "owner" as const, subject: "u" }, data: {}, created_at: ts }];
    expect(await field(runDataRows(bad({ imported: 1 }), NS, { action: "import", collection: "votes", rows }))).toMatch(/import endpoint.*skipped/);
    expect(await field(runDataRows(bad({ imported: "1", skipped: 0 }), NS, { action: "import", collection: "votes", rows }))).toMatch(/imported/);
  });

  it("test_F3_wipe_and_delete_collection_require_counts", async () => {
    expect(await field(runData(bad({ collections: 1 }), NS, { action: "wipe", confirm_namespace: "ryan" }))).toMatch(/wipe endpoint.*rows/);
    expect(await field(runDataCollection(bad({ rows: 3 }), NS, { action: "delete", collection: "votes" }))).toMatch(/delete collection endpoint.*collections/);
  });

  it("test_F3_delete_row_requires_deleted_true", async () => {
    expect(await field(runDataRows(bad({}), NS, { action: "delete", collection: "votes", id: "a" }))).toMatch(/deleted/);
    expect(await field(runDataRows(bad({ deleted: false }), NS, { action: "delete", collection: "votes", id: "a" }))).toMatch(/deleted/);
  });

  it("test_F3_enable_validates_charge_and_flags", async () => {
    const enabled = fixtureResponse(loadRoute("api.status"), "enabled").body as DataStatus;
    const unentitled = { ...enabled, entitled: false, billing: { ...enabled.billing, item_present: false } };
    const mk = (enableBody: unknown) =>
      makeClient(withAccount({ tier: "pro" }, (req) => (req.method === "GET" ? jsonResponse(200, unentitled) : jsonResponse(200, enableBody)))).client;
    const expected = { tier: "pro" as const, would_charge: false, price_cents: null, interval: "month" as const };
    const run = (b: unknown) => field(runData(mk(b), NS, { action: "enable", accept_charge: true, expected }));
    expect(await run({ entitled: true, activating: true, charge: { interval: "weekly", price_cents: 100 } })).toMatch(/charge\.interval/);
    expect(await run({ entitled: true, activating: true, charge: { interval: "month", price_cents: "1" } })).toMatch(/charge\.price_cents/);
    expect(await run({ entitled: true, charge: null })).toMatch(/activating/);
    expect(await run({ entitled: false, activating: true, charge: null })).toMatch(/entitled/);
    expect(await run({ entitled: true, activating: false, charge: null })).toBe("ok"); // charge null: children skipped
  });

  it("test_F3_disable_requires_wipe_after_timestamp", async () => {
    expect(await field(runData(bad({ entitled: false }), NS, { action: "disable" }))).toMatch(/wipe_after/);
    expect(await field(runData(bad({ entitled: false, wipe_after: "soon" }), NS, { action: "disable" }))).toMatch(/wipe_after/);
  });

  it("test_F3_jwt_set_and_clear_reject_empty_object", async () => {
    const set = { action: "set" as const, issuer: "https://i", jwks_uri: "https://i/j", audience: "a", algorithms: ["ES256" as const] };
    expect(await field(runDataJwt(bad({}), NS, set))).toMatch(/jwt-issuer endpoint.*jwt_issuer/);
    expect(await field(runDataJwt(bad({}), NS, { action: "clear" }))).toMatch(/jwt_issuer/);
    expect(await field(runDataJwt(bad({ jwt_issuer: { issuer: "x" } }), NS, set))).toMatch(/jwt_issuer\.jwks_uri/);
    expect(await field(runDataJwt(bad({ jwt_issuer: null }), NS, { action: "clear" }))).toBe("ok");
  });

  it("test_F3_row_responses_create_and_put", async () => {
    const run = (b: unknown, a: "create" | "put") =>
      field(runDataRows(bad(b), NS, a === "create" ? { action: "create", collection: "votes", data: {} } : { action: "put", collection: "votes", id: "a", data: {} }));
    expect(await run({}, "create")).toMatch(/rows endpoint.*id/);
    expect(await run(mkRow({ id: "a/b" }), "put")).toMatch(/id/);
    expect(await run(mkRow({}, { kind: "admin" }), "create")).toMatch(/author\.kind/);
    expect(await run(mkRow({}, { subject: "" }), "create")).toMatch(/author\.subject/);
    expect(await run(mkRow({}, { label: 5 }), "create")).toMatch(/author\.label/);
    expect(await run(mkRow({ data: [] }), "put")).toMatch(/data/);
    expect(await run(mkRow({ created_at: "t" }), "put")).toMatch(/created_at/);
    expect(await run(mkRow({ updated_at: undefined }), "put")).toMatch(/updated_at/);
    expect(await run(mkRow({ archived_at: "x" }), "put")).toMatch(/archived_at/);
    expect(await run([], "create")).toMatch(/\(body\)/);
    // label is optional in the contract
    expect(await run(mkRow(), "create")).toBe("ok");
    expect(await run(mkRow({ archived_at: ts }), "put")).toBe("ok");
  });

  it("test_F3_row_list_validates_page_and_each_row", async () => {
    const run = (b: unknown) => field(runDataRows(bad(b), NS, { action: "list", collection: "votes" }));
    expect(await run([])).toMatch(/\(body\)/);
    expect(await run({ next_cursor: null })).toMatch(/rows endpoint.*rows/);
    expect(await run({ rows: [], next_cursor: 5 })).toMatch(/next_cursor/);
    expect(await run({ rows: [] })).toMatch(/next_cursor/);
    expect(await run({ rows: [mkRow(), mkRow({ created_at: 1 })], next_cursor: null })).toMatch(/rows\[1\]\.created_at/);
    expect(await run({ rows: [mkRow()], next_cursor: "c" })).toBe("ok");
    expect(await run({ rows: [], next_cursor: null })).toBe("ok");
  });
});
