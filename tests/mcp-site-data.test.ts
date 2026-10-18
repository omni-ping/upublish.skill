/**
 * DW-6.1: MCP adapter tests for the site data tools (`data`, `data_collection`,
 * `data_rows`, `data_jwt`): registration, zod argument schemas (mirroring the
 * contract's payload types), and every action through the registered handler
 * over an injected fetch, including error paths and the consent echo.
 */

import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ZodTypeAny } from "zod";
import { createServer } from "../mcp/index.ts";
import type { CoreDeps } from "../lib/core.ts";
import { NS, SITES_BODY, fixtureResponse, jsonResponse, loadRoute, stackFetch, type Handler } from "./helpers/site-data.ts";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type RegisteredTool = { handler: (args: Record<string, unknown>) => Promise<ToolResult>; inputSchema: ZodTypeAny; description?: string };
type InternalServer = { _registeredTools: Record<string, RegisteredTool> };

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true, recursive: true });
});

function setup(handler: Handler) {
  const file = path.join(os.tmpdir(), `mcp-site-data-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, "refresh-token", { mode: 0o600 });
  tmpFiles.push(file);
  const { fetchFn, calls } = stackFetch(handler);
  const deps: CoreDeps = { credentialsPath: file, fetchFn };
  const tools = (createServer(deps) as unknown as InternalServer)._registeredTools;
  const call = (name: string, args: Record<string, unknown>) => tools[name]!.handler(args);
  return { tools, call, calls };
}

const text = (r: ToolResult) => r.content[0]!.text;
const DATA = `/api/ns/${NS.id}/data`;
const status = fixtureResponse(loadRoute("api.status"), "enabled").body as object;
const darkStatus = fixtureResponse(loadRoute("api.status"), "dark launch: hidden").body;
const sites = (req: { path: string }) => (req.path === `/api/ns/${NS.id}/sites` ? jsonResponse(200, SITES_BODY) : undefined);

describe("DW-6.1: site data tool registration and schemas", () => {
  test("test_DW_6_1_four_site_data_tools_registered", () => {
    const { tools } = setup(() => undefined);
    for (const n of ["data", "data_collection", "data_rows", "data_jwt"]) expect(n in tools).toBe(true);
  });

  test("test_DW_6_1_data_descriptions_state_cost_and_destructive_actions", () => {
    const { tools } = setup(() => undefined);
    expect(tools["data"]!.description).toContain("WITHOUT accept_charge");
    expect(tools["data"]!.description).toContain("DESTRUCTIVE and irreversible");
    expect(tools["data"]!.description).toContain("not available for this account");
    expect(tools["data_collection"]!.description).toContain("deletes the collection AND all its rows");
    expect(tools["data_rows"]!.description).toContain("no un-archive");
    expect(tools["data"]!.description).toContain("references/site-data.md");
  });

  test("test_DW_6_1_data_rows_has_no_get_action", () => {
    const { tools } = setup(() => undefined);
    const schema = tools["data_rows"]!.inputSchema;
    expect(schema.safeParse({ action: "get", collection: "c" }).success).toBe(false);
    for (const action of ["list", "export", "archive", "delete", "create", "put", "import"]) {
      expect(schema.safeParse({ action, collection: "c" }).success).toBe(true);
    }
  });

  test("test_DW_6_1_schema_data_actions_and_rejects_unknown", () => {
    const { tools } = setup(() => undefined);
    const s = tools["data"]!.inputSchema;
    for (const action of ["status", "enable", "disable", "wipe"]) expect(s.safeParse({ action }).success).toBe(true);
    expect(s.safeParse({ action: "nuke" }).success).toBe(false);
    expect(s.safeParse({ action: "enable", accept_charge: "yes" }).success).toBe(false);
  });

  test("test_DW_6_1_schema_collection_mirrors_collection_input", () => {
    const { tools } = setup(() => undefined);
    const s = tools["data_collection"]!.inputSchema;
    const ok = {
      action: "set", collection: "votes", rule: "own-rows", sites: ["for-her"], writers: ["passcode"],
      per_identity_limit: null, max_rows: 100_000, max_row_bytes: 65_536, writes_per_min: 600,
      write_claims: [{ kind: "passcode", claims: { site: "for-her", label: "her" } }],
      admin_claims: [{ kind: "jwt", claims: { admin: true } }],
    };
    expect(s.safeParse(ok).success).toBe(true);
    const bad: Array<Record<string, unknown>> = [
      { ...ok, rule: "public" },
      { ...ok, writers: ["owner"] },
      { ...ok, sites: [] },
      { ...ok, sites: Array.from({ length: 21 }, (_, i) => `s${i}`) },
      { ...ok, max_rows: 100_001 },
      { ...ok, max_row_bytes: 65_537 },
      { ...ok, writes_per_min: 601 },
      { ...ok, per_identity_limit: 0 },
      { ...ok, write_claims: [{ kind: "anonymous", claims: { a: "b" } }] },
      { ...ok, write_claims: [{ kind: "jwt", claims: {} }] },
      { ...ok, write_claims: [{ kind: "jwt", claims: { a: "1", b: "2", c: "3", d: "4", e: "5" } }] },
      { ...ok, admin_claims: Array.from({ length: 5 }, () => ({ kind: "jwt", claims: { a: "b" } })) },
    ];
    for (const b of bad) expect(s.safeParse(b).success).toBe(false);
  });

  test("test_DW_6_1_schema_claim_key_length_capped_at_contract_limit", () => {
    const { tools } = setup(() => undefined);
    const s = tools["data_collection"]!.inputSchema;
    const withKey = (k: string) => ({ action: "set", collection: "votes", write_claims: [{ kind: "jwt", claims: { [k]: "v" } }] });
    expect(s.safeParse(withKey("k".repeat(64))).success).toBe(true);
    expect(s.safeParse(withKey("k".repeat(65))).success).toBe(false);
    expect(s.safeParse(withKey("")).success).toBe(false);
    expect(s.safeParse({ ...withKey("k"), admin_claims: [{ kind: "jwt", claims: { ["k".repeat(65)]: true } }] }).success).toBe(false);
  });

  test("test_DW_6_1_data_rows_author_wording_points_at_the_author_line_not_the_label", () => {
    const { tools } = setup(() => undefined);
    expect(tools["data_rows"]!.description).toContain("'author:' value from list");
  });

  test("test_DW_6_1_schema_rows_limit_and_import_bounds", () => {
    const { tools } = setup(() => undefined);
    const s = tools["data_rows"]!.inputSchema;
    expect(s.safeParse({ action: "list", collection: "c", limit: 100 }).success).toBe(true);
    expect(s.safeParse({ action: "list", collection: "c", limit: 101 }).success).toBe(false);
    expect(s.safeParse({ action: "list", collection: "c" }).success).toBe(true);
    expect(s.safeParse({ action: "list" }).success).toBe(false); // collection is required for every action
    const row = { id: "a", author: { kind: "owner", subject: "u" }, data: { x: 1 }, created_at: "2026-10-18T12:00:00.000Z", updated_at: "2026-10-18T12:00:00.000Z", archived_at: null };
    expect(s.safeParse({ action: "import", collection: "c", rows: [row] }).success).toBe(true);
    expect(s.safeParse({ action: "import", collection: "c", rows: Array.from({ length: 501 }, () => row) }).success).toBe(false);
    expect(s.safeParse({ action: "import", collection: "c", rows: [{ ...row, author: { kind: "robot", subject: "u" } }] }).success).toBe(false);
  });

  test("test_DW_6_1_schema_jwt_algorithms_asymmetric_only", () => {
    const { tools } = setup(() => undefined);
    const s = tools["data_jwt"]!.inputSchema;
    const base = { action: "set", issuer: "https://i", jwks_uri: "https://i/j", audience: "a" };
    expect(s.safeParse({ ...base, algorithms: ["ES256", "EdDSA", "PS512"] }).success).toBe(true);
    for (const alg of ["HS256", "none"]) expect(s.safeParse({ ...base, algorithms: [alg] }).success).toBe(false);
    expect(s.safeParse({ ...base, algorithms: [] }).success).toBe(false);
  });
});

describe("DW-6.1: data tool", () => {
  test("test_DW_6_1_tool_data_status_renders", async () => {
    const { call } = setup((req) => sites(req) ?? jsonResponse(200, status));
    const r = await call("data", { action: "status" });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("Site data for 'ryan': ENABLED");
    expect(text(r)).toContain("sites: for-her, results");
  });

  test("test_DW_6_1_tool_data_status_dark_launch_does_not_advertise", async () => {
    const { call } = setup(() => jsonResponse(200, darkStatus));
    const r = await call("data", { action: "status" });
    expect(text(r)).toBe("Site data is not available for this account.");
    expect(r.isError).toBeUndefined();
  });

  test("test_DW_6_1_tool_data_enable_without_consent_echoes_price_and_does_not_charge", async () => {
    const noItem = { ...status, entitled: false, billing: { ...(status as { billing: object }).billing, item_present: false, interval: null, would_charge: true } };
    const { call, calls } = setup(() => jsonResponse(200, noItem));
    const r = await call("data", { action: "enable" });
    expect(text(r)).toContain("$2.00/month or $20.00/year");
    expect(text(r)).toContain("NOTHING HAS BEEN CHARGED");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("test_DW_6_3_tool_data_enable_not_charged_account_says_no_charge_and_still_never_posts_without_accept_charge", async () => {
    const free = { ...status, entitled: false }; // fixture 'enabled' carries would_charge:false
    const { call, calls } = setup(() => jsonResponse(200, free));
    const r = await call("data", { action: "enable" });
    expect(text(r)).toContain("will not charge this account");
    expect(text(r)).not.toContain("$2.00");
    expect(text(r)).toContain("accept_charge: true");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("test_DW_6_3_tool_data_enable_would_charge_fixture_keeps_price_and_nothing_charged_wording", async () => {
    const wc = fixtureResponse(loadRoute("api.status"), "not entitled: enabling would charge").body;
    const { call, calls } = setup(() => jsonResponse(200, wc));
    const r = await call("data", { action: "enable" });
    expect(text(r)).toContain("$2.00/month or $20.00/year");
    expect(text(r)).toContain("NOTHING HAS BEEN CHARGED");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("test_DW_6_1_tool_data_enable_with_consent_charges_once", async () => {
    const enabled = fixtureResponse(loadRoute("api.enable"), "enabled").body;
    const { call, calls } = setup((req) => (req.method === "POST" ? jsonResponse(200, enabled) : jsonResponse(200, { ...status, entitled: false })));
    const r = await call("data", { action: "enable", accept_charge: true });
    expect(text(r)).toContain("Charged $1.40");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ accept_charge: true });
  });

  test("test_DW_6_1_tool_data_enable_402_upgrade_required_is_actionable_error", async () => {
    const { call } = setup((req) =>
      req.method === "POST" ? jsonResponse(402, { error: "The add-on needs a Pro or Max plan.", code: "upgrade_required" }) : jsonResponse(200, { ...status, entitled: false }),
    );
    const r = await call("data", { action: "enable", accept_charge: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("[upgrade_required]");
    expect(text(r)).toContain("upgrade tool");
  });

  test("test_DW_6_1_tool_data_enable_not_available_error", async () => {
    const { call } = setup(() => jsonResponse(200, darkStatus));
    const r = await call("data", { action: "enable", accept_charge: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not available for this account");
  });

  test("test_DW_6_1_tool_data_disable_and_forbidden", async () => {
    const ok = setup(() => jsonResponse(200, { entitled: false, wipe_after: "2026-11-17T12:00:00.000Z" }));
    expect(text(await ok.call("data", { action: "disable" }))).toContain("2026-11-17T12:00:00.000Z");
    const denied = setup(() => jsonResponse(403, { error: "Owner only.", code: "forbidden" }));
    const r = await denied.call("data", { action: "disable" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("owner role");
  });

  test("test_DW_6_1_tool_data_wipe_requires_exact_confirmation", async () => {
    const { call, calls } = setup(() => jsonResponse(200, { collections: 1, rows: 49 }));
    const bad = await call("data", { action: "wipe", confirm_namespace: "nope" });
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const ok = await call("data", { action: "wipe", confirm_namespace: "ryan" });
    expect(text(ok)).toContain("Deleted ALL site data for 'ryan': 1 collection(s), 49 row(s).");
  });

  test("test_DW_6_1_tool_data_unauthenticated_points_to_login", async () => {
    const tools = (createServer({ credentialsPath: "/nonexistent/creds", fetchFn: async () => jsonResponse(500, {}) }) as unknown as InternalServer)._registeredTools;
    const r = await tools["data"]!.handler({ action: "status" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("login tool");
  });
});

describe("DW-6.1: data_collection tool", () => {
  const view = fixtureResponse(loadRoute("api.get_collection"), "found").body;

  test("test_DW_6_1_tool_collection_list_get", async () => {
    const { call } = setup((req) => sites(req) ?? (req.path.endsWith("/collections") ? jsonResponse(200, { collections: [view] }) : jsonResponse(200, view)));
    expect(text(await call("data_collection", { action: "list" }))).toContain("Collection 'votes' (own-rows)");
    expect(text(await call("data_collection", { action: "get", collection: "votes" }))).toContain("Sites: for-her, results");
  });

  test("test_DW_6_1_tool_collection_set_creates_then_reports_created", async () => {
    const { call } = setup((req) => sites(req) ?? (req.method === "PATCH" ? jsonResponse(404, { error: "x", code: "collection_not_found" }) : jsonResponse(201, view)));
    const r = await call("data_collection", { action: "set", collection: "votes", rule: "own-rows", sites: ["for-her"], writers: ["passcode"] });
    expect(text(r)).toMatch(/^Created collection 'votes'/);
  });

  test("test_DW_6_1_tool_collection_set_updates", async () => {
    const { call } = setup((req) => sites(req) ?? jsonResponse(200, view));
    expect(text(await call("data_collection", { action: "set", collection: "votes", max_rows: 5 }))).toMatch(/^Updated collection 'votes'/);
  });

  test("test_DW_6_1_tool_collection_delete_and_errors", async () => {
    const ok = setup(() => jsonResponse(200, { collections: 1, rows: 49 }));
    expect(text(await ok.call("data_collection", { action: "delete", collection: "votes" }))).toContain("and its data (49 row(s))");
    const missing = setup(() => jsonResponse(404, { error: "x", code: "collection_not_found" }));
    const r = await missing.call("data_collection", { action: "get", collection: "nope" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("[collection_not_found]");
    const noName = await missing.call("data_collection", { action: "delete" });
    expect(noName.isError).toBe(true);
    expect(text(noName)).toContain("collection is required");
  });

  test("test_DW_6_1_tool_collection_set_unknown_site_is_clear_error", async () => {
    const { call } = setup((req) => sites(req));
    const r = await call("data_collection", { action: "set", collection: "votes", sites: ["ghost"] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Unknown site 'ghost'");
  });
});

describe("DW-6.1: data_rows tool", () => {
  const row = { id: "item-17", author: { kind: "passcode", subject: "p1", label: "her" }, data: { val: "y" }, created_at: "2026-10-18T12:00:00.000Z", updated_at: "2026-10-18T12:00:00.000Z", archived_at: null };

  test("test_DW_6_1_tool_rows_list_create_put_archive_delete_import", async () => {
    const { call, calls } = setup((req) => {
      if (req.method === "GET") return jsonResponse(200, { rows: [row], next_cursor: null });
      if (req.path.endsWith("/archive")) return jsonResponse(200, { archived: 2 });
      if (req.path.endsWith("/import")) return jsonResponse(200, { imported: 1, skipped: 0 });
      if (req.method === "DELETE") return jsonResponse(200, { deleted: true });
      return jsonResponse(req.method === "POST" ? 201 : 200, row);
    });
    expect(text(await call("data_rows", { action: "list", collection: "votes", limit: 5 }))).toContain("item-17  2026-10-18T12:00:00.000Z\n  author: passcode:p1\n  label: \"her\"");
    expect(text(await call("data_rows", { action: "create", collection: "votes", data: { a: 1 } }))).toContain("Created row");
    expect(text(await call("data_rows", { action: "put", collection: "votes", id: "item-17", data: { a: 1 } }))).toContain("Saved row");
    expect(text(await call("data_rows", { action: "archive", collection: "votes" }))).toContain("Archived 2");
    expect(text(await call("data_rows", { action: "delete", collection: "votes", id: "item-17", author: "passcode:p1" }))).toContain("Deleted row");
    const imp = await call("data_rows", { action: "import", collection: "votes", rows: [{ id: "a", author: { kind: "owner", subject: "u" }, data: {}, created_at: "t" }] });
    expect(text(imp)).toContain("Imported 1");
    expect(calls.find((c) => c.method === "DELETE")!.path).toContain("?author=passcode%3Ap1");
  });

  test("test_DW_6_1_tool_rows_export_streams_to_file", async () => {
    const dest = path.join(os.tmpdir(), `mcp-export-${Date.now()}.ndjson`);
    tmpFiles.push(dest);
    const lines = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ id: `r${i}` })).join("\n") + "\n";
    const { call } = setup(() => new Response(lines, { status: 200, headers: { "Content-Type": "application/x-ndjson" } }));
    const r = await call("data_rows", { action: "export", collection: "votes", path: dest });
    expect(text(r)).toContain(`Exported 1000 row(s) (including archived) from 'votes' to ${dest}`);
    expect(fs.readFileSync(dest, "utf-8")).toBe(lines);
  });

  test("test_DW_6_1_tool_rows_errors_are_actionable", async () => {
    const full = setup(() => jsonResponse(409, { error: "Collection is full.", code: "collection_full" }));
    const r = await full.call("data_rows", { action: "create", collection: "votes", data: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("max_rows");
    const down = setup(() => jsonResponse(502, { error: "Could not reach the data plane.", code: "admin_channel_failed" }));
    expect(text(await down.call("data_rows", { action: "archive", collection: "votes" }))).toContain("retry shortly");
    const missingPath = await down.call("data_rows", { action: "export", collection: "votes" });
    expect(missingPath.isError).toBe(true);
    expect(text(missingPath)).toContain("path is required");
  });
});

describe("DW-6.1: data_jwt tool", () => {
  const issuer = { issuer: "https://a.supabase.co/auth/v1", jwks_uri: "https://a.supabase.co/auth/v1/.well-known/jwks.json", audience: "authenticated", algorithms: ["ES256"] };

  test("test_DW_6_1_tool_jwt_set_clear_and_rejection", async () => {
    const set = setup(() => jsonResponse(200, { jwt_issuer: issuer }));
    expect(text(await set.call("data_jwt", { action: "set", ...issuer }))).toContain("JWT issuer set");
    expect(set.calls[0]).toMatchObject({ method: "PUT", path: `${DATA}/jwt-issuer`, body: issuer });
    const clear = setup(() => jsonResponse(200, { jwt_issuer: null }));
    expect(text(await clear.call("data_jwt", { action: "clear" }))).toContain("cleared");
    const bad = setup(() => jsonResponse(400, { error: "jwks_uri host is not allowed", code: "invalid_request" }));
    const r = await bad.call("data_jwt", { action: "set", ...issuer });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("jwks_uri host is not allowed");
    const missing = await bad.call("data_jwt", { action: "set", issuer: issuer.issuer });
    expect(text(missing)).toContain("jwks_uri is required");
  });
});

describe("R-J: error text from the site data tools is single-line", () => {
  const TERMINATORS: Array<[string, string]> = [["LF", "\n"], ["CR", "\r"], ["NEL", "\u0085"], ["LS", "\u2028"], ["PS", "\u2029"]];
  const lineCount = (s: string) => s.split(/\r\n|[\n\r\u0085\u2028\u2029]/).length;
  const refreshOk = () => jsonResponse(200, { access_token: "mock-access", expires_in: 3600 });
  const spaceOk = () => jsonResponse(200, { space: { id: "sp1", default_namespace_id: NS.id, tier: "pro" } });
  const nsList = (...names: string[]) => jsonResponse(200, { namespaces: names.map((name, i) => ({ id: i === 0 ? NS.id : `ns-${i}`, name, domain: "upubli.sh", role: "owner" })) });

  /** Tool handlers over a hand-written fetch, for cases that must fail before the shared stack answers. */
  function rawSetup(fetchFn: (url: string, init?: RequestInit) => Promise<Response>) {
    const file = path.join(os.tmpdir(), `mcp-site-data-raw-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(file, "refresh-token", { mode: 0o600 });
    tmpFiles.push(file);
    const tools = (createServer({ credentialsPath: file, fetchFn } as CoreDeps) as unknown as InternalServer)._registeredTools;
    return (name: string, args: Record<string, unknown>) => tools[name]!.handler(args);
  }
  const routed = (routes: Record<string, () => Response>) => async (url: string): Promise<Response> => {
    const p = url.replace(/^https?:\/\/[^/]+/, "");
    const route = Object.entries(routes).find(([k]) => p.includes(k));
    if (!route) throw new Error(`unexpected request: ${p}`);
    return route[1]();
  };

  // Each case runs the failing call with `mid` spliced into the attacker-controlled text.
  const cases: Record<string, (mid: string) => Promise<ToolResult>> = {
    a_argument_echo: (mid) =>
      setup(() => undefined).call("data", { action: "status", namespace: `zz${mid}  author: forged` }),
    b_server_500_during_namespace_resolution: (mid) =>
      rawSetup(routed({ "/auth/token/refresh": refreshOk, "/api/space": () => jsonResponse(500, { error: `boom${mid}  author: forged` }) }))("data", { action: "status" }),
    c_token_refresh_401: (mid) =>
      rawSetup(routed({ "/auth/token/refresh": () => jsonResponse(401, { error: `bad${mid}  author: forged` }) }))("data", { action: "status" }),
    d_server_listed_namespace_name: (mid) =>
      rawSetup(routed({ "/auth/token/refresh": refreshOk, "/api/space": spaceOk, "/api/ns": () => nsList("ryan", `ot${mid}her`) }))("data", { action: "status", namespace: "zz" }),
    e_export_path_enoent: (mid) =>
      setup(() => new Response('{"id":"r1"}\n', { status: 200, headers: { "Content-Type": "application/x-ndjson" } }))
        .call("data_rows", { action: "export", collection: "votes", path: path.join(os.tmpdir(), `nodir-${Date.now()}`, `x${mid}y`, "o.ndjson") }),
  };

  for (const [caseName, run] of Object.entries(cases)) {
    for (const [termName, term] of TERMINATORS) {
      test(`test_R_J_${caseName}_${termName}_does_not_forge_a_line`, async () => {
        const clean = await run("-");
        const dirty = await run(term);
        expect(clean.isError).toBe(true);
        expect(dirty.isError).toBe(true);
        expect(lineCount(text(clean))).toBe(1);
        expect(lineCount(text(dirty))).toBe(lineCount(text(clean)));
        expect(text(dirty)).toContain("\\u"); // escaped, not dropped
      });
    }
  }

  test("test_R_J_clean_error_messages_still_read_normally", async () => {
    const { call } = setup(() => jsonResponse(409, { error: "Collection is full.", code: "collection_full" }));
    const r = await call("data_rows", { action: "create", collection: "votes", data: {} });
    expect(text(r)).toStartWith("Collection is full. [collection_full] ");
    expect(text(r)).toContain("max_rows");
    const bad = await call("data", { action: "status", namespace: "zz" });
    expect(text(bad)).toContain("zz");
    expect(text(bad)).toContain("Available addresses: ryan, other");
    expect(text(bad)).not.toContain("\\u");
  });
});
