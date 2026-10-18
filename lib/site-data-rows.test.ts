/**
 * DW-6.1: `data_rows` — list/archive/delete/create/put/import validation and
 * wire shapes, plus the streaming NDJSON export (multi-chunk, very large,
 * failure cleanup).
 */

import { describe, it, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDataRows } from "./site-data-rows.ts";
import type { ImportRow } from "./site-data-types.ts";
import { NS, jsonResponse, makeClient } from "../tests/helpers/site-data.ts";

const tmp = mkdtempSync(join(tmpdir(), "site-data-rows-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ROWS = `/api/ns/${NS.id}/data/collections/votes/rows`;
const row = { id: "a", author: { kind: "owner", subject: "u1" }, data: { n: 1 }, created_at: "2026-10-18T12:00:00.000Z", updated_at: "2026-10-18T12:00:00.000Z", archived_at: null };

describe("DW-6.1: data_rows list", () => {
  it("test_DW_6_1_rows_list_builds_query_with_encoding", async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { rows: [row], next_cursor: "c2" }));
    const r = await runDataRows(client, NS, {
      action: "list", collection: "votes", limit: 10, cursor: "abc==", author: "passcode:p 1", include_archived: true,
    });
    expect(r).toEqual({ action: "list", collection: "votes", rows: [row] as never, next_cursor: "c2" });
    expect(calls[0]!.path).toBe(`${ROWS}?limit=10&cursor=abc%3D%3D&author=passcode%3Ap+1&include_archived=true`);
  });

  it("test_DW_6_1_rows_list_without_filters_has_no_query", async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { rows: [], next_cursor: null }));
    await runDataRows(client, NS, { action: "list", collection: "votes" });
    expect(calls[0]!.path).toBe(ROWS);
  });

  it("test_DW_6_1_rows_list_include_archived_false_is_sent", async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { rows: [], next_cursor: null }));
    await runDataRows(client, NS, { action: "list", collection: "votes", include_archived: false });
    expect(calls[0]!.path).toBe(`${ROWS}?include_archived=false`);
  });

  it("test_DW_6_1_rows_list_rejects_bad_limit_and_collection", async () => {
    const { client, calls } = makeClient(() => undefined);
    for (const limit of [0, 101, 1.5]) {
      await expect(runDataRows(client, NS, { action: "list", collection: "votes", limit })).rejects.toThrow("limit must be an integer from 1 to 100");
    }
    await expect(runDataRows(client, NS, { action: "list", collection: "Bad Name" })).rejects.toThrow("Invalid collection name");
    await expect(runDataRows(client, NS, { action: "list" })).rejects.toThrow("collection is required when action is 'list'");
    expect(calls).toHaveLength(0);
  });

  it("test_DW_6_1_rows_list_collection_missing_and_not_enabled_errors", async () => {
    const a = makeClient(() => jsonResponse(404, { error: "x", code: "collection_not_found" }));
    await expect(runDataRows(a.client, NS, { action: "list", collection: "votes" })).rejects.toMatchObject({ code: "collection_not_found" });
    const b = makeClient(() => jsonResponse(402, { error: "x", code: "addon_not_enabled" }));
    await expect(runDataRows(b.client, NS, { action: "list", collection: "votes" })).rejects.toMatchObject({ code: "addon_not_enabled" });
    const c = makeClient(() => jsonResponse(502, { error: "x", code: "admin_channel_failed" }));
    await expect(runDataRows(c.client, NS, { action: "list", collection: "votes" })).rejects.toThrow("retry shortly");
  });
});

