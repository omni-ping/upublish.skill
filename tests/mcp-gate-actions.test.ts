/**
 * Also pins the passcode_list / passcode_revoke output text. Pins the `gate` tool's per-action output (set-without-fields, submissions, clear) that the gate action split
 * in mcp/tools/access.ts must keep byte-for-byte. get/set/remove are pinned in mcp.test.ts and
 * mcp-visibility.test.ts. The "Unexpected result" guards cannot be reached through the real core (gate()
 * always returns the action it was asked for), so they are kept verbatim rather than tested.
 */
import { describe, test, expect } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { createServer } from "../mcp/index.ts";
import type { CoreDeps } from "../lib/core.ts";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type InternalServer = {
  _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<ToolResult> }>;
};

const NS = "ns-default";
const SUBS = `/api/ns/${NS}/sites/my-site/gate/submissions`;

function setup(routes: Record<string, { status: number; body: unknown }>) {
  const calls: string[] = [];
  const credFile = path.join(os.tmpdir(), `mcp-gate-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(credFile, "test-refresh-token", { mode: 0o600 });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("/auth/token/refresh")) return json(200, { access_token: "t", expires_in: 3600 });
    if (url.endsWith("/api/space")) return json(200, { space: { id: "sp1", default_namespace_id: NS, tier: "pro" } });
    if (/\/api\/ns$/.test(url)) return json(200, { namespaces: [{ id: NS, name: "default", domain: "user.upubli.sh" }] });
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+/, "")}`;
    calls.push(key);
    const r = routes[key] ?? { status: 404, body: { error: `unrouted ${key}` } };
    return json(r.status, r.body);
  };
  const deps: CoreDeps = { credentialsPath: credFile, fetchFn };
  const tools = (createServer(deps) as unknown as InternalServer)._registeredTools;
  return { tools, calls, cleanup: () => fs.unlinkSync(credFile) };
}

const text = (r: ToolResult) => r.content[0]!.text;

describe("gate tool actions", () => {
  test("gate_set_without_fields_is_error_and_makes_no_request", async () => {
    const { tools, calls, cleanup } = setup({});
    for (const args of [{}, { fields: [] }]) {
      const r = await tools["gate"]!.handler({ action: "set", slug: "my-site", ...args });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe("fields is required when action is 'set'");
    }
    expect(calls).toEqual([]);
    cleanup();
  });

  test("gate_submissions_empty_says_none_found", async () => {
    const { tools, cleanup } = setup({ [`GET ${SUBS}`]: { status: 200, body: { submissions: [] } } });
    const r = await tools["gate"]!.handler({ action: "submissions", slug: "my-site" });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe("No submissions found for gate on 'my-site'.");
    cleanup();
  });

  test("gate_submissions_lists_each_submission_with_its_fields", async () => {
    const submitted_at = "2026-01-15T12:00:00Z";
    const { tools, cleanup } = setup({
      [`GET ${SUBS}`]: {
        status: 200,
        body: {
          submissions: [
            { id: "s1", submitted_at, data: { email: "a@b.co", name: "Ann" } },
            { id: "s2", submitted_at, data: { email: "c@d.co" } },
          ],
        },
      },
    });
    const r = await tools["gate"]!.handler({ action: "submissions", slug: "my-site" });
    const date = new Date(submitted_at).toLocaleDateString();
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe(
      `Gate submissions for 'my-site' (2):\n\n` +
      `Submitted: ${date}\n  email: a@b.co\n  name: Ann\n\n` +
      `Submitted: ${date}\n  email: c@d.co`,
    );
    cleanup();
  });

  test("gate_clear_returns_the_server_message", async () => {
    const { tools, calls, cleanup } = setup({ [`DELETE ${SUBS}`]: { status: 200, body: { message: "Cleared 3 submissions" } } });
    const r = await tools["gate"]!.handler({ action: "clear", slug: "my-site" });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe("Cleared 3 submissions");
    expect(calls).toEqual([`DELETE ${SUBS}`]);
    cleanup();
  });
});

describe("passcode_list and passcode_revoke output", () => {
  const CODES = `/api/ns/${NS}/sites/my-site/passcodes`;

  test("passcode_list_empty_says_none_found", async () => {
    const { tools, cleanup } = setup({ [`GET ${CODES}`]: { status: 200, body: { passcodes: [] } } });
    const r = await tools["passcode_list"]!.handler({ slug: "my-site" });
    expect(text(r)).toBe("No passcodes found for site 'my-site'.");
    cleanup();
  });

  test("passcode_list_lists_id_label_and_created_date", async () => {
    const created_at = "2026-01-15T12:00:00Z";
    const { tools, cleanup } = setup({
      [`GET ${CODES}`]: { status: 200, body: { passcodes: [{ id: "p1", label: "Client A", created_at }, { id: "p2", label: "B", created_at }] } },
    });
    const r = await tools["passcode_list"]!.handler({ slug: "my-site" });
    const d = new Date(created_at).toLocaleDateString();
    expect(text(r)).toBe(
      `Passcodes for my-site (2):\n\n  ID: p1\n  Label: Client A\n  Created: ${d}\n\n  ID: p2\n  Label: B\n  Created: ${d}`,
    );
    cleanup();
  });

  test.each([
    [{ id: "p1" }, "id=p1"],
    [{ label: "Client A" }, 'label="Client A"'],
  ])("passcode_revoke_reports_identifier_%j", async (args, identifier) => {
    const { tools, cleanup } = setup({
      [`GET ${CODES}`]: { status: 200, body: { passcodes: [{ id: "p1", label: "Client A", created_at: "t" }] } },
      [`DELETE ${CODES}/p1`]: { status: 200, body: { message: "Revoked" } },
    });
    const r = await tools["passcode_revoke"]!.handler({ slug: "my-site", ...args });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe(`Passcode revoked from my-site (${identifier})\nRevoked`);
    cleanup();
  });
});
