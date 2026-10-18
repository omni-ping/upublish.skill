/**
 * DW-6.1: publish warns (never blocks) when the manifest has files under a
 * `_data` at any depth directory, because the site data add-on's `/_data`
 * intercept would shadow them. Mirrors the filename-warning wiring.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { publish, classifyFilenames, renderFilenameWarning } from "./publish.ts";
import { ApiClient } from "./api-client.ts";

const SITE = {
  id: "uuid-1", user_id: "u", slug: "my-site", title: "T", created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z", file_count: 1, total_size: 1, visibility: "public" as const, passcode_hash: null,
};

function publishFetch() {
  return async (url: string, init?: RequestInit) => {
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
}

describe("classifyFilenames: reserved _data bucket", () => {
  it("test_DW_6_1_reserved_top_level_data_dir_any_case", () => {
    const r = classifyFilenames(["_data/votes.json", "_DATA/x.json", "_Data/sub/y.json", "index.html"]);
    expect(r.reserved).toEqual(["_data/votes.json", "_DATA/x.json", "_Data/sub/y.json"]);
  });

  it("test_DW_6_3_reserved_matches_a_data_segment_at_any_depth_any_case", () => {
    const r = classifyFilenames(["a/_data/x.json", "a/b/_DATA/y", "a/b/c/_Data/z/w.json", "index.html"]);
    expect(r.reserved).toEqual(["a/_data/x.json", "a/b/_DATA/y", "a/b/c/_Data/z/w.json"]);
  });

  it("test_DW_6_3_reserved_nested_file_named_data_is_shadowed_like_a_top_level_one", () => {
    expect(classifyFilenames(["a/_data", "a/b/_DATA"]).reserved).toEqual(["a/_data", "a/b/_DATA"]);
  });

  it("test_DW_6_3_reserved_ignores_lookalike_names", () => {
    const r = classifyFilenames(["my_data/x", "_data.json", "data/x", "a/_data.json", "my-data/x.json", "_data2/x.json", "x_data.json", "a/x_data/y"]);
    expect(r.reserved).toBeUndefined();
    expect("reserved" in r).toBe(false); // key omitted so existing { fragile, fyi } equality holds
  });

  it("test_DW_6_1_reserved_top_level_file_named_data_is_also_shadowed", () => {
    expect(classifyFilenames(["_data"]).reserved).toEqual(["_data"]);
  });

  it("test_DW_6_1_reserved_is_independent_of_fragile_and_fyi", () => {
    const r = classifyFilenames(["_data/a#b.json"]);
    expect(r.reserved).toEqual(["_data/a#b.json"]);
    expect(r.fragile).toEqual(["_data/a#b.json"]);
  });
});

describe("renderFilenameWarning: reserved _data", () => {
  it("test_DW_6_1_render_reserved_warning_text_and_cap", () => {
    const out = renderFilenameWarning({ fragile: [], fyi: [], reserved: ["_data/a.json"] });
    expect(out).toContain("Warning: 1 file(s) have a '_data' path segment (a '_data' directory at any depth is reserved): _data/a.json");
    expect(out).not.toContain("top-level");
    expect(out).toContain("will NOT be served");
    const many = Array.from({ length: 12 }, (_, i) => `_data/${i}.json`);
    expect(renderFilenameWarning({ fragile: [], fyi: [], reserved: many })).toContain("…and 2 more");
  });

  it("test_DW_6_1_render_reserved_alone_is_not_empty", () => {
    expect(renderFilenameWarning({ fragile: [], fyi: [], reserved: ["_data/a"] })).not.toBe("");
    expect(renderFilenameWarning({ fragile: [], fyi: [] })).toBe("");
  });
});

describe("publish(): _data warning wiring", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "upublish-datadir-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function run(files: Record<string, string>) {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    const fetchFn = publishFetch();
    return publish({ apiClient: new ApiClient("https://api.test", async () => "t", fetchFn), nsId: "ns", directory: dir, slug: "my-site", fetchFn });
  }

  it("test_DW_6_1_publish_with_data_dir_succeeds_uploads_it_and_warns", async () => {
    const r = await run({ "index.html": "hi", "_data/votes.json": "[]" });
    expect(r.url).toBe("https://u.upubli.sh/my-site/");
    expect(r.uploadedFiles).toContain("_data/votes.json"); // not skipped
    expect(r.filenameWarnings?.reserved).toEqual(["_data/votes.json"]);
    expect(renderFilenameWarning(r.filenameWarnings)).toContain("'_data'");
  });

  it("test_DW_6_3_publish_with_nested_data_dir_succeeds_uploads_it_and_warns", async () => {
    const r = await run({ "index.html": "hi", "assets/_data/x.json": "[]" });
    expect(r.uploadedFiles).toContain("assets/_data/x.json"); // warn-only, still published
    expect(r.filenameWarnings?.reserved).toEqual(["assets/_data/x.json"]);
    expect(renderFilenameWarning(r.filenameWarnings)).toContain("assets/_data/x.json");
  });

  it("test_DW_6_1_publish_without_data_dir_has_no_warnings_field", async () => {
    const r = await run({ "index.html": "hi", "assets/my_data/x.json": "[]", "_data.json": "[]" });
    expect(r.filenameWarnings).toBeUndefined();
  });
});
