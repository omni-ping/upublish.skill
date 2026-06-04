/**
 * Tests for Phase 2: Streamed upload bodies + retry re-open.
 *
 * DW-2.1: no Uint8Array bodies remain; each attempt constructs a fresh
 *         Bun.file stream (ReadableStream from Bun.file().stream())
 * DW-2.2: 403 throws immediately (no retry); 5xx/network retry ≤ UPLOAD_MAX_RETRIES;
 *         each attempt's body is independently readable
 * DW-2.3: missing needed path throws naming the path (no silent empty PUT)
 * DW-2.4: onProgress semantics unchanged
 * DW-2.5: PUT body content equals on-disk bytes; bun test lib/ green
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uploadChangedFiles } from "./publish.ts";
import type { FetchFn } from "./types.ts";
import type { UploadProgress } from "./publish.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let htmlPath: string;
let cssPath: string;
let emptyPath: string;

const HTML_CONTENT = "<h1>Hello streaming world</h1>";
const CSS_CONTENT = "body { margin: 0; color: red; }";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "upublish-streaming-"));
  htmlPath = join(tmpDir, "index.html");
  cssPath = join(tmpDir, "style.css");
  emptyPath = join(tmpDir, "empty.txt");
  writeFileSync(htmlPath, HTML_CONTENT);
  writeFileSync(cssPath, CSS_CONTENT);
  writeFileSync(emptyPath, "");
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── DW-2.1: Body is a ReadableStream (Bun.file stream), content matches disk ──

describe("DW-2.1: PUT body is a Bun.file stream with correct disk content", () => {
  it("test_DW_2_1_body_is_readable_stream_with_ondisk_content", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchFn: FetchFn = async (_url, init) => {
      capturedInit = init;
      return new Response("", { status: 200 });
    };

    await uploadChangedFiles({
      needed: [{ path: "index.html", upload_url: "https://r2.example.com/1" }],
      files: { "index.html": { size: Buffer.byteLength(HTML_CONTENT), fullPath: htmlPath } },
      fetchFn,
    });

    expect(capturedInit).toBeDefined();
    // Body must be a ReadableStream (Bun.file().stream()), not a Uint8Array
    expect(capturedInit!.body).not.toBeInstanceOf(Uint8Array);
    expect(capturedInit!.body).toBeInstanceOf(ReadableStream);

    // Content must match on-disk bytes
    const chunks: Uint8Array[] = [];
    const reader = (capturedInit!.body as ReadableStream).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as Uint8Array);
    }
    const received = Buffer.concat(chunks).toString("utf-8");
    expect(received).toBe(HTML_CONTENT);
  });

  it("test_DW_2_1_no_uint8array_body_in_source", () => {
    // Source guard: no Uint8Array body construction remains in lib/publish.ts
    // (the transitional readFileSync + Uint8Array from Phase 1 must be gone)
    const src = readFileSync(
      join(import.meta.dir, "publish.ts"),
      "utf-8"
    );
    // The transitional comment from Phase 1 must be gone
    expect(src).not.toContain("Transitional: eagerly read the body from disk");
    // No new Uint8Array construction in the upload path
    // (Allow Uint8Array in comments or types — match assignment patterns)
    expect(src).not.toContain("new Uint8Array(readFileSync");
  });

  it("test_DW_2_1_zero_byte_file_body_is_stream", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchFn: FetchFn = async (_url, init) => {
      capturedInit = init;
      return new Response("", { status: 200 });
    };

    await uploadChangedFiles({
      needed: [{ path: "empty.txt", upload_url: "https://r2.example.com/empty" }],
      files: { "empty.txt": { size: 0, fullPath: emptyPath } },
      fetchFn,
    });

    expect(capturedInit!.body).toBeInstanceOf(ReadableStream);

    // Read the stream — should be empty (0 bytes)
    const chunks: Uint8Array[] = [];
    const reader = (capturedInit!.body as ReadableStream).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value as Uint8Array);
    }
    const totalBytes = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalBytes).toBe(0);
  });
});

// ─── DW-2.10: PUT carries no auto-added Content-Type header ──────────────────

describe("DW-2.1/DW-2.10: PUT carries no Content-Type, has Content-Length", () => {
  it("test_DW_2_10_put_carries_no_content_type_header_for_html_file", async () => {
    let capturedHeaders: Headers | Record<string, string> | undefined;
    const fetchFn: FetchFn = async (_url, init) => {
      capturedHeaders = init?.headers as Headers | Record<string, string> | undefined;
      return new Response("", { status: 200 });
    };

    await uploadChangedFiles({
      needed: [{ path: "index.html", upload_url: "https://r2.example.com/1" }],
      files: { "index.html": { size: Buffer.byteLength(HTML_CONTENT), fullPath: htmlPath } },
      fetchFn,
    });

    // Must have headers
    expect(capturedHeaders).toBeDefined();

    // Extract content-type from whatever headers format is used
    let contentType: string | null = null;
    let contentLength: string | null = null;
    if (capturedHeaders instanceof Headers) {
      contentType = capturedHeaders.get("content-type");
      contentLength = capturedHeaders.get("content-length");
    } else if (typeof capturedHeaders === "object") {
      const h = capturedHeaders as Record<string, string>;
      // Check case-insensitively
      const ctKey = Object.keys(h).find(k => k.toLowerCase() === "content-type");
      const clKey = Object.keys(h).find(k => k.toLowerCase() === "content-length");
      contentType = ctKey ? h[ctKey] : null;
      contentLength = clKey ? h[clKey] : null;
    }

    // No Content-Type (wire-identical to today's Uint8Array body behavior)
    expect(contentType).toBeNull();

    // Content-Length must be present (R2 presigned PUT requirement)
    expect(contentLength).toBe(String(Buffer.byteLength(HTML_CONTENT)));
  });

  it("test_DW_2_10_put_carries_no_content_type_for_css_file", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchFn: FetchFn = async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string> | undefined;
      return new Response("", { status: 200 });
    };

    await uploadChangedFiles({
      needed: [{ path: "style.css", upload_url: "https://r2.example.com/2" }],
      files: { "style.css": { size: Buffer.byteLength(CSS_CONTENT), fullPath: cssPath } },
      fetchFn,
    });

    expect(capturedHeaders).toBeDefined();
    const h = capturedHeaders!;
    const ctKey = Object.keys(h).find(k => k.toLowerCase() === "content-type");
    const contentType = ctKey ? h[ctKey] : null;
    expect(contentType).toBeNull();
  });

  it("test_DW_2_10_content_length_is_zero_for_empty_file", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchFn: FetchFn = async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string> | undefined;
      return new Response("", { status: 200 });
    };

    await uploadChangedFiles({
      needed: [{ path: "empty.txt", upload_url: "https://r2.example.com/empty" }],
      files: { "empty.txt": { size: 0, fullPath: emptyPath } },
      fetchFn,
    });

    const h = capturedHeaders!;
    const clKey = Object.keys(h).find(k => k.toLowerCase() === "content-length");
    const contentLength = clKey ? h[clKey] : null;
    expect(contentLength).toBe("0");
  });
});

// ─── DW-2.2: 403 fast-fail + 5xx retry with fresh body per attempt ────────────

describe("DW-2.2: 403 fast-fail; 5xx retry with fresh body per attempt", () => {
  it("test_DW_2_2_403_immediate_throw_one_fetchfn_call", async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls++;
      return new Response("", { status: 403 });
    };

    await expect(
      uploadChangedFiles({
        needed: [{ path: "index.html", upload_url: "https://r2.example.com/1" }],
        files: { "index.html": { size: Buffer.byteLength(HTML_CONTENT), fullPath: htmlPath } },
        fetchFn,
      }),
    ).rejects.toThrow(/presigned URL expired/);

    expect(calls).toBe(1);
  });

  it("test_DW_2_2_5xx_then_200_three_fetchfn_calls_each_body_independently_readable", async () => {
    // Two 5xx then 200 = 3 calls total
    let calls = 0;
    const capturedBodies: ReadableStream[] = [];

    const fetchFn: FetchFn = async (_url, init) => {
      calls++;
      // Capture the body before consuming
      if (init?.body instanceof ReadableStream) {
        capturedBodies.push(init.body as ReadableStream);
      }
      const status = calls <= 2 ? 500 : 200;
      return new Response("", { status });
    };

    await uploadChangedFiles({
      needed: [{ path: "index.html", upload_url: "https://r2.example.com/1" }],
      files: { "index.html": { size: Buffer.byteLength(HTML_CONTENT), fullPath: htmlPath } },
      fetchFn,
    });

    expect(calls).toBe(3);
    expect(capturedBodies).toHaveLength(3);

    // Each attempt's body must be independently readable (fresh stream per attempt)
    for (let i = 0; i < capturedBodies.length; i++) {
      const chunks: Uint8Array[] = [];
      const reader = capturedBodies[i].getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value as Uint8Array);
      }
      const content = Buffer.concat(chunks).toString("utf-8");
      expect(content).toBe(HTML_CONTENT);
    }
  });

  it("test_DW_2_2_persistent_500_throws_after_max_retries", async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls++;
      return new Response("", { status: 500 });
    };

    await expect(
      uploadChangedFiles({
        needed: [{ path: "index.html", upload_url: "https://r2.example.com/1" }],
        files: { "index.html": { size: Buffer.byteLength(HTML_CONTENT), fullPath: htmlPath } },
        fetchFn,
      }),
    ).rejects.toThrow(/index\.html/);

    // UPLOAD_MAX_RETRIES = 3
    expect(calls).toBe(3);
  });

  it("test_DW_2_2_network_error_then_success_retried", async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls++;
      if (calls < 2) throw new Error("ECONNRESET");
      return new Response("", { status: 200 });
    };

    await uploadChangedFiles({
      needed: [{ path: "index.html", upload_url: "https://r2.example.com/1" }],
      files: { "index.html": { size: Buffer.byteLength(HTML_CONTENT), fullPath: htmlPath } },
      fetchFn,
    });

    expect(calls).toBe(2);
  });

  it("test_DW_2_2_persistent_network_error_throws_naming_path", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("ECONNRESET");
    };

    await expect(
      uploadChangedFiles({
        needed: [{ path: "index.html", upload_url: "https://r2.example.com/1" }],
        files: { "index.html": { size: Buffer.byteLength(HTML_CONTENT), fullPath: htmlPath } },
        fetchFn,
      }),
    ).rejects.toThrow(/index\.html/);
  });
});

// ─── DW-2.3: Missing needed path throws naming the path ───────────────────────

describe("DW-2.3: missing needed path throws naming the path", () => {
  it("test_DW_2_3_missing_path_throws_naming_path", async () => {
    const fetchFn: FetchFn = async () => new Response("", { status: 200 });

    let errorMessage = "";
    try {
      await uploadChangedFiles({
        needed: [{ path: "missing-file.html", upload_url: "https://r2.example.com/1" }],
        files: {}, // missing-file.html not in files
        fetchFn,
      });
    } catch (err) {
      errorMessage = (err as Error).message;
    }

    expect(errorMessage).toBeTruthy();
    // Error must name the missing path
    expect(errorMessage).toContain("missing-file.html");
    // Must NOT be the generic JS "Cannot read properties of undefined" message
    expect(errorMessage).not.toContain("Cannot read properties of undefined");
  });

  it("test_DW_2_3_missing_path_does_not_send_empty_put", async () => {
    let fetchCalled = false;
    const fetchFn: FetchFn = async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    };

    await expect(
      uploadChangedFiles({
        needed: [{ path: "not-collected.js", upload_url: "https://r2.example.com/1" }],
        files: {},
        fetchFn,
      }),
    ).rejects.toThrow();

    // fetchFn must NOT have been called (no silent empty PUT)
    expect(fetchCalled).toBe(false);
  });
});

// ─── DW-2.4: onProgress semantics ────────────────────────────────────────────

describe("DW-2.4: onProgress semantics preserved", () => {
  it("test_DW_2_4_initial_zero_report_then_per_file_cumulative", async () => {
    const fetchFn: FetchFn = async () => new Response("", { status: 200 });

    const htmlSize = Buffer.byteLength(HTML_CONTENT);
    const cssSize = Buffer.byteLength(CSS_CONTENT);
    const totalBytes = htmlSize + cssSize;

    const progressCalls: UploadProgress[] = [];
    const onProgress = (p: UploadProgress) => progressCalls.push({ ...p });

    await uploadChangedFiles({
      needed: [
        { path: "index.html", upload_url: "https://r2.example.com/1" },
        { path: "style.css", upload_url: "https://r2.example.com/2" },
      ],
      files: {
        "index.html": { size: htmlSize, fullPath: htmlPath },
        "style.css": { size: cssSize, fullPath: cssPath },
      },
      fetchFn,
      onProgress,
    });

    // At least 3 calls: initial zero + 2 per-file completions
    expect(progressCalls.length).toBeGreaterThanOrEqual(3);

    // First call: initial zero report
    const first = progressCalls[0];
    expect(first.completed).toBe(0);
    expect(first.completedBytes).toBe(0);
    expect(first.total).toBe(2);
    expect(first.totalBytes).toBe(totalBytes);

    // Last call: totals match contract sizes
    const last = progressCalls[progressCalls.length - 1];
    expect(last.completed).toBe(2);
    expect(last.total).toBe(2);
    expect(last.totalBytes).toBe(totalBytes);

    // Byte counts are monotonically increasing
    for (let i = 1; i < progressCalls.length; i++) {
      expect(progressCalls[i].completedBytes).toBeGreaterThanOrEqual(
        progressCalls[i - 1].completedBytes,
      );
    }
  });

  it("test_DW_2_4_empty_needed_zero_onprogress_calls", async () => {
    const fetchFn: FetchFn = async () => new Response("", { status: 200 });

    let callCount = 0;
    const onProgress = () => { callCount++; };

    await uploadChangedFiles({
      needed: [],
      files: {},
      fetchFn,
      onProgress,
    });

    expect(callCount).toBe(0);
  });

  it("test_DW_2_4_totals_derived_from_contract_sizes_not_actual_disk", async () => {
    // Totals come from files[path].size in the contract, not from disk stat
    const fetchFn: FetchFn = async () => new Response("", { status: 200 });
    const CONTRACT_SIZE = 999; // does not match actual disk size
    const progressCalls: UploadProgress[] = [];

    await uploadChangedFiles({
      needed: [{ path: "index.html", upload_url: "https://r2.example.com/1" }],
      files: { "index.html": { size: CONTRACT_SIZE, fullPath: htmlPath } },
      fetchFn,
      onProgress: (p) => progressCalls.push({ ...p }),
    });

    const last = progressCalls[progressCalls.length - 1];
    expect(last.totalBytes).toBe(CONTRACT_SIZE);
    expect(last.completedBytes).toBe(CONTRACT_SIZE);
  });
});

// ─── DW-2.5: PUT body content equals on-disk bytes ───────────────────────────

describe("DW-2.5: PUT body content equals on-disk bytes", () => {
  it("test_DW_2_5_put_body_content_equals_disk_bytes_html", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchFn: FetchFn = async (_url, init) => {
      capturedInit = init;
      return new Response("", { status: 200 });
    };

    await uploadChangedFiles({
      needed: [{ path: "index.html", upload_url: "https://r2.example.com/1" }],
      files: { "index.html": { size: Buffer.byteLength(HTML_CONTENT), fullPath: htmlPath } },
      fetchFn,
    });

    expect(capturedInit).toBeDefined();
    const stream = capturedInit!.body as ReadableStream;
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value as Uint8Array);
    }
    const received = Buffer.concat(chunks).toString("utf-8");
    expect(received).toBe(HTML_CONTENT);
  });

  it("test_DW_2_5_put_body_content_equals_disk_bytes_css", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchFn: FetchFn = async (_url, init) => {
      capturedInit = init;
      return new Response("", { status: 200 });
    };

    await uploadChangedFiles({
      needed: [{ path: "style.css", upload_url: "https://r2.example.com/2" }],
      files: { "style.css": { size: Buffer.byteLength(CSS_CONTENT), fullPath: cssPath } },
      fetchFn,
    });

    const stream = capturedInit!.body as ReadableStream;
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value as Uint8Array);
    }
    const received = Buffer.concat(chunks).toString("utf-8");
    expect(received).toBe(CSS_CONTENT);
  });

  it("test_DW_2_5_file_deleted_between_collect_and_put_error_names_path", async () => {
    // File exists at collection time but deleted before PUT.
    // Bun.file(deletedPath).stream() only throws ENOENT when the body is
    // actually consumed (lazy read). A mock fetchFn that ignores the body
    // would not trigger the error. We use a local Bun.serve sink that consumes
    // the body, causing the ENOENT to propagate as a network error through
    // the retry path, which ultimately throws with the file path in the message.
    const deletedPath = join(tmpDir, "will-be-deleted.html");
    writeFileSync(deletedPath, "temp content");
    rmSync(deletedPath);

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        await req.arrayBuffer(); // consume — triggers ENOENT on the client
        return new Response("ok");
      },
    });

    try {
      const fetchFn: FetchFn = (url, init) => fetch(url as string, init);
      await expect(
        uploadChangedFiles({
          needed: [{
            path: "will-be-deleted.html",
            upload_url: `http://localhost:${server.port}/`,
          }],
          files: {
            "will-be-deleted.html": { size: 12, fullPath: deletedPath },
          },
          fetchFn,
        }),
      ).rejects.toThrow(/will-be-deleted\.html/);
    } finally {
      server.stop();
    }
  });
});
