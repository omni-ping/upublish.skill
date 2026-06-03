/**
 * Tests for Phase 1 publish flow logging.
 *
 * DW-1.1: publish() logs file count and total size before calling manifest
 * DW-1.2: publish() logs manifest response (version, session_id, base_version, needed count, total files)
 * DW-1.3: uploadChangedFiles() logs batch progress (batch N/M, files in batch)
 * DW-1.4: uploadOneFile() logs each attempt with HTTP status, and logs response body on non-ok
 * DW-1.5: publish() logs finalize result and final summary (uploaded count, skipped count)
 * DW-1.6: api-client.ts logs HTTP status and response body on non-2xx from manifest and finalize
 * DW-1.8: bun test lib/ passes
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as logModule from "./log.ts";
import { publish, uploadChangedFiles } from "./publish.ts";
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

/** Builds a standard publish fetchFn with 2 files needed. */
function makePublishFetch(needed: Array<{ path: string; upload_url: string }> = []): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (urlStr.includes("/manifest")) {
      return new Response(
        JSON.stringify({
          needed,
          version: 3,
          session_id: "sess-abc",
          base_version: 2,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (urlStr.includes("r2.example.com") && init?.method === "PUT") {
      return new Response("", { status: 200 });
    }
    if (urlStr.includes("/finalize")) {
      return new Response(
        JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("Not found", { status: 404 });
  };
}

// ─── DW-1.1 + DW-1.2 + DW-1.5: publish() logging ────────────────────────────

describe("DW-1.1: publish() logs file count and total size before manifest", () => {
  let tmpDir: string;
  let logLines: string[];
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-log-test-"));
    logLines = [];
    spy = spyOn(logModule, "log").mockImplementation((msg: string) => {
      logLines.push(msg);
    });
  });

  afterEach(() => {
    spy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_1_1_logs_file_count_and_total_size_before_manifest", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(join(tmpDir, "style.css"), "body {}");

    const needed = [
      { path: "index.html", upload_url: "https://r2.example.com/1" },
      { path: "style.css", upload_url: "https://r2.example.com/2" },
    ];
    const fetchFn = makePublishFetch(needed);
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);

    await publish({ apiClient, nsId: "ns-1", directory: tmpDir, slug: "my-site", fetchFn });

    const publishLine = logLines.find((l) => l.startsWith("[publish]") && l.includes("files="));
    expect(publishLine).toBeDefined();
    expect(publishLine).toContain("files=2");
    expect(publishLine).toContain("totalBytes=");
    expect(publishLine).toContain("slug=my-site");

    // The [publish] line must appear before the [manifest] line
    const publishIdx = logLines.findIndex((l) => l.startsWith("[publish]") && l.includes("files="));
    const manifestIdx = logLines.findIndex((l) => l.startsWith("[manifest]"));
    expect(publishIdx).toBeLessThan(manifestIdx);
  });
});

describe("DW-1.2: publish() logs manifest response details", () => {
  let tmpDir: string;
  let logLines: string[];
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-log-test-"));
    logLines = [];
    spy = spyOn(logModule, "log").mockImplementation((msg: string) => {
      logLines.push(msg);
    });
  });

  afterEach(() => {
    spy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_1_2_logs_manifest_version_session_base_version_needed_total", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(join(tmpDir, "style.css"), "body {}");

    const needed = [
      { path: "index.html", upload_url: "https://r2.example.com/1" },
    ];
    const fetchFn = makePublishFetch(needed);
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);

    await publish({ apiClient, nsId: "ns-1", directory: tmpDir, slug: "my-site", fetchFn });

    const manifestLines = logLines.filter((l) => l.startsWith("[manifest]"));
    expect(manifestLines.length).toBeGreaterThan(0);

    // At least one [manifest] line must contain the key manifest fields
    const hasVersion = manifestLines.some((l) => l.includes("version=3"));
    const hasSessionId = manifestLines.some((l) => l.includes("session_id=sess-abc"));
    const hasBaseVersion = manifestLines.some((l) => l.includes("base_version=2"));
    const hasNeeded = manifestLines.some((l) => l.includes("needed=1"));
    const hasTotal = manifestLines.some((l) => l.includes("total=2"));

    expect(hasVersion).toBe(true);
    expect(hasSessionId).toBe(true);
    expect(hasBaseVersion).toBe(true);
    expect(hasNeeded).toBe(true);
    expect(hasTotal).toBe(true);
  });
});

