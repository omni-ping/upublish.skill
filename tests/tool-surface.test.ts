/**
 * Tool-surface snapshot: the frozen MCP contract of the upublish server.
 *
 * Pins, as committed JSON under tests/fixtures/tool-surface/:
 *  - {local,local-admin,hosted}.list.json (hosted = the default localFiles-off surface): every listed tool's full definition, in registration order;
 *  - calls.json: the error-path result of calling every tool once unauthenticated (config b);
 *  - hosted refusal: the text a default (localFiles off) server answers for a local-only tool name.
 *
 * Refactors must leave these files byte-identical. Regenerate deliberately with
 * `UPDATE_TOOL_SURFACE=1 bun test tests/tool-surface.test.ts` and review the diff.
 *
 * Machine/version independence (CI runs on Linux, and a version bump lands on main): the package version,
 * the test's own HOME dir is scrubbed to placeholders before comparing or writing, the test runs with its
 * own empty HOME and none of the UPUBLISH_* env vars, and a guard test fails if a fixture still holds any.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LOCAL_ONLY_TOOLS, PACKAGE_VERSION, createServer } from "../mcp/index.ts";
import type { CoreDeps } from "../lib/core.ts";

type McpServerT = ReturnType<typeof createServer>;
type Json = Record<string, unknown>;
type ToolDef = Json & { name: string };
type CallResult = { isError: boolean; content: unknown };

const FIXTURES = path.join(import.meta.dir, "fixtures", "tool-surface");
const UPDATE = process.env.UPDATE_TOOL_SURFACE === "1";
const NO_CREDENTIALS = "/nonexistent/upublish-credentials";

/** Tools not exercised by the call snapshot. `login` binds a loopback port and waits for a browser callback. */
const CALL_EXCLUSIONS = ["login"];

/** Minimal schema-valid args per tool, so each call gets past zod and into its handler's catch path. */
const CALL_ARGS: Record<string, Json> = {
  publish: { directory: "/nonexistent/site-dir", slug: "demo" },
  list: {},
  delete: { slug: "demo" },
  versions_list: { slug: "demo" },
  versions_delete: { slug: "demo", versionNumber: 1 },
  versions_restore: { slug: "demo", version: 1 },
  versions_limit: { slug: "demo" },
  analytics: { slug: "demo", enabled: true },
  passcode_add: { slug: "demo", code: "secret1" },
  visibility: { slug: "demo", visibility: "public" },
  passcode_list: { slug: "demo" },
  passcode_revoke: { slug: "demo" },
  gate: { action: "get", slug: "demo" },
  data: { action: "status" },
  data_collection: { action: "list" },
  data_rows: { action: "list", collection: "notes" },
  data_jwt: { action: "clear" },
  publish_backend: { site: "demo", code: "export default { fetch() { return new Response('hi'); } };" },
  backend: { action: "status" },
  backend_secret: { action: "list", site: "demo" },
  backend_logs: { site: "demo" },
  members: { action: "list" },
  promote: { slug: "demo" },
  qrcode: { slug: "demo" },
  template: { action: "list" },
  export: { slug: "demo", directory: "/nonexistent/export-dir" },
  logout: {},
  upgrade: {},
  status: {},
  namespace_create: { name: "demo" },
  domain: { action: "list" },
  rename: { nsId: "ns1", newName: "demo" },
  admin_user: { action: "lookup", email: "someone@example.com" },
  admin_site: { action: "block", siteId: "site1" },
  admin_stats: {},
  admin_storage: { action: "sweep" },
  admin_domains: { action: "list" },
};

// ─── Hermetic environment ────────────────────────────────────────────────────

const SAVED_ENV_KEYS = ["HOME", "UPUBLISH_ADMIN", "UPUBLISH_API_URL", "UPUBLISH_SITE_URL"] as const;
const savedEnv = new Map<string, string | undefined>();
let homeDir = "";

beforeAll(() => {
  for (const k of SAVED_ENV_KEYS) savedEnv.set(k, process.env[k]);
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-surface-home-"));
  process.env.HOME = homeDir;
  delete process.env.UPUBLISH_API_URL;
  delete process.env.UPUBLISH_SITE_URL;
});

const open: Array<{ client: Client; server: McpServerT }> = [];

