/**
 * MCP adapter tests for the Phase 2 access-control surface:
 * `visibility` tool, `passcode_add` guard, truthful `gate` set/remove.
 *
 * Drives registered tool handlers with a route-table mock fetch that records
 * every API call, so each test can assert the exact call sequence (including
 * that refusals made NO mutating request).
 *
 * Covers DW-2.1 .. DW-2.9 at the adapter layer.
 */

import { describe, test, expect } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { createServer } from "../mcp/index.ts";
import type { CoreDeps } from "../lib/core.ts";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type RegisteredTool = { description?: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> };
type InternalServer = { _registeredTools: Record<string, RegisteredTool> };
type Route = { status: number; body: unknown };

const NS = "ns-default";
const SITES = `GET /api/ns/${NS}/sites`;
const CODES = `GET /api/ns/${NS}/sites/my-site/passcodes`;
const POST = `POST /api/ns/${NS}/sites/my-site/passcodes`;
const PATCH = `PATCH /api/ns/${NS}/sites/my-site/visibility`;
const PUT_GATE = `PUT /api/ns/${NS}/sites/my-site/gate`;
const DEL_PUBLIC = `DELETE /api/ns/${NS}/sites/my-site/gate?visibility=public`;
const DEL_PASSCODE = `DELETE /api/ns/${NS}/sites/my-site/gate?visibility=passcode`;

