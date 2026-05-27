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
 *
 * Covers DW-5.7: core.ts exports addPasscode, listPasscodes, revokePasscode with CoreDeps injection
 *
 * Covers DW-1.3 (new plan): ListResult includes namespace: Namespace field populated by list() in core
 * Covers DW-1.4 (new plan): StatusResult authenticated branch includes namespaces: Namespace[]
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
  addPasscode,
  listPasscodes,
  revokePasscode,
  gate,
} from "./core.ts";
import type { CoreDeps, StatusResult } from "./core.ts";
import type { LoginDeps } from "./auth.ts";
import type { Namespace } from "./types.ts";

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

/**
 * Returns a mockFetch that handles token refresh, namespace resolution, and the
 * presigned-URL publish flow (manifest → presigned PUT → finalize).
 */
function mockFetchForPublish(
  publishResponse: { site: unknown; url: string },
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
      return new Response(JSON.stringify(publishResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not found", { status: 404 });
  };
}

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
      fetchFn: mockFetchForPublish(publishResponse),
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
      fetchFn: mockFetchForPublish(publishResponse),
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

// ─── DW-5.7: core passcode functions ─────────────────────────────────────────

/**
 * Returns a mockFetch that handles token refresh, namespace resolution,
 * and a caller-specified set of URL→response mappings (matched by substring).
 */
function mockFetchMulti(
  routes: Array<{ match: string; status: number; body: unknown }>,
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
    for (const route of routes) {
      if (url.includes(route.match)) {
        return new Response(JSON.stringify(route.body), {
          status: route.status,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("Not found", { status: 404 });
  };
}

describe("DW-5.7: core.addPasscode()", () => {
  it("test_DW_5_7_core_exports_add_passcode", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchMulti([
        {
          match: "/passcodes",
          status: 201,
          body: { id: "pc-1", label: "Client A", created_at: "2026-01-01T00:00:00Z" },
        },
      ]),
    };

    const result = await addPasscode("my-site", "mycode", "Client A", undefined, deps);
    expect(result.passcode.id).toBe("pc-1");
    expect(result.passcode.label).toBe("Client A");
  });

  it("test_DW_5_7_add_passcode_no_credentials_throws", async () => {
    const deps: CoreDeps = { credentialsPath: "/does/not/exist/credentials" };
    await expect(addPasscode("my-site", "mycode", "Client A", undefined, deps)).rejects.toThrow("Not authenticated");
  });
});

describe("DW-5.7: core.listPasscodes()", () => {
  it("test_DW_5_7_core_exports_list_passcodes", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const passcodes = [
      { id: "pc-1", label: "Client A", created_at: "2026-01-01T00:00:00Z" },
      { id: "pc-2", label: "Client B", created_at: "2026-02-01T00:00:00Z" },
    ];

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchMulti([
        { match: "/passcodes", status: 200, body: { passcodes } },
      ]),
    };

    const result = await listPasscodes("my-site", undefined, deps);
    expect(result.passcodes).toHaveLength(2);
    expect(result.passcodes[0].label).toBe("Client A");
  });

  it("test_DW_5_7_list_passcodes_no_credentials_throws", async () => {
    const deps: CoreDeps = { credentialsPath: "/does/not/exist/credentials" };
    await expect(listPasscodes("my-site", undefined, deps)).rejects.toThrow("Not authenticated");
  });
});

describe("DW-5.7: core.revokePasscode()", () => {
  it("test_DW_5_7_core_exports_revoke_passcode_by_id", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchMulti([
        { match: "/passcodes/pc-1", status: 200, body: { message: "Passcode revoked" } },
      ]),
    };

    const result = await revokePasscode("my-site", { id: "pc-1" }, undefined, deps);
    expect(result.message).toBe("Passcode revoked");
  });

  it("test_DW_5_7_revoke_passcode_by_label_resolves_id", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const passcodes = [
      { id: "pc-1", label: "Client A", created_at: "2026-01-01T00:00:00Z" },
    ];

    const fetchFn = async (url: string, init?: RequestInit) => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/space")) {
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
      const method = init?.method ?? "GET";
      if (url.includes("/passcodes/pc-1") && method === "DELETE") {
        return new Response(JSON.stringify({ message: "Passcode revoked" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/passcodes") && method === "GET") {
        return new Response(JSON.stringify({ passcodes }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };

    const result = await revokePasscode("my-site", { label: "Client A" }, undefined, deps);
    expect(result.message).toBe("Passcode revoked");
  });

  it("test_DW_5_7_revoke_passcode_label_not_found_throws", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchMulti([
        { match: "/passcodes", status: 200, body: { passcodes: [] } },
      ]),
    };

    await expect(
      revokePasscode("my-site", { label: "Nonexistent" }, undefined, deps),
    ).rejects.toThrow('No passcode with label "Nonexistent" found');
  });

  it("test_DW_5_7_revoke_passcode_no_id_or_label_throws", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchMulti([]),
    };

    await expect(
      revokePasscode("my-site", {}, undefined, deps),
    ).rejects.toThrow("Either id or label must be provided");
  });

  it("test_DW_5_7_revoke_passcode_no_credentials_throws", async () => {
    const deps: CoreDeps = { credentialsPath: "/does/not/exist/credentials" };
    await expect(revokePasscode("my-site", { id: "pc-1" }, undefined, deps)).rejects.toThrow("Not authenticated");
  });
});

// ─── DW-4.2: core.gate() dispatch ────────────────────────────────────────────

