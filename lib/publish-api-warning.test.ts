/**
 * DW-6.1: publish warns (never blocks) when the manifest has files under an
 * `_api` path segment at any depth, because `{site}/_api/*` belongs to the
 * site's backend and would shadow them. Mirrors the `_data` warning.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ApiClient } from "./api-client.ts";
import { classifyFilenames, publish, renderFilenameWarning } from "./publish.ts";

describe("classifyFilenames: reserved _api bucket", () => {
  it("test_DW_6_1_api_segment_at_any_depth_and_any_case", () => {
    const r = classifyFilenames(["_api/x.json", "_API/y", "a/_Api/z/w.json", "a/b/_api", "index.html"]);
    expect(r.reservedApi).toEqual(["_api/x.json", "_API/y", "a/_Api/z/w.json", "a/b/_api"]);
  });

  it("lookalikes are not flagged: api, my-api, _apix, x_api, _api.json", () => {
    const r = classifyFilenames(["api/x", "my-api/x", "_apix/x", "x_api/y", "a/_api.json", "docs/api/index.html"]);
    expect("reservedApi" in r).toBe(false);
    expect(r).toEqual({ fragile: [], fyi: [] });
  });

  it("is independent of the _data bucket", () => {
    const r = classifyFilenames(["_data/a", "_api/b"]);
    expect(r.reserved).toEqual(["_data/a"]);
    expect(r.reservedApi).toEqual(["_api/b"]);
  });
});

describe("renderFilenameWarning: _api", () => {
  it("test_DW_6_1_warns_that_the_files_will_not_be_served", () => {
    const t = renderFilenameWarning(classifyFilenames(["docs/_api/x.html", "index.html"]));
    expect(t).toContain("1 file(s) have an '_api' path segment");
    expect(t).toContain("docs/_api/x.html");
    expect(t).toContain("reserved for the site's backend");
    expect(t).toContain("will NOT be served");
  });

  it("summarizes a long list", () => {
    const paths = Array.from({ length: 12 }, (_, i) => `_api/f${i}.json`);
    expect(renderFilenameWarning(classifyFilenames(paths))).toContain("…and 2 more");
  });

  it("renders an _api-only classification (no other buckets)", () => {
    expect(renderFilenameWarning({ fragile: [], fyi: [], reservedApi: ["_api/x"] })).toContain("'_api' path segment");
  });
});

describe("publish(): _api warning wiring", () => {
  const SITE = {
    id: "uuid-1", user_id: "u", slug: "my-site", title: "T", created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z", file_count: 1, total_size: 1, visibility: "public" as const, passcode_hash: null,
  };
  const fetchFn = async (url: string, init?: RequestInit) => {
    const json = { status: 200, headers: { "Content-Type": "application/json" } };
    if (url.includes("/manifest")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { files: Record<string, unknown> };
      const needed = Object.keys(body.files).map((p) => ({ path: p, upload_url: `https://r2.example.com/${encodeURIComponent(p)}` }));
      return new Response(JSON.stringify({ needed, version: 1, session_id: "s", base_version: null }), json);
    }
    if (url.includes("r2.example.com")) return new Response("", { status: 200 });
    if (url.includes("/finalize")) return new Response(JSON.stringify({ site: SITE, url: "https://u.upubli.sh/my-site/" }), json);
    return new Response("nf", { status: 404 });
  };

  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "upublish-apidir-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function run(files: Record<string, string>) {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    return publish({ apiClient: new ApiClient("https://api.test", async () => "t", fetchFn), nsId: "ns", directory: dir, slug: "my-site", fetchFn });
  }

  it("test_DW_6_1_publish_with_an_api_dir_succeeds_uploads_it_and_warns", async () => {
    const r = await run({ "index.html": "hi", "docs/_api/x.html": "x" });
    expect(r.uploadedFiles).toContain("docs/_api/x.html"); // warn-only, still published
    expect(r.filenameWarnings?.reservedApi).toEqual(["docs/_api/x.html"]);
    expect(renderFilenameWarning(r.filenameWarnings)).toContain("'_api'");
  });

  it("test_DW_6_1_publish_without_an_api_segment_has_no_warnings_field", async () => {
    const r = await run({ "index.html": "hi", "api/x.json": "[]", "_apix/y.json": "[]" });
    expect(r.filenameWarnings).toBeUndefined();
  });
});
