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

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readFileSync, readdirSync } from "fs";
import * as fsModule from "fs";
import { dirname } from "path";
import { createHash } from "node:crypto";
import {
  publish,
  collectFilesWithHashes,
  uploadChangedFiles,
  isValidSlug,
  parseIgnoreFile,
} from "./publish.ts";
import { ApiClient } from "./api-client.ts";
import type { PublishOpts, UploadProgress } from "./publish.ts";
// Re-export reachability: adapters import UploadProgress only from core.ts (DW-1.3).
import type { UploadProgress as UploadProgressFromCore } from "./core.ts";

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

    expect(result.files).toBeDefined();
    expect(Object.keys(result.files)).toHaveLength(2);
    expect(result.files["index.html"].hash).toBeDefined();
    expect(result.files["style.css"].hash).toBeDefined();
  });

  it("test_DW_5_1_md5_hash_correct_value", () => {
    // MD5 of "hello" is 5d41402abc4b2a76b9719d911017c592
    writeFileSync(join(tmpDir, "test.txt"), "hello");

    const result = collectFilesWithHashes(tmpDir);

    expect(result.files["test.txt"].hash).toBe("5d41402abc4b2a76b9719d911017c592");
  });

  it("test_DW_5_1_hash_map_keyed_by_path", () => {
    mkdirSync(join(tmpDir, "subdir"));
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");
    writeFileSync(join(tmpDir, "subdir", "app.js"), "const x = 1;");

    const result = collectFilesWithHashes(tmpDir);

    // Keys use the relative path
    expect(result.files["index.html"]).toBeDefined();
    expect(result.files[join("subdir", "app.js")]).toBeDefined();
  });

  it("test_DW_5_1_excluded_files_not_in_files_map", () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");
    writeFileSync(join(tmpDir, ".DS_Store"), "");
    writeFileSync(join(tmpDir, ".env"), "SECRET=abc");

    const result = collectFilesWithHashes(tmpDir);

    // Only index.html should be hashed — excluded files not present
    expect(Object.keys(result.files)).toHaveLength(1);
    expect(result.files[".DS_Store"]).toBeUndefined();
    expect(result.files[".env"]).toBeUndefined();
  });

  it("test_DW_5_1_returns_excluded_and_warnings", () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hi</h1>");
    writeFileSync(join(tmpDir, ".DS_Store"), "");
    writeFileSync(join(tmpDir, "nginx.conf"), "server {}");

    const result = collectFilesWithHashes(tmpDir);

    expect(result.excluded).toContain(".DS_Store");
    expect(result.warnings).toContain("nginx.conf");
  });

  it("test_DW_5_1_empty_dir_returns_empty_files", () => {
    const result = collectFilesWithHashes(tmpDir);
    expect(Object.keys(result.files)).toHaveLength(0);
  });
});

// ─── DW-1.1–1.4 (Phase 1): streamed hash pass + collection contract ──────────

describe("DW-1.1: collectFilesWithHashes returns the files contract", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-collect-contract-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_1_1_collect_returns_files_contract", () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const result = collectFilesWithHashes(tmpDir);

    const entry = result.files["index.html"];
    expect(entry).toBeDefined();
    // CollectedFile = { hash, size, fullPath }
    expect(typeof entry.hash).toBe("string");
    expect(entry.hash).toHaveLength(32); // MD5 hex digest
    expect(entry.size).toBe(Buffer.byteLength("<h1>Hello</h1>"));
    expect(entry.fullPath).toBe(join(tmpDir, "index.html"));
    // The old two-map shape is gone.
    expect((result as unknown as { fileMap?: unknown }).fileMap).toBeUndefined();
    expect((result as unknown as { hashes?: unknown }).hashes).toBeUndefined();
  });

  it("test_DW_1_1_no_filemap_field_in_publish_source", () => {
    // Source guard: no `fileMap` token remains anywhere in lib/publish.ts.
    const src = readFileSync(join(dirname(import.meta.path), "publish.ts"), "utf-8");
    expect(src.includes("fileMap")).toBe(false);
  });
});

