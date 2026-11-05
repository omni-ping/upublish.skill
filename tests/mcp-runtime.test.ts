/**
 * Adapter tests for the old-Bun runtime note (Phase 4).
 *
 * DW-4.2 runtimeCheck on an old injected version prefixes every tool response;
 *        createServer() without opts never does; stdioServerOptions() opts in.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, stdioServerOptions } from "../mcp/index.ts";
import type { CoreDeps } from "../lib/core.ts";
import type { CreateServerOpts } from "../mcp/index.ts";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Tools = Record<string, { handler: (args: Record<string, unknown>) => Promise<ToolResult> }>;
const toolsOf = (s: ReturnType<typeof createServer>) => (s as unknown as { _registeredTools: Tools })._registeredTools;

const MARK = "bun upgrade";
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

let dir: string;
let credFile: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "upublish-runtime-"));
  credFile = path.join(dir, "credentials");
  fs.writeFileSync(credFile, "refresh-token", { mode: 0o600 });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const json = (b: unknown) => new Response(JSON.stringify(b));
const fetchFn: NonNullable<CoreDeps["fetchFn"]> = async (url) => {
  if (url.includes("raw.githubusercontent.com")) return json({ version: "99.0.0" });
  if (url.includes("/auth/token/refresh")) return json({ access_token: "tok", expires_in: 3600 });
  if (url.includes("/auth/me")) return json({ username: "u" });
  if (/\/api\/space/.test(url)) return json({ space: { id: "sp", default_namespace_id: "n1", tier: "pro" } });
  if (/\/api\/ns$/.test(url)) return json({ namespaces: [{ id: "n1", name: "default", domain: "u.upubli.sh" }] });
  return json({ sites: [] });
};

function build(opts?: CreateServerOpts, noCreds = false) {
  if (noCreds) fs.rmSync(credFile);
  return toolsOf(createServer({ credentialsPath: credFile, fetchFn }, opts));
}

describe("runtimeCheck (DW-4.2)", () => {
  test("test_DW_4_2_old_version_prefixes_every_tool_response", async () => {
    const tools = build({ runtimeCheck: { version: "1.4.3" } });
    for (let i = 0; i < 2; i++) {
      for (const name of ["status", "list"]) {
        const r = await tools[name]!.handler({});
        expect(r.content[0]!.text).toContain(MARK); // prefix, not suffix
        expect(r.content[0]!.text).toContain("1.4.3");
        expect(r.content.length).toBeGreaterThan(1);
      }
    }
  });

  test("test_DW_4_2_error_responses_are_prefixed_too", async () => {
    const tools = build({ runtimeCheck: { version: "1.4.3" } }, true);
    const r = await tools["list"]!.handler({});
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain(MARK);
    expect(text(r)).toContain("Not authenticated");
  });

  test("test_DW_4_2_createServer_without_opts_never_adds_the_note", async () => {
    const tools = build();
    for (const name of ["status", "list"]) expect(text(await tools[name]!.handler({}))).not.toContain(MARK);
  });

  test.each([
    ["supported", "1.4.4"],
    ["newer", "1.6.0"],
    ["canary of minimum", "1.4.4-canary.1"],
    ["non-Bun host", undefined],
    ["malformed", "abc"],
  ])("runtimeCheck with %s version adds no note", async (_label, version) => {
    const tools = build({ runtimeCheck: { version } });
    expect(text(await tools["status"]!.handler({}))).not.toContain(MARK);
  });

  test("stdioServerOptions opts in with the running Bun version", () => {
    expect(stdioServerOptions().runtimeCheck).toEqual({ version: Bun.version });
  });

  test("runtime note leads and update note trails on the same response", async () => {
    const tools = build({ runtimeCheck: { version: "1.4.3" }, updateCheck: true });
    await Bun.sleep(50); // let the un-awaited update check resolve
    const r = await tools["status"]!.handler({});
    expect(r.content[0]!.text).toContain(MARK);
    expect(r.content[r.content.length - 1]!.text).toContain("out of date");
    expect(text(await tools["status"]!.handler({}))).not.toContain("out of date"); // update note is once
    expect((await tools["status"]!.handler({})).content[0]!.text).toContain(MARK); // runtime note every time
  });
});
