/**
 * MCP-level tests for the `domain` tool (custom domains).
 *
 * Verifies the tool is registered and that it delegates to lib/core's domain()
 * (which the adapter imports only from core — hexagonal rule). Uses the same
 * harness as the other MCP tests: createServer(deps) → _registeredTools →
 * handler({...}); fetch is mocked to answer token refresh then the endpoint.
 *
 * DW-5.1 — tool registered + wired to core.
 * DW-5.3 — add(subdomain) output shows a single CNAME, no apex A-record.
 */
import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../mcp/index.ts";
import type { CoreDeps } from "../lib/core.ts";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type RegisteredTool = { handler: (args: Record<string, unknown>) => Promise<ToolResult> };
type RegisteredTools = Record<string, RegisteredTool>;
type InternalServer = { _registeredTools: RegisteredTools };

const REFRESH_TOKEN = "test-refresh-token";

function writeTempCredentials(): string {
  const tmpFile = path.join(os.tmpdir(), `mcp-domain-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmpFile, REFRESH_TOKEN, { mode: 0o600 });
  return tmpFile;
}

function getTools(server: ReturnType<typeof createServer>): RegisteredTools {
  return (server as unknown as InternalServer)._registeredTools;
}

/** Refresh-then-respond fetch. `respond(url, init)` returns {status, body}. */
function mockFetch(respond: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("/auth/token/refresh")) {
      return new Response(
        JSON.stringify({ access_token: "mock-access", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const r = respond(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  };
}

function makeDeps(fetchFn: (url: string, init?: RequestInit) => Promise<Response>): { credFile: string; deps: CoreDeps } {
  const credFile = writeTempCredentials();
  return { credFile, deps: { credentialsPath: credFile, fetchFn } };
}

describe("DW-5.1: domain MCP tool", () => {
  test("test_server_registers_domain_tool", () => {
    const { credFile, deps } = makeDeps(mockFetch(() => ({ status: 200, body: {} })));
    const tools = getTools(createServer(deps));
    expect("domain" in tools).toBe(true);
    fs.unlinkSync(credFile);
  });

  test("test_domain_add_apex_renders_a_and_cname", async () => {
    const { credFile, deps } = makeDeps(
      mockFetch(() => ({
        status: 201,
        body: {
          domain: { id: "dom-1", hostname: "example.com", verified: false },
          namespace: { id: "ns-1", name: "example.com", domain: "example.com" },
          a_record_ip: "37.16.9.151",
          dns_instructions: {
            apex: { type: "A", hostname: "example.com", value: "37.16.9.151" },
            www: { type: "CNAME", hostname: "www.example.com", value: "custom.upubli.sh" },
          },
        },
      })),
    );
    const tools = getTools(createServer(deps));

    const res = await tools["domain"].handler({ action: "add", hostname: "example.com" });

    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain("A");
    expect(text).toContain("37.16.9.151");
    expect(text).toContain("custom.upubli.sh");
    expect(text.toLowerCase()).toContain("namespace");
    fs.unlinkSync(credFile);
  });

  test("test_DW_5_3_domain_add_subdomain_single_cname_no_apex", async () => {
    const { credFile, deps } = makeDeps(
      mockFetch(() => ({
        status: 201,
        body: {
          domain: { id: "dom-2", hostname: "blog.example.com", verified: false },
          namespace: { id: "ns-2", name: "blog.example.com", domain: "blog.example.com" },
          a_record_ip: "37.16.9.151",
          dns_instructions: {
            cname: { type: "CNAME", hostname: "blog.example.com", value: "custom.upubli.sh" },
          },
        },
      })),
    );
    const tools = getTools(createServer(deps));

    const res = await tools["domain"].handler({ action: "add", hostname: "blog.example.com" });

    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain("CNAME");
    expect(text).toContain("custom.upubli.sh");
    // No apex A-record echoed for a subdomain (research §1 gotcha).
    expect(text).not.toContain("37.16.9.151");
    // Exactly one DNS record line.
    expect((text.match(/CNAME/g) ?? []).length).toBe(1);
    fs.unlinkSync(credFile);
  });

  test("test_domain_status_reports_active", async () => {
    const { credFile, deps } = makeDeps(
      mockFetch(() => ({
        status: 200,
        body: { domain: { id: "dom-1", hostname: "example.com", verified: true, hostname_status: "active", ssl_status: "active", verified_at: "2026-06-13T00:00:00Z", error_message: null } },
      })),
    );
    const tools = getTools(createServer(deps));

    const res = await tools["domain"].handler({ action: "status", id: "dom-1" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain("ACTIVE");
    fs.unlinkSync(credFile);
  });

  test("test_domain_403_maps_to_friendly_tier_text", async () => {
    const { credFile, deps } = makeDeps(
      mockFetch(() => ({ status: 403, body: { error: "Custom domains require a paid plan." } })),
    );
    const tools = getTools(createServer(deps));

    const res = await tools["domain"].handler({ action: "add", hostname: "example.com" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text.toLowerCase()).toMatch(/pro|max/);
    fs.unlinkSync(credFile);
  });

  test("test_domain_add_missing_hostname_errors", async () => {
    const { credFile, deps } = makeDeps(mockFetch(() => ({ status: 200, body: {} })));
    const tools = getTools(createServer(deps));
    const res = await tools["domain"].handler({ action: "add" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/hostname is required/i);
    fs.unlinkSync(credFile);
  });
});
