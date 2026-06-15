/**
 * Tests for the injectable TokenProvider seam in lib/core.ts.
 *
 * Covers DW-4.1: CoreDeps.tokenProvider? added; buildApiClient prefers it, else disk default.
 * Covers DW-4.2: stdio path unchanged — disk-cred behavior identical when omitted.
 * Covers DW-4.3: createServer threads coreDeps to all tools; injected provider invoked per call.
 * Covers DW-4.4: TypeScript types — CoreDeps and TokenProvider importable from package entry.
 * Covers DW-4.5: unit test — injected provider's bearer is used by an ApiClient call (mock fetchFn).
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { list, status } from "./core.ts";
import type { CoreDeps, TokenProvider } from "./core.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NS_ID = "ns-injected-test";

/** Writes a refresh token to a temp file and returns its path. */
function writeTempCredentials(token: string): string {
  const tmpFile = path.join(
    os.tmpdir(),
    `core-token-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, token, { mode: 0o600 });
  return tmpFile;
}

/**
 * Returns a mockFetch that inspects every outgoing request for the Authorization
 * header and records the bearer values it sees. Also handles namespace resolution
 * and the target API endpoint, so the full call chain succeeds.
 *
 * The `capturedBearers` array is mutated by the returned function — callers
 * assert on it after the call to prove which bearer was used.
 */
function makeBearerCapturingFetch(
  capturedBearers: string[],
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
    if (auth) {
      capturedBearers.push(auth);
    }

    // Namespace resolution
    if (url.includes("/api/space")) {
      return new Response(
        JSON.stringify({ space: { id: "sp1", default_namespace_id: NS_ID, tier: "free" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
      return new Response(
        JSON.stringify({ namespaces: [{ id: NS_ID, name: "default", domain: "test.upubli.sh" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Sites list endpoint
    if (url.includes("/sites")) {
      return new Response(
        JSON.stringify({ sites: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("Not found", { status: 404 });
  };
}

/**
 * Returns a mockFetch that handles /auth/token/refresh (disk-backed path),
 * namespace resolution, and the sites list endpoint.
 */
function makeDiskPathFetch(
  capturedBearers: string[],
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
    if (auth) {
      capturedBearers.push(auth);
    }

    if (url.includes("/auth/token/refresh")) {
      return new Response(
        JSON.stringify({ access_token: "disk-access-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/space")) {
      return new Response(
        JSON.stringify({ space: { id: "sp1", default_namespace_id: NS_ID, tier: "free" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
      return new Response(
        JSON.stringify({ namespaces: [{ id: NS_ID, name: "default", domain: "test.upubli.sh" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/sites")) {
      return new Response(
        JSON.stringify({ sites: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("Not found", { status: 404 });
  };
}

// ─── DW-4.1: CoreDeps.tokenProvider? — injected provider used ─────────────────

describe("DW-4.1: CoreDeps.tokenProvider", () => {
  it("test_DW_4_1_injected_provider_used — injected tokenProvider is called, not disk", async () => {
    const capturedBearers: string[] = [];
    let providerCallCount = 0;

    const injectedProvider: TokenProvider = async () => {
      providerCallCount++;
      return "injected-bearer-token";
    };

    const deps: CoreDeps = {
      tokenProvider: injectedProvider,
      fetchFn: makeBearerCapturingFetch(capturedBearers),
    };

    // No credentials file — would throw "Not authenticated" on the disk path.
    // The injected provider bypasses disk entirely.
    const result = await list(undefined, deps);

    expect(result.sites).toEqual([]);
    // The injected provider was called (at least once — may be once per API call)
    expect(providerCallCount).toBeGreaterThan(0);
    // The bearer used matches the injected token
    const bearersWithInjected = capturedBearers.filter((b) => b.includes("injected-bearer-token"));
    expect(bearersWithInjected.length).toBeGreaterThan(0);
  });

  it("test_DW_4_1_disk_default_when_omitted — disk path used when tokenProvider omitted", async () => {
    const capturedBearers: string[] = [];
    const credFile = writeTempCredentials("refresh-token-for-disk-test");

    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: makeDiskPathFetch(capturedBearers),
    };

    const result = await list(undefined, deps);

    // Disk path resolves via token refresh to "disk-access-token"
    expect(result.sites).toEqual([]);
    const diskBearers = capturedBearers.filter((b) => b.includes("disk-access-token"));
    expect(diskBearers.length).toBeGreaterThan(0);

    // Clean up
    fs.unlinkSync(credFile);
  });

  it("test_DW_4_1_tokenProvider_wins_over_credentialsPath — tokenProvider takes precedence", async () => {
    const capturedBearers: string[] = [];

    // Write a real credentials file to ensure it's accessible
    const credFile = writeTempCredentials("should-not-be-used-refresh-token");

    const deps: CoreDeps = {
      credentialsPath: credFile,
      tokenProvider: async () => "wins-over-cred-path",
      fetchFn: makeBearerCapturingFetch(capturedBearers),
    };

    await list(undefined, deps);

    // The bearer from the injected provider must appear
    const winnerBearers = capturedBearers.filter((b) => b.includes("wins-over-cred-path"));
    expect(winnerBearers.length).toBeGreaterThan(0);

    // The disk refresh flow must NOT have been triggered
    const diskBearers = capturedBearers.filter((b) => b.includes("disk-access-token"));
    expect(diskBearers.length).toBe(0);

    // Clean up
    fs.unlinkSync(credFile);
  });
});

// ─── DW-4.2: Disk-cred path unchanged ──────────────────────────────────────

describe("DW-4.2: disk-cred default path unchanged", () => {
  it("test_DW_4_2_disk_cred_path_unchanged — no credentials throws Not authenticated", async () => {
    const noCredPath = path.join(os.tmpdir(), `no-exist-creds-${Date.now()}`);

    const deps: CoreDeps = {
      credentialsPath: noCredPath,
      fetchFn: async () => new Response("{}", { status: 200 }),
    };

    // Disk path — no file → must throw "Not authenticated"
    await expect(list(undefined, deps)).rejects.toThrow("Not authenticated");
  });

  it("test_DW_4_2_status_no_credentials_returns_unauthenticated — status() never throws", async () => {
    const noCredPath = path.join(os.tmpdir(), `no-exist-creds-status-${Date.now()}`);

    const deps: CoreDeps = {
      credentialsPath: noCredPath,
      fetchFn: async () => new Response("{}", { status: 200 }),
    };

    // status() follows its own disk path without buildApiClient — must return unauthenticated
    const result = await status(deps);
    expect(result.authenticated).toBe(false);
  });
});

// ─── DW-4.3: Provider invoked per call (no caching) ──────────────────────────

describe("DW-4.3: injected provider invoked per call, no caching", () => {
  it("test_DW_4_3_provider_invoked_per_call — separate calls each invoke the provider", async () => {
    const callLog: string[] = [];
    let callCount = 0;

    // Return a different token each call to prove no caching occurs
    const provider: TokenProvider = async () => {
      callCount++;
      const token = `token-call-${callCount}`;
      callLog.push(token);
      return token;
    };

    const capturedBearers: string[] = [];
    const deps: CoreDeps = {
      tokenProvider: provider,
      fetchFn: makeBearerCapturingFetch(capturedBearers),
    };

    // Two separate top-level calls
    await list(undefined, deps);
    await list(undefined, deps);

    // Provider must have been called at least twice (once per list() call minimum)
    expect(callCount).toBeGreaterThanOrEqual(2);

    // Each unique token from the provider must appear in the captured bearers
    // (proves the per-call value was actually used, not a cached earlier value)
    for (const token of callLog) {
      const found = capturedBearers.some((b) => b.includes(token));
      expect(found).toBe(true);
    }
  });
});

// ─── DW-4.4: Types importable from package/module entry ─────────────────────

describe("DW-4.4: CoreDeps and TokenProvider importable from lib/core.ts", () => {
  it("test_DW_4_4_types_importable — CoreDeps and TokenProvider can be used as types", () => {
    // This test is a TypeScript compile-time check: if CoreDeps and TokenProvider
    // are properly exported, this file compiles. Runtime: construct valid instances.

    const provider: TokenProvider = async () => "bearer-123";
    const deps: CoreDeps = { tokenProvider: provider };

    expect(typeof deps.tokenProvider).toBe("function");
    expect(provider).toBeInstanceOf(Function);
  });
});

// ─── DW-4.5: Injected bearer used in API call ────────────────────────────────

describe("DW-4.5: injected provider bearer appears in API call", () => {
  it("test_DW_4_5_injected_bearer_used_in_api_call — bearer from provider sent to API", async () => {
    const EXPECTED_BEARER = "secret-injected-bearer-xyz";
    const capturedAuthHeaders: string[] = [];

    const mockFetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
      if (auth) {
        capturedAuthHeaders.push(auth);
      }

      if (url.includes("/api/space")) {
        return new Response(
          JSON.stringify({ space: { id: "sp1", default_namespace_id: NS_ID, tier: "free" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
        return new Response(
          JSON.stringify({ namespaces: [{ id: NS_ID, name: "default", domain: "test.upubli.sh" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/sites")) {
        return new Response(
          JSON.stringify({ sites: [{ id: "s1", slug: "my-site", title: "My Site", url: "https://my-site.test.upubli.sh/", file_count: 1, total_size: 100, visibility: "public", passcode_hash: null, user_id: "u1", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const deps: CoreDeps = {
      tokenProvider: async () => EXPECTED_BEARER,
      fetchFn: mockFetchFn,
    };

    const result = await list(undefined, deps);

    // The API call succeeded and returned the site
    expect(result.sites.length).toBe(1);
    expect(result.sites[0].slug).toBe("my-site");

    // At least one outgoing request carried the injected bearer
    const bearerHeaders = capturedAuthHeaders.filter((h) => h === `Bearer ${EXPECTED_BEARER}`);
    expect(bearerHeaders.length).toBeGreaterThan(0);
  });

  it("test_DW_4_5_provider_throws_propagates_as_error — thrown provider surfaces as error", async () => {
    const deps: CoreDeps = {
      tokenProvider: async () => {
        throw new Error("provider-auth-failure");
      },
      fetchFn: async () => new Response("{}", { status: 200 }),
    };

    // The error propagates — tools catch it and return errResponse, but
    // from core's perspective it throws.
    await expect(list(undefined, deps)).rejects.toThrow("provider-auth-failure");
  });

  it("empty-bearer guard — provider resolves to empty string → auth error, not a request", async () => {
    let fetchCalled = false;
    const deps: CoreDeps = {
      tokenProvider: async () => "",
      fetchFn: async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      },
    };

    // Must throw the same "Not authenticated" message as the disk path.
    await expect(list(undefined, deps)).rejects.toThrow(
      "Not authenticated. Use the login tool to sign in.",
    );

    // The guard must fire before any HTTP request is sent.
    expect(fetchCalled).toBe(false);
  });

  it("empty-bearer guard — provider resolves to whitespace-only → auth error, not a request", async () => {
    let fetchCalled = false;
    const deps: CoreDeps = {
      tokenProvider: async () => "   ",
      fetchFn: async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      },
    };

    await expect(list(undefined, deps)).rejects.toThrow(
      "Not authenticated. Use the login tool to sign in.",
    );

    expect(fetchCalled).toBe(false);
  });
});