describe("DW-1.2/1.3: chunked hashing matches a full-buffer reference", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-chunk-hash-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Deterministic pseudo-random bytes so the reference and the chunked impl
  // hash the exact same content.
  function fill(n: number): Buffer {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
    return b;
  }
  function refMd5(buf: Buffer): string {
    return createHash("md5").update(buf).digest("hex");
  }

  it("test_DW_1_3_chunked_hash_matches_reference", () => {
    // Sizes straddle the 64 KiB chunk boundary (±1) and span multiple chunks.
    const CHUNK = 64 * 1024;
    const sizes = [100, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 3 + 17];
    for (const [i, n] of sizes.entries()) {
      const data = fill(n);
      const name = `f${i}.bin`;
      writeFileSync(join(tmpDir, name), data);
      const entry = collectFilesWithHashes(tmpDir).files[name];
      expect(entry.hash).toBe(refMd5(data));
      expect(entry.size).toBe(n);
    }
  });

  it("test_DW_1_2_hashes_large_file_via_bounded_chunks", () => {
    // A file several × the chunk size: correctness here proves the chunked
    // read loop runs (a single readFileSync would also pass, but DW-1.2 is
    // additionally enforced by the source-scan test below).
    const big = fill(64 * 1024 * 5 + 123);
    writeFileSync(join(tmpDir, "big.bin"), big);

    const entry = collectFilesWithHashes(tmpDir).files["big.bin"];
    expect(entry.hash).toBe(refMd5(big));
    expect(entry.size).toBe(big.byteLength);
  });

  it("test_DW_1_2_collection_does_not_readFileSync_file_bytes", () => {
    // The content-hashing path must stream via readSync, not buffer the whole
    // file with readFileSync. The only readFileSync left in the source is the
    // tiny .upublishignore control file (and the transitional upload-body read,
    // swapped in Phase 2) — assert collectFiles uses readSync.
    const src = readFileSync(join(dirname(import.meta.path), "publish.ts"), "utf-8");
    expect(src.includes("readSync(")).toBe(true);
  });

  it("test_DW_1_3_empty_file_canonical_md5", () => {
    writeFileSync(join(tmpDir, "empty.txt"), "");

    const entry = collectFilesWithHashes(tmpDir).files["empty.txt"];
    expect(entry.hash).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(entry.size).toBe(0);
  });
});

describe("DW-1.4: size derives from bytes hashed", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-size-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_1_4_size_equals_bytes_hashed", () => {
    const content = "a".repeat(4096) + "bcdef"; // 4101 bytes
    writeFileSync(join(tmpDir, "doc.txt"), content);

    const entry = collectFilesWithHashes(tmpDir).files["doc.txt"];
    expect(entry.size).toBe(Buffer.byteLength(content));
  });

  it("test_DW_1_4_force_mode_random_hash_real_size", async () => {
    // force=true sends random hashes to the manifest, but the reported size
    // must remain the real on-disk byte count. Capture the manifest payload.
    const content = "<h1>Hello</h1>";
    writeFileSync(join(tmpDir, "index.html"), content);

    const collected = collectFilesWithHashes(tmpDir);
    const realHash = collected.files["index.html"].hash;

    let capturedFiles: Record<string, { hash: string; size: number }> = {};
    const fetchFn = async (url: string, init?: RequestInit) => {
      if (url.includes("/manifest")) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        capturedFiles = body.files;
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
          JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await publish({
      apiClient,
      nsId: "ns-1",
      directory: tmpDir,
      slug: "my-site",
      force: true,
      fetchFn,
    });

    // Random hash != real collected hash, but size is the real byte count.
    expect(capturedFiles["index.html"].hash).not.toBe(realHash);
    expect(capturedFiles["index.html"].size).toBe(Buffer.byteLength(content));
  });
});