function setup(routes: Record<string, Route>) {
  const calls: string[] = [];
  const credFile = path.join(os.tmpdir(), `mcp-vis-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

const sites = (visibility?: string): Route => ({
  status: 200,
  body: { sites: [{ slug: "my-site", ...(visibility ? { visibility } : {}) }] },
});
const codes = (n: number): Route => ({
  status: 200,
  body: { passcodes: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, label: `l${i}`, created_at: "t" })) },
});
const created: Route = { status: 201, body: { id: "new-1", label: "Client A", created_at: "t" } };
const patched = (v: string): Route => ({ status: 200, body: { site: { slug: "my-site", visibility: v } } });
const text = (r: ToolResult) => r.content[0]!.text;

describe("DW-2.1/2.2: visibility tool", () => {
  test("test_DW_2_1_visibility_output_names_new_previous_and_count_and_orders_post_before_patch", async () => {
    const { tools, calls, cleanup } = setup({ [SITES]: sites("public"), [CODES]: codes(0), [POST]: created, [PATCH]: patched("passcode") });
    const r = await tools["visibility"]!.handler({ slug: "my-site", visibility: "passcode", passcode: "abcd", label: "Client A" });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('Visibility of "my-site" is now PASSCODE (was PUBLIC). Active passcodes: 1.');
    expect(text(r)).toContain('Added passcode "Client A"');
    expect(calls).toEqual([SITES, CODES, POST, PATCH]);
    cleanup();
  });

  test("test_DW_2_2_visibility_with_existing_code_patches_and_says_it_already_exists", async () => {
    const { tools, calls, cleanup } = setup({
      [SITES]: sites("public"),
      [CODES]: codes(1),
      [POST]: { status: 200, body: { id: "old-1", label: "Client A", created_at: "t", existed: true } },
      [PATCH]: patched("passcode"),
    });
    const r = await tools["visibility"]!.handler({ slug: "my-site", visibility: "passcode", passcode: "abcd" });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('Visibility of "my-site" is now PASSCODE (was PUBLIC). Active passcodes: 1.');
    expect(text(r)).toContain("That passcode already exists on this site as 'Client A' (id old-1); nothing changed.");
    expect(text(r)).not.toContain("Added passcode");
    expect(calls).toEqual([SITES, CODES, POST, PATCH]);
    cleanup();
  });

  test("test_DW_2_2_visibility_passcode_with_zero_codes_is_error_and_no_patch", async () => {
    const { tools, calls, cleanup } = setup({ [SITES]: sites("public"), [CODES]: codes(0) });
    const r = await tools["visibility"]!.handler({ slug: "my-site", visibility: "passcode" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("no passcodes");
    expect(calls).not.toContain(PATCH);
    cleanup();
  });

  test("test_DW_2_2_visibility_public_patches_public_and_says_so", async () => {
    const { tools, calls, cleanup } = setup({ [SITES]: sites("passcode"), [PATCH]: patched("public") });
    const r = await tools["visibility"]!.handler({ slug: "my-site", visibility: "public" });
    expect(text(r)).toContain('Visibility of "my-site" is now PUBLIC (was PASSCODE).');
    expect(text(r)).toContain("not enforced while public");
    expect(calls).toEqual([SITES, PATCH]);
    cleanup();
  });

  test("test_DW_2_2_visibility_post_ok_patch_500_names_added_code_and_unchanged_visibility", async () => {
    const { tools, cleanup } = setup({
      [SITES]: sites("public"), [CODES]: codes(0), [POST]: created, [PATCH]: { status: 500, body: { error: "boom" } },
    });
    const r = await tools["visibility"]!.handler({ slug: "my-site", visibility: "passcode", passcode: "abcd", label: "Client A" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Passcode "Client A"');
    expect(text(r)).toContain("is still PUBLIC");
    cleanup();
  });

  test("test_DW_2_2_visibility_free_tier_403_text_carries_upgrade_hint", async () => {
    const { tools, calls, cleanup } = setup({
      [SITES]: sites("public"), [CODES]: codes(0),
      [POST]: { status: 403, body: { error: "Passcode-protected sites require a paid plan" } },
    });
    const r = await tools["visibility"]!.handler({ slug: "my-site", visibility: "passcode", passcode: "abcd" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("`upgrade` tool");
    expect(calls).not.toContain(PATCH);
    cleanup();
  });

  test("test_DW_2_2_visibility_unknown_slug_is_not_found_with_no_mutation", async () => {
    const { tools, calls, cleanup } = setup({ [SITES]: { status: 200, body: { sites: [] } } });
    const r = await tools["visibility"]!.handler({ slug: "my-site", visibility: "public" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not found");
    expect(calls).toEqual([SITES]);
    cleanup();
  });
});

describe("DW-2.8: visibility on gated / unreadable sites", () => {
  test("test_DW_2_8_gated_site_output_names_leftover_gate_config_and_gate_remove", async () => {
    const { tools, cleanup } = setup({ [SITES]: sites("gated"), [CODES]: codes(1), [PATCH]: patched("passcode") });
    const r = await tools["visibility"]!.handler({ slug: "my-site", visibility: "passcode" });
    expect(r.isError).toBeUndefined();
    const t = text(r);
    expect(t).toContain("was GATED");
    expect(t).toContain("form gate is no longer enforced");
    expect(t).toContain("settings and submissions remain");
    expect(t).toContain("`gate`");
    expect(t).toContain("'remove'");
    cleanup();
  });

  test("test_DW_2_8_missing_visibility_field_refuses_visibility_with_no_mutation", async () => {
    const { tools, calls, cleanup } = setup({ [SITES]: sites(undefined) });
    const r = await tools["visibility"]!.handler({ slug: "my-site", visibility: "public" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("couldn't read the site's current visibility");
    expect(calls).toEqual([SITES]);
    cleanup();
  });
});

describe("DW-1.1: passcode_add label optional", () => {
  test("test_DW_1_1_omitted_empty_and_blank_label_all_succeed", async () => {
    const { tools, calls, cleanup } = setup({ [SITES]: sites("passcode"), [POST]: created });
    for (const label of [undefined, "", "   "]) {
      const r = await tools["passcode_add"]!.handler({ slug: "my-site", code: "abcd", label });
      expect(r.isError).toBeUndefined();
    }
    expect(calls.filter((c) => c === POST)).toHaveLength(3);
    cleanup();
  });

  test("test_DW_1_1_whitespace_label_posts_default_body", async () => {
    const sent: unknown[] = [];
    const credFile = path.join(os.tmpdir(), `mcp-vis-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(credFile, "test-refresh-token", { mode: 0o600 });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/auth/token/refresh")) return json(200, { access_token: "t", expires_in: 3600 });
      if (url.endsWith("/api/space")) return json(200, { space: { id: "sp1", default_namespace_id: NS, tier: "pro" } });
      if (/\/api\/ns$/.test(url)) return json(200, { namespaces: [{ id: NS, name: "default", domain: "user.upubli.sh" }] });
      if (init?.method === "POST") { sent.push(JSON.parse(init.body as string)); return json(201, { id: "n", label: "default", created_at: "t" }); }
      return json(200, { sites: [{ slug: "my-site", visibility: "passcode" }] });
    };
    const tools = (createServer({ credentialsPath: credFile, fetchFn } as CoreDeps) as unknown as InternalServer)._registeredTools;
    await tools["passcode_add"]!.handler({ slug: "my-site", code: "abcd", label: "   " });
    await tools["passcode_add"]!.handler({ slug: "my-site", code: "abcd" });
    await tools["passcode_add"]!.handler({ slug: "my-site", code: "abcd", label: "Client A" });
    expect(sent).toEqual([
      { code: "abcd", label: "default" },
      { code: "abcd", label: "default" },
      { code: "abcd", label: "Client A" },
    ]);
    fs.unlinkSync(credFile);
  });
});

