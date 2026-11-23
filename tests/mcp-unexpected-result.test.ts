/** Pins the "Unexpected result" guard in every domain / members action handler (core answers with a mismatched action). */
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import * as core from "../lib/core.ts";
import { createServer } from "../mcp/index.ts";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const tools = () =>
  (createServer({ credentialsPath: "/nonexistent" }, { localFiles: true }) as unknown as {
    _registeredTools: Record<string, { handler: Handler }>;
  })._registeredTools;

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

const DOMAIN_CASES: Array<[Record<string, unknown>, string]> = [
  [{ action: "add", hostname: "a.com" }, "list"],
  [{ action: "status", id: "d" }, "list"],
  [{ action: "remove", id: "d" }, "list"],
  [{ action: "list" }, "add"],
];
const MEMBERS_CASES: Array<Record<string, unknown>> = [
  { action: "list" },
  { action: "add", username: "u", role: "user" },
  { action: "remove", username: "u" },
  { action: "role", username: "u", role: "admin" },
  { action: "leave", namespace: "n" },
  { action: "invite" },
  { action: "invites" },
  { action: "revoke", invite_id: "i" },
];

describe("Unexpected result guards", () => {
  test("domain: every action refuses a mismatched core result with the exact text", async () => {
    for (const [args, wrong] of DOMAIN_CASES) {
      spies.push(spyOn(core, "domain").mockResolvedValue({ action: wrong } as never));
      const r = await tools()["domain"].handler(args);
      expect([r.isError, r.content[0].text]).toEqual([true, "Unexpected result"]);
    }
  });

  test("members: every action refuses a mismatched core result with the exact text", async () => {
    for (const args of MEMBERS_CASES) {
      spies.push(spyOn(core, "members").mockResolvedValue({ action: "bogus" } as never));
      const r = await tools()["members"].handler(args);
      expect([r.isError, r.content[0].text]).toEqual([true, "Unexpected result"]);
    }
  });

  test("members list with no members says the owner has sole access", async () => {
    spies.push(spyOn(core, "members").mockResolvedValue({ action: "list", members: [] } as never));
    const r = await tools()["members"].handler({ action: "list" });
    expect([r.isError, r.content[0].text]).toEqual([undefined, "No members found. The address owner has sole access."]);
  });

  test("logout failure is reported as an error", async () => {
    spies.push(spyOn(core, "logout").mockResolvedValue({ loggedOut: false, error: "boom" } as never));
    const r = await tools()["logout"].handler({});
    expect([r.isError, r.content[0].text]).toEqual([true, "Logout failed: boom"]);
  });
});
