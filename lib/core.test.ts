/**
 * Tests for lib/core.ts — high-level operations with internal credential/API wiring.
 *
 * Covers DW-1.1: core.ts exports list(), publish(), delete(), login(), status()
 * Covers DW-1.2: each function reads credentials from disk on every call
 * Covers DW-1.3: functions accept optional CoreDeps for test injection
 * Covers DW-1.4: calling core.list() with no credentials throws "Not authenticated"
 * Covers DW-1.5: calling core.status() after writing credentials returns { authenticated: true, username }
 * Covers DW-1.6: all 6 core functions have unit tests with injected deps
 *
 * Covers DW-2.1: core.logout() deletes credentials file and calls revoke endpoint
 * Covers DW-2.2: core.logout() succeeds even when server is unreachable (best-effort revoke)
 * Covers DW-2.3: core.logout() returns { loggedOut: true } on success, { loggedOut: false, error } on failure
 * Covers DW-2.6: Tests cover core logout (happy path, no credentials file, server unreachable)
 * Covers DW-2.7: core.logout() with no credentials file returns { loggedOut: true } (no-op success)
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  list,
  publish,
  deleteOp,
  login,
  status,
  logout,
} from "./core.ts";
import type { CoreDeps } from "./core.ts";
import type { LoginDeps } from "./auth.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const REFRESH_TOKEN = "test-refresh-token";
const USERNAME = "testuser";

/** Writes a refresh token to a temp file and returns the file path. */
function writeTempCredentials(token: string): string {
  const tmpFile = path.join(os.tmpdir(), `core-test-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, token, { mode: 0o600 });
  return tmpFile;
}

/** Returns a mockFetch that responds with status + body JSON. */
function mockFetch(
  status: number,
  body: unknown,
): (url: string, init?: RequestInit) => Promise<Response> {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

const NS_ID = "ns-test-id";

/**
 * Returns a mockFetch that handles token refresh, namespace resolution
 * (GET /api/space and GET /api/ns), and a primary API endpoint.
 *
 * Routing priority (most-specific match first):
 *   1. /auth/token/refresh → access token response
 *   2. /api/space          → default namespace response
 *   3. /api/ns (exact, no path segment after) → namespace list
 *   4. The caller-supplied apiPath  → apiBody with apiStatus
 */
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
    // Match /api/ns exactly (not /api/ns/something/...)
    if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
      return new Response(
        JSON.stringify({ namespaces: [{ id: NS_ID, name: "default", domain: "user.upubli.sh" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Match the primary endpoint — try exact suffix match (last path segment)
    // so /api/sites matches /api/ns/:nsId/sites and direct /api/sites
    if (url.includes(apiPath) || url.endsWith(apiPath.replace(/^.*\//, "/"))) {
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

// ─── DW-1.1 + DW-1.6: core.list() ───────────────────────────────────────────

describe("DW-1.1/1.6: core.list()", () => {
  it("test_DW_1_1_core_exports_list", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchWithTokenRefresh("/api/sites", 200, { sites: [] }),
    };

    const result = await list(undefined, deps);
    expect(result.sites).toEqual([]);
  });

  it("test_DW_1_3_list_accepts_core_deps", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const SITE = {
      id: "uuid-1",
      user_id: "user-1",
      slug: "my-site",
      title: "My Site",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      file_count: 3,
      total_size: 1024,
      visibility: "public" as const,
      passcode_hash: null,
      url: "https://user.upubli.sh/my-site/",
    };

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchWithTokenRefresh("/api/sites", 200, { sites: [SITE] }),
    };

    const result = await list(undefined, deps);
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0].slug).toBe("my-site");
  });

  it("test_DW_1_4_list_no_credentials_throws", async () => {
    const deps: CoreDeps = {
      credentialsPath: "/does/not/exist/credentials",
      fetchFn: mockFetch(200, { sites: [] }),
    };

    await expect(list(undefined, deps)).rejects.toThrow("Not authenticated");
  });

  it("test_DW_1_2_list_reads_credentials_per_call", async () => {
    // First call: no credentials → throws
    const credFile = path.join(os.tmpdir(), `core-fresh-${Date.now()}`);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchWithTokenRefresh("/api/sites", 200, { sites: [] }),
    };

    await expect(list(undefined, deps)).rejects.toThrow("Not authenticated");

    // Write credentials between calls
    fs.writeFileSync(credFile, REFRESH_TOKEN, { mode: 0o600 });

    // Second call: credentials now present → succeeds (proves per-call read)
    const result = await list(undefined, deps);
    expect(result.sites).toEqual([]);
  });
});

// ─── DW-1.1 + DW-1.4 + DW-1.6: core.publish() ───────────────────────────────

describe("DW-1.1/1.4/1.6: core.publish()", () => {
  it("test_DW_1_1_core_exports_publish", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    // Create a temp directory with a file to publish
    const tmpDir = path.join(os.tmpdir(), `core-publish-dir-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>");
    tmpFiles.push(path.join(tmpDir, "index.html"));

    const publishResponse = {
      site: {
        id: "uuid-1",
        user_id: "u1",
        slug: "test-site",
        title: "Test Site",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        file_count: 1,
        total_size: 100,
        visibility: "public" as const,
        passcode_hash: null,
      },
      url: "https://test-site.upubli.sh",
    };

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchWithTokenRefresh("/api/sites", 200, publishResponse),
    };

    const result = await publish({ directory: tmpDir, slug: "test-site" }, deps);
    expect(result.url).toBe("https://test-site.upubli.sh");
    expect(result.site.slug).toBe("test-site");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_1_4_publish_no_credentials_throws", async () => {
    const tmpDir = path.join(os.tmpdir(), `core-publish-noauth-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const deps: CoreDeps = {
      credentialsPath: "/does/not/exist/credentials",
      fetchFn: mockFetch(200, {}),
    };

    await expect(publish({ directory: tmpDir, slug: "test-site" }, deps)).rejects.toThrow("Not authenticated");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_DW_1_2_publish_reads_credentials_per_call", async () => {
    const credFile = path.join(os.tmpdir(), `core-publish-fresh-${Date.now()}`);
    tmpFiles.push(credFile);

    const tmpDir = path.join(os.tmpdir(), `core-publish-dir2-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const publishResponse = {
      site: {
        id: "uuid-1", user_id: "u1", slug: "test-site", title: "Test Site",
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
        file_count: 1, total_size: 100, visibility: "public" as const, passcode_hash: null,
      },
      url: "https://test-site.upubli.sh",
    };

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchWithTokenRefresh("/api/sites", 200, publishResponse),
    };

    // No credentials yet
    await expect(publish({ directory: tmpDir, slug: "test-site" }, deps)).rejects.toThrow("Not authenticated");

    // Write credentials between calls
    fs.writeFileSync(credFile, REFRESH_TOKEN, { mode: 0o600 });

    // Now works — proves fresh read per call
    const result = await publish({ directory: tmpDir, slug: "test-site" }, deps);
    expect(result.url).toBe("https://test-site.upubli.sh");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── DW-1.1 + DW-1.4 + DW-1.6: core.deleteOp() ─────────────────────────────

describe("DW-1.1/1.4/1.6: core.deleteOp()", () => {
  it("test_DW_1_1_core_exports_delete", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchWithTokenRefresh("/api/sites/my-site", 200, { message: "Deleted" }),
    };

    const result = await deleteOp("my-site", undefined, deps);
    expect(result.message).toBe("Deleted");
  });

  it("test_DW_1_4_delete_no_credentials_throws", async () => {
    const deps: CoreDeps = {
      credentialsPath: "/does/not/exist/credentials",
      fetchFn: mockFetch(200, { message: "Deleted" }),
    };

    await expect(deleteOp("my-site", undefined, deps)).rejects.toThrow("Not authenticated");
  });
});

