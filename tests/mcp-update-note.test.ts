/**
 * MCP-level tests for the out-of-date note and the client-version header (Phase 2).
 *
 * DW-2.1 note once, on the first response after the check resolves (ok + error)
 * DW-2.2 no note for equal / older / malformed / failed checks; tools never fail
 * DW-2.5 a hanging check never delays or fails a tool call
 * DW-2.6 default createServer() (hosted router shape) never checks, caches or notes;
 *        stdioServerOptions() opts in
 * DW-2.4 header on API requests only (not on presigned R2 PUTs or GitHub)
 *
 * All fetches are stubs; credentials and the update cache live in a temp dir.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, stdioServerOptions, PACKAGE_VERSION } from "../mcp/index.ts";
import type { CoreDeps } from "../lib/core.ts";
import type { CreateServerOpts } from "../mcp/index.ts";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Tools = Record<string, { handler: (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult> }>;
const toolsOf = (s: ReturnType<typeof createServer>) => (s as unknown as { _registeredTools: Tools })._registeredTools;

const GITHUB = "raw.githubusercontent.com";
const H = "X-Upublish-Client";
const NOTE_MARK = "out of date";

let dir: string;
let credFile: string;
let cacheFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "upublish-update-note-"));
  credFile = path.join(dir, "credentials");
  cacheFile = path.join(dir, "update-check.json");
  fs.writeFileSync(credFile, "refresh-token", { mode: 0o600 });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

interface Stub {
  fetchFn: NonNullable<CoreDeps["fetchFn"]>;
  github: number;
  seen: Array<{ url: string; headers: Headers }>;
}

/** Stub for API + GitHub + R2. `github` decides the plugin.json response. */
function makeStub(github: () => Promise<Response> | Response): Stub {
  const stub: Stub = {
    github: 0,
    seen: [],
    fetchFn: async (url, init) => {
      stub.seen.push({ url, headers: new Headers(init?.headers) });
      const json = (b: unknown) => new Response(JSON.stringify(b));
      if (url.includes(GITHUB)) {
        stub.github++;
        return github();
      }
      if (url.includes("r2.example.com")) return new Response("", { status: 200 });
      if (url.includes("/auth/token/refresh")) return json({ access_token: "tok", expires_in: 3600 });
      if (url.includes("/auth/me")) return json({ username: "u" });
      if (/\/api\/space/.test(url)) return json({ space: { id: "sp", default_namespace_id: "n1", tier: "pro" } });
      if (/\/manifest/.test(url))
        return json({ needed: [{ path: "index.html", upload_url: "https://r2.example.com/p/index.html" }], version: 1, session_id: "s", base_version: null });
      if (/\/finalize/.test(url)) return json({ site: { slug: "s" }, url: "https://u.upubli.sh/s/" });
      if (/\/api\/ns$/.test(url)) return json({ namespaces: [{ id: "n1", name: "default", domain: "u.upubli.sh" }] });
      return json({ sites: [] });
    },
  };
  return stub;
}

const remoteVersion = (v: unknown) => () => new Response(JSON.stringify({ version: v }));

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const hasNote = (r: ToolResult) => text(r).includes(NOTE_MARK);

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(2);
  await Bun.sleep(5); // let the .then() that stores the note run
}

function server(stub: Stub, opts?: CreateServerOpts, extra?: Partial<CoreDeps>) {
  return toolsOf(createServer({ credentialsPath: credFile, fetchFn: stub.fetchFn, ...extra }, opts));
}

