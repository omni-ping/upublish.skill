/**
 * Tests for preview flag in lib/publish.ts and lib/core.ts.
 *
 * Covers DW-3.1: PublishOpts includes optional preview?: boolean
 * Covers DW-3.2: When preview=true, manifest body includes preview: true
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

// ─── DW-3.1: PublishOpts includes preview?: boolean ──────────────────────────

describe("DW-3.1: PublishOpts has preview field", () => {
  it("test_DW_3_1_publish_opts_has_preview_field", () => {
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
    const opts: PublishOpts = {
      apiClient: new ApiClient(BASE_URL, staticTokenProvider, async () => new Response("{}")),
      nsId: "ns-test",
      directory: "/tmp",
      slug: "my-site",
    };
    expect(opts.preview).toBeUndefined();
  });
});

// ─── DW-3.2: When preview=true, manifest body includes preview: true ─────────

describe("DW-3.2: preview flag included in manifest body", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "upublish-preview-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_3_2_preview_flag_sent_in_manifest_body", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    let capturedManifestBody: Record<string, unknown> | null = null;

    const fetchFn = async (url: string, init?: RequestInit) => {
      if (url.includes("/manifest")) {
        capturedManifestBody = init?.body ? JSON.parse(init.body as string) : null;
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
      if (url.includes("r2.example.com")) {
        return new Response("", { status: 200 });
      }
      if (url.includes("/finalize")) {
        return new Response(
          JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL, preview_url: SAMPLE_PREVIEW_URL }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    await publish({
      apiClient,
      nsId: "ns-test",
      directory: tmpDir,
      slug: "my-site",
      preview: true,
      fetchFn,
    });

    expect(capturedManifestBody).not.toBeNull();
    expect((capturedManifestBody as Record<string, unknown>)["preview"]).toBe(true);
  });

  it("test_DW_3_2_no_preview_flag_not_sent_in_manifest", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

    let capturedManifestBody: Record<string, unknown> | null = null;

    const fetchFn = async (url: string, init?: RequestInit) => {
      if (url.includes("/manifest")) {
        capturedManifestBody = init?.body ? JSON.parse(init.body as string) : null;
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
      if (url.includes("r2.example.com")) {
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
      nsId: "ns-test",
      directory: tmpDir,
      slug: "my-site",
      fetchFn,
    });

    expect(capturedManifestBody).not.toBeNull();
    // preview field not in body when not specified
    expect((capturedManifestBody as Record<string, unknown>)["preview"]).toBeUndefined();
  });
});

// ─── DW-3.3: Publish result includes preview_url when preview is true ────────

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
      if (url.includes("r2.example.com")) {
        return new Response("", { status: 200 });
      }
      if (url.includes("/finalize")) {
        return new Response(
          JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_URL, preview_url: SAMPLE_PREVIEW_URL }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
    const result: PublishResult = await publish({
      apiClient,
      nsId: "ns-test",
      directory: tmpDir,
      slug: "my-site",
      preview: true,
      fetchFn,
    });

    expect(result.preview_url).toBe(SAMPLE_PREVIEW_URL);
    expect(result.url).toBe(SAMPLE_URL);
  });

  it("test_DW_3_3_normal_publish_preview_url_is_undefined", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>Hello</h1>");

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
      if (url.includes("r2.example.com")) {
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
    const result: PublishResult = await publish({
      apiClient,
      nsId: "ns-test",
      directory: tmpDir,
      slug: "my-site",
      fetchFn,
    });

    expect(result.preview_url).toBeUndefined();
  });
});
