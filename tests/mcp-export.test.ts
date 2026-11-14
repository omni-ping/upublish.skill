/**
 * The local-only `export` MCP tool end to end through createServer (stubbed fetch, real temp directory).
 * DW-2.5 (registration side): present on stdio (localFiles), absent and refused hosted.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LOCAL_ONLY_TOOLS, createHostedServer, createServer } from "../mcp/index.ts";
import type { CoreDeps } from "../lib/core.ts";
import { setFileLogging } from "../lib/log.ts";

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Tools = Record<string, { handler: (a: Record<string, unknown>) => Promise<Result>; inputSchema?: unknown }>;
const tools = (s: unknown): Tools => (s as { _registeredTools: Tools })._registeredTools;

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const dirs: string[] = [];
afterEach(() => {
  setFileLogging(true); // createHostedServer flips this process-wide; leaking it silences the log for later files
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-export-"));
  dirs.push(d);
  return d;
};

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

function deps(files: Record<string, string>, seen: string[] = []): CoreDeps {
  return {
    tokenProvider: async () => "t",
    fetchFn: async (url: string) => {
      seen.push(url);
      if (url.startsWith("https://r2.test/")) return new Response(files[decodeURIComponent(new URL(url).pathname.slice(1))] ?? "", { status: 200 });
      if (/\/api\/ns$/.test(url)) return json({ namespaces: [{ id: "ns-default", name: "me", domain: "upubli.sh", role: "owner" }] });
      if (url.endsWith("/api/space")) return json({ space: { id: "sp", default_namespace_id: "ns-default", tier: "pro" } });
      if (url.includes("/export")) {
        return json({
          version: 2,
          file_count: Object.keys(files).length,
          total_size: 0,
          files: Object.entries(files).map(([p, body]) => ({ path: p, size: body.length, md5: md5(body), url: `https://r2.test/${encodeURIComponent(p)}?X-Amz-Signature=SECRETSIG` })),
          next_cursor: null,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        });
      }
      return json({});
    },
  };
}

describe("export tool registration (DW-2.5)", () => {
  test("LOCAL_ONLY_TOOLS includes export", () => {
    expect([...LOCAL_ONLY_TOOLS]).toContain("export");
  });

  test("the stdio server lists export; the hosted server does not and refuses a forced registration", () => {
    expect("export" in tools(createServer({}, { localFiles: true }))).toBe(true);
    expect("export" in tools(createServer({}))).toBe(false);
    expect("export" in tools(createHostedServer({ tokenProvider: async () => "t" }))).toBe(false);
    expect(() =>
      createHostedServer({ tokenProvider: async () => "t" }, (d) => {
        const s = createServer(d, { localFiles: false });
        s.registerTool("export", { description: "x" }, async () => ({ content: [] }));
        return s;
      }),
    ).toThrow(/export/);
  });
});

describe("export tool behaviour", () => {
  test("writes the files and reports counts, bytes and version; the default address is used", async () => {
    const dir = path.join(tmp(), "site");
    const seen: string[] = [];
    const server = createServer(deps({ "index.html": "<p>hi</p>", "a/b.txt": "bee" }, seen), { localFiles: true });
    const r = await tools(server).export!.handler({ slug: "demo", directory: dir });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain("Exported 'demo' v2");
    expect(r.content[0]!.text).toContain("Files written: 2 of 2");
    expect(fs.readFileSync(path.join(dir, "a/b.txt"), "utf8")).toBe("bee");
    expect(seen.some((u) => u.endsWith("/api/ns/ns-default/sites/demo/export"))).toBe(true);
    expect(r.content[0]!.text).not.toContain("SECRETSIG");
  });

  test("version is passed through to the route", async () => {
    const seen: string[] = [];
    const server = createServer(deps({ "x.txt": "x" }, seen), { localFiles: true });
    await tools(server).export!.handler({ slug: "demo", directory: path.join(tmp(), "o"), version: 2 });
    expect(seen.some((u) => u.includes("/export?version=2"))).toBe(true);
  });

  test("per-file failures make the response an error and name the file, without the URL query", async () => {
    const d = deps({ "x.txt": "x" });
    const inner = d.fetchFn!;
    d.fetchFn = async (u, i) => (u.startsWith("https://r2.test/") ? new Response("zzz") : inner(u, i)); // wrong bytes
    const r = await tools(createServer(d, { localFiles: true })).export!.handler({ slug: "demo", directory: path.join(tmp(), "o") });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('"x.txt"');
    expect(r.content[0]!.text).not.toContain("SECRETSIG");
  });

  test("a refused export (non-empty directory) is an error response and nothing is requested", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "mine.txt"), "m");
    const seen: string[] = [];
    const r = await tools(createServer(deps({ "x.txt": "x" }, seen), { localFiles: true })).export!.handler({ slug: "demo", directory: dir });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/not empty/);
    expect(seen.filter((u) => u.includes("/export"))).toEqual([]);
  });

  test("overwrite: true is honoured", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "mine.txt"), "m");
    const r = await tools(createServer(deps({ "x.txt": "x" }), { localFiles: true })).export!.handler({ slug: "demo", directory: dir, overwrite: true });
    expect(r.isError).toBeUndefined();
    expect(fs.readdirSync(dir).sort()).toEqual(["mine.txt", "x.txt"]);
  });

  test("an API error (403 upgrade_required) surfaces as an error response", async () => {
    const d = deps({});
    d.fetchFn = async (u) => (u.includes("/export") ? json({ error: "Exporting a non-live version requires a paid plan", code: "upgrade_required" }, 403) : deps({}).fetchFn!(u));
    const r = await tools(createServer(d, { localFiles: true })).export!.handler({ slug: "demo", directory: path.join(tmp(), "o"), version: 1 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/paid plan/);
  });
});