describe("note appears once after the check resolves (DW-2.1)", () => {
  test("test_DW_2_1_first_ok_response_after_resolve_has_note_later_ones_do_not", async () => {
    const stub = makeStub(remoteVersion("99.0.0"));
    const tools = server(stub, { updateCheck: true });
    await waitFor(() => fs.existsSync(cacheFile));

    const first = await tools["status"]!.handler({});
    expect(first.isError).toBeUndefined();
    expect(hasNote(first)).toBe(true);
    const note = first.content[first.content.length - 1]!.text;
    expect(note).toContain(PACKAGE_VERSION);
    expect(note).toContain("99.0.0");
    expect(note).toContain("/plugin update upublish@upublish.skill");
    expect(note).not.toContain("\n");

    const second = await tools["status"]!.handler({});
    expect(hasNote(second)).toBe(false);
    expect(hasNote(await tools["list"]!.handler({}))).toBe(false);
    expect(stub.github).toBe(1);
  });

  test("test_DW_2_1_error_response_gets_the_note_once", async () => {
    const stub = makeStub(remoteVersion("99.0.0"));
    fs.rmSync(credFile); // list -> "Not authenticated" isError
    const tools = server(stub, { updateCheck: true });
    await waitFor(() => fs.existsSync(cacheFile));

    const first = await tools["list"]!.handler({});
    expect(first.isError).toBe(true);
    expect(text(first)).toContain("Not authenticated");
    expect(hasNote(first)).toBe(true);
    expect(hasNote(await tools["list"]!.handler({}))).toBe(false);
  });

  test("each server instance notes once on its own", async () => {
    const stub = makeStub(remoteVersion("99.0.0"));
    const a = server(stub, { updateCheck: true });
    await waitFor(() => fs.existsSync(cacheFile));
    expect(hasNote(await a["status"]!.handler({}))).toBe(true);
    const b = server(stub, { updateCheck: true }); // fresh cache: no new fetch, new instance notes again
    await waitFor(() => false, 30);
    expect(hasNote(await b["status"]!.handler({}))).toBe(true);
    expect(stub.github).toBe(1);
  });

  test("a response produced while the check is still in flight has no note; a later one does", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const stub = makeStub(async () => {
      await gate;
      return new Response(JSON.stringify({ version: "99.0.0" }));
    });
    const tools = server(stub, { updateCheck: true });
    const early = await tools["status"]!.handler({});
    expect(hasNote(early)).toBe(false);
    release();
    await waitFor(() => fs.existsSync(cacheFile));
    expect(hasNote(await tools["status"]!.handler({}))).toBe(true);
    expect(hasNote(await tools["status"]!.handler({}))).toBe(false);
  });
});

describe("no note, no failure for non-behind or failed checks (DW-2.2)", () => {
  const cases: Array<[string, () => Promise<Response> | Response]> = [
    ["equal", remoteVersion(PACKAGE_VERSION)],
    ["older", remoteVersion("0.0.1")],
    ["malformed JSON", () => new Response("{nope")],
    ["non-semver", remoteVersion("99.0.0; rm -rf /")],
    ["missing version", () => new Response("{}")],
    ["404", () => new Response("nf", { status: 404 })],
    ["500", () => new Response("err", { status: 500 })],
    ["network error", () => { throw new Error("ENOTFOUND"); }],
  ];
  for (const [name, github] of cases) {
    test(`test_DW_2_2_${name.replace(/\W+/g, "_")}`, async () => {
      const stub = makeStub(github);
      const tools = server(stub, { updateCheck: true });
      await waitFor(() => stub.github > 0);
      const r = await tools["status"]!.handler({});
      expect(r.isError).toBeUndefined();
      expect(hasNote(r)).toBe(false);
      expect(text(r)).not.toContain("rm -rf");
    });
  }
});

describe("never delays a tool call (DW-2.5)", () => {
  test("test_DW_2_5_tool_returns_while_the_remote_fetch_hangs", async () => {
    const stub = makeStub(() => new Promise<Response>(() => {}));
    const tools = server(stub, { updateCheck: true });
    await waitFor(() => stub.github > 0, 200);
    expect(stub.github).toBe(1); // the check is genuinely in flight
    const t0 = Date.now();
    const r = await tools["status"]!.handler({});
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.isError).toBeUndefined();
    expect(hasNote(r)).toBe(false);
  });
});