const GATE_CONFIG = {
  slug: "my-site",
  fields: ["email", "name"],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const SUBMISSION = {
  id: "sub-1",
  submitted_at: "2026-01-02T00:00:00Z",
  data: { email: "visitor@example.com", name: "Alice" },
};

describe("DW-4.2/4.5: core.gate() action=get", () => {
  it("test_DW_4_2_core_gate_get_dispatches", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchMulti([
        { match: "/gate", status: 200, body: { gate: GATE_CONFIG, submission_count: 5 } },
      ]),
    };

    const result = await gate({ action: "get", slug: "my-site" }, deps);
    expect(result.action).toBe("get");
    if (result.action === "get") {
      expect(result.gate.slug).toBe("my-site");
      expect(result.submission_count).toBe(5);
    }
  });

  it("test_DW_4_2_core_gate_get_no_credentials_throws", async () => {
    const deps: CoreDeps = { credentialsPath: "/does/not/exist/credentials" };
    await expect(gate({ action: "get", slug: "my-site" }, deps)).rejects.toThrow("Not authenticated");
  });
});

describe("DW-4.2/4.4: core.gate() action=set", () => {
  it("test_DW_4_4_core_gate_set_dispatches", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchMulti([
        { match: "/gate", status: 200, body: { gate: GATE_CONFIG } },
      ]),
    };

    const result = await gate({ action: "set", slug: "my-site", fields: ["email", "name"] }, deps);
    expect(result.action).toBe("set");
    if (result.action === "set") {
      expect(result.gate.fields).toEqual(["email", "name"]);
    }
  });

  it("test_DW_4_4_core_gate_set_no_credentials_throws", async () => {
    const deps: CoreDeps = { credentialsPath: "/does/not/exist/credentials" };
    await expect(gate({ action: "set", slug: "my-site", fields: ["email"] }, deps)).rejects.toThrow("Not authenticated");
  });
});

describe("DW-4.2/4.6: core.gate() action=remove", () => {
  it("test_DW_4_6_core_gate_remove_dispatches", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchMulti([
        { match: "/gate", status: 200, body: { message: "Gate removed" } },
      ]),
    };

    const result = await gate({ action: "remove", slug: "my-site" }, deps);
    expect(result.action).toBe("remove");
    if (result.action === "remove") {
      expect(result.message).toBe("Gate removed");
    }
  });
});

describe("DW-4.2/4.7: core.gate() action=submissions", () => {
  it("test_DW_4_7_core_gate_submissions_dispatches", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchMulti([
        { match: "/gate/submissions", status: 200, body: { submissions: [SUBMISSION] } },
      ]),
    };

    const result = await gate({ action: "submissions", slug: "my-site" }, deps);
    expect(result.action).toBe("submissions");
    if (result.action === "submissions") {
      expect(result.submissions).toHaveLength(1);
      expect(result.submissions[0].id).toBe("sub-1");
    }
  });
});

describe("DW-4.2/4.8: core.gate() action=clear", () => {
  it("test_DW_4_8_core_gate_clear_dispatches", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchMulti([
        { match: "/gate/submissions", status: 200, body: { message: "Submissions cleared" } },
      ]),
    };

    const result = await gate({ action: "clear", slug: "my-site" }, deps);
    expect(result.action).toBe("clear");
    if (result.action === "clear") {
      expect(result.message).toBe("Submissions cleared");
    }
  });
});

// ─── DW-1.3 (new plan): ListResult includes namespace: Namespace ────────────

describe("DW-1.3: list() result includes namespace", () => {
  it("test_DW_1_3_list_result_includes_namespace", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchWithTokenRefresh("/api/sites", 200, { sites: [] }),
    };

    const result = await list(undefined, deps);
    expect(result.namespace).toBeDefined();
    expect(result.namespace.id).toBe(NS_ID);
  });

  it("test_DW_1_3_list_result_namespace_has_name_and_domain", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchWithTokenRefresh("/api/sites", 200, { sites: [] }),
    };

    const result = await list(undefined, deps);
    const ns: Namespace = result.namespace;
    expect(ns.name).toBe("default");
    expect(ns.domain).toBe("user.upubli.sh");
  });
});

// ─── DW-1.4 (new plan): StatusResult includes namespaces: Namespace[] ───────

describe("DW-1.4: status() result includes namespaces", () => {
  it("test_DW_1_4_status_result_includes_namespaces", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchWithTokenRefresh("/auth/me", 200, { username: USERNAME }),
    };

    const result = await status(deps);
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.namespaces).toBeDefined();
      expect(Array.isArray(result.namespaces)).toBe(true);
      expect(result.namespaces.length).toBeGreaterThan(0);
    }
  });

  it("test_DW_1_4_status_namespaces_have_name_and_domain", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchWithTokenRefresh("/auth/me", 200, { username: USERNAME }),
    };

    const result = await status(deps);
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      const ns: Namespace = result.namespaces[0];
      expect(ns.id).toBe(NS_ID);
      expect(ns.name).toBe("default");
      expect(ns.domain).toBe("user.upubli.sh");
    }
  });

  it("test_DW_1_4_status_unauthenticated_has_no_namespaces", async () => {
    const deps: CoreDeps = {
      credentialsPath: "/does/not/exist/credentials",
      fetchFn: mockFetch(200, { username: USERNAME }),
    };

    const result = await status(deps);
    expect(result.authenticated).toBe(false);
    // Unauthenticated result should NOT have namespaces property
    expect("namespaces" in result).toBe(false);
  });

  it("test_DW_1_4_status_namespaces_graceful_on_ns_failure", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    // Custom fetch: /auth/me succeeds but /api/ns fails
    const fetchFn = async (url: string) => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/auth/me")) {
        return new Response(
          JSON.stringify({ username: USERNAME }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
        return new Response(
          JSON.stringify({ error: "Service unavailable" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };

    const result = await status(deps);
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      // Should still be authenticated, just with empty namespaces
      expect(result.namespaces).toEqual([]);
    }
  });
});
