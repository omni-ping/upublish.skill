/**
 * Tests for the MCP publish tool heartbeat — ensures progress notifications
 * fire at least once per heartbeat interval when no file has completed.
 *
 * DW-5.2: During a long gap between file completions, at least one progress
 *         notification fires per ~20 s (tested with a short injectable interval).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { createServer } from "../mcp/index.ts";
import type { CoreDeps } from "../lib/core.ts";
import type { ProgressNotification } from "@modelcontextprotocol/sdk/types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type RegisteredTool = {
  handler: (
    args: Record<string, unknown>,
    extra: {
      _meta?: { progressToken?: string | number };
      sendNotification: (n: ProgressNotification) => Promise<void>;
    },
  ) => Promise<ToolResult>;
};

type InternalServer = { _registeredTools: Record<string, RegisteredTool> };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeTempCredentials(token: string): string {
  const tmpFile = path.join(
    os.tmpdir(),
    `mcp-heartbeat-test-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(tmpFile, token, { mode: 0o600 });
  return tmpFile;
}

function writeTempDir(files: Record<string, string>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "upublish-heartbeat-test-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(tmpDir, name), content);
  }
  return tmpDir;
}

const REFRESH_TOKEN = "test-refresh-token";
const DEFAULT_NS_ID = "ns-default";

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
  url: "https://user1.upubli.sh/my-site/",
};

// ─── DW-5.2: heartbeat fires during upload gap ────────────────────────────────

describe("DW-5.2: publish tool heartbeat", () => {
  let tmpDir: string;
  let credFile: string;

  beforeEach(() => {
    tmpDir = writeTempDir({ "index.html": "<h1>Hello</h1>" });
    credFile = writeTempCredentials(REFRESH_TOKEN);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try { fs.unlinkSync(credFile); } catch { /* ignore */ }
  });

  test("test_DW_5_2_heartbeat_fires_during_upload_gap", async () => {
    // Slow upload: the presigned PUT hangs for 3 heartbeat intervals before resolving
    const HEARTBEAT_MS = 50; // short interval for test
    const UPLOAD_DELAY_MS = HEARTBEAT_MS * 3 + 20; // 170 ms — enough for 3+ heartbeats

    const notifications: ProgressNotification[] = [];

    // Mock fetch: slow presigned PUT, instant API calls
    const mockFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/space") || url.includes("/api/space?")) {
        return new Response(
          JSON.stringify({ space: { id: "sp1", default_namespace_id: DEFAULT_NS_ID, tier: "pro" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
        return new Response(
          JSON.stringify({
            namespaces: [{ id: DEFAULT_NS_ID, name: "default", domain: "user.upubli.sh" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/ns/") && url.includes("/manifest")) {
        return new Response(
          JSON.stringify({
            needed: [
              { path: "index.html", upload_url: "https://r2.example.com/presigned/index.html" },
            ],
            copied: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("r2.example.com/presigned")) {
        // Slow upload — simulate the 1 GB upload delay
        await new Promise((resolve) => setTimeout(resolve, UPLOAD_DELAY_MS));
        return new Response("", { status: 200 });
      }
      if (url.includes("/finalize")) {
        return new Response(
          JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_SITE.url }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn: mockFetch };
    const server = createServer(deps, { heartbeatIntervalMs: HEARTBEAT_MS });
    const tools = (server as unknown as InternalServer)._registeredTools;
    const publishTool = tools["publish"];
    expect(publishTool).toBeDefined();

    const progressToken = "test-token-123";

    await publishTool.handler(
      {
        directory: tmpDir,
        slug: "my-site",
      },
      {
        _meta: { progressToken },
        sendNotification: async (n) => {
          notifications.push(n);
        },
      },
    );

    // During the slow upload, heartbeat should have fired at least once
    const heartbeatNotifications = notifications.filter(
      (n) =>
        n.params.progressToken === progressToken &&
        typeof n.params.message === "string" &&
        n.params.message.includes("still uploading"),
    );

    expect(heartbeatNotifications.length).toBeGreaterThanOrEqual(1);
  });

  test("test_DW_5_2_no_heartbeat_when_no_progress_token", async () => {
    const notifications: ProgressNotification[] = [];

    const mockFetch = async (url: string): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/space") || url.includes("/api/space?")) {
        return new Response(
          JSON.stringify({ space: { id: "sp1", default_namespace_id: DEFAULT_NS_ID, tier: "pro" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
        return new Response(
          JSON.stringify({
            namespaces: [{ id: DEFAULT_NS_ID, name: "default", domain: "user.upubli.sh" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/ns/") && url.includes("/manifest")) {
        return new Response(
          JSON.stringify({ needed: [], copied: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/finalize")) {
        return new Response(
          JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_SITE.url }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn: mockFetch };
    const server = createServer(deps, { heartbeatIntervalMs: 10 });
    const tools = (server as unknown as InternalServer)._registeredTools;
    const publishTool = tools["publish"];

    // Call without progressToken — no notifications expected
    await publishTool.handler(
      { directory: tmpDir, slug: "my-site" },
      {
        _meta: {},
        sendNotification: async (n) => {
          notifications.push(n);
        },
      },
    );

    expect(notifications).toHaveLength(0);
  });

  test("test_DW_5_2_heartbeat_clears_on_completion", async () => {
    // After publish completes, no more heartbeat notifications should fire
    const HEARTBEAT_MS = 20;
    const notifications: ProgressNotification[] = [];
    let notificationsSentAtCompletion = 0;

    const mockFetch = async (url: string): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/space") || url.includes("/api/space?")) {
        return new Response(
          JSON.stringify({ space: { id: "sp1", default_namespace_id: DEFAULT_NS_ID, tier: "pro" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/ns$/.test(url) || /\/api\/ns\?/.test(url)) {
        return new Response(
          JSON.stringify({
            namespaces: [{ id: DEFAULT_NS_ID, name: "default", domain: "user.upubli.sh" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/ns/") && url.includes("/manifest")) {
        return new Response(
          JSON.stringify({ needed: [], copied: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/finalize")) {
        return new Response(
          JSON.stringify({ site: SAMPLE_SITE, url: SAMPLE_SITE.url }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const deps: CoreDeps = { credentialsPath: credFile, fetchFn: mockFetch };
    const server = createServer(deps, { heartbeatIntervalMs: HEARTBEAT_MS });
    const tools = (server as unknown as InternalServer)._registeredTools;
    const publishTool = tools["publish"];

    await publishTool.handler(
      { directory: tmpDir, slug: "my-site" },
      {
        _meta: { progressToken: "token-456" },
        sendNotification: async (n) => {
          notifications.push(n);
        },
      },
    );

    notificationsSentAtCompletion = notifications.length;

    // Wait for 2 more heartbeat intervals — no new notifications should fire
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS * 2 + 5));

    // Count should be frozen at completion
    expect(notifications.length).toBe(notificationsSentAtCompletion);
  });
});
