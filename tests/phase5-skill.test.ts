/**
 * Phase 5 structural + adapter tests — unified login, namespace_create tool, docs.
 *
 * Covers:
 *   DW-5.3 — the namespace_create MCP tool is registered and returns the new
 *            namespace id + domain (success) / an actionable error (failure).
 *   DW-5.4 — SKILL.md documents signup-on-first-login + the namespace tool;
 *            references/troubleshooting.md covers the 410 upgrade_required path;
 *            repo CLAUDE.md tool list is current.
 *   DW-5.5 — adapters (mcp/index.ts) import only from lib/core.ts.
 */

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../mcp/index.ts";
import type { CoreDeps } from "../lib/core.ts";

const REPO_ROOT = path.join(path.dirname(import.meta.url.replace("file://", "")), "..");

function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8");
}

// ─── MCP harness (mirrors tests/mcp.test.ts) ──────────────────────────────────

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type RegisteredTool = { handler: (args: Record<string, unknown>) => Promise<ToolResult> };
type RegisteredTools = Record<string, RegisteredTool>;
type InternalServer = { _registeredTools: RegisteredTools };

const REFRESH_TOKEN = "test-refresh-token";

function writeTempCredentials(): string {
  const tmpFile = path.join(os.tmpdir(), `phase5-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmpFile, REFRESH_TOKEN, { mode: 0o600 });
  return tmpFile;
}

function getTools(server: ReturnType<typeof createServer>): RegisteredTools {
  return (server as unknown as InternalServer)._registeredTools;
}

/** Handles token refresh, then responds to POST /api/ns with the given status/body. */
function mockNsCreateFetch(status: number, body: unknown, capture?: { body?: Record<string, unknown> }) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("/auth/token/refresh")) {
      return new Response(
        JSON.stringify({ access_token: "mock-access", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (capture && init?.body) capture.body = JSON.parse(init.body as string) as Record<string, unknown>;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
}

function makeDeps(fetchFn: (url: string, init?: RequestInit) => Promise<Response>): { credFile: string; deps: CoreDeps } {
  const credFile = writeTempCredentials();
  return { credFile, deps: { credentialsPath: credFile, fetchFn } };
}

// ─── DW-5.3: namespace_create tool ────────────────────────────────────────────

describe("DW-5.3: namespace_create MCP tool", () => {
  test("test_DW_5_3_server_registers_namespace_create_tool", () => {
    const { credFile, deps } = makeDeps(mockNsCreateFetch(201, {}));
    const tools = getTools(createServer(deps));
    expect("namespace_create" in tools).toBe(true);
    fs.unlinkSync(credFile);
  });

  test("test_DW_5_3_namespace_create_returns_id_and_domain", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const { credFile, deps } = makeDeps(
      mockNsCreateFetch(201, { namespace: { id: "ns-mcp-1", name: "frank", domain: "upubli.sh" } }, capture),
    );
    const tools = getTools(createServer(deps));

    const res = await tools["namespace_create"].handler({ name: "frank" });

    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain("ns-mcp-1");
    expect(text).toContain("upubli.sh");
    // Default platform domain sent when none supplied.
    expect(capture.body).toEqual({ name: "frank", domain: "upubli.sh" });
    fs.unlinkSync(credFile);
  });

  test("test_DW_5_3_namespace_create_tier_limit_is_actionable", async () => {
    const { credFile, deps } = makeDeps(
      mockNsCreateFetch(403, {
        error: "Root namespace limit reached. Your plan allows 1 root namespace(s).",
        limit: 1,
        usage: 1,
      }),
    );
    const tools = getTools(createServer(deps));

    const res = await tools["namespace_create"].handler({ name: "second" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/upgrade/i);
    expect(res.content[0].text).toMatch(/upubli\.sh\/pricing/i);
    fs.unlinkSync(credFile);
  });
});

// ─── DW-5.5: adapter import boundary ──────────────────────────────────────────

describe("DW-5.5: adapters import only core.ts", () => {
  test("test_DW_5_5_mcp_index_imports_only_core_from_lib", () => {
    const src = readRepoFile("mcp/index.ts");
    // Every relative import of a lib/ module must be lib/core.ts (or lib/log.ts,
    // the shared logger the adapter is allowed to use). No reaching into auth.ts,
    // api-client.ts, namespace.ts, publish.ts, etc.
    const importLines = src
      .split("\n")
      .filter((l) => /from\s+["']\.\.\/lib\//.test(l));
    for (const line of importLines) {
      const ok = /from\s+["']\.\.\/lib\/core\.ts["']/.test(line) || /from\s+["']\.\.\/lib\/log\.ts["']/.test(line);
      expect(ok).toBe(true);
    }
  });
});

// ─── DW-5.4: documentation ────────────────────────────────────────────────────

describe("Phase5-DW-5.4: docs document signup-on-first-login + namespace tool + 410", () => {
  test("test_DW_5_4_skill_md_documents_signup_on_first_login", () => {
    const content = readRepoFile("skills/upublish/SKILL.md").toLowerCase();
    // The skill must set the expectation that first-time users finish setup in
    // the browser, so the agent doesn't look stuck waiting on the callback.
    expect(content).toMatch(/first[\s-]*time|new user|sign[\s-]*up/);
    expect(content).toContain("browser");
  });

  test("test_DW_5_4_skill_md_lists_namespace_create_tool", () => {
    const content = readRepoFile("skills/upublish/SKILL.md");
    expect(content).toContain("namespace_create");
  });

  test("test_DW_5_4_troubleshooting_covers_410_upgrade_required", () => {
    const content = readRepoFile("references/troubleshooting.md");
    expect(content).toContain("upgrade_required");
    expect(content).toMatch(/410/);
  });

  test("test_DW_5_4_repo_claude_md_lists_namespace_tool", () => {
    const content = readRepoFile("CLAUDE.md");
    expect(content).toContain("namespace_create");
  });
});