afterEach(async () => {
  for (const { client, server } of open.splice(0)) {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
  delete process.env.UPUBLISH_ADMIN;
});

afterAll(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(homeDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Replaces everything that varies by machine or release with a stable placeholder. */
function scrub<T>(value: T): T {
  const swaps: Array<[string, string]> = [
    [PACKAGE_VERSION, "<version>"],
    // Only the test's own HOME is scrubbed, never os.tmpdir() itself: on Linux that is "/tmp", which also
    // appears as a literal example path in a tool description and must not be rewritten.
    [fs.realpathSync(homeDir), "<home>"],
    [homeDir, "<home>"],
  ];
  let s = JSON.stringify(value);
  for (const [from, to] of swaps) s = s.split(JSON.stringify(from).slice(1, -1)).join(to);
  return JSON.parse(s) as T;
}

const NO_NETWORK: CoreDeps = {
  credentialsPath: NO_CREDENTIALS,
  fetchFn: () => Promise.reject(new Error("network disabled in tool-surface test")),
};

async function connect(server: McpServerT): Promise<Client> {
  const client = new Client({ name: "tool-surface-test", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  open.push({ client, server });
  return client;
}

async function listTools(server: McpServerT): Promise<ToolDef[]> {
  const { tools } = await (await connect(server)).listTools();
  return scrub(
    tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
      execution: t.execution,
      _meta: t._meta,
    })) as ToolDef[],
  );
}

async function callTool(client: Client, name: string, args: Json): Promise<CallResult> {
  try {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: unknown };
    return { isError: r.isError === true, content: r.content };
  } catch (err) {
    // A protocol-level refusal (unknown tool) arrives as a rejection: still the caller-visible text.
    return { isError: true, content: (err as Error).message };
  }
}

function readFixture<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, file), "utf8")) as T;
}

function writeFixture(file: string, value: unknown): void {
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, file), JSON.stringify(value, null, 2) + "\n");
}

/** Per-tool differences, each naming the tool, so a failure reads as "tool X: field Y changed". */
function diffTools(actual: ToolDef[], expected: ToolDef[]): string[] {
  const out: string[] = [];
  const names = (l: ToolDef[]) => l.map((t) => t.name);
  if (JSON.stringify(names(actual)) !== JSON.stringify(names(expected))) {
    out.push(`tool names/order differ:\n  actual:   ${names(actual).join(",")}\n  expected: ${names(expected).join(",")}`);
  }
  const byName = new Map(expected.map((t) => [t.name, t]));
  for (const a of actual) {
    const e = byName.get(a.name);
    if (!e) continue;
    for (const field of new Set([...Object.keys(a), ...Object.keys(e)])) {
      if (JSON.stringify(a[field]) !== JSON.stringify(e[field])) {
        out.push(`tool "${a.name}" field "${field}":\n  actual:   ${JSON.stringify(a[field])}\n  expected: ${JSON.stringify(e[field])}`);
      }
    }
  }
  return out;
}

/** Writes the fixture under UPDATE_TOOL_SURFACE=1, otherwise returns what is committed. */
function expectedFixture<T>(file: string, actual: T): T {
  if (UPDATE) {
    writeFixture(file, actual);
    return actual;
  }
  return readFixture<T>(file);
}

const localServer = () => createServer(NO_NETWORK, { localFiles: true, openBrowser: async () => undefined }) // `upgrade` must never launch a browser;
const hostedServer = () => createServer(NO_NETWORK, { localFiles: false }); // the default createServer() surface

// ─── Listing snapshots ───────────────────────────────────────────────────────

describe("tools/list snapshot", () => {
  test("DW_0_1_local: stdio server without admin lists 33 tools exactly as committed", async () => {
    delete process.env.UPUBLISH_ADMIN;
    const actual = await listTools(localServer());
    expect(actual).toHaveLength(33);
    const expected = expectedFixture("local.list.json", actual);
    expect(expected).toHaveLength(33);
    expect(diffTools(actual, expected)).toEqual([]);
  });

  test("DW_0_1_local_admin: UPUBLISH_ADMIN=1 lists 38 tools exactly as committed", async () => {
    process.env.UPUBLISH_ADMIN = "1";
    const actual = await listTools(localServer());
    expect(actual).toHaveLength(38);
    const expected = expectedFixture("local-admin.list.json", actual);
    expect(expected).toHaveLength(38);
    expect(diffTools(actual, expected)).toEqual([]);
  });

  test("DW_0_1_hosted: default (localFiles off) server lists 33 minus the 7 LOCAL_ONLY tools (26), as committed", async () => {
    process.env.UPUBLISH_ADMIN = "1"; // a localFiles-off server must ignore it
    const actual = await listTools(hostedServer());
    expect(actual).toHaveLength(33 - LOCAL_ONLY_TOOLS.length);
    expect(actual).toHaveLength(26);
    const expected = expectedFixture("hosted.list.json", actual);
    expect(expected).toHaveLength(26);
    expect(diffTools(actual, expected)).toEqual([]);
  });

  test("DW_0_1_order: local-admin extends local by exactly the 5 admin tools, same relative order", () => {
    const local = readFixture<ToolDef[]>("local.list.json").map((t) => t.name);
    const admin = readFixture<ToolDef[]>("local-admin.list.json").map((t) => t.name);
    expect(admin.filter((n) => local.includes(n))).toEqual(local);
    expect(admin.filter((n) => !local.includes(n))).toHaveLength(5);
  });
});

