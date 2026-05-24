/**
 * Tests for preview flag additions in lib/publish.ts and lib/core.ts.
 *
 * Covers DW-3.1: PublishOpts and PublishArgs include optional preview?: boolean
 * Covers DW-3.2: When preview=true, form data includes preview: "true" field
 * Covers DW-3.3: Publish result includes preview_url when preview is true
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { publish } from "./publish.ts";
import type { PublishOpts, PublishResult } from "./publish.ts";
import { ApiClient } from "./api-client.ts";

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
  file_count: 1,
  total_size: 500,
  visibility: "public" as const,
  passcode_hash: null,
};

const SAMPLE_URL = "https://testuser.upubli.sh/my-site/";
const SAMPLE_PREVIEW_URL = "https://testuser.upubli.sh/my-site/@v2/";

// ─── DW-3.1: PublishOpts and PublishArgs include preview?: boolean ─────────────

describe("DW-3.1: PublishOpts has preview field", () => {
  it("test_DW_3_1_publish_opts_has_preview_field", () => {
    // TypeScript type check — if preview?: boolean is not on PublishOpts, this
    // compile-time assignment would fail the type checker (caught by bun test --ts-errors).
    // At runtime, simply verify we can construct an object with preview set.
    const opts: PublishOpts = {
      apiClient: new ApiClient(BASE_URL, staticTokenProvider, async () => new Response("{}")),
      nsId: "ns-test",
      directory: "/tmp",
      slug: "my-site",
      preview: true,
    };
    expect(opts.preview).toBe(true);
  });

  it("test_DW_3_1_publish_opts_preview_is_optional", () => {
    // preview must be optional — can omit entirely
    const opts: PublishOpts = {
      apiClient: new ApiClient(BASE_URL, staticTokenProvider, async () => new Response("{}")),
      nsId: "ns-test",
      directory: "/tmp",
      slug: "my-site",
    };
    expect(opts.preview).toBeUndefined();
  });
});

// ─── DW-3.2: When preview=true, form data includes preview: "true" ──────────────

describe("DW-3.2: preview flag sends preview form field", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-preview-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_3_2_preview_flag_sends_preview_true_in_form_data", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    let capturedForm: FormData | null = null;
    const fetchFn = async (_url: string, init?: RequestInit) => {
      capturedForm = init?.body as FormData;
      return new Response(
        JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL, preview_url: SAMPLE_PREVIEW_URL }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await publish({
      apiClient,
      nsId: "ns-test",
      directory: tmpDir,
      slug: "my-site",
      preview: true,
    });

    expect(capturedForm).not.toBeNull();
    expect((capturedForm as FormData).get("preview")).toBe("true");
  });

  it("test_DW_3_2_no_preview_flag_does_not_send_preview_field", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    let capturedForm: FormData | null = null;
    const fetchFn = async (_url: string, init?: RequestInit) => {
      capturedForm = init?.body as FormData;
      return new Response(
        JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await publish({
      apiClient,
      nsId: "ns-test",
      directory: tmpDir,
      slug: "my-site",
    });

    expect(capturedForm).not.toBeNull();
    // preview field must not be sent when not specified
    expect((capturedForm as FormData).get("preview")).toBeNull();
  });
});

// ─── DW-3.3: Publish result includes preview_url when preview is true ───────────

describe("DW-3.3: publish result includes preview_url", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-preview-result-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_3_3_publish_result_includes_preview_url", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const fetchFn = async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          site: SAMPLE_SITE,
          url: SAMPLE_URL,
          preview_url: SAMPLE_PREVIEW_URL,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result: PublishResult = await publish({
      apiClient,
      nsId: "ns-test",
      directory: tmpDir,
      slug: "my-site",
      preview: true,
    });

    expect(result.preview_url).toBe(SAMPLE_PREVIEW_URL);
    expect(result.url).toBe(SAMPLE_URL);
  });

  it("test_DW_3_3_normal_publish_preview_url_is_undefined", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const fetchFn = async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result: PublishResult = await publish({
      apiClient,
      nsId: "ns-test",
      directory: tmpDir,
      slug: "my-site",
    });

    // Normal publish: no preview_url in response, field must be undefined
    expect(result.preview_url).toBeUndefined();
  });
});
