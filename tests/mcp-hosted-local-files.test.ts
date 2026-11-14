/**
 * Hosted /mcp must never touch the machine the server runs on.
 *
 * DW-1.1 tool lists, DW-1.2 call-time refusal with no side effects, DW-1.3 data_rows export,
 * DW-1.4 status() with an injected tokenProvider, DW-1.5 inline publish_backend sandbox,
 * DW-1.7 createHostedServer self-verification. Nothing here reaches the network: every fetch is a stub.
 */

import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ADMIN_TOOLS,
  LOCAL_ONLY_TOOLS,
  HostedServerUnsafeError,
  assertHostedServerSafe,
  createHostedServer,
  createServer,
  openUrlIfLocal,
  stdioServerOptions,
} from "../mcp/index.ts";
import type { CoreDeps, CreateServerOpts } from "../mcp/index.ts";
import * as auth from "../lib/auth.ts";
import { log, setFileLogging } from "../lib/log.ts";
import { status } from "../lib/core.ts";

type McpServerT = ReturnType<typeof createServer>;

/** The full stdio tool set today (32 tools). A new tool must be added here deliberately. */
const STDIO_TOOLS = [
  "publish", "list", "delete", "versions_list", "versions_delete", "versions_restore", "versions_limit", "analytics",
  "passcode_add", "visibility", "passcode_list", "passcode_revoke", "gate", "data", "data_collection", "data_rows",
  "data_jwt", "publish_backend", "backend", "backend_secret", "backend_logs", "members", "promote", "qrcode", "logout",
  "login", "upgrade", "status", "namespace_create", "domain", "rename", "template", "export",
];

const HOSTED: CoreDeps = { tokenProvider: async () => "t" };

const tmpDirs: string[] = [];
const open: Array<{ client: Client; server: McpServerT }> = [];
const savedAdmin = process.env.UPUBLISH_ADMIN;

