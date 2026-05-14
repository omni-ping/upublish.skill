/**
 * Tests for lib/core.ts — high-level operations with internal credential/API wiring.
 *
 * Covers DW-1.1: core.ts exports list(), publish(), delete(), login(), status()
 * Covers DW-1.2: each function reads credentials from disk on every call
 * Covers DW-1.3: functions accept optional CoreDeps for test injection
 * Covers DW-1.4: calling core.list() with no credentials throws "Not authenticated"
 * Covers DW-1.5: calling core.status() after writing credentials returns { authenticated: true, username }
 * Covers DW-1.6: all 6 core functions have unit tests with injected deps
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

/**
 * Returns a mockFetch that handles both the token refresh endpoint and
 * a single API endpoint with a given response.
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

// ─── DW-1.1 + DW-1.6: core.list() ───────────────────────────────────────────

describe("DW-1.1/1.6: core.list()", () => {
  it("test_DW_1_1_core_exports_list", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchWithTokenRefresh("/api/sites", 200, { sites: [] }),
    };

    const result = await list(deps);
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

    const result = await list(deps);
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0].slug).toBe("my-site");
  });

  it("test_DW_1_4_list_no_credentials_throws", async () => {
    const deps: CoreDeps = {
      credentialsPath: "/does/not/exist/credentials",
      fetchFn: mockFetch(200, { sites: [] }),
    };

    await expect(list(deps)).rejects.toThrow("Not authenticated");
  });

  it("test_DW_1_2_list_reads_credentials_per_call", async () => {
    // First call: no credentials → throws
    const credFile = path.join(os.tmpdir(), `core-fresh-${Date.now()}`);
    tmpFiles.push(credFile);

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchWithTokenRefresh("/api/sites", 200, { sites: [] }),
    };

    await expect(list(deps)).rejects.toThrow("Not authenticated");

    // Write credentials between calls
    fs.writeFileSync(credFile, REFRESH_TOKEN, { mode: 0o600 });

    // Second call: credentials now present → succeeds (proves per-call read)
    const result = await list(deps);
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

    const result = await deleteOp("my-site", deps);
    expect(result.message).toBe("Deleted");
  });

  it("test_DW_1_4_delete_no_credentials_throws", async () => {
    const deps: CoreDeps = {
      credentialsPath: "/does/not/exist/credentials",
      fetchFn: mockFetch(200, { message: "Deleted" }),
    };

    await expect(deleteOp("my-site", deps)).rejects.toThrow("Not authenticated");
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