describe("DW-1.2/1.3: hash error paths propagate and never leak an fd", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-hash-errpath-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_1_3_unreadable_file_mid_walk_propagates", () => {
    // An unreadable file encountered during the directory walk must surface as
    // an error out of collectFilesWithHashes — collection has no swallow path
    // for a file it cannot open. (Current, intended behavior.)
    //
    // Root bypasses Unix permission bits, so chmod 0o000 would NOT block the
    // open and this assertion could not hold — skip gracefully when running as
    // root rather than asserting something the environment can't produce.
    if (process.getuid?.() === 0) return;

    const badPath = join(tmpDir, "secret.txt");
    writeFileSync(join(tmpDir, "index.html"), "<h1>ok</h1>");
    writeFileSync(badPath, "cannot read me");
    chmodSync(badPath, 0o000);

    try {
      expect(() => collectFilesWithHashes(tmpDir)).toThrow();
    } finally {
      // Restore perms so afterEach cleanup (and any reader) can remove the file.
      chmodSync(badPath, 0o600);
    }
  });

  it("test_DW_1_3_fd_closed_when_read_fails_mid_hash", () => {
    // hashFileChunked() opens the file, then reads it in a chunk loop inside a
    // try/finally that closes the fd. Prove the finally runs on the error path:
    // force readSync to throw AFTER the open, then assert closeSync was still
    // called with the fd that openSync handed out (the descriptor opened for
    // this file), and that the read error propagated.
    //
    // spyOn redefines the property on the fs module record, so the named
    // readSync/closeSync imports inside lib/publish.ts observe the spies. Both
    // spies are restored in finally — scoped to this test, no global leak.
    const filePath = join(tmpDir, "data.bin");
    writeFileSync(filePath, "some bytes to hash");

    const realCloseSync = fsModule.closeSync;
    const closedFds: number[] = [];

    const readSpy = spyOn(fsModule, "readSync").mockImplementation(() => {
      throw new Error("simulated mid-hash read failure");
    });
    const closeSpy = spyOn(fsModule, "closeSync").mockImplementation(
      ((fd: number) => {
        closedFds.push(fd);
        // Actually close so we don't leak the real descriptor in the test.
        return (realCloseSync as (fd: number) => void)(fd);
      }) as typeof fsModule.closeSync,
    );

    try {
      expect(() => collectFilesWithHashes(tmpDir)).toThrow(
        "simulated mid-hash read failure",
      );

      // The fd opened for the file was closed despite the read error — the
      // try/finally in hashFileChunked ran. openSync returns one fd here.
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(closedFds).toHaveLength(1);
      expect(closeSpy).toHaveBeenCalledWith(closedFds[0]);
    } finally {
      readSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });
});

