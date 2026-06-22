/**
 * Phase 2: Skill/MCP — publish-time filename warning.
 *
 * Covers the pure classifier (`classifyFilenames`), the render helper
 * (`renderFilenameWarning`), and the full-publish wiring that attaches
 * `filenameWarnings` to the result and surfaces it through the existing channel.
 *
 * The platform worker now decodes percent-encoded request paths, so spaces and
 * non-ASCII names SERVE fine — the FYI bucket is informational, never "broken".
 * `#`, `?`, and control chars stay URL-fragile regardless → the fragile bucket.
 * This feature is WARN-ONLY: it never blocks a publish and never renames a file.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  publish,
  classifyFilenames,
  renderFilenameWarning,
} from "./publish.ts";
import type { PublishOpts, FilenameWarnings } from "./publish.ts";
import { ApiClient } from "./api-client.ts";
// Re-export reachability (hexagonal): adapters import these from core.ts only.
import {
  renderFilenameWarning as renderFromCore,
} from "./core.ts";
import type { FilenameWarnings as FilenameWarningsFromCore } from "./core.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const BASE_URL = "https://api.example.com";
const staticTokenProvider = async () => "test-token";

const SAMPLE_SITE = {
  id: "uuid-1",
  user_id: "user-1",
  slug: "my-site",
  title: "My Site",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  file_count: 1,
  total_size: 10,
  visibility: "public" as const,
  passcode_hash: null,
};
const SAMPLE_URL = "https://testuser.upubli.sh/my-site/";

/**
 * Mock fetch that drives a full publish to success: every file is "needed",
 * presigned PUTs succeed, finalize returns the sample site. Records the manifest
 * paths the server actually received so tests can assert paths are sent verbatim.
 */
function makePublishFetch(sentPaths: { value: string[] }) {
  return async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/manifest")) {
      // Wire format: files is a Record<path, {hash, size}>, not an array.
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        files: Record<string, { hash: string; size: number }>;
      };
      const paths = Object.keys(body.files);
      sentPaths.value = paths;
      return new Response(
        JSON.stringify({
          needed: paths.map((p) => ({
            path: p,
            upload_url: `https://r2.example.com/${encodeURIComponent(p)}`,
          })),
          version: 1,
          session_id: "sess-1",
          base_version: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("r2.example.com") && method === "PUT") {
      return new Response("", { status: 200 });
    }
    if (url.includes("/finalize")) {
      return new Response(
        JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("Not found", { status: 404 });
  };
}

/** Publishes `files` (relPath → contents) from a temp dir and returns the result. */
async function publishTree(
  tmpDir: string,
  files: Record<string, string>,
  sentPaths: { value: string[] },
) {
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(tmpDir, name), contents);
  }
  const fetchFn = makePublishFetch(sentPaths);
  const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
  const opts: PublishOpts = {
    apiClient,
    nsId: "ns-1",
    directory: tmpDir,
    slug: "my-site",
    fetchFn,
  };
  return publish(opts);
}

// ─── classifyFilenames (pure classifier) ─────────────────────────────────────

describe("classifyFilenames — DW-2.1 fragile bucket", () => {
  it("test_DW_2_1_hash_named_file_flagged_fragile", () => {
    const r = classifyFilenames(["a#b.html"]);
    expect(r.fragile).toEqual(["a#b.html"]);
    expect(r.fyi).toEqual([]);
  });

  it("test_DW_2_1_question_named_file_flagged_fragile", () => {
    const r = classifyFilenames(["faq?.html"]);
    expect(r.fragile).toEqual(["faq?.html"]);
    expect(r.fyi).toEqual([]);
  });

  it("test_DW_2_1_control_char_tab_flagged_fragile", () => {
    const r = classifyFilenames(["weird\tname.txt"]);
    expect(r.fragile).toEqual(["weird\tname.txt"]);
    expect(r.fyi).toEqual([]);
  });

  it("test_DW_2_1_del_char_0x7f_flagged_fragile", () => {
    const r = classifyFilenames(["bad\x7f.txt"]);
    expect(r.fragile).toEqual(["bad\x7f.txt"]);
  });

  it("test_DW_2_1_null_byte_0x00_flagged_fragile", () => {
    const r = classifyFilenames(["nul\x00.txt"]);
    expect(r.fragile).toEqual(["nul\x00.txt"]);
  });
});

describe("classifyFilenames — DW-2.2 fyi bucket", () => {
  it("test_DW_2_2_space_named_file_flagged_fyi", () => {
    const r = classifyFilenames(["my file.pdf"]);
    expect(r.fyi).toEqual(["my file.pdf"]);
    expect(r.fragile).toEqual([]);
  });

  it("test_DW_2_2_non_ascii_file_flagged_fyi", () => {
    const r = classifyFilenames(["café.png"]);
    expect(r.fyi).toEqual(["café.png"]);
    expect(r.fragile).toEqual([]);
  });

  it("test_DW_2_2_astral_unicode_flagged_fyi", () => {
    // Emoji (astral plane, codepoint > 0xFFFF) must count as non-ASCII.
    const r = classifyFilenames(["party🎉.html"]);
    expect(r.fyi).toEqual(["party🎉.html"]);
    expect(r.fragile).toEqual([]);
  });

  it("test_DW_2_2_fyi_distinct_from_fragile_bucket", () => {
    // Distinct files land in distinct buckets — never merged.
    const r = classifyFilenames(["frag#ile.html", "spa ce.html", "café.txt"]);
    expect(r.fragile).toEqual(["frag#ile.html"]);
    expect(r.fyi).toEqual(["spa ce.html", "café.txt"]);
  });
});