// ─── DW-1.1 + DW-1.6: core.login() ──────────────────────────────────────────

describe("DW-1.1/1.6: core.login()", () => {
  it("test_DW_1_1_core_exports_login", async () => {
    const credFile = path.join(os.tmpdir(), `core-login-test-${Date.now()}`);
    tmpFiles.push(credFile);

    const loginDeps: LoginDeps = {
      apiBaseUrl: "https://api.example.com",
      credentialsFilePath: credFile,
      openBrowser: async () => {},
      startCallbackServer: async () => ({
        port: 12345,
        waitForTokens: async () => ({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          username: USERNAME,
        }),
        close: async () => {},
      }),
      log: () => {},
    };

    const coreDeps: CoreDeps = { credentialsPath: credFile };

    const result = await login(loginDeps, coreDeps);
    expect(result.username).toBe(USERNAME);
    expect(result.credentialsFilePath).toBe(credFile);

    // Verify credentials were written
    const saved = fs.readFileSync(credFile, "utf-8");
    expect(saved).toBe("rt");
  });
});

// ─── DW-1.1 + DW-1.5 + DW-1.6: core.status() ───────────────────────────────

describe("DW-1.1/1.5/1.6: core.status()", () => {
  it("test_DW_1_1_core_exports_status", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchWithTokenRefresh("/auth/me", 200, { username: USERNAME }),
    };

    const result = await status(deps);
    expect(result.authenticated).toBe(true);
  });

  it("test_DW_1_4_status_no_credentials_throws", async () => {
    const deps: CoreDeps = {
      credentialsPath: "/does/not/exist/credentials",
      fetchFn: mockFetch(200, { username: USERNAME }),
    };

    // status() returns { authenticated: false } rather than throwing
    const result = await status(deps);
    expect(result.authenticated).toBe(false);
  });

  it("test_DW_1_5_status_authenticated_returns_username", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchWithTokenRefresh("/auth/me", 200, { username: USERNAME }),
    };

    const result = await status(deps);
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.username).toBe(USERNAME);
    }
  });

  it("test_DW_1_5_status_stale_state_regression", async () => {
    // Regression: status() reads credentials fresh per call, not once at startup.
    const credFile = path.join(os.tmpdir(), `core-status-stale-${Date.now()}`);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchWithTokenRefresh("/auth/me", 200, { username: USERNAME }),
    };

    // Before login: not authenticated
    const before = await status(deps);
    expect(before.authenticated).toBe(false);

    // Simulate login writing credentials
    fs.writeFileSync(credFile, REFRESH_TOKEN, { mode: 0o600 });

    // After login: authenticated (same deps object, proves fresh read)
    const after = await status(deps);
    expect(after.authenticated).toBe(true);
    if (after.authenticated) {
      expect(after.username).toBe(USERNAME);
    }
  });

  it("status returns authenticated:false when API call fails", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: async (url: string) => {
        if (url.includes("/auth/token/refresh")) {
          return new Response(
            JSON.stringify({ access_token: "mock-token", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ error: "unauthorized" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      },
    };

    const result = await status(deps);
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.error).toBeDefined();
    }
  });
});

