/**
 * Tests for restoreSiteVersion() in lib/core.ts (Phase 1).
 *
 * Covers DW-1.1: core.ts exports restoreSiteVersion(slug, versionNumber,
 * namespace?, deps?). It builds the client via buildApiClient(deps) (credentials
 * read fresh), resolves the namespace, then delegates to the domain restoreVersion,
 * POSTing to .../versions/:version/rollback with the resolved nsId. Tested with
 * injected CoreDeps + a mock fetch (no real network calls).
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { restoreSiteVersion } from "./core.ts";
import type { CoreDeps } from "./core.ts";

const REFRESH_TOKEN = "test-refresh-token";
const NS_ID = "ns-test-id";

function writeTempCredentials(token: string): string {
  const tmpFile = path.join(
    os.tmpdir(),
    `core-restore-test-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(tmpFile, token, { mode: 0o600 });
  return tmpFile;
}

/** Mock fetch stubbing token-refresh, /api/space, /api/ns; delegates op to opFn. */
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
        JSON.stringify({
          namespaces: [
            { id: NS_ID, name: "default", domain: "user.upubli.sh" },
            { id: "ns-team", name: "team", domain: "team.upubli.sh" },
          ],
        }),
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

// ─── DW-1.1: core.restoreSiteVersion() ────────────────────────────────────────

describe("DW-1.1: core.restoreSiteVersion()", () => {
  it("test_DW_1_1_core_restore_version_resolves_default_namespace", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    let capturedUrl = "";
    let capturedMethod = "";
    const fetchFn = makeMockFetch((url, init) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return new Response(
        JSON.stringify({ url: "https://default.user.upubli.sh/my-site/" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    const result = await restoreSiteVersion("my-site", 2, undefined, deps);

    // Default namespace resolved (NS_ID from /api/space) and used in the rollback path.
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toContain(`/api/ns/${NS_ID}/sites/my-site/versions/2/rollback`);
    expect(result.version_number).toBe(2);
    expect(result.url).toBe("https://default.user.upubli.sh/my-site/");
  });

  it("test_DW_1_1_core_restore_version_resolves_named_namespace", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    tmpFiles.push(credFile);

    let capturedUrl = "";
    const fetchFn = makeMockFetch((url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ url: "https://team.upubli.sh/my-site/" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
    await restoreSiteVersion("my-site", 3, "team", deps);

    expect(capturedUrl).toContain("/api/ns/ns-team/sites/my-site/versions/3/rollback");
  });

  it("test_DW_1_1_core_restore_version_not_authenticated_throws", async () => {
    const deps: CoreDeps = {
      credentialsPath: "/does/not/exist/credentials",
      fetchFn: async () => new Response("{}", { status: 200 }),
    };

    await expect(restoreSiteVersion("my-site", 1, undefined, deps)).rejects.toThrow(
      "Not authenticated",
    );
  });
});
