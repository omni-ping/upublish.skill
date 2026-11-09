/**
 * Phase 3 adapter-level tests: publish tool description, new params threaded
 * through core, guard errors rendered as isError text, overwrite line in output.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { createServer } from "../mcp/index.ts";
import type { CoreDeps } from "../lib/core.ts";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type RegisteredTool = { description?: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> };
type InternalServer = { _registeredTools: Record<string, RegisteredTool> };

const NS = "ns-default";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let dir: string;
let cred: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-guard-"));
  cred = path.join(os.tmpdir(), `mcp-guard-cred-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(cred, "refresh", { mode: 0o600 });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(cred, { force: true }); });

function setup(o: { base?: number | null; tier?: string; role?: string; preview?: boolean } = {}) {
  const urls: string[] = [];
  let manifest: Record<string, any> | null = null;
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    urls.push(url);
    if (url.includes("/auth/token/refresh")) return json(200, { access_token: "t", expires_in: 3600 });
    if (url.endsWith("/api/space")) return json(200, { space: { id: "sp", default_namespace_id: NS, tier: o.tier ?? "pro" } });
    if (/\/api\/ns$/.test(url)) return json(200, { namespaces: [{ id: NS, name: "default", domain: "u.upubli.sh", ...(o.role ? { role: o.role } : {}) }] });
    if (url.includes("/manifest")) {
      manifest = JSON.parse(init!.body as string);
      return json(200, { needed: [], version: 5, session_id: "s", base_version: o.base ?? null });
    }
    if (url.includes("/finalize")) {
      const site = { id: "i", slug: "my-site", file_count: 1, total_size: 1 };
      return json(200, { site, url: "https://u.upubli.sh/my-site/", ...(o.preview ? { preview_url: "https://u.upubli.sh/my-site/@v5/" } : {}) });
    }
    return json(404, {});
  };
  const deps: CoreDeps = { credentialsPath: cred, fetchFn };
  const tools = (createServer(deps, { localFiles: true }) as unknown as InternalServer)._registeredTools;
  return { publish: tools["publish"]!, urls, manifest: () => manifest };
}
const text = (r: ToolResult) => r.content[0]!.text;
const args = (extra: Record<string, unknown> = {}) => ({ directory: dir, slug: "my-site", ...extra });
const write = (files: Record<string, string>) => {
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
};

describe("DW-3.6: publish description", () => {
  const d = () => setup().publish.description!;
  test("test_DW_3_6_no_public_url_claim", () => {
    expect(d()).not.toContain("public URL");
  });
  test("test_DW_3_6_states_replace_and_undo_rule", () => {
    expect(d()).toContain("REPLACES the live version");
    expect(d()).toContain("versions_restore");
    expect(d()).toContain("free plans cannot restore");
  });
  test("test_DW_3_6_public_never_unprotects", () => {
    expect(d()).toMatch(/visibility:"public" never removes protection[\s\S]*visibility tool/);
  });
  test("test_DW_3_6_mentions_spa_every_publish_and_guard_flags", () => {
    expect(d()).toContain("spa:true on EVERY publish");
    expect(d()).toContain("allow_no_index");
    expect(d()).toContain("allow_project_files");
  });
});

describe("guard + params through the MCP tool", () => {
  test("test_DW_3_1_mcp_guard_is_error_and_no_manifest_call", async () => {
    write({ "a.html": "x" });
    const s = setup();
    const r = await s.publish.handler(args());
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("allow_no_index");
    expect(s.urls.some((u) => u.includes("/manifest"))).toBe(false);
  });
  test("test_DW_3_1_mcp_allow_no_index_param", async () => {
    write({ "a.html": "x" });
    const r = await setup().publish.handler(args({ allow_no_index: true }));
    expect(r.isError).toBeUndefined();
  });
  test("test_DW_3_2_mcp_allow_project_files_param", async () => {
    write({ "index.html": "x", "package.json": "{}", "src/a.ts": "x" });
    const s = setup();
    expect((await s.publish.handler(args())).isError).toBe(true);
    expect((await s.publish.handler(args({ allow_project_files: true }))).isError).toBeUndefined();
  });
  test("test_DW_3_3_mcp_include_sourcemaps_param", async () => {
    write({ "index.html": "x", "a.js.map": "m" });
    const s = setup();
    await s.publish.handler(args());
    expect(Object.keys(s.manifest()!.files)).toEqual(["index.html"]);
    await s.publish.handler(args({ include_sourcemaps: true }));
    expect(Object.keys(s.manifest()!.files).sort()).toEqual(["a.js.map", "index.html"]);
  });
  test("test_DW_3_4_mcp_spa_param_in_manifest", async () => {
    write({ "index.html": "x" });
    const s = setup();
    await s.publish.handler(args({ spa: true }));
    expect(s.manifest()!.spa).toBe(true);
    await s.publish.handler(args());
    expect("spa" in s.manifest()!).toBe(false);
  });
});

describe("DW-3.5: overwrite line in tool output", () => {
  beforeEach(() => write({ "index.html": "x" }));
  test("test_DW_3_5_first_publish_has_no_replaced_line", async () => {
    expect(text(await setup({ base: null }).publish.handler(args()))).not.toContain("Replaced live version");
  });
  test("test_DW_3_5_paid_line", async () => {
    expect(text(await setup({ base: 4, tier: "pro" }).publish.handler(args()))).toContain(
      "Replaced live version v4 → v5. Undo: versions_restore(my-site, 4)",
    );
  });
  test("test_DW_3_5_free_line", async () => {
    expect(text(await setup({ base: 4, tier: "free" }).publish.handler(args()))).toContain(
      "(free plan: the previous version can't be restored)",
    );
  });
  test("test_DW_3_5_member_namespace_neutral_line", async () => {
    const s = setup({ base: 4, tier: "free", role: "user" });
    expect(text(await s.publish.handler(args()))).toContain("restoring needs a paid plan");
  });
  test("test_DW_3_5_preview_line", async () => {
    const out = text(await setup({ base: 4, preview: true }).publish.handler(args({ preview: true })));
    expect(out).toContain("Live site unchanged (preview)");
    expect(out).not.toContain("Replaced live version");
  });
});