describe("classifyFilenames — DW-2.3 precedence (fragile wins, once)", () => {
  it("test_DW_2_3_fragile_and_space_reported_once_in_fragile", () => {
    const r = classifyFilenames(["my #file.html"]);
    expect(r.fragile).toEqual(["my #file.html"]);
    expect(r.fyi).toEqual([]);
  });

  it("test_DW_2_3_not_double_counted", () => {
    // Name has BOTH a fragile char and non-ASCII + space → appears exactly once.
    const name = "café ?notes.html";
    const r = classifyFilenames([name]);
    const total = r.fragile.length + r.fyi.length;
    expect(total).toBe(1);
    expect(r.fragile).toEqual([name]);
  });

  it("test_DW_2_3_fragile_char_after_space_still_fragile", () => {
    // The space appears before the '#'; precedence must still pick fragile.
    const r = classifyFilenames(["a b#c.html"]);
    expect(r.fragile).toEqual(["a b#c.html"]);
    expect(r.fyi).toEqual([]);
  });
});

describe("classifyFilenames — DW-2.4 clean tree & separators", () => {
  it("test_DW_2_4_clean_tree_no_filename_warnings", () => {
    const r = classifyFilenames(["index.html", "assets/app.js", "style.css"]);
    expect(r.fragile).toEqual([]);
    expect(r.fyi).toEqual([]);
  });

  it("test_DW_2_4_path_separators_never_flagged", () => {
    // The '/' separators and normal nested dirs must never qualify a path.
    const r = classifyFilenames(["a/b/c/deep-file_1.html"]);
    expect(r.fragile).toEqual([]);
    expect(r.fyi).toEqual([]);
  });

  it("test_DW_2_4_unicode_in_dir_not_basename_not_flagged", () => {
    // Classification is by BASENAME: a non-ASCII directory with a clean filename
    // is NOT flagged (only the served filename matters for the URL hint).
    const r = classifyFilenames(["café/index.html"]);
    expect(r.fragile).toEqual([]);
    expect(r.fyi).toEqual([]);
  });

  it("test_DW_2_4_empty_input_returns_empty_buckets", () => {
    const r = classifyFilenames([]);
    expect(r).toEqual({ fragile: [], fyi: [] });
  });
});

describe("classifyFilenames — DW-2.6 purity (no mutation)", () => {
  it("test_DW_2_6_classifier_does_not_mutate_paths", () => {
    const input = ["a#b.html", "my file.pdf", "clean.html"];
    const snapshot = [...input];
    classifyFilenames(input);
    expect(input).toEqual(snapshot);
  });
});

// ─── renderFilenameWarning (output formatting) ───────────────────────────────

describe("renderFilenameWarning — DW-2.5 distinct, honest, capped output", () => {
  it("test_DW_2_5_render_helper_formats_buckets", () => {
    const out = renderFilenameWarning({
      fragile: ["a#b.html"],
      fyi: ["café.png"],
    });
    // Fragile and FYI are visually distinct lines.
    expect(out).toContain("Warning:");
    expect(out).toContain("a#b.html");
    expect(out).toContain("may not be reachable by URL");
    expect(out).toContain("FYI:");
    expect(out).toContain("café.png");
    // Honest wording for FYI — served fine, NOT "broken".
    expect(out).toContain("simple names are safest");
    expect(out.toLowerCase()).not.toContain("broken");
  });

  it("test_DW_2_5_empty_buckets_render_empty_string", () => {
    expect(renderFilenameWarning({ fragile: [], fyi: [] })).toBe("");
  });

  it("test_DW_2_5_undefined_renders_empty_string", () => {
    expect(renderFilenameWarning(undefined)).toBe("");
  });

  it("test_DW_2_5_only_fragile_omits_fyi_section", () => {
    const out = renderFilenameWarning({ fragile: ["a#b.html"], fyi: [] });
    expect(out).toContain("Warning:");
    expect(out).not.toContain("FYI:");
  });

  it("test_DW_2_5_only_fyi_omits_fragile_section", () => {
    const out = renderFilenameWarning({ fragile: [], fyi: ["my file.pdf"] });
    expect(out).toContain("FYI:");
    expect(out).not.toContain("Warning:");
  });

  it("test_DW_2_5_large_list_is_capped_and_summarized", () => {
    // 15 fragile files → list caps at 10, summarizes "…and 5 more".
    const many = Array.from({ length: 15 }, (_, i) => `f${i}#x.html`);
    const out = renderFilenameWarning({ fragile: many, fyi: [] });
    expect(out).toContain("…and 5 more");
    // The count in the header still reflects the true total.
    expect(out).toContain("15 file(s)");
    // The 11th name onward is not spelled out.
    expect(out).not.toContain("f14#x.html");
  });
});

