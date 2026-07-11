/**
 * Tests for nested-path publishing at the MCP adapter boundary.
 *
 * These drive createServer() through an in-memory MCP tools/call request so the
 * registered input schemas and handlers are exercised together, then capture
 * the API payloads produced by the core/domain path.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../mcp/index.ts";
import type { CoreDeps } from "./core.ts";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

const REFRESH_TOKEN = "test-refresh-token";
const NS_ID = "ns-test-id";

const tmpFiles: string[] = [];
const tmpDirs: string[] = [];
const connectedClients: Array<{ client: Client; server: ReturnType<typeof createServer> }> = [];

afterEach(async () => {
  for (const { client, server } of connectedClients) {
    try { await client.close(); } catch { /* ignore */ }
    try { await server.close(); } catch { /* ignore */ }
  }
  connectedClients.length = 0;

  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;

  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

function writeTempCredentials(): string {
  const p = path.join(
    os.tmpdir(),
    `mcp-path-prefix-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(p, REFRESH_TOKEN, { mode: 0o600 });
  tmpFiles.push(p);
  return p;
}

function makeTmpSiteDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-path-prefix-site-"));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Hello</h1>");
  return dir;
}

async function connectClient(deps: CoreDeps): Promise<Client> {
  const server = createServer(deps);
  const client = new Client({ name: "mcp-path-prefix-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connectedClients.push({ client, server });

  return client;
}

function authAndNamespaceFetch(
  opFn: (url: string, init?: RequestInit) => Response | Promise<Response>,
): CoreDeps["fetchFn"] {
  return async (url: string, init?: RequestInit) => {
    if (url.includes("/auth/token/refresh")) {
      return new Response(
        JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.endsWith("/api/space") || url.includes("/api/space?")) {
      return new Response(
        JSON.stringify({ space: { id: "sp1", default_namespace_id: NS_ID, tier: "pro" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
      return new Response(
        JSON.stringify({
          namespaces: [{ id: NS_ID, name: "default", domain: "user.upubli.sh", role: "owner" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return opFn(url, init);
  };
}

describe("MCP path_prefix adapter wiring", () => {
  it("test_mcp_publish_with_path_prefix_forwards_to_manifest_payload", async () => {
    const dir = makeTmpSiteDir();
    let capturedManifestBody: Record<string, unknown> | undefined;

    const fetchFn = authAndNamespaceFetch((url, init) => {
      if (url.includes("/manifest")) {
        capturedManifestBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            needed: [],
            version: 1,
            session_id: "sess-1",
            base_version: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/finalize")) {
        return new Response(
          JSON.stringify({
            site: {
              id: "site-1",
              user_id: "user-1",
              slug: "code-report",
              title: "Code Report",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
              file_count: 1,
              total_size: 14,
              visibility: "public",
              passcode_hash: null,
            },
            url: "https://user.upubli.sh/2026/q3/code-report/",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ error: "unexpected request" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = await connectClient({ credentialsPath: writeTempCredentials(), fetchFn });
    const result = await client.callTool({
      name: "publish",
      arguments: {
        directory: dir,
        slug: "code-report",
        path_prefix: "2026/q3",
        title: "Code Report",
      },
    }) as ToolResult;

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("https://user.upubli.sh/2026/q3/code-report/");
    expect(capturedManifestBody?.path_prefix).toBe("2026/q3");
  });

  it("test_mcp_rename_sets_path_prefix_in_api_payload", async () => {
    let capturedRenameBody: Record<string, unknown> | undefined;

    const fetchFn = authAndNamespaceFetch((url, init) => {
      if (url.includes(`/api/ns/${NS_ID}/sites/old-slug/rename`)) {
        capturedRenameBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            slug: "new-slug",
            url: "https://user.upubli.sh/2026/q4/new-slug/",
            redirect_expires_at: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ error: "unexpected request" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = await connectClient({ credentialsPath: writeTempCredentials(), fetchFn });
    const result = await client.callTool({
      name: "rename",
      arguments: {
        nsId: "default",
        site: "old-slug",
        newName: "new-slug",
        path_prefix: "2026/q4",
        redirect: "30d",
      },
    }) as ToolResult;

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("https://user.upubli.sh/2026/q4/new-slug/");
    expect(capturedRenameBody).toMatchObject({
      new_slug: "new-slug",
      redirect: "30d",
      path_prefix: "2026/q4",
    });
  });

  it("test_mcp_invalid_path_prefix_is_rejected_before_core_invocation", async () => {
    let fetchCalls = 0;
    const fetchFn: CoreDeps["fetchFn"] = async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ error: "should not be called" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = await connectClient({ credentialsPath: writeTempCredentials(), fetchFn });
    const result = await client.callTool({
      name: "rename",
      arguments: {
        nsId: "default",
        site: "old-slug",
        newName: "new-slug",
        path_prefix: 42,
      },
    }) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Input validation error");
    expect(result.content[0]?.text).toContain("path_prefix");
    expect(fetchCalls).toBe(0);
  });
});