describe("DW-1.5: publish() logs finalize result and summary", () => {
  let tmpDir: string;
  let logLines: string[];
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-log-test-"));
    logLines = [];
    spy = spyOn(logModule, "log").mockImplementation((msg: string) => {
      logLines.push(msg);
    });
  });

  afterEach(() => {
    spy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_1_5_logs_finalize_result_and_uploaded_skipped_counts", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(join(tmpDir, "style.css"), "body {}");

    // Only style.css is needed — index.html will be skipped
    const needed = [
      { path: "style.css", upload_url: "https://r2.example.com/2" },
    ];
    const fetchFn = makePublishFetch(needed);
    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);

    await publish({ apiClient, nsId: "ns-1", directory: tmpDir, slug: "my-site", fetchFn });

    const finalizeLine = logLines.find((l) => l.startsWith("[finalize]") && l.includes("uploaded="));
    expect(finalizeLine).toBeDefined();
    expect(finalizeLine).toContain("uploaded=1");
    expect(finalizeLine).toContain("skipped=1");
    expect(finalizeLine).toContain("url=");
  });
});

// ─── DW-1.3: uploadChangedFiles() batch logging ───────────────────────────────

describe("DW-1.3: uploadChangedFiles() logs batch progress", () => {
  let logLines: string[];
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logLines = [];
    spy = spyOn(logModule, "log").mockImplementation((msg: string) => {
      logLines.push(msg);
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("test_DW_1_3_logs_batch_number_and_file_names", async () => {
    const fetchFn = async () => new Response("", { status: 200 });

    const fileMap: Record<string, Uint8Array> = {
      "index.html": new Uint8Array(Buffer.from("<h1>")),
      "style.css": new Uint8Array(Buffer.from("body {}")),
    };

    const needed = [
      { path: "index.html", upload_url: "https://r2.example.com/1" },
      { path: "style.css", upload_url: "https://r2.example.com/2" },
    ];

    await uploadChangedFiles({ needed, fileMap, fetchFn });

    const batchLine = logLines.find((l) => l.startsWith("[upload]") && l.includes("batch="));
    expect(batchLine).toBeDefined();
    expect(batchLine).toContain("batch=1/1");
    expect(batchLine).toContain("index.html");
    expect(batchLine).toContain("style.css");
  });

  it("test_DW_1_3_logs_multiple_batches_for_more_than_5_files", async () => {
    const fetchFn = async () => new Response("", { status: 200 });

    const fileMap: Record<string, Uint8Array> = {};
    const needed: Array<{ path: string; upload_url: string }> = [];

    for (let i = 0; i < 7; i++) {
      fileMap[`file${i}.html`] = new Uint8Array(Buffer.from(`file${i}`));
      needed.push({ path: `file${i}.html`, upload_url: `https://r2.example.com/file${i}` });
    }

    await uploadChangedFiles({ needed, fileMap, fetchFn });

    const batchLines = logLines.filter((l) => l.startsWith("[upload]") && l.includes("batch="));
    expect(batchLines).toHaveLength(2);
    expect(batchLines[0]).toContain("batch=1/2");
    expect(batchLines[1]).toContain("batch=2/2");
  });

  it("test_DW_1_3_no_batch_log_when_needed_is_empty", async () => {
    const fetchFn = async () => new Response("", { status: 200 });

    await uploadChangedFiles({ needed: [], fileMap: {}, fetchFn });

    const batchLines = logLines.filter((l) => l.startsWith("[upload]") && l.includes("batch="));
    expect(batchLines).toHaveLength(0);
  });
});

// ─── DW-1.4: uploadOneFile() per-file logging ────────────────────────────────

describe("DW-1.4: uploadOneFile() logs attempt with HTTP status", () => {
  let logLines: string[];
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logLines = [];
    spy = spyOn(logModule, "log").mockImplementation((msg: string) => {
      logLines.push(msg);
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("test_DW_1_4_logs_ok_upload_with_status", async () => {
    const fetchFn = async () => new Response("", { status: 200 });

    const fileMap = { "index.html": new Uint8Array(Buffer.from("hello")) };
    const needed = [{ path: "index.html", upload_url: "https://r2.example.com/1" }];

    await uploadChangedFiles({ needed, fileMap, fetchFn });

    const fileLine = logLines.find((l) => l.startsWith("[upload]") && l.includes("file=index.html"));
    expect(fileLine).toBeDefined();
    expect(fileLine).toContain("status=200");
    expect(fileLine).toContain("attempt=1");
  });

  it("test_DW_1_4_logs_response_body_on_non_ok_status", async () => {
    // Use 500 (transient error) so the request retries and we can verify
    // that both the status and response body are logged on non-ok responses.
    // 403 is non-retryable (presigned URL expired) and tested separately in
    // lib/upload-retry.test.ts (DW-5.1).
    let attempts = 0;
    const fetchFn = async () => {
      attempts++;
      if (attempts < 3) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response("", { status: 200 });
    };

    const fileMap = { "index.html": new Uint8Array(Buffer.from("hello")) };
    const needed = [{ path: "index.html", upload_url: "https://r2.example.com/1" }];

    await uploadChangedFiles({ needed, fileMap, fetchFn });

    const failLines = logLines.filter(
      (l) => l.startsWith("[upload]") && l.includes("file=index.html") && l.includes("status=500"),
    );
    expect(failLines.length).toBeGreaterThan(0);
    expect(failLines[0]).toContain("body=Internal Server Error");
  });
});

// ─── DW-1.6: api-client.ts logs non-2xx from manifest and finalize ───────────

describe("DW-1.6: api-client.ts logs HTTP status and body on non-2xx", () => {
  let logLines: string[];
  let spy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logLines = [];
    spy = spyOn(logModule, "log").mockImplementation((msg: string) => {
      logLines.push(msg);
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("test_DW_1_6_logs_status_and_body_on_manifest_error", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ error: "Tier limit exceeded" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });

    const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);

    await expect(
      client.manifest("ns-1", "my-site", { files: [] }),
    ).rejects.toThrow("Tier limit exceeded");

    const apiLine = logLines.find((l) => l.startsWith("[api]") && l.includes("status=403"));
    expect(apiLine).toBeDefined();
    expect(apiLine).toContain("status=403");
    expect(apiLine).toContain("Tier limit exceeded");
  });

  it("test_DW_1_6_logs_status_and_body_on_finalize_error", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ error: "Upload incomplete", missing: ["index.html"] }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });

    const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);

    await expect(
      client.finalize("ns-1", "my-site", "sess-abc"),
    ).rejects.toThrow("Upload incomplete");

    const apiLine = logLines.find((l) => l.startsWith("[api]") && l.includes("status=422"));
    expect(apiLine).toBeDefined();
    expect(apiLine).toContain("status=422");
    expect(apiLine).toContain("Upload incomplete");
  });

  it("test_DW_1_6_no_error_log_on_successful_2xx", async () => {
    const fetchFn = async () =>
      new Response(
        JSON.stringify({ needed: [], version: 1, session_id: "s", base_version: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const client = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await client.manifest("ns-1", "my-site", { files: [] });

    const apiErrorLines = logLines.filter((l) => l.startsWith("[api]") && l.includes("status="));
    expect(apiErrorLines).toHaveLength(0);
  });
});