// ─── Tamper detection (DW-0.2 as an in-suite proof) ──────────────────────────

describe("tamper detection", () => {
  test("DW_0_2_description_change_names_the_tool", () => {
    const expected = readFixture<ToolDef[]>("local.list.json");
    const tampered = structuredClone(expected);
    const victim = tampered.find((t) => t.name === "visibility")!;
    victim.description = `${String(victim.description)} Tampered.`;
    const diffs = diffTools(tampered, expected);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain('tool "visibility" field "description"');
  });

  test("a schema change, a reorder and a dropped tool are all reported", () => {
    const expected = readFixture<ToolDef[]>("local.list.json");
    const schema = structuredClone(expected);
    (schema[0]!.inputSchema as Json).required = ["nope"];
    expect(diffTools(schema, expected)[0]).toContain(`tool "${expected[0]!.name}" field "inputSchema"`);
    expect(diffTools([...expected].reverse(), expected)[0]).toContain("names/order differ");
    expect(diffTools(expected.slice(1), expected)[0]).toContain("names/order differ");
  });
});

// ─── Error-path call snapshot ────────────────────────────────────────────────

describe("unauthenticated call snapshot", () => {
  test("DW_0_3_calls: every tool of the admin config except the exclusions has an entry, and results match", async () => {
    process.env.UPUBLISH_ADMIN = "1";
    const listed = (await listTools(localServer())).map((t) => t.name);
    const toCall = listed.filter((n) => !CALL_EXCLUSIONS.includes(n));
    expect(Object.keys(CALL_ARGS).sort()).toEqual([...toCall].sort());

    const client = await connect(localServer());
    const actual: Record<string, CallResult> = {};
    for (const name of listed) {
      if (!CALL_EXCLUSIONS.includes(name)) actual[name] = scrub(await callTool(client, name, CALL_ARGS[name]!));
    }
    const expected = expectedFixture("calls.json", actual);

    expect(Object.keys(expected)).toEqual(toCall); // ordered, complete
    expect(listed.filter((n) => !(n in expected))).toEqual(CALL_EXCLUSIONS);
    expect(actual).toEqual(expected);
  });

  test("calls are unauthenticated and offline: no call result is a success that needed the network", () => {
    const calls = readFixture<Record<string, CallResult>>("calls.json");
    const ok = Object.entries(calls).filter(([, r]) => !r.isError).map(([n]) => n);
    // Only tools that legitimately answer without a session may succeed: logout and status (local-only
    // state) and template (lists bundled starters).
    expect(ok.sort()).toEqual(["logout", "status", "template"].filter((n) => ok.includes(n)));
  });

  test("DW_0_3_hosted_refusal: a localFiles-off server refuses a local-only tool name with a stable message", async () => {
    const client = await connect(hostedServer());
    const actual = scrub(await callTool(client, "publish", CALL_ARGS.publish!));
    const expected = expectedFixture("hosted-refusal.json", actual);
    expect(actual.isError).toBe(true);
    expect(actual).toEqual(expected);
  });
});

// ─── Fixture hygiene ─────────────────────────────────────────────────────────

describe("fixtures are machine- and release-independent", () => {
  const files = () => fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));

  test("no version string, absolute machine path, temp or home dir, or timestamp", () => {
    expect(files().sort()).toEqual(["calls.json", "hosted-refusal.json", "hosted.list.json", "local-admin.list.json", "local.list.json"]);
    const banned: Array<[string, RegExp]> = [
      ["package version", new RegExp(PACKAGE_VERSION.replaceAll(".", "\\."))],
      ["/Users/", /\/Users\//],
      ["/private/", /\/private\//],
      ["mkdtemp dir", /tool-surface-home-/],
      ["/var/folders", /\/var\/folders/],
      ["/home/", /\/home\//],
      ["ISO timestamp", /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/],
    ];
    for (const f of files()) {
      const body = fs.readFileSync(path.join(FIXTURES, f), "utf8");
      for (const [label, re] of banned) expect({ file: f, label, hit: re.test(body) }).toEqual({ file: f, label, hit: false });
    }
  });
});
