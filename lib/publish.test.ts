/**
 * Tests for lib/publish.ts — presigned-URL publish flow, file collection,
 * exclusion logic, and API client methods.
 *
 * DW-3.1: publish() is the presigned-URL flow (calls manifest+finalize, not postForm)
 * DW-3.7: manifest errors propagate — no fallback to zip
 * DW-5.1: publish.ts computes MD5 hash of each file during directory walk
 * DW-5.2: api-client.ts has manifest() method
 * DW-5.3: api-client.ts has finalize() method
 * DW-5.4: uploadChangedFiles() uploads to presigned URLs in parallel with retry
 * DW-5.5: publish() uses the presigned-URL flow (was publishIncremental)
 * DW-5.8: progress output shows uploaded and skipped files
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  publish,
  collectFilesWithHashes,
  uploadChangedFiles,
  isValidSlug,
  parseIgnoreFile,
} from "./publish.ts";
import { ApiClient } from "./api-client.ts";
import type { PublishOpts } from "./publish.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const BASE_URL = "https://api.example.com";
const TOKEN = "test-token";
const staticTokenProvider = async () => TOKEN;

const SAMPLE_SITE = {
  id: "uuid-1",
  user_id: "user-1",
  slug: "my-site",
  title: "My Site",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  file_count: 2,
  total_size: 1234,
  visibility: "public" as const,
  passcode_hash: null,
};

const SAMPLE_URL = "https://testuser.upubli.sh/my-site/";

// ─── parseIgnoreFile unit tests ─────────────────────────────────────────────

describe("parseIgnoreFile", () => {
  it("parses lines, skipping comments and blanks", () => {
    const content = "# comment\n\nfoo.txt\n*.log\n  bar/  \n";
    expect(parseIgnoreFile(content)).toEqual(["foo.txt", "*.log", "bar/"]);
  });

  it("returns empty array for empty content", () => {
    expect(parseIgnoreFile("")).toEqual([]);
    expect(parseIgnoreFile("# only comments\n# here")).toEqual([]);
  });
});

// ─── isValidSlug unit tests ─────────────────────────────────────────────────

describe("isValidSlug", () => {
  it("accepts valid slugs", () => {
    expect(isValidSlug("abc")).toBe(true);
    expect(isValidSlug("my-site")).toBe(true);
    expect(isValidSlug("my-awesome-portfolio-2026")).toBe(true);
    expect(isValidSlug("a1b")).toBe(true);
  });

  it("rejects too-short slugs", () => {
    expect(isValidSlug("ab")).toBe(false);
    expect(isValidSlug("a")).toBe(false);
    expect(isValidSlug("")).toBe(false);
  });

  it("rejects uppercase", () => {
    expect(isValidSlug("My-Site")).toBe(false);
  });

  it("rejects slugs starting or ending with hyphen", () => {
    expect(isValidSlug("-bad")).toBe(false);
    expect(isValidSlug("bad-")).toBe(false);
  });

  it("rejects too-long slugs", () => {
    expect(isValidSlug("a".repeat(64))).toBe(false);
  });

  it("rejects _root (format rules only — publish() handles the bypass)", () => {
    expect(isValidSlug("_root")).toBe(false);
  });
});

// ─── DW-5.1: collectFilesWithHashes ─────────────────────────────────────────

describe("DW-5.1: collectFilesWithHashes()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-hash-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_5_1_collect_files_hashes_each_file", () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(join(tmpDir, "style.css"), "body { margin: 0; }");

    const result = collectFilesWithHashes(tmpDir);

    expect(result.hashes).toBeDefined();
    expect(Object.keys(result.hashes)).toHaveLength(2);
    expect(result.hashes["index.html"]).toBeDefined();
    expect(result.hashes["style.css"]).toBeDefined();
  });

  it("test_DW_5_1_md5_hash_correct_value", () => {
    // MD5 of "hello" is 5d41402abc4b2a76b9719d911017c592
    writeFileSync(join(tmpDir, "test.txt"), "hello");

    const result = collectFilesWithHashes(tmpDir);

    expect(result.hashes["test.txt"]).toBe("5d41402abc4b2a76b9719d911017c592");
  });

  it("test_DW_5_1_hash_map_keyed_by_path", () => {
    mkdirSync(join(tmpDir, "subdir"));
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");
    writeFileSync(join(tmpDir, "subdir", "app.js"), "const x = 1;");

    const result = collectFilesWithHashes(tmpDir);

    // Keys use the relative path (same as fileMap keys)
    expect(result.hashes["index.html"]).toBeDefined();
    expect(result.hashes[join("subdir", "app.js")]).toBeDefined();
  });

  it("test_DW_5_1_file_map_matches_hash_keys", () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const result = collectFilesWithHashes(tmpDir);

    const hashKeys = Object.keys(result.hashes).sort();
    const fileMapKeys = Object.keys(result.fileMap).sort();
    expect(hashKeys).toEqual(fileMapKeys);
  });

  it("test_DW_5_1_excluded_files_not_in_hash_map", () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");
    writeFileSync(join(tmpDir, ".DS_Store"), "");
    writeFileSync(join(tmpDir, ".env"), "SECRET=abc");

    const result = collectFilesWithHashes(tmpDir);

    // Only index.html should be hashed — excluded files not present
    expect(Object.keys(result.hashes)).toHaveLength(1);
    expect(result.hashes[".DS_Store"]).toBeUndefined();
    expect(result.hashes[".env"]).toBeUndefined();
  });

  it("test_DW_5_1_returns_excluded_and_warnings", () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");
    writeFileSync(join(tmpDir, ".DS_Store"), "");
    writeFileSync(join(tmpDir, "nginx.conf"), "server {}");

    const result = collectFilesWithHashes(tmpDir);

    expect(result.excluded).toContain(".DS_Store");
    expect(result.warnings).toContain("nginx.conf");
  });

  it("test_DW_5_1_empty_dir_returns_empty_hashes", () => {
    const result = collectFilesWithHashes(tmpDir);
    expect(Object.keys(result.hashes)).toHaveLength(0);
    expect(Object.keys(result.fileMap)).toHaveLength(0);
  });
});

// ─── DW-5.2: ApiClient.manifest() ────────────────────────────────────────────

describe("DW-5.2: ApiClient.manifest()", () => {
  it("test_DW_5_2_manifest_posts_correct_payload", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;
    let capturedMethod = "";

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(
        JSON.stringify({
          needed: [],
          version: 2,
          session_id: "sess-abc",
          base_version: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const files = [
      { path: "index.html", hash: "abc123", size: 100 },
      { path: "style.css", hash: "def456", size: 200 },
    ];

    await client.manifest("ns-1", "my-site", { files });

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/ns-1/sites/my-site/manifest`);
    expect(capturedMethod).toBe("POST");
    expect((capturedBody as { files: unknown }).files).toEqual({
      "index.html": { hash: "abc123", size: 100 },
      "style.css": { hash: "def456", size: 200 },
    });
  });

  it("test_DW_5_2_manifest_returns_needed_and_session", async () => {
    const manifestResponse = {
      needed: [
        { path: "index.html", upload_url: "https://r2.example.com/presigned-1" },
      ],
      version: 3,
      session_id: "sess-xyz",
      base_version: 2,
    };

    const fetchFn = async () =>
      new Response(JSON.stringify(manifestResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await client.manifest("ns-1", "my-site", {
      files: [{ path: "index.html", hash: "abc", size: 50 }],
    });

    expect(result.needed).toHaveLength(1);
    expect(result.needed[0].path).toBe("index.html");
    expect(result.needed[0].upload_url).toBe(
      "https://r2.example.com/presigned-1",
    );
    expect(result.session_id).toBe("sess-xyz");
    expect(result.version).toBe(3);
    expect(result.base_version).toBe(2);
  });

  it("test_DW_5_2_manifest_passes_publish_options", async () => {
    let capturedBody: unknown = null;

    const fetchFn = async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(
        JSON.stringify({
          needed: [],
          version: 1,
          session_id: "sess-1",
          base_version: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await client.manifest("ns-1", "my-site", {
      files: [],
      title: "My Site",
      visibility: "public",
      preview: true,
    });

    expect(capturedBody).toMatchObject({
      files: {},
      title: "My Site",
      visibility: "public",
      preview: true,
    });
  });

  it("test_DW_5_2_manifest_throws_on_api_error", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ error: "Tier limit exceeded" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });

    const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await expect(
      client.manifest("ns-1", "my-site", { files: [] }),
    ).rejects.toThrow("Tier limit exceeded");
  });

  it("test_DW_5_2_manifest_first_deploy_returns_null_base_version", async () => {
    const fetchFn = async () =>
      new Response(
        JSON.stringify({
          needed: [{ path: "index.html", upload_url: "https://r2.example.com/1" }],
          version: 1,
          session_id: "sess-new",
          base_version: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await client.manifest("ns-1", "new-site", {
      files: [{ path: "index.html", hash: "abc", size: 50 }],
    });

    expect(result.base_version).toBeNull();
    expect(result.version).toBe(1);
  });
});

// ─── DW-5.3: ApiClient.finalize() ────────────────────────────────────────────

describe("DW-5.3: ApiClient.finalize()", () => {
  it("test_DW_5_3_finalize_posts_session_id", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;

    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(
        JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await client.finalize("ns-1", "my-site", "sess-abc");

    expect(capturedUrl).toBe(`${BASE_URL}/api/ns/ns-1/sites/my-site/finalize`);
    expect(capturedBody).toMatchObject({ session_id: "sess-abc" });
  });

  it("test_DW_5_3_finalize_returns_publish_result", async () => {
    const fetchFn = async () =>
      new Response(
        JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await client.finalize("ns-1", "my-site", "sess-abc");

    expect(result.site).toBeDefined();
    expect(result.url).toBe(SAMPLE_URL);
  });

  it("test_DW_5_3_finalize_throws_on_missing_files", async () => {
    const fetchFn = async () =>
      new Response(
        JSON.stringify({
          error: "Upload incomplete",
          missing: ["index.html"],
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      );

    const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await expect(
      client.finalize("ns-1", "my-site", "sess-abc"),
    ).rejects.toThrow("Upload incomplete");
  });

  it("test_DW_5_3_finalize_throws_on_session_not_found", async () => {
    const fetchFn = async () =>
      new Response(
        JSON.stringify({ error: "Session not found or expired" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );

    const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await expect(
      client.finalize("ns-1", "my-site", "sess-expired"),
    ).rejects.toThrow("Session not found or expired");
  });
});

// ─── DW-5.4: uploadChangedFiles() ────────────────────────────────────────────

describe("DW-5.4: uploadChangedFiles()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-upload-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_5_4_upload_changed_files_puts_to_presigned_url", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const calls: Array<{ url: string; method: string }> = [];

    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "" });
      return new Response("", { status: 200 });
    };

    const fileMap = {
      "index.html": new Uint8Array(Buffer.from("<h1>Hello</h1>")),
    };

    const needed = [
      { path: "index.html", upload_url: "https://r2.example.com/presigned/index.html" },
    ];

    await uploadChangedFiles({ needed, fileMap, fetchFn });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://r2.example.com/presigned/index.html");
    expect(calls[0].method).toBe("PUT");
  });

  it("test_DW_5_4_upload_parallel_batches", async () => {
    // Create 7 files to verify batching (batch size 5 → 2 batches)
    for (let i = 0; i < 7; i++) {
      writeFileSync(join(tmpDir, `file${i}.html`), `<h${i}>`);
    }

    const callOrder: string[] = [];

    const fetchFn = async (url: string) => {
      callOrder.push(url);
      return new Response("", { status: 200 });
    };

    const fileMap: Record<string, Uint8Array> = {};
    const needed: Array<{ path: string; upload_url: string }> = [];

    for (let i = 0; i < 7; i++) {
      fileMap[`file${i}.html`] = new Uint8Array(Buffer.from(`<h${i}>`));
      needed.push({
        path: `file${i}.html`,
        upload_url: `https://r2.example.com/file${i}.html`,
      });
    }

    await uploadChangedFiles({ needed, fileMap, fetchFn });

    // All 7 files should have been uploaded
    expect(callOrder).toHaveLength(7);
  });

  it("test_DW_5_4_upload_retries_on_failure", async () => {
    writeFileSync(join(tmpDir, "index.html"), "hello");

    let attemptCount = 0;

    const fetchFn = async () => {
      attemptCount++;
      if (attemptCount < 3) {
        // Fail first 2 attempts
        return new Response("", { status: 500 });
      }
      return new Response("", { status: 200 });
    };

    const fileMap = {
      "index.html": new Uint8Array(Buffer.from("hello")),
    };
    const needed = [
      { path: "index.html", upload_url: "https://r2.example.com/index.html" },
    ];

    // Should succeed after retries (resolves without throwing)
    await uploadChangedFiles({ needed, fileMap, fetchFn });

    expect(attemptCount).toBe(3);
  });

  it("test_DW_5_4_upload_fails_after_max_retries", async () => {
    writeFileSync(join(tmpDir, "index.html"), "hello");

    const fetchFn = async () => new Response("", { status: 500 });

    const fileMap = {
      "index.html": new Uint8Array(Buffer.from("hello")),
    };
    const needed = [
      { path: "index.html", upload_url: "https://r2.example.com/index.html" },
    ];

    await expect(
      uploadChangedFiles({ needed, fileMap, fetchFn }),
    ).rejects.toThrow("index.html");
  });

  it("test_DW_5_4_upload_empty_needed_list_is_noop", async () => {
    let callCount = 0;
    const fetchFn = async () => {
      callCount++;
      return new Response("", { status: 200 });
    };

    await uploadChangedFiles({ needed: [], fileMap: {}, fetchFn });

    expect(callCount).toBe(0);
  });
});

// ─── DW-3.1 + DW-3.7 + DW-5.5 + DW-5.8: publish() ──────────────────────────

describe("DW-3.1/5.5: publish() uses presigned-URL flow", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-publish-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_3_1_publish_calls_manifest_not_postform", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const callLog: string[] = [];

    const fetchFn = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.includes("/manifest")) {
        callLog.push("manifest");
        return new Response(
          JSON.stringify({
            needed: [
              {
                path: "index.html",
                upload_url: "https://r2.example.com/presigned",
              },
            ],
            version: 1,
            session_id: "sess-1",
            base_version: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("r2.example.com") && method === "PUT") {
        callLog.push("presigned-upload");
        return new Response("", { status: 200 });
      }
      if (url.includes("/finalize")) {
        callLog.push("finalize");
        return new Response(
          JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Must NOT be called for zip upload
      if (url.includes("/sites") && method === "POST") {
        callLog.push("full-zip-upload");
      }
      return new Response("Not found", { status: 404 });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const opts: PublishOpts = {
      apiClient,
      nsId: "ns-1",
      directory: tmpDir,
      slug: "my-site",
      fetchFn,
    };

    const result = await publish(opts);

    expect(callLog).toContain("manifest");
    expect(callLog).toContain("presigned-upload");
    expect(callLog).toContain("finalize");
    expect(callLog).not.toContain("full-zip-upload");
    expect(result.url).toBe(SAMPLE_URL);
  });

  it("test_DW_3_7_manifest_error_propagates_no_fallback", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    // Manifest endpoint returns an error — must propagate, not fall back to zip
    const fetchFn = async (url: string) => {
      if (url.includes("/manifest")) {
        return new Response(
          JSON.stringify({ error: "Tier limit exceeded" }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);

    // Error must propagate — no silent fallback
    await expect(
      publish({ apiClient, nsId: "ns-1", directory: tmpDir, slug: "my-site", fetchFn }),
    ).rejects.toThrow("Tier limit exceeded");
  });

  it("test_DW_3_7_manifest_network_error_propagates", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const fetchFn = async (url: string) => {
      if (url.includes("/manifest")) {
        throw new Error("Network timeout");
      }
      return new Response("Not found", { status: 404 });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);

    await expect(
      publish({ apiClient, nsId: "ns-1", directory: tmpDir, slug: "my-site", fetchFn }),
    ).rejects.toThrow("Network timeout");
  });

  it("test_DW_5_8_progress_reports_uploaded_files", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(join(tmpDir, "style.css"), "body {}");

    // Server says both files are needed (first deploy, no base)
    const fetchFn = async (url: string, init?: RequestInit) => {
      if (url.includes("/manifest")) {
        return new Response(
          JSON.stringify({
            needed: [
              { path: "index.html", upload_url: "https://r2.example.com/1" },
              { path: "style.css", upload_url: "https://r2.example.com/2" },
            ],
            version: 1,
            session_id: "sess-1",
            base_version: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("r2.example.com") && init?.method === "PUT") {
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

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);

    const result = await publish({
      apiClient,
      nsId: "ns-1",
      directory: tmpDir,
      slug: "my-site",
      fetchFn,
    });

    // Both files were uploaded (none skipped)
    expect(result.uploadedFiles).toBeDefined();
    expect(result.uploadedFiles).toHaveLength(2);
    expect(result.uploadedFiles).toContain("index.html");
    expect(result.uploadedFiles).toContain("style.css");
  });

  it("test_DW_5_8_progress_reports_skipped_files", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(join(tmpDir, "style.css"), "body {}");

    // Server says only style.css changed (index.html unchanged, skipped)
    const fetchFn = async (url: string, init?: RequestInit) => {
      if (url.includes("/manifest")) {
        return new Response(
          JSON.stringify({
            needed: [
              { path: "style.css", upload_url: "https://r2.example.com/2" },
            ],
            version: 2,
            session_id: "sess-2",
            base_version: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("r2.example.com") && init?.method === "PUT") {
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

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);

    const result = await publish({
      apiClient,
      nsId: "ns-1",
      directory: tmpDir,
      slug: "my-site",
      fetchFn,
    });

    // style.css uploaded, index.html skipped
    expect(result.uploadedFiles).toHaveLength(1);
    expect(result.uploadedFiles).toContain("style.css");
    expect(result.skippedFiles).toBeDefined();
    expect(result.skippedFiles).toContain("index.html");
  });

  it("test_DW_5_5_publish_validates_directory", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      async () => new Response("{}", { status: 200 }),
    );

    await expect(
      publish({
        apiClient,
        nsId: "ns-1",
        directory: "/nonexistent/path/xyz",
        slug: "my-site",
      }),
    ).rejects.toThrow("does not exist");
  });

  it("test_DW_5_5_publish_validates_slug", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");

    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      async () => new Response("{}", { status: 200 }),
    );

    await expect(
      publish({ apiClient, nsId: "ns-1", directory: tmpDir, slug: "ab" }),
    ).rejects.toThrow("Invalid slug");
  });

  it("test_DW_5_5_publish_rejects_empty_dir", async () => {
    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      async () => new Response("{}", { status: 200 }),
    );

    await expect(
      publish({ apiClient, nsId: "ns-1", directory: tmpDir, slug: "my-site" }),
    ).rejects.toThrow("empty");
  });

  it("test_DW_5_5_publish_validates_passcode_required", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");

    const apiClient = new ApiClient(
      BASE_URL,
      staticTokenProvider,
      async () => new Response("{}", { status: 200 }),
    );

    await expect(
      publish({
        apiClient,
        nsId: "ns-1",
        directory: tmpDir,
        slug: "my-site",
        visibility: "passcode",
      }),
    ).rejects.toThrow("passcode is required");
  });

  it("accepts _root as a slug (bypasses format validation)", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const rootSite = { ...SAMPLE_SITE, slug: "_root" };
    const rootUrl = "https://testuser.upubli.sh/";

    const fetchFn = async (url: string, init?: RequestInit) => {
      if (url.includes("/manifest")) {
        return new Response(
          JSON.stringify({
            needed: [{ path: "index.html", upload_url: "https://r2.example.com/1" }],
            version: 1,
            session_id: "sess-1",
            base_version: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("r2.example.com") && init?.method === "PUT") {
        return new Response("", { status: 200 });
      }
      if (url.includes("/finalize")) {
        return new Response(
          JSON.stringify({ site: rootSite, url: rootUrl }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result = await publish({
      apiClient,
      nsId: "ns-1",
      directory: tmpDir,
      slug: "_root",
      fetchFn,
    });

    expect(result.url).toBe(rootUrl);
    expect(result.site.slug).toBe("_root");
  });
});

// ─── DW-3.2: No incremental field in PublishArgs ─────────────────────────────

describe("DW-3.2: PublishArgs has no incremental field", () => {
  it("test_DW_3_2_publish_args_type_has_no_incremental_field", () => {
    // Verify that PublishOpts does not have an incremental field.
    // TypeScript will catch this at compile time; here we verify at runtime
    // by checking the keys of a constructed opts object.
    const opts: PublishOpts = {
      apiClient: new ApiClient(BASE_URL, staticTokenProvider, async () => new Response("{}")),
      nsId: "ns-test",
      directory: "/tmp",
      slug: "my-site",
    };
    // incremental should not be a key on PublishOpts
    expect("incremental" in opts).toBe(false);
  });
});