describe("DW-6.1: data_rows archive/delete/create/put", () => {
  it("test_DW_6_1_rows_archive_posts_empty_body", async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { archived: 3 }));
    expect(await runDataRows(client, NS, { action: "archive", collection: "votes" })).toEqual({ action: "archive", collection: "votes", archived: 3 });
    expect(calls[0]).toMatchObject({ method: "POST", path: `${ROWS.replace("/rows", "/archive")}`, body: {} });
  });

  it("test_DW_6_1_rows_delete_percent_encodes_author", async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { deleted: true }));
    await runDataRows(client, NS, { action: "delete", collection: "votes", id: "item-17", author: "jwt:https://i.example|sub 1" });
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.path).toBe(`${ROWS}/item-17?author=jwt%3Ahttps%3A%2F%2Fi.example%7Csub+1`);
  });

  it("test_DW_6_1_rows_delete_without_author_has_no_query", async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { deleted: true }));
    await runDataRows(client, NS, { action: "delete", collection: "votes", id: "x" });
    expect(calls[0]!.path).toBe(`${ROWS}/x`);
  });

  it("test_DW_6_6_rows_delete_archived_true_appends_archived_after_author", async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { deleted: true }));
    const res = await runDataRows(client, NS, { action: "delete", collection: "votes", id: "item-17", author: "passcode:p1", archived: true });
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.path).toBe(`${ROWS}/item-17?author=passcode%3Ap1&archived=true`);
    expect(res).toEqual({ action: "delete", collection: "votes", id: "item-17", archived: true });
  });

  it("test_DW_6_6_rows_delete_archived_true_without_author", async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { deleted: true }));
    await runDataRows(client, NS, { action: "delete", collection: "votes", id: "x", archived: true });
    expect(calls[0]!.path).toBe(`${ROWS}/x?archived=true`);
  });

  it("test_DW_6_6_rows_delete_archived_false_or_omitted_sends_no_param", async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { deleted: true }));
    await runDataRows(client, NS, { action: "delete", collection: "votes", id: "x", author: "owner:u", archived: false });
    await runDataRows(client, NS, { action: "delete", collection: "votes", id: "x", author: "owner:u" });
    expect(calls.map((c) => c.path)).toEqual([`${ROWS}/x?author=owner%3Au`, `${ROWS}/x?author=owner%3Au`]);
  });

  it("test_DW_6_1_rows_delete_rejects_path_traversal_and_bad_ids", async () => {
    const { client, calls } = makeClient(() => undefined);
    for (const id of ["..", ".", "a/b", "a%2Fb", "", "x".repeat(129)]) {
      await expect(runDataRows(client, NS, { action: "delete", collection: "votes", id })).rejects.toThrow("Invalid row id");
    }
    await expect(runDataRows(client, NS, { action: "delete", collection: "votes" })).rejects.toThrow("id is required when action is 'delete'");
    expect(calls).toHaveLength(0);
  });

  it("test_DW_6_1_rows_create_sends_data_directly_no_extra_fields", async () => {
    const { client, calls } = makeClient(() => jsonResponse(201, row));
    const r = await runDataRows(client, NS, { action: "create", collection: "votes", data: { title: "Hi" } });
    expect(r).toMatchObject({ action: "create", row: { id: "a" } });
    expect(calls[0]).toMatchObject({ method: "POST", path: ROWS, body: { data: { title: "Hi" } } });
  });

  it("test_DW_6_1_rows_create_and_put_require_data", async () => {
    const { client } = makeClient(() => undefined);
    await expect(runDataRows(client, NS, { action: "create", collection: "votes" })).rejects.toThrow("data is required when action is 'create'");
    await expect(runDataRows(client, NS, { action: "put", collection: "votes", id: "a" })).rejects.toThrow("data is required when action is 'put'");
    await expect(runDataRows(client, NS, { action: "put", collection: "votes", data: {} })).rejects.toThrow("id is required when action is 'put'");
  });

  it("test_DW_6_1_rows_put_by_id_and_server_limits_are_mapped", async () => {
    const ok = makeClient(() => jsonResponse(200, row));
    await runDataRows(ok.client, NS, { action: "put", collection: "votes", id: "a", data: { n: 2 } });
    expect(ok.calls[0]).toMatchObject({ method: "PUT", path: `${ROWS}/a`, body: { data: { n: 2 } } });
    for (const [status, code, hint] of [[409, "collection_full", "max_rows"], [413, "row_too_large", "max_row_bytes"]] as const) {
      const bad = makeClient(() => jsonResponse(status, { error: "x", code }));
      await expect(runDataRows(bad.client, NS, { action: "put", collection: "votes", id: "a", data: {} })).rejects.toThrow(hint);
    }
  });
});

