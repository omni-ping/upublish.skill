/**
 * MCP server tests for preview + promote features.
 *
 * Covers DW-3.4: MCP publish tool has preview boolean parameter in its input schema
 * Covers DW-3.5: MCP publish tool response shows preview URL when preview is true
 * Covers DW-3.8: MCP promote tool registered with slug and optional namespace params
 */

import { describe, test, expect, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { createServer } from "../mcp/index.ts";
import type { CoreDeps } from "../lib/core.ts";

// ─── Test types ───────────────────────────────────────────────────────────────

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type RegisteredTool = {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  inputSchema?: Record<string, unknown>;
};

type RegisteredTools = Record<string, RegisteredTool>;

type InternalServer = { _registeredTools: RegisteredTools };

// ─── Mock helpers ─────────────────────────────────────────────────────────────

const REFRESH_TOKEN = "test-refresh-token";
const DEFAULT_NS_ID = "ns-default";
const LIVE_URL = "https://testuser.upubli.sh/my-site/";
const PREVIEW_URL = "https://testuser.upubli.sh/my-site/@v2/";

const SAMPLE_SITE = {
  id: "abc123",
  user_id: "user1",
  slug: "my-site",
  title: "My Site",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  file_count: 1,
  total_size: 512,
  visibility: "public",
  passcode_hash: null,
  url: LIVE_URL,
};

function writeTempCredentials(token: string): string {
  const tmpFile = path.join(
    os.tmpdir(),
    `mcp-preview-test-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(tmpFile, token, { mode: 0o600 });
  return tmpFile;
}

function makeMockFetch(overrideFn?: (url: string, init?: RequestInit) => Promise<Response> | null) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    // Let override handle it first
    if (overrideFn) {
      const override = await overrideFn(url, init);
      if (override !== null) return override;
    }

    if (url.includes("/auth/token/refresh")) {
      return new Response(
        JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/api/space") || url.includes("/api/space?")) {
      return new Response(
        JSON.stringify({ space: { id: "sp1", default_namespace_id: DEFAULT_NS_ID, tier: "free" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
      return new Response(
        JSON.stringify({ namespaces: [{ id: DEFAULT_NS_ID, name: "default", domain: "user.upubli.sh" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function makeDeps(fetchFn = makeMockFetch()): { credFile: string; deps: CoreDeps } {
  const credFile = writeTempCredentials(REFRESH_TOKEN);
  return { credFile, deps: { credentialsPath: credFile, fetchFn } };
}

function getTools(server: ReturnType<typeof createServer>): RegisteredTools {
  return (server as unknown as InternalServer)._registeredTools;
}

const tmpDirs: string[] = [];
const tmpCredFiles: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
  for (const f of tmpCredFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  tmpCredFiles.length = 0;
});

// ─── DW-3.4: MCP publish tool has preview boolean parameter ──────────────────

describe("DW-3.4: MCP publish tool has preview parameter", () => {
  test("test_DW_3_4_mcp_publish_tool_passes_preview_to_core", async () => {
    let sentPreviewField = false;

    const fetchFn = makeMockFetch(async (url, init) => {
      if (url.includes("/sites") && init?.method === "POST") {
        const form = init.body as FormData;
        if (form?.get("preview") === "true") {
          sentPreviewField = true;
        }
        return new Response(
          JSON.stringify({
            site: SAMPLE_SITE,
            url: LIVE_URL,
            preview_url: PREVIEW_URL,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return null as unknown as Response;
    });

    const { credFile, deps } = makeDeps(fetchFn);
    tmpCredFiles.push(credFile);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-preview-pub-"));
    tmpDirs.push(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const server = createServer(deps);
    const tools = getTools(server);

    await tools["publish"].handler({
      directory: tmpDir,
      slug: "my-site",
      preview: true,
    });

    expect(sentPreviewField).toBe(true);
  });
});

// ─── DW-3.5: MCP publish tool response shows preview URL when preview is true ─

describe("DW-3.5: MCP publish tool response uses preview URL", () => {
  test("test_DW_3_5_mcp_publish_response_shows_preview_url", async () => {
    const fetchFn = makeMockFetch(async (url, init) => {
      if (url.includes("/sites") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            site: SAMPLE_SITE,
            url: LIVE_URL,
            preview_url: PREVIEW_URL,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return null as unknown as Response;
    });

    const { credFile, deps } = makeDeps(fetchFn);
    tmpCredFiles.push(credFile);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-preview-resp-"));
    tmpDirs.push(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["publish"].handler({
      directory: tmpDir,
      slug: "my-site",
      preview: true,
    });

    const text = result.content[0].text;
    // Response must include the preview URL (not just the live URL)
    expect(text).toContain(PREVIEW_URL);
    expect(text).not.toBe(undefined);
  });

  test("test_DW_3_5_mcp_publish_response_shows_live_url_for_normal_publish", async () => {
    const fetchFn = makeMockFetch(async (url, init) => {
      if (url.includes("/sites") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ site: SAMPLE_SITE, url: LIVE_URL }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return null as unknown as Response;
    });

    const { credFile, deps } = makeDeps(fetchFn);
    tmpCredFiles.push(credFile);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-live-resp-"));
    tmpDirs.push(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>");

    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["publish"].handler({
      directory: tmpDir,
      slug: "my-site",
    });

    const text = result.content[0].text;
    expect(text).toContain(LIVE_URL);
  });
});

// ─── DW-3.8: MCP promote tool registered with slug + optional namespace ───────

describe("DW-3.8: MCP promote tool registered", () => {
  test("test_DW_3_8_promote_tool_is_registered", () => {
    const { credFile, deps } = makeDeps();
    tmpCredFiles.push(credFile);

    const server = createServer(deps);
    const tools = getTools(server);
    expect("promote" in tools).toBe(true);
  });

  test("test_DW_3_8_mcp_promote_tool_calls_core_promote", async () => {
    let promoteCalled = false;

    const fetchFn = makeMockFetch(async (url, init) => {
      if (url.includes("/promote") && init?.method === "POST") {
        promoteCalled = true;
        return new Response(
          JSON.stringify({ url: LIVE_URL }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return null as unknown as Response;
    });

    const { credFile, deps } = makeDeps(fetchFn);
    tmpCredFiles.push(credFile);

    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["promote"].handler({ slug: "my-site" });

    expect(promoteCalled).toBe(true);
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain(LIVE_URL);
  });

  test("test_DW_3_8_promote_tool_accepts_optional_namespace", async () => {
    const fetchFn = makeMockFetch(async (url, init) => {
      if (url.includes("/promote") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ url: LIVE_URL }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return null as unknown as Response;
    });

    const { credFile, deps } = makeDeps(fetchFn);
    tmpCredFiles.push(credFile);

    const server = createServer(deps);
    const tools = getTools(server);

    // namespace is optional — must not throw when omitted
    const result = await tools["promote"].handler({ slug: "my-site", namespace: undefined });
    expect(result.isError).not.toBe(true);
  });

  test("test_DW_3_8_promote_returns_error_response_on_failure", async () => {
    const fetchFn = makeMockFetch(async (url, init) => {
      if (url.includes("/promote") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ error: "No staging version to promote" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      return null as unknown as Response;
    });

    const { credFile, deps } = makeDeps(fetchFn);
    tmpCredFiles.push(credFile);

    const server = createServer(deps);
    const tools = getTools(server);

    const result = await tools["promote"].handler({ slug: "my-site" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No staging version to promote");
  });
});
