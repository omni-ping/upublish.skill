/**
 * The `template` MCP tool (DW-2.1, DW-2.2, DW-2.6 at the adapter): list output, create output naming the absolute
 * path, the placeholders, the # links and the next step; structured refusals; absent when localFiles is off.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../mcp/index.ts";

const ROOT = path.join(import.meta.dir, "..", "templates");
const SIX = ["coming-soon", "docs", "landing", "links", "portfolio", "resume"];

const tmpDirs: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  clients.length = 0;
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tpl-"));
  tmpDirs.push(d);
  return d;
}

async function connect(localFiles: boolean): Promise<Client> {
  const server = createServer({ credentialsPath: "/nonexistent" }, { localFiles });
  const client = new Client({ name: "template-test", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  clients.push(client);
  return client;
}

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };
async function call(client: Client, args: Record<string, unknown>): Promise<Result & { text: string }> {
  let r: Result;
  try {
    r = (await client.callTool({ name: "template", arguments: args })) as Result;
  } catch (err) {
    r = { content: [{ type: "text", text: (err as Error).message }], isError: true };
  }
  return { ...r, text: r.content.map((c) => c.text).join("\n") };
}

describe("template tool", () => {
  test("test_DW_2_1_list_names_all_six_with_title_and_description", async () => {
    const r = await call(await connect(true), { action: "list" });
    expect(r.isError).toBeUndefined();
    for (const name of SIX) {
      const m = JSON.parse(fs.readFileSync(path.join(ROOT, `${name}.json`), "utf8"));
      expect(r.text).toContain(`- ${name}: ${m.title}. ${m.description}`);
    }
  });

  test("test_DW_2_2_create_reports_the_absolute_path_placeholders_links_and_next_step", async () => {
    const target = path.join(tmp(), "my-links");
    const r = await call(await connect(true), { action: "create", name: "links", directory: target });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain(`Created the "links" template in ${target}`);
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, "links.json"), "utf8"));
    for (const p of m.placeholders) expect(r.text).toContain(`- ${p.token}: ${p.hint}`);
    expect(r.text).toMatch(/- index\.html: .+/); // a data-placeholder-href hint
    expect(r.text).toContain("Next: replace every [[...]] and every data-placeholder-href `#`, show the user, then publish this folder");
    expect(fs.existsSync(path.join(target, "index.html"))).toBe(true);
  });

  test("a refusal is an isError result with the reason, and writes nothing", async () => {
    const client = await connect(true);
    const d = tmp();
    fs.writeFileSync(path.join(d, "index.html"), "mine");

    const notEmpty = await call(client, { action: "create", name: "links", directory: d });
    expect(notEmpty.isError).toBe(true);
    expect(notEmpty.text).toContain("allow_non_empty");

    const clash = await call(client, { action: "create", name: "links", directory: d, allow_non_empty: true });
    expect(clash.isError).toBe(true);
    expect(clash.text).toContain("index.html");
    expect(fs.readdirSync(d)).toEqual(["index.html"]);
    expect(fs.readFileSync(path.join(d, "index.html"), "utf8")).toBe("mine");

    const unknown = await call(client, { action: "create", name: "blog", directory: path.join(d, "x") });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("portfolio");

    const noDir = await call(client, { action: "create", name: "links" });
    expect(noDir.isError).toBe(true);
    expect(noDir.text).toContain("directory");
  });

  test("test_DW_2_6_absent_when_localFiles_is_off", async () => {
    const client = await connect(false);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("template");
    const r = await call(client, { action: "list" });
    expect(r.isError).toBe(true);
  });
});