describe("DW-6.1: data_rows import", () => {
  const imp = (id: string): ImportRow => ({ id, author: { kind: "passcode", subject: "p1", label: "her" }, data: { v: 1 }, created_at: "2026-10-18T12:00:00.000Z" });

  it("test_DW_6_1_rows_import_posts_rows_and_reports_counts", async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { imported: 2, skipped: 1 }));
    const rows = [imp("a"), imp("b"), imp("c")];
    expect(await runDataRows(client, NS, { action: "import", collection: "votes", rows })).toEqual({ action: "import", collection: "votes", imported: 2, skipped: 1 });
    expect(calls[0]).toMatchObject({ path: `${ROWS.replace("/rows", "/import")}`, body: { rows } });
  });

  it("test_DW_6_1_rows_import_enforces_row_count_bounds", async () => {
    const { client, calls } = makeClient(() => undefined);
    await expect(runDataRows(client, NS, { action: "import", collection: "votes", rows: [] })).rejects.toThrow("1 to 500 rows");
    const many = Array.from({ length: 501 }, (_, i) => imp(`r${i}`));
    await expect(runDataRows(client, NS, { action: "import", collection: "votes", rows: many })).rejects.toThrow("split larger imports");
    await expect(runDataRows(client, NS, { action: "import", collection: "votes" })).rejects.toThrow("rows is required when action is 'import'");
    expect(calls).toHaveLength(0);
  });

  it("test_DW_6_1_rows_import_accepts_exactly_500_and_rejects_bad_ids", async () => {
    const ok = makeClient(() => jsonResponse(200, { imported: 500, skipped: 0 }));
    const rows = Array.from({ length: 500 }, (_, i) => imp(`r${i}`));
    await runDataRows(ok.client, NS, { action: "import", collection: "votes", rows });
    const bad = makeClient(() => undefined);
    await expect(runDataRows(bad.client, NS, { action: "import", collection: "votes", rows: [imp("../x")] })).rejects.toThrow("Invalid row id");
  });

  it("test_DW_6_1_rows_import_over_max_rows_is_collection_full", async () => {
    const { client } = makeClient(() => jsonResponse(409, { error: "Import would exceed max_rows.", code: "collection_full" }));
    await expect(runDataRows(client, NS, { action: "import", collection: "votes", rows: [imp("a")] })).rejects.toThrow("[collection_full]");
  });

  it("test_DW_6_1_rows_import_is_owner_only_forbidden_names_owner", async () => {
    const { client } = makeClient(() => jsonResponse(403, { error: "no", code: "forbidden" }));
    await expect(runDataRows(client, NS, { action: "import", collection: "votes", rows: [imp("a")] })).rejects.toThrow("owner role");
  });
});

// ─── Export ──────────────────────────────────────────────────────────────────

const EXPORT_PATH = `/api/ns/${NS.id}/data/collections/votes/export`;
const enc = new TextEncoder();

/** A Response whose body is produced chunk by chunk; `.text()`/`.arrayBuffer()` throw to prove nothing buffers it. */
function streamingResponse(chunks: Iterable<string>, observe?: { pulled: number }): Response {
  const it = chunks[Symbol.iterator]();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const n = it.next();
      if (n.done) return controller.close();
      if (observe) observe.pulled++;
      controller.enqueue(enc.encode(n.value));
    },
  });
  const res = new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  for (const m of ["text", "json", "arrayBuffer", "blob"] as const) {
    Object.defineProperty(res, m, { value: () => { throw new Error(`export must stream, not call ${m}()`); } });
  }
  return res;
}

