/**
 * Tests for the version wrappers in lib/core.ts.
 *
 * Covers DW-4.2: core.ts exports listSiteVersions(slug, namespace?, deps?) and
 * deleteSiteVersion(slug, versionNumber, namespace?, deps?). Both build the
 * client via buildApiClient(deps) (credentials read fresh) and resolve the
 * namespace before delegating to the domain functions. Tested with injected
 * CoreDeps + a mock fetch (no real network calls).
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listSiteVersions, deleteSiteVersion, setSiteVersionsLimit } from "./core.ts";
import type { CoreDeps } from "./core.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const REFRESH_TOKEN = "test-refresh-token";
const NS_ID = "ns-test-id";

function writeTempCredentials(token: string): string {
  const tmpFile = path.join(
    os.tmpdir(),
    `core-versions-test-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(tmpFile, token, { mode: 0o600 });
  return tmpFile;
}

/**
 * Mock fetch that stubs token-refresh, /api/space, and /api/ns (default
 * namespace resolution), delegating the operation path to opFn.
 */
function makeMockFetch(
  opFn: (url: string, init?: RequestInit) => Response,
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

// ─── DW-4.2: core.listSiteVersions() ──────────────────────────────────────────

describe("DW-4.2: core.listSiteVersions()", () => {
  it("test_DW_4_2_core_list_versions_calls_domain", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    let capturedUrl = "";
    const fetchFn = makeMockFetch((url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          versions: [
            { version_number: 2, status: "live", is_live: true },
            { version_number: 1, status: "archived", is_live: false },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const result = await listSiteVersions("my-site", undefined, deps);

    expect(result.versions).toHaveLength(2);
    // namespace was resolved (NS_ID came from /api/space) and used in the path
    expect(capturedUrl).toContain(`/api/ns/${NS_ID}/sites/my-site/versions`);
  });

  it("test_DW_4_2_core_list_versions_no_credentials_throws", async () => {
    // Credentials read fresh on every call — missing file ⇒ "Not authenticated"
    const deps: CoreDeps = {
      credentialsPath: "/does/not/exist/credentials",
      fetchFn: async () => new Response("{}", { status: 200 }),
    };

    await expect(listSiteVersions("my-site", undefined, deps)).rejects.toThrow(
      "Not authenticated",
    );
  });
});

// ─── DW-4.2: core.deleteSiteVersion() ─────────────────────────────────────────

describe("DW-4.2: core.deleteSiteVersion()", () => {
  it("test_DW_4_2_core_delete_version_returns_usage", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    let capturedUrl = "";
    let capturedMethod = "";
    const fetchFn = makeMockFetch((url, init) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return new Response(
        JSON.stringify({
          version_number: 1,
          freed_bytes: 2048,
          usage: { used_bytes: 4096, limit_bytes: 104857600 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const result = await deleteSiteVersion("my-site", 1, undefined, deps);

    expect(result.version_number).toBe(1);
    expect(result.freed_bytes).toBe(2048);
    expect(result.usage.used_bytes).toBe(4096);
    expect(capturedMethod).toBe("DELETE");
    expect(capturedUrl).toContain(`/api/ns/${NS_ID}/sites/my-site/versions/1`);
  });

  it("test_DW_4_2_core_delete_version_no_credentials_throws", async () => {
    const deps: CoreDeps = {
      credentialsPath: "/does/not/exist/credentials",
      fetchFn: async () => new Response("{}", { status: 200 }),
    };

    await expect(deleteSiteVersion("my-site", 1, undefined, deps)).rejects.toThrow(
      "Not authenticated",
    );
  });

  it("test_DW_4_2_core_delete_version_resolves_namespace", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    // Named namespace must be resolved via /api/ns (not the default)
    let capturedUrl = "";
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
        return new Response(
          JSON.stringify({
            namespaces: [
              { id: "ns-default", name: "default", domain: "user.upubli.sh" },
              { id: "ns-team", name: "team", domain: "team.upubli.sh" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      capturedUrl = url;
      return new Response(
        JSON.stringify({ version_number: 3, freed_bytes: 10, usage: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    await deleteSiteVersion("my-site", 3, "team", deps);

    expect(capturedUrl).toContain("/api/ns/ns-team/sites/my-site/versions/3");
  });
});

// ─── DW-3.1 + DW-3.3: core.setSiteVersionsLimit() ────────────────────────────

describe("DW-3.1: core.setSiteVersionsLimit()", () => {
  it("test_DW_3_1_core_set_versions_limit_calls_domain", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: unknown;

    const fetchFn = makeMockFetch((url, init) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          site: { max_versions: 5 },
          pruned: [1, 2],
          freed_bytes: 2097152,
          usage: { used_bytes: 8388608, limit_bytes: 104857600 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const result = await setSiteVersionsLimit("my-site", 5, undefined, deps);

    expect(capturedMethod).toBe("PUT");
    expect(capturedUrl).toContain(`/api/ns/${NS_ID}/sites/my-site/versions/limit`);
    expect(capturedBody).toEqual({ limit: 5 });
    expect(result.site.max_versions).toBe(5);
    expect(result.pruned).toEqual([1, 2]);
    expect(result.freed_bytes).toBe(2097152);
    expect(result.usage.used_bytes).toBe(8388608);
  });

  it("test_DW_3_1_core_set_versions_limit_clear", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    let capturedBody: unknown;
    const fetchFn = makeMockFetch((_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ site: { max_versions: null }, pruned: [], freed_bytes: 0, usage: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const result = await setSiteVersionsLimit("my-site", null, undefined, deps);

    expect(capturedBody).toEqual({ limit: null });
    expect(result.site.max_versions).toBeNull();
    expect(result.pruned).toEqual([]);
  });

  it("test_DW_3_3_not_authenticated_throws", async () => {
    // Credentials read fresh on every call — missing file => "Not authenticated"
    const deps: CoreDeps = {
      credentialsPath: "/does/not/exist/credentials",
      fetchFn: async () => new Response("{}", { status: 200 }),
    };

    await expect(setSiteVersionsLimit("my-site", 3, undefined, deps)).rejects.toThrow(
      "Not authenticated",
    );
  });

  it("test_DW_3_1_core_set_versions_limit_resolves_named_namespace", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    let capturedUrl = "";
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
        return new Response(
          JSON.stringify({
            namespaces: [
              { id: "ns-default", name: "default", domain: "user.upubli.sh" },
              { id: "ns-work", name: "work", domain: "work.upubli.sh" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      capturedUrl = url;
      return new Response(
        JSON.stringify({ site: { max_versions: 10 }, pruned: [], freed_bytes: 0, usage: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    await setSiteVersionsLimit("my-site", 10, "work", deps);

    expect(capturedUrl).toContain("/api/ns/ns-work/sites/my-site/versions/limit");
  });
});

// ─── DW-3.4: package.json version bump ───────────────────────────────────────

describe("DW-3.4: version bump", () => {
  it("test_DW_3_4_version_bumped_from_0_10_3", async () => {
    const pkgJson = await import("../package.json", { assert: { type: "json" } });
    const version: string = pkgJson.default.version;
    const [major, minor] = version.split(".").map(Number);
    // Must be a minor bump: 0.11.x or higher
    expect(major).toBe(0);
    expect(minor).toBeGreaterThanOrEqual(11);
  });
});