describe("renderFilenameWarning — re-export reachability (hexagonal)", () => {
  it("test_render_helper_reachable_from_core", () => {
    // Adapters import only from core.ts — the helper must be re-exported there
    // and behave identically to the lib export.
    const fw: FilenameWarningsFromCore = { fragile: ["a#b.html"], fyi: [] };
    expect(renderFromCore(fw)).toBe(renderFilenameWarning(fw));
  });
});

// ─── Full-publish wiring (warn-and-continue through the result) ───────────────

describe("publish() filename warnings — DW-2.1/2.2/2.4/2.5/2.6 wiring", () => {
  let tmpDir: string;
  let sentPaths: { value: string[] };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-fnwarn-"));
    sentPaths = { value: [] };
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_2_1_publish_succeeds_with_fragile_warning", async () => {
    const result = await publishTree(
      tmpDir,
      { "index.html": "<h1>hi</h1>", "a#b.html": "x" },
      sentPaths,
    );
    // Publish still succeeded (DW-2.1: non-blocking).
    expect(result.url).toBe(SAMPLE_URL);
    expect(result.site).toBeDefined();
    // The fragile file is named in the warning channel.
    expect(result.filenameWarnings).toBeDefined();
    expect(result.filenameWarnings!.fragile).toContain("a#b.html");
  });

  it("test_DW_2_2_publish_succeeds_with_fyi_note", async () => {
    const result = await publishTree(
      tmpDir,
      { "index.html": "<h1>hi</h1>", "my file.pdf": "x", "café.png": "y" },
      sentPaths,
    );
    expect(result.url).toBe(SAMPLE_URL);
    // FYI bucket distinct from fragile (which is empty here).
    expect(result.filenameWarnings).toBeDefined();
    expect(result.filenameWarnings!.fyi).toContain("my file.pdf");
    expect(result.filenameWarnings!.fyi).toContain("café.png");
    expect(result.filenameWarnings!.fragile).toEqual([]);
  });

  it("test_DW_2_3_publish_both_chars_reported_once_fragile", async () => {
    const result = await publishTree(
      tmpDir,
      { "index.html": "<h1>hi</h1>", "my #doc.html": "x" },
      sentPaths,
    );
    expect(result.filenameWarnings!.fragile).toEqual(["my #doc.html"]);
    expect(result.filenameWarnings!.fyi).toEqual([]);
  });

  it("test_DW_2_4_clean_publish_omits_filename_warning_field", async () => {
    const result = await publishTree(
      tmpDir,
      { "index.html": "<h1>hi</h1>", "style.css": "body{}" },
      sentPaths,
    );
    // Clean tree → field absent (no new warning).
    expect(result.filenameWarnings).toBeUndefined();
  });

  it("test_DW_2_4_existing_suspicious_warnings_unchanged", async () => {
    // A clean-named-but-suspicious file (nginx.conf) still flows through the
    // separate `warnings` channel, untouched by the filename feature.
    const result = await publishTree(
      tmpDir,
      { "index.html": "<h1>hi</h1>", "nginx.conf": "server {}" },
      sentPaths,
    );
    expect(result.warnings).toContain("nginx.conf");
    // And the suspicious file is not clean-name fragile/fyi → field absent.
    expect(result.filenameWarnings).toBeUndefined();
  });

  it("test_DW_2_5_filename_warning_present_in_publish_result_shape", async () => {
    // The warning rides on PublishResult.filenameWarnings — the exact shape the
    // mcp adapter renders via renderFilenameWarning in its existing result block.
    const result = await publishTree(
      tmpDir,
      { "index.html": "<h1>hi</h1>", "a#b.html": "x", "café.png": "y" },
      sentPaths,
    );
    const rendered = renderFilenameWarning(result.filenameWarnings);
    expect(rendered).toContain("a#b.html");
    expect(rendered).toContain("café.png");
    expect(rendered).toContain("Warning:");
    expect(rendered).toContain("FYI:");
  });

  it("test_DW_2_6_fragile_publish_not_blocked_returns_result", async () => {
    // Even an all-fragile tree publishes successfully — never rejected.
    const result = await publishTree(
      tmpDir,
      { "a#b.html": "x", "c?d.html": "y" },
      sentPaths,
    );
    expect(result.url).toBe(SAMPLE_URL);
    expect(result.filenameWarnings!.fragile.sort()).toEqual(
      ["a#b.html", "c?d.html"].sort(),
    );
  });

  it("test_DW_2_6_manifest_paths_sent_verbatim", async () => {
    // The feature must not rename files: the paths the server receives are the
    // literal on-disk names, unchanged by classification.
    await publishTree(
      tmpDir,
      { "index.html": "<h1>hi</h1>", "my file.pdf": "x", "a#b.html": "y" },
      sentPaths,
    );
    expect(sentPaths.value.sort()).toEqual(
      ["index.html", "my file.pdf", "a#b.html"].sort(),
    );
  });
});