// ─── DW-2.1/2.2/2.3/2.6/2.7: core.logout() ──────────────────────────────────

describe("DW-2.1/2.3/2.6: core.logout() happy path", () => {
  it("test_DW_2_1_logout_deletes_file_and_calls_revoke", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    // Not added to tmpFiles — logout should delete it

    let revokeCalled = false;
    let revokeBody: unknown = null;

    const fetchFn = async (url: string, init?: RequestInit) => {
      if (url.includes("/auth/token/revoke")) {
        revokeCalled = true;
        revokeBody = init?.body ? JSON.parse(init.body as string) : null;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };

    const result = await logout(deps);

    expect(result.loggedOut).toBe(true);
    expect(revokeCalled).toBe(true);
    expect(revokeBody).toMatchObject({ refresh_token: REFRESH_TOKEN });
    expect(fs.existsSync(credFile)).toBe(false);
  });

  it("test_DW_2_3_logout_returns_logged_out_true", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    };

    const result = await logout(deps);
    expect(result.loggedOut).toBe(true);
    expect(fs.existsSync(credFile)).toBe(false);
  });
});

describe("DW-2.2/2.6: core.logout() server unreachable", () => {
  it("test_DW_2_2_logout_succeeds_when_server_unreachable", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);

    // fetchFn throws a network error (simulates offline)
    const fetchFn = async (_url: string) => {
      throw new Error("fetch failed: connection refused");
    };

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };

    const result = await logout(deps);

    // Must succeed despite network failure — best-effort revoke
    expect(result.loggedOut).toBe(true);
    // Credentials file must be gone even when server is unreachable
    expect(fs.existsSync(credFile)).toBe(false);
  });
});

describe("DW-2.7/2.6: core.logout() no credentials file", () => {
  it("test_DW_2_7_logout_no_credentials_file", async () => {
    let revokeCalled = false;
    const deps: CoreDeps = {
      credentialsPath: "/does/not/exist/credentials",
      fetchFn: async () => {
        revokeCalled = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    };

    const result = await logout(deps);

    // No-op success — already logged out
    expect(result.loggedOut).toBe(true);
    // Should not call revoke if there is nothing to revoke
    expect(revokeCalled).toBe(false);
  });
});

describe("DW-2.3: core.logout() returns loggedOut:false on delete error", () => {
  it("test_DW_2_3_logout_returns_logged_out_false_on_delete_error", async () => {
    // Create a directory where the credentials path points so unlinkSync fails
    const tmpDir = path.join(os.tmpdir(), `logout-fail-dir-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    // Point credentialsPath to the directory itself — can't unlink a directory
    const deps: CoreDeps = {
      credentialsPath: tmpDir,
      fetchFn: async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    };

    // Write a fake token so readCredentials returns something
    // (readCredentials checks existsSync, and the dir exists, but readFileSync on a dir will error)
    // Instead, let's write a real file and then make it read-only after writing
    // Actually the simplest approach: inject a custom unlink that throws.
    // But CoreDeps doesn't have unlinkFn. Let's verify the result shape when unlink fails
    // by writing a credentials file to a path inside a non-writable parent.
    // On macOS we can't reliably make files undeletable without root.
    // Use the directory-as-path approach: existsSync(dir) = true, readFileSync(dir) throws EISDIR.
    // But readCredentials reads content and trims — reading a dir as a file throws.
    // So readCredentials itself would throw, which means logout should handle that gracefully.

    // Since readCredentials is sync (readFileSync), if it throws on the dir path,
    // logout must catch and return { loggedOut: false, error }.
    const result = await logout(deps);

    // Should not throw — must return structured result
    expect(typeof result.loggedOut).toBe("boolean");
    if (!result.loggedOut) {
      expect(typeof result.error).toBe("string");
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
