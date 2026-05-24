/**
 * Tests for the promote() function in lib/core.ts.
 *
 * Covers DW-3.7: core.ts exports a promote(slug, namespace?, deps?) function
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promote } from "./core.ts";
import type { CoreDeps } from "./core.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const REFRESH_TOKEN = "test-refresh-token";
const NS_ID = "ns-test-id";
const LIVE_URL = "https://testuser.upubli.sh/my-site/";

function writeTempCredentials(token: string): string {
  const tmpFile = path.join(
    os.tmpdir(),
    `core-promote-test-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(tmpFile, token, { mode: 0o600 });
  return tmpFile;
}

function mockFetchWithTokenRefresh(
  apiPath: string,
  apiStatus: number,
  apiBody: unknown,
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url: string) => {
    if (url.includes("/auth/token/refresh")) {
      return new Response(
        JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/api/space") || url.includes("/api/space?")) {
      return new Response(
        JSON.stringify({ space: { id: "sp1", default_namespace_id: NS_ID, tier: "free" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
      return new Response(
        JSON.stringify({ namespaces: [{ id: NS_ID, name: "default", domain: "user.upubli.sh" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes(apiPath)) {
      return new Response(JSON.stringify(apiBody), {
        status: apiStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not found", { status: 404 });
  };
}

const tmpFiles: string[] = [];

afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
});

// ─── DW-3.7: core.promote() ──────────────────────────────────────────────────

describe("DW-3.7: core.promote()", () => {
  it("test_DW_3_7_core_promote_calls_domain_promote", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    let capturedUrl = "";
    const fetchFn = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/space") || url.includes("/api/space?")) {
        return new Response(
          JSON.stringify({ space: { id: "sp1", default_namespace_id: NS_ID, tier: "free" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
        return new Response(
          JSON.stringify({ namespaces: [{ id: NS_ID, name: "default", domain: "user.upubli.sh" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ url: LIVE_URL }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const result = await promote("my-site", undefined, deps);

    expect(result.url).toBe(LIVE_URL);
    expect(capturedUrl).toContain("/promote");
  });

  it("test_DW_3_7_core_promote_returns_url", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchWithTokenRefresh("/promote", 200, { url: LIVE_URL }),
    };

    const result = await promote("my-site", undefined, deps);
    expect(result.url).toBe(LIVE_URL);
  });

  it("test_DW_3_7_core_promote_no_credentials_throws", async () => {
    const deps: CoreDeps = {
      credentialsPath: "/does/not/exist/credentials",
      fetchFn: async () => new Response("{}", { status: 200 }),
    };

    await expect(promote("my-site", undefined, deps)).rejects.toThrow("Not authenticated");
  });
});
