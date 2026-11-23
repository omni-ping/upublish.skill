/**
 * Unit tests for the shared MCP response layer (mcp/tool-response.ts).
 *
 * DW-C1.5 guarded turns a rejecting or synchronously throwing handler into an
 *         errResponse with displayMsg text
 */
import { describe, test, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { displayMsg } from "../lib/core.ts";
import { errResponse, guarded, okResponse, wrapToolResults } from "../mcp/tool-response.ts";
import type { ToolResponse } from "../mcp/tool-response.ts";

const MSG = "Namespace foo not found";
const expectedErr: ToolResponse = {
  isError: true,
  content: [{ type: "text", text: displayMsg(MSG) }],
};

describe("okResponse / errResponse", () => {
  test("okResponse wraps text without isError", () => {
    expect(okResponse("hi")).toEqual({ content: [{ type: "text", text: "hi" }] });
  });
  test("errResponse applies displayMsg to the message", () => {
    expect(errResponse(new Error(MSG))).toEqual(expectedErr);
    expect(displayMsg(MSG)).not.toBe(MSG);
  });
});

describe("guarded", () => {
  test("DW_C1_5 async rejection becomes an error response", async () => {
    const h = guarded(async () => {
      await Promise.resolve();
      throw new Error(MSG);
    });
    expect(await h()).toEqual(expectedErr);
  });
  test("DW_C1_5 synchronous throw becomes an error response", async () => {
    const h = guarded((() => {
      throw new Error(MSG);
    }) as () => Promise<ToolResponse>);
    expect(await h()).toEqual(expectedErr);
  });
  test("passes args through and returns the handler result", async () => {
    const h = guarded(async (a: number, b: string) => okResponse(`${a}${b}`));
    expect(await h(1, "x")).toEqual(okResponse("1x"));
  });
});

describe("wrapToolResults", () => {
  type Cb = (...a: unknown[]) => Promise<unknown>;
  function setup() {
    const server = new McpServer({ name: "t", version: "0" });
    const captured: Record<string, Cb> = {};
    (server as { registerTool: unknown }).registerTool = (name: string, _c: unknown, cb: Cb) => {
      captured[name] = cb;
    };
    const register = (name: string, cb: Cb) =>
      (server as unknown as { registerTool: (n: string, c: unknown, cb: Cb) => void }).registerTool(name, {}, cb);
    return { server, captured, register };
  }
  const tag = (t: string) => (r: ToolResponse): ToolResponse => ({
    ...r,
    content: [...r.content, { type: "text", text: t }],
  });

  test("transforms results of tools registered afterwards, passing args", async () => {
    const { server, captured, register } = setup();
    wrapToolResults(server, tag("N"));
    register("a", async (x) => okResponse(x as string));
    expect(await captured.a!("v")).toEqual({
      content: [{ type: "text", text: "v" }, { type: "text", text: "N" }],
    });
  });
  test("results without a content array are returned untouched", async () => {
    const { server, captured, register } = setup();
    let called = 0;
    wrapToolResults(server, (r) => (called++, r));
    register("a", async () => undefined);
    expect(await captured.a!()).toBeUndefined();
    expect(called).toBe(0);
  });
  test("wrappers compose: the earliest installed runs outermost (sees the result last)", async () => {
    const { server, captured, register } = setup();
    wrapToolResults(server, tag("first"));
    wrapToolResults(server, tag("second"));
    register("a", async () => okResponse("b"));
    const r = (await captured.a!()) as ToolResponse;
    expect(r.content.map((c) => c.text)).toEqual(["b", "second", "first"]);
  });
});
