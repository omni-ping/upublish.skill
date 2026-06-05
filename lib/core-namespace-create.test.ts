/**
 * Phase 5 tests — core.namespaceCreate() facade.
 *
 * The MCP `namespace_create` tool reaches the API only through the core facade
 * (adapters import core.ts only). This verifies the facade reads credentials
 * fresh, builds an authenticated client, and returns {namespace_id, domain}.
 *
 * Covers DW-5.3 (facade path) and DW-5.5 (CoreDeps injection, no real network).
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { namespaceCreate } from "./core.ts";
import type { CoreDeps } from "./core.ts";

const REFRESH_TOKEN = "test-refresh-token";

const tmpFiles: string[] = [];

afterEach(() => {
  for (const f of tmpFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  tmpFiles.length = 0;
});

function writeTempCredentials(token: string): string {
  const tmpFile = path.join(os.tmpdir(), `core-nscreate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmpFile, token, { mode: 0o600 });
  tmpFiles.push(tmpFile);
  return tmpFile;
}

/** Handles the token refresh, then the POST /api/ns. */
function mockFetchCreate(status: number, body: unknown) {
  return async (url: string): Promise<Response> => {
    if (url.includes("/auth/token/refresh")) {
      return new Response(
        JSON.stringify({ access_token: "mock-access", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("DW-5.3/5.5: core.namespaceCreate()", () => {
  it("test_DW_5_3_core_namespace_create_facade", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: mockFetchCreate(201, { namespace: { id: "ns-core-1", name: "carol", domain: "upubli.sh" } }),
    };

    const result = await namespaceCreate("carol", undefined, deps);
    expect(result).toEqual({ namespace_id: "ns-core-1", domain: "upubli.sh" });
  });

  it("test_DW_5_5_core_namespace_create_requires_auth", async () => {
    const deps: CoreDeps = {
      credentialsPath: "/definitely/does/not/exist/credentials",
      fetchFn: mockFetchCreate(201, {}),
    };
    await expect(namespaceCreate("dave", undefined, deps)).rejects.toThrow(/Not authenticated/i);
  });

  it("test_DW_5_3_core_namespace_create_passes_domain", async () => {
    const credFile = writeTempCredentials(REFRESH_TOKEN);
    let capturedBody: Record<string, unknown> = {};
    const deps: CoreDeps = {
      credentialsPath: credFile,
      fetchFn: async (url: string, init?: RequestInit): Promise<Response> => {
        if (url.includes("/auth/token/refresh")) {
          return new Response(
            JSON.stringify({ access_token: "a", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ namespace: { id: "ns-x", name: "eve", domain: "coolsites.io" } }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      },
    };

    const result = await namespaceCreate("eve", "coolsites.io", deps);
    expect(capturedBody).toEqual({ name: "eve", domain: "coolsites.io" });
    expect(result.domain).toBe("coolsites.io");
  });
});