describe("DW-2.3: passcode_add guard", () => {
  const REFUSAL =
    'Site "my-site" is PUBLIC — adding a passcode does not protect it. ' +
    'To make it private, call visibility(slug, "passcode", passcode: "<code>").';

  test("test_DW_2_3_passcode_add_on_public_site_returns_refusal_and_makes_no_post", async () => {
    const { tools, calls, cleanup } = setup({ [SITES]: sites("public"), [POST]: created });
    const r = await tools["passcode_add"]!.handler({ slug: "my-site", code: "abcd", label: "x" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(REFUSAL);
    expect(calls).toEqual([SITES]);
    cleanup();
  });

  test("test_DW_2_3_passcode_add_on_gated_site_refuses_and_explains_gate_replaces_passcodes", async () => {
    const { tools, calls, cleanup } = setup({ [SITES]: sites("gated"), [POST]: created });
    const r = await tools["passcode_add"]!.handler({ slug: "my-site", code: "abcd", label: "x" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("form gate replaces passcodes");
    expect(calls).toEqual([SITES]);
    cleanup();
  });

  test("test_DW_2_3_passcode_add_on_passcode_site_behaves_as_before", async () => {
    const { tools, calls, cleanup } = setup({ [SITES]: sites("passcode"), [POST]: created });
    const r = await tools["passcode_add"]!.handler({ slug: "my-site", code: "abcd", label: "Client A" });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe("Passcode added to my-site\nID:    new-1\nLabel: Client A");
    expect(calls).toEqual([SITES, POST]);
    cleanup();
  });

  test("test_DW_2_1_passcode_add_existing_code_is_a_friendly_non_error_message", async () => {
    const { tools, calls, cleanup } = setup({
      [SITES]: sites("passcode"),
      [POST]: { status: 200, body: { id: "old-1", label: "Client A", created_at: "t", existed: true } },
    });
    const r = await tools["passcode_add"]!.handler({ slug: "my-site", code: "abcd", label: "other" });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe("That passcode already exists on this site as 'Client A' (id old-1); nothing changed.");
    expect(calls).toEqual([SITES, POST]);
    cleanup();
  });

  test("test_DW_2_1_passcode_add_non_boolean_existed_prints_the_normal_added_text", async () => {
    const { tools, cleanup } = setup({
      [SITES]: sites("passcode"),
      [POST]: { status: 201, body: { id: "new-1", label: "Client A", created_at: "t", existed: "true" } },
    });
    const r = await tools["passcode_add"]!.handler({ slug: "my-site", code: "abcd", label: "Client A" });
    expect(text(r)).toBe("Passcode added to my-site\nID:    new-1\nLabel: Client A");
    cleanup();
  });

  test("test_DW_2_3_passcode_add_free_tier_403_has_upgrade_hint", async () => {
    const { tools, cleanup } = setup({
      [SITES]: sites("passcode"),
      [POST]: { status: 403, body: { error: "Passcode-protected sites require a paid plan" } },
    });
    const r = await tools["passcode_add"]!.handler({ slug: "my-site", code: "abcd", label: "x" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("`upgrade` tool");
    cleanup();
  });

  test("test_DW_2_3_passcode_add_description_says_it_does_not_make_a_site_private", () => {
    const { tools, cleanup } = setup({});
    expect(tools["passcode_add"]!.description).toContain("does NOT make a site private");
    expect(tools["passcode_add"]!.description).toContain("`visibility`");
    cleanup();
  });
});

describe("DW-2.4/2.7: gate remove", () => {
  test("test_DW_2_4_gate_remove_without_visibility_after_makes_no_delete_and_returns_guidance", async () => {
    const { tools, calls, cleanup } = setup({ [DEL_PUBLIC]: { status: 200, body: { message: "Gate removed" } } });
    const r = await tools["gate"]!.handler({ action: "remove", slug: "my-site" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("visibility_after");
    expect(text(r)).toContain("Nothing was changed");
    expect(calls).toEqual([]);
    cleanup();
  });

  test("test_DW_2_4_gate_remove_rejects_invalid_visibility_after_with_no_delete", async () => {
    const { tools, calls, cleanup } = setup({});
    const r = await tools["gate"]!.handler({ action: "remove", slug: "my-site", visibility_after: "gated" });
    expect(r.isError).toBe(true);
    expect(calls).toEqual([]);
    cleanup();
  });

  test("test_DW_2_4_gate_remove_passcode_sends_query_and_renders_echoed_visibility", async () => {
    const { tools, calls, cleanup } = setup({ [DEL_PASSCODE]: { status: 200, body: { message: "Gate removed", visibility: "passcode" } } });
    const r = await tools["gate"]!.handler({ action: "remove", slug: "my-site", visibility_after: "passcode" });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("Gate removed");
    expect(text(r)).toContain("Site is now PASSCODE.");
    expect(text(r)).not.toContain("PUBLIC");
    expect(calls).toEqual([DEL_PASSCODE]);
    cleanup();
  });

  test("test_DW_2_4_gate_remove_public_with_no_visibility_in_response_says_public", async () => {
    const { tools, cleanup } = setup({ [DEL_PUBLIC]: { status: 200, body: { message: "Gate removed" } } });
    const r = await tools["gate"]!.handler({ action: "remove", slug: "my-site", visibility_after: "public" });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("Site is now PUBLIC.");
    cleanup();
  });

  test("test_DW_2_7_gate_remove_passcode_with_no_visibility_in_response_is_error_never_success", async () => {
    const { tools, cleanup } = setup({ [DEL_PASSCODE]: { status: 200, body: { message: "Gate removed" } } });
    const r = await tools["gate"]!.handler({ action: "remove", slug: "my-site", visibility_after: "passcode" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(
      'The server did not keep passcode protection — "my-site" is now PUBLIC. Run visibility(slug, "passcode") now.',
    );
    cleanup();
  });

  test("test_DW_2_7_gate_remove_passcode_with_public_in_response_is_error", async () => {
    const { tools, cleanup } = setup({ [DEL_PASSCODE]: { status: 200, body: { message: "Gate removed", visibility: "public" } } });
    const r = await tools["gate"]!.handler({ action: "remove", slug: "my-site", visibility_after: "passcode" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("The server did not keep passcode protection");
    cleanup();
  });

  test("test_DW_2_4_gate_remove_409_no_passcodes_is_error_with_guidance", async () => {
    const { tools, cleanup } = setup({ [DEL_PASSCODE]: { status: 409, body: { error: "Site has no passcodes", code: "no_passcodes" } } });
    const r = await tools["gate"]!.handler({ action: "remove", slug: "my-site", visibility_after: "passcode" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("NOT removed");
    cleanup();
  });
});

describe("DW-2.5: gate set warning + tool descriptions", () => {
  const GATE = { id: "g", slug: "my-site", fields: [{ type: "email", required: true }], created_at: "t", updated_at: "t" };

  test("test_DW_2_5_gate_set_reports_replaced_passcode_protection", async () => {
    const { tools, cleanup } = setup({ [PUT_GATE]: { status: 200, body: { gate: GATE, previous_visibility: "passcode" } } });
    const r = await tools["gate"]!.handler({ action: "set", slug: "my-site", fields: ["email"] });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("passcode protection replaced by form gate (was: passcode)");
    cleanup();
  });

  test.each(["public", undefined])("test_DW_2_5_gate_set_no_warning_when_previous_was_%s", async (prev) => {
    const { tools, cleanup } = setup({ [PUT_GATE]: { status: 200, body: { gate: GATE, previous_visibility: prev } } });
    const r = await tools["gate"]!.handler({ action: "set", slug: "my-site", fields: ["email"] });
    expect(text(r)).not.toContain("replaced");
    cleanup();
  });

  test("test_DW_2_5_gate_and_visibility_descriptions_state_side_effects", () => {
    const { tools, cleanup } = setup({});
    const gateDesc = tools["gate"]!.description!;
    expect(gateDesc).toContain("REPLACES passcode protection");
    expect(gateDesc).toContain("visibility_after");
    const visDesc = tools["visibility"]!.description!;
    expect(visDesc).toContain("FIRST");
    expect(visDesc).toContain("zero codes");
    expect(visDesc).toContain("submissions remain");
    expect(visDesc).toContain("not enforced while public");
    cleanup();
  });

  test("test_DW_2_5_visibility_and_gate_schemas_only_accept_public_or_passcode", () => {
    const { tools, cleanup } = setup({});
    type Shape = { inputSchema: { shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }> } };
    const vis = (tools["visibility"] as unknown as Shape).inputSchema.shape["visibility"]!;
    const after = (tools["gate"] as unknown as Shape).inputSchema.shape["visibility_after"]!;
    for (const field of [vis, after]) {
      expect(field.safeParse("public").success).toBe(true);
      expect(field.safeParse("passcode").success).toBe(true);
      expect(field.safeParse("gated").success).toBe(false);
    }
    cleanup();
  });
});