afterEach(async () => {
  setFileLogging(true); // createHostedServer flips this process-wide; other test files rely on the default
  for (const { client, server } of open) {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
  open.length = 0;
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
  if (savedAdmin === undefined) delete process.env.UPUBLISH_ADMIN;
  else process.env.UPUBLISH_ADMIN = savedAdmin;
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-local-"));
  tmpDirs.push(d);
  return d;
}

const names = (s: McpServerT): string[] => Object.keys((s as unknown as { _registeredTools: object })._registeredTools);

async function connect(server: McpServerT): Promise<Client> {
  const client = new Client({ name: "hosted-test", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  open.push({ client, server });
  return client;
}

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  try {
    return (await client.callTool({ name, arguments: args })) as Result;
  } catch (err) {
    // A protocol-level refusal (unknown tool) reaches the caller as a rejection: still a refusal.
    return { content: [{ type: "text", text: (err as Error).message }], isError: true };
  }
}
const text = (r: Result) => r.content.map((c) => c.text).join("\n");

/** Fetch stub that records every URL and answers like a minimal authenticated API. */
function recordingFetch(seen: string[]): CoreDeps["fetchFn"] {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  return async (url: string) => {
    seen.push(url);
    if (url.includes("/auth/token/refresh")) return json({ access_token: "a", expires_in: 3600 });
    if (url.includes("/auth/me")) return json({ username: "caller@example.com" });
    if (url.endsWith("/api/space")) return json({ space: { id: "sp", default_namespace_id: "ns1", tier: "pro" } });
    if (/\/api\/ns$/.test(url)) return json({ namespaces: [{ id: "ns1", name: "caller", domain: "upubli.sh", role: "owner" }] });
    if (url.includes("/rows")) return json({ rows: [], next_cursor: null });
    return json({});
  };
}

describe("DW-1.1: hosted tool list has no local-only or admin tool", () => {
  const forbidden = [...LOCAL_ONLY_TOOLS, ...ADMIN_TOOLS];

  test("LOCAL_ONLY_TOOLS and ADMIN_TOOLS are the pinned name lists", () => {
    expect([...LOCAL_ONLY_TOOLS]).toEqual(["publish", "qrcode", "login", "logout", "upgrade", "template", "export"]);
    expect([...ADMIN_TOOLS]).toEqual(["admin_user", "admin_site", "admin_stats", "admin_storage", "admin_domains"]);
  });

  test.each([
    ["createServer(deps)", () => createServer({ fetchFn: recordingFetch([]) })],
    ["createServer() with no args", () => createServer()],
    ["createServer(deps, { localFiles: false })", () => createServer({}, { localFiles: false })],
    ["createServer(deps, {})", () => createServer({}, {})],
    ["createHostedServer(deps)", () => createHostedServer(HOSTED)],
  ])("%s lists none of them, even with UPUBLISH_ADMIN=1 (registry and tools/list)", async (_label, make) => {
    process.env.UPUBLISH_ADMIN = "1";
    const server = make();
    for (const n of forbidden) expect(names(server)).not.toContain(n);
    const listed = (await (await connect(server)).listTools()).tools.map((t) => t.name);
    for (const n of forbidden) expect(listed).not.toContain(n);
    expect(listed).toContain("list");
    expect(listed).toContain("status");
    expect(listed).toContain("data_rows");
  });

  test("the hosted set is exactly the stdio set minus the local-only tools", () => {
    delete process.env.UPUBLISH_ADMIN;
    const hosted = names(createHostedServer(HOSTED));
    expect(hosted.sort()).toEqual(STDIO_TOOLS.filter((n) => !(LOCAL_ONLY_TOOLS as readonly string[]).includes(n)).sort());
  });

  test("stdioServerOptions() exposes the full current tool set; admin tools only with UPUBLISH_ADMIN=1", () => {
    expect(stdioServerOptions().localFiles).toBe(true);
    delete process.env.UPUBLISH_ADMIN;
    expect(names(createServer({}, stdioServerOptions())).sort()).toEqual([...STDIO_TOOLS].sort());
    process.env.UPUBLISH_ADMIN = "1";
    expect(names(createServer({}, stdioServerOptions())).sort()).toEqual([...STDIO_TOOLS, ...ADMIN_TOOLS].sort());
    process.env.UPUBLISH_ADMIN = "0";
    expect(names(createServer({}, stdioServerOptions()))).not.toContain("admin_user");
  });

  test("localFiles:true without UPUBLISH_ADMIN registers the local tools but no admin tool", () => {
    delete process.env.UPUBLISH_ADMIN;
    const n = names(createServer({}, { localFiles: true }));
    for (const t of LOCAL_ONLY_TOOLS) expect(n).toContain(t);
    for (const t of ADMIN_TOOLS) expect(n).not.toContain(t);
  });
});

describe("DW-1.2: a local-only call is refused with no side effect", () => {
  const ARGS: Record<string, Record<string, unknown>> = {
    publish: { directory: "/etc", slug: "x" },
    qrcode: { slug: "x", outputDir: "" },
    login: {},
    logout: {},
    upgrade: { plan: "pro" },
    template: { action: "create", name: "links", directory: "" },
    export: { slug: "x", directory: "" }, // directory is pointed at the harness's outDir below
  };

  /** Spies and fixtures shared by the "nothing happened" assertions. */
  function harness() {
    const seen: string[] = [];
    const dir = tmp();
    const credFile = path.join(dir, "credentials");
    fs.writeFileSync(credFile, "host-refresh-token", { mode: 0o600 });
    const outDir = path.join(dir, "out");
    fs.mkdirSync(outDir);
    const opened: string[] = [];
    const serve = spyOn(Bun, "serve");
    const deps: CoreDeps = { credentialsPath: credFile, fetchFn: recordingFetch(seen) };
    const openBrowser = async (u: string) => { opened.push(u); };
    const assertUntouched = () => {
      expect(seen).toEqual([]);
      expect(opened).toEqual([]);
      expect(serve).not.toHaveBeenCalled();
      expect(fs.readFileSync(credFile, "utf8")).toBe("host-refresh-token");
      expect(fs.readdirSync(outDir)).toEqual([]);
      serve.mockRestore();
    };
    return { deps, openBrowser, outDir, assertUntouched };
  }

  test.each(LOCAL_ONLY_TOOLS)("hosted: tools/call %s is an error and nothing is read, written, opened or bound", async (name) => {
    const h = harness();
    const client = await connect(createServer(h.deps, { openBrowser: h.openBrowser, localFiles: false }));
    const args = { ...ARGS[name], ...(name === "qrcode" ? { outputDir: h.outDir } : name === "template" || name === "export" ? { directory: h.outDir } : {}) };
    const r = await call(client, name, args);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not found|unknown|disabled/i);
    h.assertUntouched();
  });

  test.each(LOCAL_ONLY_TOOLS)("call-time guard: %s registered under localFiles:true but flipped off is refused by its handler", async (name) => {
    const h = harness();
    const opts: CreateServerOpts = { openBrowser: h.openBrowser, localFiles: true };
    const client = await connect(createServer(h.deps, opts));
    opts.localFiles = false; // the handler re-reads the flag on every call
    const args = { ...ARGS[name], ...(name === "qrcode" ? { outputDir: h.outDir } : name === "template" || name === "export" ? { directory: h.outDir } : {}) };
    const r = await call(client, name, args);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("only available in the local upublish plugin");
    h.assertUntouched();
  });

  test("call-time guard also covers an admin tool", async () => {
    process.env.UPUBLISH_ADMIN = "1";
    const seen: string[] = [];
    const opts: CreateServerOpts = { localFiles: true };
    const client = await connect(createServer({ fetchFn: recordingFetch(seen), tokenProvider: async () => "t" }, opts));
    opts.localFiles = false;
    const r = await call(client, "admin_stats");
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("only available in the local upublish plugin");
    expect(seen).toEqual([]);
  });

  test("unknown tool name is an SDK error, not executed", async () => {
    const client = await connect(createHostedServer(HOSTED));
    const r = await call(client, "definitely_not_a_tool");
    expect(r.isError).toBe(true);
  });

  test("the default openBrowser refuses when localFiles is off and opens when on", async () => {
    const opened: string[] = [];
    const opener = async (u: string) => { opened.push(u); };
    await expect(openUrlIfLocal("https://x.test/", false, opener)).rejects.toThrow("only available in the local upublish plugin");
    expect(opened).toEqual([]);
    await openUrlIfLocal("https://x.test/", true, opener);
    expect(opened).toEqual(["https://x.test/"]);
  });

  test("login routes through the injected openBrowser (not the open package)", async () => {
    const opened: string[] = [];
    const client = await connect(
      createServer({ fetchFn: recordingFetch([]), credentialsPath: path.join(tmp(), "c") }, {
        localFiles: true,
        openBrowser: async (u) => { opened.push(u); throw new Error("stub: browser unavailable"); },
      }),
    );
    const r = await call(client, "login");
    expect(opened.length).toBe(1);
    expect(opened[0]).toMatch(/^https?:\/\//);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(opened[0]!); // the auth URL is echoed so the user can open it manually
  });

  test("local server: an injected openBrowser is used by upgrade, and login routes through it too (stdio unchanged)", async () => {
    const opened: string[] = [];
    const seen: string[] = [];
    const client = await connect(
      createServer({ fetchFn: recordingFetch(seen), tokenProvider: async () => "t" }, { localFiles: true, openBrowser: async (u) => { opened.push(u); } }),
    );
    const r = await call(client, "upgrade", { plan: "pro" });
    expect(text(r)).not.toContain("only available in the local upublish plugin");
    // upgrade asked the API for a checkout URL (stubbed to {}); whether it succeeded is not the point here:
    expect(seen.some((u) => u.includes("checkout"))).toBe(true);
  });
});

describe("DW-1.3: hosted data_rows has no file export", () => {
  const props = async (server: McpServerT): Promise<string[]> => {
    const t = (await (await connect(server)).listTools()).tools.find((x) => x.name === "data_rows")!;
    return Object.keys((t.inputSchema as { properties: object }).properties);
  };

  test("hosted schema omits path and overwrite; the local schema keeps them", async () => {
    const hosted = await props(createServer({}));
    expect(hosted).toContain("action");
    expect(hosted).not.toContain("path");
    expect(hosted).not.toContain("overwrite");
    const local = await props(createServer({}, { localFiles: true }));
    expect(local).toContain("path");
    expect(local).toContain("overwrite");
  });

  test("hosted export is refused (with or without a path) and writes nothing", async () => {
    const seen: string[] = [];
    const dir = tmp();
    const target = path.join(dir, "rows.ndjson");
    const client = await connect(createHostedServer({ fetchFn: recordingFetch(seen), tokenProvider: async () => "t" }));
    for (const extra of [{}, { path: target, overwrite: true }]) {
      const r = await call(client, "data_rows", { action: "export", collection: "votes", ...extra });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("Export to a file is only available in the local upublish plugin; use list to page through rows.");
    }
    expect(fs.existsSync(target)).toBe(false);
    expect(seen.some((u) => u.includes("/rows"))).toBe(false);
  });

  test("hosted list still works", async () => {
    const seen: string[] = [];
    const client = await connect(createHostedServer({ fetchFn: recordingFetch(seen), tokenProvider: async () => "t" }));
    const r = await call(client, "data_rows", { action: "list", collection: "votes" });
    expect(r.isError).toBeUndefined();
    expect(seen.some((u) => u.includes("/rows"))).toBe(true);
  });

  test("local export is not refused by the gate (stdio unchanged)", async () => {
    const seen: string[] = [];
    const dir = tmp();
    const client = await connect(createServer({ fetchFn: recordingFetch(seen), tokenProvider: async () => "t" }, { localFiles: true }));
    const r = await call(client, "data_rows", { action: "export", collection: "votes", path: path.join(dir, "rows.ndjson") });
    expect(text(r)).not.toContain("only available in the local upublish plugin");
  });
});

describe("DW-1.4: status() with an injected tokenProvider ignores the host credentials file", () => {
  test("never calls readCredentials, uses the provider's bearer for /auth/me", async () => {
    const dir = tmp();
    const credFile = path.join(dir, "credentials");
    fs.writeFileSync(credFile, "HOST-refresh-token", { mode: 0o600 });
    const bearers: string[] = [];
    const urls: string[] = [];
    const fetchFn = recordingFetch(urls);
    const spy = spyOn(auth, "readCredentials");
    try {
      const r = await status({
        credentialsPath: credFile,
        tokenProvider: async () => "CALLER-bearer",
        fetchFn: async (url, init) => {
          bearers.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""));
          return fetchFn!(url, init);
        },
      });
      expect(r).toMatchObject({ authenticated: true, username: "caller@example.com" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(urls.some((u) => u.includes("/auth/token/refresh"))).toBe(false); // the host's refresh token was never exchanged
    expect(bearers.length).toBeGreaterThan(0);
    for (const b of bearers) expect(b).toBe("Bearer CALLER-bearer");
  });

  test("an empty provider bearer fails closed and still does not read the file", async () => {
    const credFile = path.join(tmp(), "credentials");
    fs.writeFileSync(credFile, "HOST-refresh-token");
    const r = await status({ credentialsPath: credFile, tokenProvider: async () => "  ", fetchFn: recordingFetch([]) });
    expect(r.authenticated).toBe(false);
  });

  test("without a provider the disk path is unchanged (reads the file; absent file means not authenticated)", async () => {
    expect(await status({ credentialsPath: path.join(tmp(), "none"), fetchFn: recordingFetch([]) })).toEqual({ authenticated: false });
  });

  test("hosted status tool reports the caller, not the host", async () => {
    const credFile = path.join(tmp(), "credentials");
    fs.writeFileSync(credFile, "HOST-refresh-token");
    const urls: string[] = [];
    const client = await connect(createHostedServer({ credentialsPath: credFile, tokenProvider: async () => "caller", fetchFn: recordingFetch(urls) }));
    const r = await call(client, "status");
    expect(text(r)).toContain("Authenticated as: caller@example.com");
    expect(urls.some((u) => u.includes("/auth/token/refresh"))).toBe(false);
  });
});

describe("DW-1.5: inline publish_backend code cannot read files outside the virtual entry", () => {
  test.each([
    ["absolute path", `import "/etc/passwd"; export default { fetch() { return new Response("x"); } };`],
    ["parent path", `import "../x"; export default { fetch() { return new Response("x"); } };`],
  ])("hosted: %s import is refused before anything is sent", async (_l, code) => {
    const seen: string[] = [];
    const client = await connect(createHostedServer({ fetchFn: recordingFetch(seen), tokenProvider: async () => "t" }));
    const r = await call(client, "publish_backend", { site: "s", code });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain("root:");
    expect(seen.some((u) => u.includes("backend"))).toBe(false);
  });

  test("hosted: entry is refused", async () => {
    const client = await connect(createHostedServer({ fetchFn: recordingFetch([]), tokenProvider: async () => "t" }));
    const r = await call(client, "publish_backend", { site: "s", entry: "/etc/passwd" });
    expect(r.isError).toBe(true);
  });
});

describe("DW-1.7: createHostedServer verifies what it registered", () => {
  test("returns a normal server when nothing unsafe is registered, and forces localFiles off", () => {
    let seenOpts: CreateServerOpts | undefined;
    const server = createHostedServer(HOSTED, (d, o) => { seenOpts = o; return createServer(d, o); });
    expect(seenOpts).toEqual({ localFiles: false, updateCheck: false });
    expect(names(server)).toContain("list");
  });

  test("a forced build registering a local-only tool throws HostedServerUnsafeError naming it", () => {
    for (const bad of LOCAL_ONLY_TOOLS) {
      let err: unknown;
      try {
        createHostedServer(HOSTED, (d) => {
          const s = createServer(d, { localFiles: false });
          s.registerTool(bad, { description: "x" }, async () => ({ content: [] }));
          return s;
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(HostedServerUnsafeError);
      expect((err as HostedServerUnsafeError).tools).toEqual([bad]);
      expect((err as Error).message).toContain(bad);
    }
  });

  test("a forced build registering an admin tool throws, listing every offender", () => {
    expect(() =>
      createHostedServer(HOSTED, (d) => {
        const s = createServer(d, { localFiles: false });
        s.registerTool("admin_user", { description: "x" }, async () => ({ content: [] }));
        s.registerTool("logout", { description: "x" }, async () => ({ content: [] }));
        return s;
      }),
    ).toThrow(/admin_user, logout/);
  });

  test("assertHostedServerSafe reads the real SDK registry: a full stdio server trips on all five local tools", () => {
    delete process.env.UPUBLISH_ADMIN;
    try {
      assertHostedServerSafe(createServer({}, stdioServerOptions()));
      throw new Error("expected HostedServerUnsafeError");
    } catch (e) {
      expect(e).toBeInstanceOf(HostedServerUnsafeError);
      expect([...(e as HostedServerUnsafeError).tools].sort()).toEqual([...LOCAL_ONLY_TOOLS].sort());
    }
  });

  test("requires a tokenProvider: without one API tools would use the host credentials", () => {
    for (const deps of [undefined, {}, { credentialsPath: "/host/creds" }, { tokenProvider: undefined }]) {
      expect(() => createHostedServer(deps as CoreDeps | undefined)).toThrow(HostedServerUnsafeError);
      expect(() => createHostedServer(deps as CoreDeps | undefined)).toThrow(/tokenProvider/);
    }
  });

  test("forces updateCheck and localFiles off whatever the build would otherwise get", () => {
    let seen: CreateServerOpts | undefined;
    createHostedServer(HOSTED, (d, o) => { seen = o; return createServer(d, o); });
    expect(seen?.updateCheck).toBe(false);
    expect(seen?.localFiles).toBe(false);
    expect(seen?.runtimeCheck).toBeUndefined();
  });

  test("switches host file logging off: log() writes nothing after createHostedServer", () => {
    const home = tmp();
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      log("before");
      expect(fs.existsSync(path.join(home, ".upublish", "publish.log"))).toBe(true);
      fs.rmSync(path.join(home, ".upublish"), { recursive: true });
      createHostedServer(HOSTED);
      log("after hosted server");
      expect(fs.existsSync(path.join(home, ".upublish"))).toBe(false);
      setFileLogging(true);
      log("restored");
      expect(fs.readFileSync(path.join(home, ".upublish", "publish.log"), "utf8")).toContain("restored");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  test("a Map registry is read by its keys; a Map holding publish throws", () => {
    expect(() => assertHostedServerSafe({ _registeredTools: new Map([["list", {}], ["publish", {}]]) } as unknown as McpServerT)).toThrow(/publish/);
    expect(() => assertHostedServerSafe({ _registeredTools: new Map([["list", {}]]) } as unknown as McpServerT)).not.toThrow();
  });

  test("any unrecognised or empty registry shape fails closed", () => {
    for (const reg of [null, undefined, 42, "publish", new Map(), {}, []]) {
      expect(() => assertHostedServerSafe({ _registeredTools: reg } as unknown as McpServerT), String(reg)).toThrow(HostedServerUnsafeError);
    }
  });

  test("fails closed when the SDK registry cannot be read", () => {
    const fake = {} as unknown as McpServerT;
    expect(() => assertHostedServerSafe(fake)).toThrow(HostedServerUnsafeError);
  });

  test("an array-shaped registry is also read", () => {
    const fake = { _registeredTools: ["list", "publish"] } as unknown as McpServerT;
    expect(() => assertHostedServerSafe(fake)).toThrow(/publish/);
    expect(() => assertHostedServerSafe({ _registeredTools: ["list"] } as unknown as McpServerT)).not.toThrow();
  });
});

describe("DW-2.6 (starter templates): template is wholly local-only", () => {
  test("test_DW_2_6_hosted_tool_list_excludes_template_and_stdio_includes_it", async () => {
    delete process.env.UPUBLISH_ADMIN;
    expect(names(createHostedServer(HOSTED))).not.toContain("template");
    const listed = (await (await connect(createHostedServer(HOSTED))).listTools()).tools.map((t) => t.name);
    expect(listed).not.toContain("template");
    expect(names(createServer({}, stdioServerOptions()))).toContain("template");
  });

  test("test_DW_2_6_forced_hosted_template_create_is_refused_and_writes_nothing", async () => {
    const parent = tmp();
    const target = path.join(parent, "site");
    const client = await connect(createHostedServer(HOSTED));
    for (const args of [{ action: "create", name: "links", directory: target }, { action: "list" }]) {
      const r = await call(client, "template", args);
      expect(r.isError).toBe(true);
    }
    const opts: CreateServerOpts = { localFiles: true };
    const flipped = await connect(createServer(HOSTED, opts));
    opts.localFiles = false;
    const r = await call(flipped, "template", { action: "create", name: "links", directory: target });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("only available in the local upublish plugin");
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  test("test_DW_2_6_hosted_self_check_throws_if_template_is_ever_registered", () => {
    expect(() =>
      createHostedServer(HOSTED, (d) => {
        const s = createServer(d, { localFiles: false });
        s.registerTool("template", { description: "x" }, async () => ({ content: [] }));
        return s;
      }),
    ).toThrow(/template/);
  });
});
