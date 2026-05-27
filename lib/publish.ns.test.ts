/**
 * Tests for lib/publish.ts namespace-scoped path.
 *
 * Covers DW-6.5: publish uses /api/ns/:nsId/sites/:slug/manifest and finalize
 */

import { describe, it, expect } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { publish } from "./publish.ts";
import { ApiClient } from "./api-client.ts";

const BASE_URL = "https://api.example.com";
const TOKEN = "test-token";
const staticTokenProvider = async () => TOKEN;
const NS_ID = "ns-abc123";

const SAMPLE_SITE = {
  id: "abc",
  user_id: "u1",
  slug: "test-site",
  title: "Test Site",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  file_count: 1,
  total_size: 100,
  visibility: "public" as const,
  passcode_hash: null,
};

// ─── DW-6.5: namespace-scoped publish ────────────────────────────────────────

describe("DW-6.5: publish with namespace", () => {
  it("test_DW_6_5_publish_uses_ns_manifest_path", async () => {
    let capturedManifestUrl = "";

    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/manifest")) {
        capturedManifestUrl = url;
        return new Response(
          JSON.stringify({
            needed: [{ path: "index.html", upload_url: "https://r2.example.com/presigned" }],
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
          JSON.stringify({ site: SAMPLE_SITE, url: "https://test.upubli.sh/test-site/" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-ns-test-"));
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>");

    try {
      const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
      await publish({ apiClient, nsId: NS_ID, directory: tmpDir, slug: "test-site", fetchFn });

      // Manifest URL must include the namespace ID
      expect(capturedManifestUrl).toBe(
        `${BASE_URL}/api/ns/${NS_ID}/sites/test-site/manifest`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("test_DW_6_5_publish_returns_result_with_ns", async () => {
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/manifest")) {
        return new Response(
          JSON.stringify({
            needed: [{ path: "index.html", upload_url: "https://r2.example.com/presigned" }],
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
          JSON.stringify({ site: SAMPLE_SITE, url: "https://test.upubli.sh/test-site/" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-ns-result-"));
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>");

    try {
      const apiClient = new ApiClient(BASE_URL, staticTokenProvider, fetchFn);
      const result = await publish({ apiClient, nsId: NS_ID, directory: tmpDir, slug: "test-site", fetchFn });

      expect(result.url).toBe("https://test.upubli.sh/test-site/");
      expect(result.site.slug).toBe("test-site");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