describe("opt-in only (DW-2.6)", () => {
  test("test_DW_2_6_stdioServerOptions_opts_in", () => {
    expect(stdioServerOptions().updateCheck).toBe(true);
  });

  test("test_DW_2_6_default_createServer_never_fetches_caches_or_notes", async () => {
    const stub = makeStub(remoteVersion("99.0.0"));
    const tools = server(stub); // default opts
    await Bun.sleep(30);
    const r = await tools["status"]!.handler({});
    expect(hasNote(r)).toBe(false);
    expect(stub.github).toBe(0);
    expect(stub.seen.some((s) => s.url.includes(GITHUB))).toBe(false);
    expect(fs.existsSync(cacheFile)).toBe(false);
  });

  test("updateCheck:false behaves like the default", async () => {
    const stub = makeStub(remoteVersion("99.0.0"));
    const tools = server(stub, { updateCheck: false });
    await Bun.sleep(30);
    expect(hasNote(await tools["status"]!.handler({}))).toBe(false);
    expect(stub.github).toBe(0);
  });

  test("hosted router shape: header on API calls, no GitHub fetch, no note", async () => {
    const stub = makeStub(remoteVersion("99.0.0"));
    const tools = toolsOf(createServer({ fetchFn: stub.fetchFn, tokenProvider: async () => "hosted" }));
    await Bun.sleep(30);
    const r = await tools["list"]!.handler({});
    expect(r.isError).toBeUndefined();
    expect(hasNote(r)).toBe(false);
    expect(stub.github).toBe(0);
    const api = stub.seen.filter((s) => s.url.includes("/api/"));
    expect(api.length).toBeGreaterThan(0);
    for (const s of api) expect(s.headers.get(H)).toBe(`upublish-mcp/${PACKAGE_VERSION}`);
  });
});

describe("header scope through createServer (DW-2.4)", () => {
  test("API calls carry it; presigned R2 PUT and GitHub fetch do not", async () => {
    const stub = makeStub(remoteVersion("99.0.0"));
    const tools = server(stub, { updateCheck: true });
    await waitFor(() => fs.existsSync(cacheFile));
    const site = fs.mkdtempSync(path.join(dir, "site-"));
    fs.writeFileSync(path.join(site, "index.html"), "<h1>hi</h1>");

    const r = await tools["publish"]!.handler({ directory: site, slug: "s" }, { sendNotification: async () => {} });
    expect(r.isError).toBeUndefined();

    const want = `upublish-mcp/${PACKAGE_VERSION}`;
    const r2 = stub.seen.filter((s) => s.url.includes("r2.example.com"));
    const gh = stub.seen.filter((s) => s.url.includes(GITHUB));
    const api = stub.seen.filter((s) => !s.url.includes("r2.example.com") && !s.url.includes(GITHUB));
    expect(r2.length).toBe(1);
    expect(gh.length).toBe(1);
    expect(api.length).toBeGreaterThanOrEqual(3);
    for (const s of api) expect(s.headers.get(H)).toBe(want);
    for (const s of [...r2, ...gh]) expect(s.headers.has(H)).toBe(false);
  });

  test("a caller-supplied clientVersion wins over PACKAGE_VERSION", async () => {
    const stub = makeStub(remoteVersion("0.0.1"));
    const tools = server(stub, undefined, { clientVersion: "7.7.7" });
    await tools["status"]!.handler({});
    const api = stub.seen.filter((s) => s.url.includes("/auth/"));
    expect(api.length).toBeGreaterThan(0);
    for (const s of api) expect(s.headers.get(H)).toBe("upublish-mcp/7.7.7");
  });

  test("logout revoke through the tool carries the header", async () => {
    const stub = makeStub(remoteVersion("0.0.1"));
    const tools = server(stub);
    const r = await tools["logout"]!.handler({});
    expect(r.isError).toBeUndefined();
    const revoke = stub.seen.find((s) => s.url.includes("/auth/token/revoke"));
    expect(revoke?.headers.get(H)).toBe(`upublish-mcp/${PACKAGE_VERSION}`);
  });
});