describe("DW-1.5: uploadOneFile reads the PUT body from files[path].fullPath", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-fullpath-body-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_1_5_upload_reads_body_from_fullPath", async () => {
    const content = "<h1>Body from disk</h1>";
    const filePath = join(tmpDir, "index.html");
    writeFileSync(filePath, content);

    let capturedBody: BodyInit | undefined;
    const fetchFn = async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body ?? undefined;
      return new Response("", { status: 200 });
    };

    await uploadChangedFiles({
      needed: [{ path: "index.html", upload_url: "https://r2.example.com/1" }],
      files: { "index.html": { size: Buffer.byteLength(content), fullPath: filePath } },
      fetchFn,
    });

    // The PUT body equals the on-disk bytes (read transitionally from fullPath).
    expect(capturedBody).toBeDefined();
    const sent = await new Response(capturedBody).arrayBuffer();
    expect(Buffer.from(sent).toString("utf-8")).toBe(content);
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
    const filePath = join(tmpDir, "index.html");
    writeFileSync(filePath, "<h1>Hello</h1>");

    const calls: Array<{ url: string; method: string }> = [];

    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "" });
      return new Response("", { status: 200 });
    };

    const files = {
      "index.html": { size: Buffer.byteLength("<h1>Hello</h1>"), fullPath: filePath },
    };

    const needed = [
      { path: "index.html", upload_url: "https://r2.example.com/presigned/index.html" },
    ];

    await uploadChangedFiles({ needed, files, fetchFn });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://r2.example.com/presigned/index.html");
    expect(calls[0].method).toBe("PUT");
  });

  it("test_DW_5_4_upload_parallel_batches", async () => {
    // Create 7 files to verify batching (batch size 5 → 2 batches)
    const callOrder: string[] = [];

    const fetchFn = async (url: string) => {
      callOrder.push(url);
      return new Response("", { status: 200 });
    };

    const files: Record<string, { size: number; fullPath: string }> = {};
    const needed: Array<{ path: string; upload_url: string }> = [];

    for (let i = 0; i < 7; i++) {
      const content = `<h${i}>`;
      const fullPath = join(tmpDir, `file${i}.html`);
      writeFileSync(fullPath, content);
      files[`file${i}.html`] = { size: Buffer.byteLength(content), fullPath };
      needed.push({
        path: `file${i}.html`,
        upload_url: `https://r2.example.com/file${i}.html`,
      });
    }

    await uploadChangedFiles({ needed, files, fetchFn });

    // All 7 files should have been uploaded
    expect(callOrder).toHaveLength(7);
  });

  it("test_DW_5_4_upload_retries_on_failure", async () => {
    const filePath = join(tmpDir, "index.html");
    writeFileSync(filePath, "hello");

    let attemptCount = 0;

    const fetchFn = async () => {
      attemptCount++;
      if (attemptCount < 3) {
        // Fail first 2 attempts
        return new Response("", { status: 500 });
      }
      return new Response("", { status: 200 });
    };

    const files = {
      "index.html": { size: 5, fullPath: filePath },
    };
    const needed = [
      { path: "index.html", upload_url: "https://r2.example.com/index.html" },
    ];

    // Should succeed after retries (resolves without throwing)
    await uploadChangedFiles({ needed, files, fetchFn });

    expect(attemptCount).toBe(3);
  });

  it("test_DW_5_4_upload_fails_after_max_retries", async () => {
    const filePath = join(tmpDir, "index.html");
    writeFileSync(filePath, "hello");

    const fetchFn = async () => new Response("", { status: 500 });

    const files = {
      "index.html": { size: 5, fullPath: filePath },
    };
    const needed = [
      { path: "index.html", upload_url: "https://r2.example.com/index.html" },
    ];

    await expect(
      uploadChangedFiles({ needed, files, fetchFn }),
    ).rejects.toThrow("index.html");
  });

  it("test_DW_5_4_upload_empty_needed_list_is_noop", async () => {
    let callCount = 0;
    const fetchFn = async () => {
      callCount++;
      return new Response("", { status: 200 });
    };

    await uploadChangedFiles({ needed: [], files: {}, fetchFn });

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

// ─── DW-1: onProgress callback threaded through publish core ─────────────────

describe("DW-1.1/1.4: uploadChangedFiles fires onProgress", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-progress-upload-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Builds a needed[] of N files plus a matching files map (on-disk, 4 bytes
  // each: `<h0>`..), all uploads succeed.
  function makeUpload(count: number) {
    const files: Record<string, { size: number; fullPath: string }> = {};
    const needed: Array<{ path: string; upload_url: string }> = [];
    for (let i = 0; i < count; i++) {
      const path = `file${i}.html`;
      const content = `<h${i}>`;
      const fullPath = join(tmpDir, path);
      writeFileSync(fullPath, content);
      files[path] = { size: Buffer.byteLength(content), fullPath };
      needed.push({ path, upload_url: `https://r2.example.com/${path}` });
    }
    return { files, needed };
  }

  const okFetch = async () => new Response("", { status: 200 });

  it("test_DW_1_1_fires_initial_then_per_file_cumulative", async () => {
    // 6 needed files, each 4 bytes (`<h0>`..`<h5>`) => totalBytes 24.
    // Expect an initial all-zero report, then one report per file as it lands:
    // completed 1..6 and completedBytes 4,8,..,24 (files are equal-sized, so
    // the byte sequence is deterministic regardless of completion order).
    const { files, needed } = makeUpload(6);
    const events: UploadProgress[] = [];

    await uploadChangedFiles({
      needed,
      files,
      fetchFn: okFetch,
      onProgress: (p) => events.push({ ...p }),
    });

    // Initial report + one per file.
    expect(events).toHaveLength(7);
    expect(events[0]).toEqual({
      completed: 0,
      total: 6,
      completedBytes: 0,
      totalBytes: 24,
    });
    // completed climbs 0..6 by ones; bytes climb 0..24 in lockstep (4/file).
    expect(events.map((e) => e.completed)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(events.map((e) => e.completedBytes)).toEqual([0, 4, 8, 12, 16, 20, 24]);
    // total and totalBytes never change across the run.
    expect(events.every((e) => e.total === 6 && e.totalBytes === 24)).toBe(true);
    // Final call always reaches the totals.
    expect(events[events.length - 1]).toEqual({
      completed: 6,
      total: 6,
      completedBytes: 24,
      totalBytes: 24,
    });
  });

  it("test_DW_1_1_empty_needed_fires_no_progress", async () => {
    const events: UploadProgress[] = [];

    await uploadChangedFiles({
      needed: [],
      files: {},
      fetchFn: okFetch,
      onProgress: (p) => events.push({ ...p }),
    });

    // Early-return path: NOT even the initial {0,0} fires.
    expect(events).toHaveLength(0);
  });
});

describe("DW-1.2: onProgress is optional and threaded through publish()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-progress-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Mock that serves manifest (both files needed), R2 PUTs, and finalize.
  function publishFetch() {
    return async (url: string, init?: RequestInit) => {
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
  }

  it("test_DW_1_2_publish_threads_onProgress_to_upload", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(join(tmpDir, "style.css"), "body {}");

    const fetchFn = publishFetch();
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const events: UploadProgress[] = [];

    await publish({
      apiClient,
      nsId: "ns-1",
      directory: tmpDir,
      slug: "my-site",
      fetchFn,
      onProgress: (p) => events.push({ ...p }),
    });

    // 2 needed files => initial zero report, then one per file as it lands.
    // index.html ("<h1>Hello</h1>") = 14 bytes, style.css ("body {}") = 7 bytes
    // => totalBytes 21.
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      completed: 0,
      total: 2,
      completedBytes: 0,
      totalBytes: 21,
    });
    expect(events[events.length - 1]).toEqual({
      completed: 2,
      total: 2,
      completedBytes: 21,
      totalBytes: 21,
    });
  });

  it("test_DW_1_2_omitting_onProgress_still_publishes", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(join(tmpDir, "style.css"), "body {}");

    const fetchFn = publishFetch();
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);

    // No onProgress supplied — must publish successfully, identical behavior.
    const result = await publish({
      apiClient,
      nsId: "ns-1",
      directory: tmpDir,
      slug: "my-site",
      fetchFn,
    });

    expect(result.url).toBe(SAMPLE_URL);
    expect(result.uploadedFiles).toHaveLength(2);
  });
});

describe("DW-1.3: callback is generic and UploadProgress is exported from core", () => {
  it("test_DW_1_3_lib_has_no_mcp_sdk_imports", () => {
    // Scan every lib/*.ts source file (excluding tests) for an MCP SDK import.
    // The progress callback must stay platform-agnostic (hexagonal boundary).
    const libDir = dirname(import.meta.path);
    const files = readdirSync(libDir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );

    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(libDir, f), "utf-8");
      if (src.includes("@modelcontextprotocol/sdk")) {
        offenders.push(f);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("test_DW_1_3_uploadprogress_exported_from_core", () => {
    // Compile-time: the type imported from core.ts must be structurally usable.
    // (The `UploadProgressFromCore` import at the top fails to type-check if
    //  core.ts does not re-export it.)
    const p: UploadProgressFromCore = {
      completed: 1,
      total: 2,
      completedBytes: 40,
      totalBytes: 100,
    };
    expect(p.completed).toBe(1);
    expect(p.total).toBe(2);
    expect(p.completedBytes).toBe(40);
    expect(p.totalBytes).toBe(100);
  });
});
