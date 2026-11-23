/**
 * Pins the members tool's missing-argument error text per action (the add/remove/role
 * guards run before any request, so no network is touched).
 */
import { describe, test, expect } from "bun:test";
import { createServer } from "../mcp/index.ts";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function membersHandler(): Handler {
  const fetchFn = async (): Promise<Response> => {
    throw new Error("no request expected: the argument guard must run first");
  };
  const server = createServer({ credentialsPath: "/nonexistent/members-args-creds", fetchFn });
  return (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools["members"].handler;
}

describe("members: required-argument errors", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["add without username", { action: "add", role: "user" }, "username is required for the add action"],
    ["add without role", { action: "add", username: "bob" }, "role is required for the add action"],
    ["remove without username", { action: "remove" }, "username is required for the remove action"],
    ["role without username", { action: "role", role: "admin" }, "username is required for the role action"],
    ["role without role", { action: "role", username: "bob" }, "role is required for the role action"],
  ];
  for (const [name, args, message] of cases) {
    test(`members_${name.replace(/ /g, "_")}`, async () => {
      const result = await membersHandler()(args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(message);
    });
  }
});
