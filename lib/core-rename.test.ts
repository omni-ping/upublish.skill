/**
 * Tests for the rename() function in lib/core.ts.
 *
 * Covers DW-6.1: Core happy paths (site, ns) via mock-fetch deps;
 *   correct routes + bodies asserted.
 * Covers DW-6.3 (partial): 4xx surfaces verbatim as structured failure;
 *   network failure returns failure message; unauthenticated → login guidance.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rename } from "./core.ts";
import type { CoreDeps } from "./core.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const REFRESH_TOKEN = "test-refresh-token";
const NS_ID = "ns-test-id";

function writeTempCredentials(token: string): string {
  const tmpFile = path.join(
    os.tmpdir(),
    `core-rename-test-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(tmpFile, token, { mode: 0o600 });
  return tmpFile;
}

/**
 * Mock fetch that stubs token-refresh and namespace resolution,
 * delegating the actual operation URL to opFn.
 */
function makeMockFetch(
  opFn: (url: string, init?: RequestInit) => Response | Promise<Response>,
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url: string, init?: RequestInit) => {
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
    return opFn(url, init);
  };
}

const tmpFiles: string[] = [];

afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
});

// ─── DW-6.1: Core happy path — site rename ───────────────────────────────────

describe("DW-6.1: core.rename() site happy path", () => {
  it("test_DW_6_1_core_rename_site_calls_correct_route", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    let capturedUrl = "";
    let capturedBody: unknown;

    const fetchFn = makeMockFetch((url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string ?? "{}");
      return new Response(
        JSON.stringify({ slug: "new-slug", url: "https://user.upubli.sh/new-slug/", redirect_expires_at: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    await rename({ nsId: NS_ID, site: "old-slug", newName: "new-slug" }, deps);

    expect(capturedUrl).toContain(`/api/ns/${NS_ID}/sites/old-slug/rename`);
    expect((capturedBody as Record<string, unknown>).new_slug).toBe("new-slug");
  });

  it("test_DW_6_1_core_rename_site_returns_success", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const fetchFn = makeMockFetch(() =>
      new Response(
        JSON.stringify({ slug: "new-slug", url: "https://user.upubli.sh/new-slug/", redirect_expires_at: "2026-07-05T00:00:00.000Z" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    );

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const result = await rename({ nsId: NS_ID, site: "old-slug", newName: "new-slug", redirect: "30d" }, deps);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.url).toBe("https://user.upubli.sh/new-slug/");
      expect(result.redirectExpiresAt).toBe("2026-07-05T00:00:00.000Z");
    }
  });

  it("test_DW_6_1_core_rename_site_default_redirect_is_30d", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    let capturedBody: unknown;

    const fetchFn = makeMockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string ?? "{}");
      return new Response(
        JSON.stringify({ slug: "new-slug", url: "https://user.upubli.sh/new-slug/", redirect_expires_at: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    // No redirect specified — should default to "30d"
    await rename({ nsId: NS_ID, site: "old-slug", newName: "new-slug" }, deps);

    expect((capturedBody as Record<string, unknown>).redirect).toBe("30d");
  });

  it("test_DW_6_1_core_rename_site_explicit_redirect_off", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    let capturedBody: unknown;

    const fetchFn = makeMockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string ?? "{}");
      return new Response(
        JSON.stringify({ slug: "new-slug", url: "https://user.upubli.sh/new-slug/", redirect_expires_at: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    await rename({ nsId: NS_ID, site: "old-slug", newName: "new-slug", redirect: "off" }, deps);

    expect((capturedBody as Record<string, unknown>).redirect).toBe("off");
  });
});

// ─── DW-6.1: Core happy path — namespace rename ──────────────────────────────

describe("DW-6.1: core.rename() namespace happy path", () => {
  it("test_DW_6_1_core_rename_ns_calls_correct_route", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    let capturedUrl = "";
    let capturedBody: unknown;

    const fetchFn = makeMockFetch((url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string ?? "{}");
      return new Response(
        JSON.stringify({ name: "new-ns", url: "https://new-ns.upubli.sh/", redirect_expires_at: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    // site omitted → namespace rename
    await rename({ nsId: NS_ID, newName: "new-ns" }, deps);

    expect(capturedUrl).toContain(`/api/ns/${NS_ID}/rename`);
    expect((capturedBody as Record<string, unknown>).new_name).toBe("new-ns");
  });

  it("test_DW_6_1_core_rename_ns_returns_success", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const fetchFn = makeMockFetch(() =>
      new Response(
        JSON.stringify({ name: "new-ns", url: "https://new-ns.upubli.sh/", redirect_expires_at: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    );

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const result = await rename({ nsId: NS_ID, newName: "new-ns", redirect: "permanent" }, deps);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.url).toBe("https://new-ns.upubli.sh/");
      expect(result.redirectExpiresAt).toBeNull();
    }
  });

  it("test_DW_6_1_core_rename_ns_default_redirect_is_30d", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    let capturedBody: unknown;

    const fetchFn = makeMockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string ?? "{}");
      return new Response(
        JSON.stringify({ name: "new-ns", url: "https://new-ns.upubli.sh/", redirect_expires_at: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    await rename({ nsId: NS_ID, newName: "new-ns" }, deps);

    expect((capturedBody as Record<string, unknown>).redirect).toBe("30d");
  });
});

// ─── DW-6.3: Dirty paths ─────────────────────────────────────────────────────

describe("DW-6.3: core.rename() dirty paths", () => {
  it("test_DW_6_3_core_rename_4xx_returns_verbatim_error", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const serverErrorMessage = "Cannot rename: cooldown active, 12 days remaining";

    const fetchFn = makeMockFetch(() =>
      new Response(
        JSON.stringify({ error: serverErrorMessage }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      )
    );

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const result = await rename({ nsId: NS_ID, site: "old-slug", newName: "new-slug" }, deps);

    expect(result.success).toBe(false);
    if (!result.success) {
      // Server error message must be surfaced verbatim
      expect(result.error).toContain(serverErrorMessage);
    }
  });

  it("test_DW_6_3_core_rename_404_verbatim_error", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const serverErrorMessage = "Site not found";

    const fetchFn = makeMockFetch(() =>
      new Response(
        JSON.stringify({ error: serverErrorMessage }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )
    );

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const result = await rename({ nsId: NS_ID, site: "ghost", newName: "new-slug" }, deps);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain(serverErrorMessage);
    }
  });

  it("test_DW_6_3_core_rename_network_failure_returns_failure", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const fetchFn = makeMockFetch(() => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const result = await rename({ nsId: NS_ID, site: "my-site", newName: "new-site" }, deps);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("test_DW_6_3_core_rename_no_credentials_returns_failure", async () => {
    const deps: CoreDeps = {
      credentialsPath: "/does/not/exist/credentials",
      fetchFn: async () => new Response("{}", { status: 200 }),
    };

    const result = await rename({ nsId: NS_ID, site: "my-site", newName: "new-site" }, deps);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("authenticated");
    }
  });
});
