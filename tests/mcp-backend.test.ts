/**
 * DW-6.1: MCP adapter tests for the backend tools (`publish_backend`,
 * `backend`, `backend_secret`, `backend_logs`): registration, zod argument
 * schemas, every action through the registered handler over an injected fetch,
 * error paths, and the secret-handling guarantees.
 */

import { describe, test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ZodTypeAny } from "zod";
import { createServer } from "../mcp/index.ts";
import { backendSecret, type CoreDeps } from "../lib/core.ts";
import { NS, SITES_BODY, jsonResponse, stackFetch, type Handler, type Recorded } from "./helpers/site-data.ts";
import { backendResponse, loadBackendRoute, SLUG } from "./helpers/backend.ts";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type RegisteredTool = { handler: (args: Record<string, unknown>) => Promise<ToolResult>; inputSchema: ZodTypeAny; description?: string };
type InternalServer = { _registeredTools: Record<string, RegisteredTool> };

// The skill logs to ~/.upublish/publish.log: point HOME at a temp dir so these tests never touch the real one.
const realHome = process.env.HOME;
let tempHome = "";
beforeAll(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-backend-home-"));
  process.env.HOME = tempHome;
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

const tmp: string[] = [];
afterEach(() => { for (const f of tmp.splice(0)) fs.rmSync(f, { force: true, recursive: true }); });

function setup(handler: Handler, opts: { credentials?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-backend-"));
  tmp.push(dir);
  const file = path.join(dir, "credentials");
  if (opts.credentials !== false) fs.writeFileSync(file, "refresh-token", { mode: 0o600 });
  const { fetchFn, calls } = stackFetch(handler);
  const deps: CoreDeps = { credentialsPath: file, fetchFn };
  const tools = (createServer(deps) as unknown as InternalServer)._registeredTools;
  return { tools, dir, file, calls, call: (name: string, args: Record<string, unknown>) => tools[name]!.handler(args) };
}

const text = (r: ToolResult) => r.content[0]!.text;
const BASE = `/api/ns/${NS.id}`;
const BACKEND = `${BASE}/sites/${SLUG}/backend`;
const ADDON = `${BASE}/backend-addon`;
const fx = (route: string, name: string) => backendResponse(loadBackendRoute(route), name);
const reply = (route: string, name: string) => { const r = fx(route, name); return jsonResponse(r.status, r.body); };
const CODE = "export default { async fetch() { return Response.json({ ok: true }); } };";
const offered = { ...fx("addon.status", "not-yet-launched").body, available: true, billing: { ...fx("addon.status", "not-yet-launched").body.billing, would_charge: true } };

describe("DW-6.1: backend tool registration and schemas", () => {
  test("test_DW_6_1_four_backend_tools_registered", () => {
    const { tools } = setup(() => undefined);
    for (const n of ["publish_backend", "backend", "backend_secret", "backend_logs"]) expect(n in tools).toBe(true);
  });

  test("test_DW_6_1_descriptions_state_cost_consent_and_route_to_the_guide", () => {
    const { tools } = setup(() => undefined);
    const d = tools["backend"]!.description!;
    expect(d).toContain("CHARGES");
    expect(d).toContain("includes Site data");
    expect(d).toContain("WITHOUT accept_charge it charges nothing");
    expect(d).toContain("accept_charge: true AND that same `expected`");
    expect(d).toContain("Free plans must use the upgrade tool first");
    expect(d).toContain("not available for this account");
    expect(d).toContain("DESTRUCTIVE and irreversible: deletes the site's backend script, ALL its versions and archives and its secrets");
    expect(d).toContain("frees one of the 5 per-address backend slots");
    expect(d).toContain("Requires confirm_site equal to the site slug");
    for (const n of ["publish_backend", "backend"]) expect(tools[n]!.description).toContain("references/backends.md");
    expect(tools["backend_secret"]!.description).toContain("NAMES only");
    expect(tools["backend_logs"]!.description).toContain("untrusted data");
  });

  test("backend actions: the ten, delete among them, no unknown", () => {
    const { tools } = setup(() => undefined);
    const s = tools["backend"]!.inputSchema;
    for (const action of ["status", "versions", "rollback", "enable", "disable", "access", "delete", "addon_status", "addon_enable", "addon_disable"]) {
      expect(s.safeParse({ action }).success).toBe(true);
    }
    expect(s.safeParse({ action: "nuke" }).success).toBe(false);
    expect(s.safeParse({ action: "delete", confirm_site: "" }).success).toBe(false);
    expect(s.safeParse({ action: "addon_enable", accept_charge: "yes" }).success).toBe(false);
    expect(s.safeParse({ action: "rollback", version: 0 }).success).toBe(false);
    expect(s.safeParse({ action: "access", access: "everyone" }).success).toBe(false);
  });

  test("expected is a strict object of the six consent fields", () => {
    const { tools } = setup(() => undefined);
    const s = tools["backend"]!.inputSchema;
    const ok = { would_charge: true, converts_data_addon: false, interval: "month", price_cents: 300, month_cents: 300, year_cents: 3000 };
    expect(s.safeParse({ action: "addon_enable", accept_charge: true, expected: ok }).success).toBe(true);
    expect(s.safeParse({ action: "addon_enable", expected: { ...ok, extra: 1 } }).success).toBe(false);
    expect(s.safeParse({ action: "addon_enable", expected: { ...ok, interval: "week" } }).success).toBe(false);
    expect(s.safeParse({ action: "addon_enable", expected: { ...ok, price_cents: -1 } }).success).toBe(false);
  });

  test("publish_backend: site required; vars names and counts are bounded; access enum", () => {
    const { tools } = setup(() => undefined);
    const s = tools["publish_backend"]!.inputSchema;
    expect(s.safeParse({ entry: "a.ts" }).success).toBe(false);
    expect(s.safeParse({ site: "contact", entry: "a.ts", access: "public", vars: { A_B: "x" } }).success).toBe(true);
    expect(s.safeParse({ site: "contact", code: CODE, access: "private" }).success).toBe(false);
    expect(s.safeParse({ site: "contact", code: CODE, vars: { "bad-name": "x" } }).success).toBe(false);
    expect(s.safeParse({ site: "contact", code: CODE, vars: { A: "x".repeat(5121) } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`V${i}`, "x"]));
    expect(s.safeParse({ site: "contact", code: CODE, vars: many }).success).toBe(false);
    expect(s.safeParse({ site: "", code: CODE }).success).toBe(false);
  });

  test("backend_secret and backend_logs schemas", () => {
    const { tools } = setup(() => undefined);
    const sec = tools["backend_secret"]!.inputSchema;
    expect(sec.safeParse({ action: "set", site: "c", name: "KEY_1", value: "v" }).success).toBe(true);
    expect(sec.safeParse({ action: "set", site: "c", name: "1KEY", value: "v" }).success).toBe(false);
    expect(sec.safeParse({ action: "set", site: "c", name: "K", value: "" }).success).toBe(false);
    expect(sec.safeParse({ action: "set", site: "c", name: "K", value: "x".repeat(5121) }).success).toBe(false);
    expect(sec.safeParse({ action: "drop", site: "c" }).success).toBe(false);
    const logs = tools["backend_logs"]!.inputSchema;
    expect(logs.safeParse({ site: "c", limit: 100 }).success).toBe(true);
    expect(logs.safeParse({ site: "c", limit: 101 }).success).toBe(false);
    expect(logs.safeParse({ site: "c", limit: 0 }).success).toBe(false);
  });
});

describe("DW-6.1: publish_backend through the handler", () => {
  const deploy: Handler = (req) => {
    if (req.method === "POST" && req.path === BACKEND) return reply("backend.deploy", "deployed");
    if (req.method === "GET" && req.path === `${BASE}/sites`) return jsonResponse(200, SITES_BODY);
    return undefined;
  };

  test("deploys inline code and prints the result", async () => {
    const { call, calls } = setup(deploy);
    const r = await call("publish_backend", { site: SLUG, code: CODE, access: "public", vars: { PUBLIC_TO: "a@b.c" } });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("Backend deployed for 'contact' in address 'ryan'");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ access: "public", vars: { PUBLIC_TO: "a@b.c" } });
  });

  test("test_DW_6_1_bundle_failure_surfaces_compiler_errors_as_an_error_and_sends_nothing", async () => {
    const { call, calls } = setup(deploy);
    const r = await call("publish_backend", { site: SLUG, code: "export default {{{" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Nothing was uploaded.");
    expect(text(r)).toContain("Bundling failed:");
    expect(calls.filter((c) => c.path.includes("/sites/"))).toEqual([]);
  });

  test("test_DW_6_1_bundle_over_1mb_is_an_error_caught_locally", async () => {
    const { call, calls } = setup(deploy);
    const r = await call("publish_backend", { site: SLUG, code: `export default { fetch() { return new Response("${"a".repeat(1_100_000)}"); } };` });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/limit is 1048576/);
    expect(calls.filter((c) => c.path.includes("/sites/"))).toEqual([]);
  });

  test("a deploy refused by the add-on gate is an error carrying its code and next step", async () => {
    const { call } = setup(() => reply("backend.deploy", "addon-off"));
    const r = await call("publish_backend", { site: SLUG, code: CODE });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("[addon_not_enabled]");
    expect(text(r)).toContain("addon_enable");
  });

  test("both entry and code is an argument error", async () => {
    const { call } = setup(deploy);
    const r = await call("publish_backend", { site: SLUG, code: CODE, entry: "x.ts" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("exactly one of");
  });
});

describe("DW-6.1: backend actions through the handler", () => {
  const status = fx("backend.status", "deployed").body;
  const handler: Handler = (req) => {
    if (req.path === BACKEND && req.method === "GET") return jsonResponse(200, status);
    if (req.path === BACKEND && req.method === "PATCH") return jsonResponse(200, { ...status, ...(req.body as object) });
    if (req.path === `${BACKEND}/versions`) return reply("backend.versions", "two-versions");
    if (req.path === `${BACKEND}/rollback`) return reply("backend.rollback", "rolled-back");
    return undefined;
  };

  test("status, versions, rollback, enable, disable, access", async () => {
    const { call, calls } = setup(handler);
    expect(text(await call("backend", { action: "status", site: SLUG }))).toContain("version 2, access: site");
    expect(text(await call("backend", { action: "versions", site: SLUG }))).toContain("v2 (live)");
    expect(text(await call("backend", { action: "rollback", site: SLUG, version: 1 }))).toContain("version 1 is live again");
    expect(text(await call("backend", { action: "disable", site: SLUG }))).toContain("Backend disabled");
    expect(text(await call("backend", { action: "enable", site: SLUG }))).toContain("Backend re-enabled");
    expect(text(await call("backend", { action: "access", site: SLUG, access: "public" }))).toContain("Access set to public");
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ disabled: true }, { disabled: false }, { access: "public" }]);
  });

  test("test_DW_6_1_delete_needs_the_slug_echo_then_deletes", async () => {
    const { call, calls } = setup((req) => (req.method === "DELETE" && req.path === BACKEND ? reply("backend.delete", "deleted") : undefined));
    const noEcho = await call("backend", { action: "delete", site: SLUG });
    expect(noEcho.isError).toBe(true);
    expect(text(noEcho)).toContain("confirm_site is required");
    const wrong = await call("backend", { action: "delete", site: SLUG, confirm_site: "nope" });
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toContain("Nothing was deleted");
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    const done = await call("backend", { action: "delete", site: SLUG, confirm_site: SLUG });
    expect(done.isError).toBeUndefined();
    expect(text(done)).toContain("deleted");
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  test("a missing site or version is an error naming the argument", async () => {
    const { call } = setup(handler);
    const a = await call("backend", { action: "status" });
    expect(a.isError).toBe(true);
    expect(text(a)).toContain("site is required when action is 'status'");
    expect(text(await call("backend", { action: "rollback", site: SLUG }))).toContain("version is required");
  });

  test("a forbidden member and an unknown site are errors with their codes", async () => {
    expect(text(await setup(() => reply("backend.update", "not-admin")).call("backend", { action: "disable", site: SLUG }))).toContain("[forbidden]");
    const r = await setup(() => reply("backend.status", "unknown-site")).call("backend", { action: "status", site: "zzz" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("[not_found]");
  });
});

describe("DW-6.1: add-on consent through the handler", () => {
  const posts = (calls: Recorded[]) => calls.filter((c) => c.method === "POST");
  const server = (status: object = offered, post: () => Response = () => reply("addon.enable", "charged")) =>
    setup((req) => {
      if (req.method === "GET" && req.path === ADDON) return jsonResponse(200, status);
      if (req.method === "POST" && req.path === `${ADDON}/enable`) return post();
      if (req.method === "POST" && req.path === `${ADDON}/disable`) return reply("addon.disable", "disabled");
      return undefined;
    });
  const expectedOf = (consent: string) => JSON.parse(consent.split("\n").find((l) => l.startsWith("expected: "))!.slice("expected: ".length)) as Record<string, unknown>;

  test("test_DW_6_1_addon_status_when_not_available_tells_the_user_to_stop", async () => {
    const { call } = server(fx("addon.status", "not-yet-launched").body);
    expect(text(await call("backend", { action: "addon_status" }))).toBe("The Backend add-on is not available for this account.");
  });

  test("addon_status shows the enabled add-on", async () => {
    const { call } = server(fx("addon.status", "enabled").body);
    expect(text(await call("backend", { action: "addon_status" }))).toContain("ENABLED");
  });

  test("test_DW_6_1_enable_never_charges_without_the_consent_echo", async () => {
    const { call, calls } = server();
    const consent = text(await call("backend", { action: "addon_enable" }));
    expect(consent).toContain("prorated");
    expect(consent).toContain("$3.00/month or $30.00/year");
    expect(consent).toContain("includes Site data");
    expect(posts(calls)).toEqual([]);

    const noEcho = await call("backend", { action: "addon_enable", accept_charge: true });
    expect(text(noEcho)).toContain("accept_charge needs the exact `expected` object");
    expect(posts(calls)).toEqual([]);

    const wrong = await call("backend", { action: "addon_enable", accept_charge: true, expected: { ...expectedOf(consent), month_cents: 100 } });
    expect(text(wrong)).toContain("changed since the last consent");
    expect(posts(calls)).toEqual([]);
  });

  test("test_DW_6_1_enable_after_the_echo_charges_once", async () => {
    const { call, calls } = server();
    const consent = text(await call("backend", { action: "addon_enable" }));
    const done = await call("backend", { action: "addon_enable", accept_charge: true, expected: expectedOf(consent) });
    expect(done.isError).toBeUndefined();
    expect(text(done)).toContain("The Backend add-on is enabled");
    expect(text(done)).toContain("Charged: $3.00/month");
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0]!.body).toEqual({ accept_charge: true });
  });

  test("402 free tier on enable is an error with the upgrade hint; disable works for the owner", async () => {
    const { call } = server(offered, () => reply("addon.enable", "free-tier"));
    const consent = text(await call("backend", { action: "addon_enable" }));
    const r = await call("backend", { action: "addon_enable", accept_charge: true, expected: expectedOf(consent) });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("[upgrade_required]");
    expect(text(r)).toContain("upgrade tool");
    expect(text(await server().call("backend", { action: "addon_disable" }))).toContain("every /_api endpoint stops answering now");
  });
});

describe("DW-6.1: unauthenticated", () => {
  for (const [tool, args] of [
    ["publish_backend", { site: SLUG, code: CODE }],
    ["backend", { action: "status", site: SLUG }],
    ["backend", { action: "addon_status" }],
    ["backend_secret", { action: "list", site: SLUG }],
    ["backend_logs", { site: SLUG }],
  ] as const) {
    test(`test_DW_6_1_unauthenticated_${tool}_${(args as { action?: string }).action ?? "deploy"}`, async () => {
      const { call, calls } = setup(() => undefined, { credentials: false });
      const r = await call(tool, args);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("Not authenticated");
      expect(calls).toEqual([]);
    });
  }

  test("a 401 from the API is an error pointing at login", async () => {
    const { call } = setup(() => jsonResponse(401, { error: "bad token", code: "unauthenticated" }));
    const r = await call("backend", { action: "status", site: SLUG });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("login tool");
  });
});

describe("DW-6.1: backend_logs through the handler", () => {
  test("prints the lines fenced as untrusted data", async () => {
    const { call, calls } = setup(() => reply("backend.logs", "lines"));
    const r = await call("backend_logs", { site: SLUG, limit: 50 });
    expect(text(r)).toContain("untrusted text");
    expect(text(r)).toContain('"TypeError: cannot read properties of undefined"');
    expect(calls[0]!.path).toBe(`${BACKEND}/logs?limit=50`);
  });

  test("an out-of-range limit that bypasses zod is still an error", async () => {
    const { call } = setup(() => undefined);
    const r = await call("backend_logs", { site: SLUG, limit: 500 });
    expect(r.isError).toBe(true);
  });
});

describe("DW-6.1: secrets are never echoed, logged or written locally", () => {
  const SENTINEL = "SENTINEL-s3cr3t-9f1c2e7a-do-not-leak";
  const logFile = () => path.join(process.env.HOME!, ".upublish", "publish.log");
  const logSize = () => (fs.existsSync(logFile()) ? fs.statSync(logFile()).size : 0);
  const logTail = (from: number) => (fs.existsSync(logFile()) ? fs.readFileSync(logFile()).subarray(from).toString("utf-8") : "");
  const filesUnder = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));

  test("test_DW_6_1_set_sends_the_value_once_and_it_never_reaches_output_log_or_disk", async () => {
    const { call, calls, dir, file } = setup((req) => (req.method === "PUT" ? reply("backend.secret_set", "set") : undefined));
    const before = fs.readFileSync(file, "utf-8");
    const logFrom = logSize();

    const r = await call("backend_secret", { action: "set", site: SLUG, name: "RESEND_API_KEY", value: SENTINEL });

    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("Secret 'RESEND_API_KEY' is set");
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
    // The only appearance on the wire is the one PUT body.
    const withValue = calls.filter((c) => JSON.stringify(c).includes(SENTINEL));
    expect(withValue).toHaveLength(1);
    expect(withValue[0]).toMatchObject({ method: "PUT", path: `${BACKEND}/secrets/RESEND_API_KEY`, body: { value: SENTINEL } });
    // Not in the skill's own log, not in the credentials file, not anywhere under the credentials dir.
    expect(logTail(logFrom)).not.toContain(SENTINEL);
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
    for (const f of filesUnder(dir)) expect(fs.readFileSync(f, "utf-8")).not.toContain(SENTINEL);
  });

  test("test_DW_6_1_a_server_error_that_echoes_the_value_cannot_put_it_in_tool_output_or_the_log", async () => {
    const { call } = setup(() => jsonResponse(400, { error: `rejected value ${SENTINEL}`, code: "invalid_request" }));
    const logFrom = logSize();
    const r = await call("backend_secret", { action: "set", site: SLUG, name: "K", value: SENTINEL });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
    expect(text(r)).toContain("[redacted]");
    // The api client logs error bodies; a body answering a secret PUT is withheld (status only).
    const tail = logTail(logFrom);
    expect(tail).toContain("[api] status=400");
    expect(tail).not.toContain(SENTINEL);
  });

  test("an unstructured gateway error that echoes the value is scrubbed from output and log", async () => {
    const { call } = setup(() => new Response(`<html>${SENTINEL}</html>`, { status: 502, statusText: `Bad ${SENTINEL}` }));
    const logFrom = logSize();
    const r = await call("backend_secret", { action: "set", site: SLUG, name: "K", value: SENTINEL });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
    expect(logTail(logFrom)).not.toContain(SENTINEL);
  });

  test("test_DW_6_1_a_multi_line_secret_echoed_in_any_spelling_reaches_neither_output_nor_log", async () => {
    const PEM = "-----BEGIN KEY-----\nPEMLINE-aaaa-1111\nPEMLINE-bbbb-2222\n-----END KEY-----\twith\ttabs-3333";
    const fragments = ["PEMLINE-aaaa-1111", "PEMLINE-bbbb-2222", "tabs-3333", PEM, JSON.stringify(PEM).slice(1, -1)];
    const echoes: Array<{ error: string; code: string }> = [
      { error: `bad ${PEM}`, code: "invalid_request" },
      { error: "one line PEMLINE-bbbb-2222 only", code: "invalid_request" },
      { error: JSON.stringify({ value: PEM }), code: "invalid_request" },
      { error: "text", code: PEM },
      { error: "text", code: "PEMLINE-aaaa-1111" },
    ];
    for (const echo of echoes) {
      const { call } = setup(() => jsonResponse(400, echo));
      const logFrom = logSize();
      const r = await call("backend_secret", { action: "set", site: SLUG, name: "K", value: PEM });
      expect(r.isError).toBe(true);
      const haystack = JSON.stringify(r) + text(r) + logTail(logFrom);
      for (const f of fragments) expect(haystack, `leaked ${f}`).not.toContain(f);
    }
  });

  test("test_DW_6_1_every_error_on_the_secret_path_is_redacted_whatever_its_kind", async () => {
    const SECRET = "ZQXsecret-padded-value-90817";
    const NON_ASCII = "pässwörd-日本語-ZQX90817";
    const lower = "p\\u00e4ssw\\u00f6rd-\\u65e5\\u672c\\u8a9e-ZQX90817";
    const upper = lower.replace(/\\u([0-9a-f]{4})/g, (_: string, h: string) => `\\u${h.toUpperCase()}`);
    const scenarios: Array<{ label: string; value: string; fragments: string[]; handler: () => Response }> = [
      { label: "2xx non-JSON body starting with the secret", value: SECRET, fragments: [SECRET, "ZQXsecret"], handler: () => new Response(`${SECRET} saved`, { status: 200 }) },
      { label: "padded secret echoed trimmed", value: `  ${SECRET}  `, fragments: [SECRET], handler: () => jsonResponse(400, { error: `bad ${SECRET} here`, code: "invalid_request" }) },
      { label: "non-ASCII echoed with lowercase \\u escapes", value: NON_ASCII, fragments: [NON_ASCII, lower, "ZQX90817"], handler: () => jsonResponse(400, { error: `bad ${lower}`, code: "invalid_request" }) },
      { label: "non-ASCII echoed with uppercase \\u escapes", value: NON_ASCII, fragments: [NON_ASCII, upper, "ZQX90817"], handler: () => jsonResponse(400, { error: `bad ${upper}`, code: "invalid_request" }) },
      { label: "a thrown TypeError containing the secret", value: SECRET, fragments: [SECRET], handler: () => { throw new TypeError(`Cannot read ${SECRET}`); } },
      { label: "a network error whose message contains the secret", value: SECRET, fragments: [SECRET], handler: () => { throw new Error(`connect ECONNREFUSED ${SECRET}`, { cause: new Error(`inner ${SECRET}`) }); } },
    ];
    for (const sc of scenarios) {
      const { call } = setup(sc.handler);
      const logFrom = logSize();
      const r = await call("backend_secret", { action: "set", site: SLUG, name: "K", value: sc.value });
      expect(r.isError, sc.label).toBe(true);
      const haystack = JSON.stringify(r) + text(r) + logTail(logFrom);
      for (const f of sc.fragments) expect(haystack, `${sc.label}: leaked ${f}`).not.toContain(f);
    }
  });

  test("test_DW_6_1_ensure_ascii_style_echo_of_a_quote_backslash_and_non_ascii_secret_leaks_nowhere", async () => {
    const V = 'pä"ss\\wörd-ZQX9999';
    const lower = 'p\\u00e4\\"ss\\\\w\\u00f6rd-ZQX9999';
    const upper = lower.replace(/\\u([0-9a-f]{4})/g, (_: string, h: string) => `\\u${h.toUpperCase()}`);
    for (const echo of [lower, upper]) {
      const handler = () => jsonResponse(400, { error: `bad ${echo}`, code: "invalid_request" });
      // Through the MCP handler: the result and the log.
      const viaMcp = setup(handler);
      const logFrom = logSize();
      const r = await viaMcp.call("backend_secret", { action: "set", site: SLUG, name: "K", value: V });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r) + text(r) + logTail(logFrom)).not.toContain("ZQX9999");
      // Through core.backendSecret: the thrown message, stack and cause.
      const viaCore = setup(handler);
      const thrown = await backendSecret({ action: "set", site: SLUG, name: "K", value: V }, { credentialsPath: viaCore.file, fetchFn: stackFetch(handler).fetchFn }).catch((e: Error) => e);
      expect(thrown).toBeInstanceOf(Error);
      const err = thrown as Error;
      expect(`${err.message}\n${err.stack ?? ""}\n${String((err as { cause?: unknown }).cause ?? "")}`).not.toContain("ZQX9999");
      expect((err as { cause?: unknown }).cause).toBeUndefined();
    }
  });

  test("test_DW_6_1_a_server_PUT_response_whose_name_equals_the_value_is_never_printed", async () => {
    const VALUE = "RESEND_API_KEY_ZQX90817";
    const { call } = setup(() => jsonResponse(200, { name: VALUE, set_at: "2026-11-06T12:00:00.000Z" }));
    const logFrom = logSize();
    const r = await call("backend_secret", { action: "set", site: SLUG, name: "RESEND_API_KEY", value: VALUE });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("Secret 'RESEND_API_KEY' is set");
    expect(JSON.stringify(r) + logTail(logFrom)).not.toContain(VALUE);
    const del = setup(() => jsonResponse(200, { deleted: VALUE }));
    expect(text(await del.call("backend_secret", { action: "delete", site: SLUG, name: "RESEND_API_KEY" }))).not.toContain(VALUE);
  });

  test("control: a non-secret request still logs its error body (the omission is specific to secrets)", async () => {
    const MARK = "LOGGED-BODY-MARKER-4e1b";
    const { call } = setup(() => jsonResponse(500, { error: MARK, code: "unavailable" }));
    const logFrom = logSize();
    await call("backend", { action: "status", site: SLUG });
    expect(logTail(logFrom)).toContain(MARK);
  });

  test("list and delete return names only", async () => {
    const list = await setup(() => reply("backend.secrets_list", "one-secret")).call("backend_secret", { action: "list", site: SLUG });
    expect(text(list)).toContain("RESEND_API_KEY");
    expect(text(list)).toContain("values are never shown");
    const del = await setup(() => reply("backend.secret_delete", "deleted")).call("backend_secret", { action: "delete", site: SLUG, name: "RESEND_API_KEY" });
    expect(text(del)).toContain("Secret 'RESEND_API_KEY' deleted");
  });

  test("addon-off 402 on set is an error without the value", async () => {
    const r = await setup(() => reply("backend.secret_set", "addon-off")).call("backend_secret", { action: "set", site: SLUG, name: "K", value: SENTINEL });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("[addon_not_enabled]");
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });

  test("argument errors never quote the value", async () => {
    const r = await setup(() => undefined).call("backend_secret", { action: "set", site: SLUG, name: "bad-name", value: SENTINEL });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });
});