describe("DW-6.1: data_rows export (streamed)", () => {
  it("test_DW_6_1_export_writes_ndjson_and_counts_rows_across_split_chunks", async () => {
    const dest = join(tmp, "split.ndjson");
    // Lines split mid-row across chunks, including one split exactly at a newline.
    const { client } = makeClient(() => streamingResponse(['{"id":"a"}\n{"i', 'd":"b"}\n', '{"id":"c"}\n']));
    const r = await runDataRows(client, NS, { action: "export", collection: "votes", path: dest });
    expect(r).toEqual({ action: "export", collection: "votes", path: dest, rows: 3, bytes: 33 });
    expect(readFileSync(dest, "utf-8")).toBe('{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n');
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });

  it("test_DW_6_1_export_counts_final_line_without_trailing_newline", async () => {
    const dest = join(tmp, "nonl.ndjson");
    const { client } = makeClient(() => streamingResponse(['{"id":"a"}\n{"id":"b"}']));
    expect(await runDataRows(client, NS, { action: "export", collection: "votes", path: dest })).toMatchObject({ rows: 2 });
  });

  it("test_DW_6_1_export_empty_collection_writes_empty_file", async () => {
    const dest = join(tmp, "empty.ndjson");
    const { client } = makeClient(() => streamingResponse([]));
    expect(await runDataRows(client, NS, { action: "export", collection: "votes", path: dest })).toMatchObject({ rows: 0, bytes: 0 });
    expect(statSync(dest).size).toBe(0);
  });

  it("test_DW_6_1_export_streams_the_maximum_100000_rows_without_buffering", async () => {
    const dest = join(tmp, "big.ndjson");
    const observe = { pulled: 0 };
    const line = (i: number) => `{"id":"item-${i}","author":{"kind":"anonymous","subject":"${"x".repeat(40)}"},"data":{"val":${i}},"created_at":"2026-10-18T12:00:00.000Z","updated_at":"2026-10-18T12:00:00.000Z","archived_at":null}\n`;
    function* chunks() {
      for (let c = 0; c < 200; c++) {
        let s = "";
        for (let i = c * 500; i < (c + 1) * 500; i++) s += line(i);
        yield s;
      }
    }
    const { client } = makeClient(() => streamingResponse(chunks(), observe));
    const r = await runDataRows(client, NS, { action: "export", collection: "votes", path: dest });
    expect(r).toMatchObject({ rows: 100_000 });
    expect(observe.pulled).toBe(200);
    expect(statSync(dest).size).toBe((r as { bytes: number }).bytes);
    const text = readFileSync(dest, "utf-8");
    expect(text.split("\n")).toHaveLength(100_001); // 100k lines + trailing empty
    expect(text.startsWith('{"id":"item-0"')).toBe(true);
    expect(text.endsWith(line(99_999))).toBe(true);
  });

  it("test_DW_6_1_export_uses_get_with_bearer_to_export_route", async () => {
    const { client, calls } = makeClient(() => streamingResponse(["{}\n"]));
    await runDataRows(client, NS, { action: "export", collection: "votes", path: join(tmp, "req.ndjson") });
    expect(calls[0]).toMatchObject({ method: "GET", path: EXPORT_PATH });
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok");
  });

  it("test_DW_6_1_export_requires_path_and_valid_collection", async () => {
    const { client, calls } = makeClient(() => undefined);
    await expect(runDataRows(client, NS, { action: "export", collection: "votes" })).rejects.toThrow("path is required when action is 'export'");
    await expect(runDataRows(client, NS, { action: "export", collection: "..", path: "x" })).rejects.toThrow("Invalid collection name");
    expect(calls).toHaveLength(0);
  });

  it("test_DW_6_1_export_api_error_creates_no_file", async () => {
    const dest = join(tmp, "denied.ndjson");
    const { client } = makeClient(() => jsonResponse(403, { error: "no", code: "forbidden" }));
    await expect(runDataRows(client, NS, { action: "export", collection: "votes", path: dest })).rejects.toThrow("admin role");
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });

  it("test_DW_6_1_export_stream_failure_leaves_no_partial_and_keeps_existing_file", async () => {
    const dest = join(tmp, "keep.ndjson");
    writeFileSync(dest, "previous export\n");
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(enc.encode('{"id":"a"}\n')); return; }
        controller.error(new Error("connection reset"));
      },
    });
    const { client } = makeClient(() => new Response(body, { status: 200 }));
    await expect(runDataRows(client, NS, { action: "export", collection: "votes", path: dest, overwrite: true })).rejects.toThrow("connection reset");
    expect(readFileSync(dest, "utf-8")).toBe("previous export\n");
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });

  it("test_DW_6_4_export_rejects_other_extensions_before_any_request", async () => {
    for (const name of ["votes.txt", "votes", "votes.json", "votes.ndjson.bak", ".ssh-authorized_keys"]) {
      const { client, calls } = makeClient(() => streamingResponse(["{}\n"]));
      await expect(runDataRows(client, NS, { action: "export", collection: "votes", path: join(tmp, name) })).rejects.toThrow("must end in .ndjson or .jsonl");
      expect(calls).toHaveLength(0);
    }
  });

  it("test_DW_6_4_export_accepts_ndjson_and_jsonl_in_any_case", async () => {
    for (const name of ["a.ndjson", "b.jsonl", "c.NDJSON", "d.JsonL"]) {
      const { client } = makeClient(() => streamingResponse(["{}\n"]));
      expect(await runDataRows(client, NS, { action: "export", collection: "votes", path: join(tmp, name) })).toMatchObject({ rows: 1 });
    }
  });

  it("test_DW_6_4_export_refuses_existing_destination_without_overwrite_and_makes_no_request", async () => {
    const dest = join(tmp, "exists.ndjson");
    writeFileSync(dest, "precious\n");
    const { client, calls } = makeClient(() => streamingResponse(["{}\n"]));
    await expect(runDataRows(client, NS, { action: "export", collection: "votes", path: dest })).rejects.toThrow("already exists");
    await expect(runDataRows(client, NS, { action: "export", collection: "votes", path: dest, overwrite: false })).rejects.toThrow("overwrite: true");
    expect(calls).toHaveLength(0);
    expect(readFileSync(dest, "utf-8")).toBe("precious\n");
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });

  it("test_DW_6_4_export_refuses_a_dangling_symlink_destination", async () => {
    const dest = join(tmp, "link.ndjson");
    symlinkSync(join(tmp, "nowhere-target"), dest);
    const { client } = makeClient(() => streamingResponse(["{}\n"]));
    await expect(runDataRows(client, NS, { action: "export", collection: "votes", path: dest })).rejects.toThrow("already exists");
    expect(existsSync(join(tmp, "nowhere-target"))).toBe(false);
  });

  it("test_DW_6_4_export_overwrite_true_replaces_only_at_the_final_rename", async () => {
    const dest = join(tmp, "replace.ndjson");
    writeFileSync(dest, "old\n");
    const { client } = makeClient(() => streamingResponse(['{"id":"new"}\n']));
    await runDataRows(client, NS, { action: "export", collection: "votes", path: dest, overwrite: true });
    expect(readFileSync(dest, "utf-8")).toBe('{"id":"new"}\n');
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });

  it("test_DW_6_4_export_overwrite_failure_keeps_the_old_file", async () => {
    const dest = join(tmp, "replace-fail.ndjson");
    writeFileSync(dest, "old\n");
    const { client } = makeClient(() => new Response(new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("boom")); } }), { status: 200 }));
    await expect(runDataRows(client, NS, { action: "export", collection: "votes", path: dest, overwrite: true })).rejects.toThrow("boom");
    expect(readFileSync(dest, "utf-8")).toBe("old\n");
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });

  it("test_DW_6_4_export_pre_existing_partial_is_refused_even_with_overwrite_and_never_deleted", async () => {
    const dest = join(tmp, "busy.ndjson");
    writeFileSync(`${dest}.partial`, "someone else's data");
    for (const overwrite of [false, true]) {
      const { client, calls } = makeClient(() => streamingResponse(["{}\n"]));
      await expect(runDataRows(client, NS, { action: "export", collection: "votes", path: dest, overwrite })).rejects.toThrow(
        "a previous export may be running or failed; remove",
      );
      expect(calls).toHaveLength(0);
      expect(readFileSync(`${dest}.partial`, "utf-8")).toBe("someone else's data");
    }
    expect(existsSync(dest)).toBe(false);
  });

  it("test_DW_6_4_export_pre_existing_partial_dangling_symlink_is_refused_not_followed", async () => {
    const dest = join(tmp, "symp.ndjson");
    symlinkSync(join(tmp, "victim-file"), `${dest}.partial`);
    const { client } = makeClient(() => streamingResponse(["{}\n"]));
    await expect(runDataRows(client, NS, { action: "export", collection: "votes", path: dest })).rejects.toThrow("remove");
    expect(existsSync(join(tmp, "victim-file"))).toBe(false);
  });

  it("test_DW_6_4_export_partial_appearing_after_the_check_is_not_deleted", async () => {
    const dest = join(tmp, "race.ndjson");
    // The partial appears while the request is in flight (after the pre-check, before the exclusive open).
    const { client } = makeClient(() => {
      writeFileSync(`${dest}.partial`, "raced");
      return streamingResponse(["{}\n"]);
    });
    await expect(runDataRows(client, NS, { action: "export", collection: "votes", path: dest })).rejects.toThrow("remove");
    expect(readFileSync(`${dest}.partial`, "utf-8")).toBe("raced");
    expect(existsSync(dest)).toBe(false);
  });

  it("test_DW_6_4_export_destination_appearing_during_export_is_not_clobbered_without_overwrite", async () => {
    const dest = join(tmp, "late.ndjson");
    // The destination appears while the request is in flight (after the pre-check).
    const { client } = makeClient(() => {
      writeFileSync(dest, "appeared");
      return streamingResponse(["{}\n"]);
    });
    await expect(runDataRows(client, NS, { action: "export", collection: "votes", path: dest })).rejects.toThrow("appeared during the export");
    expect(readFileSync(dest, "utf-8")).toBe("appeared");
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });

  it("test_DW_6_4_export_file_mode_is_0600", async () => {
    const dest = join(tmp, "mode.ndjson");
    const { client } = makeClient(() => streamingResponse(["{}\n"]));
    await runDataRows(client, NS, { action: "export", collection: "votes", path: dest });
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    const over = join(tmp, "mode2.ndjson");
    writeFileSync(over, "x", { mode: 0o644 });
    await runDataRows(client, NS, { action: "export", collection: "votes", path: over, overwrite: true });
    expect(statSync(over).mode & 0o777).toBe(0o600);
  });

  it("test_DW_6_1_export_unwritable_destination_fails_cleanly", async () => {
    const { client } = makeClient(() => streamingResponse(["{}\n"]));
    await expect(
      runDataRows(client, NS, { action: "export", collection: "votes", path: join(tmp, "no-such-dir", "x.ndjson") }),
    ).rejects.toThrow();
  });

  it("test_DW_6_1_export_response_without_body_is_an_error", async () => {
    const { client } = makeClient(() => new Response(null, { status: 204 }));
    await expect(runDataRows(client, NS, { action: "export", collection: "votes", path: join(tmp, "nobody.ndjson") })).rejects.toThrow("no body");
  });
});
