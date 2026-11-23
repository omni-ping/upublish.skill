/**
 * Shared MCP response layer: result shapes, the one error-rendering boundary,
 * the per-handler error guard, and the registerTool result-wrapper. Lives apart
 * from index.ts so tool modules can import it without a cycle.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { displayMsg } from "../lib/core.ts";

type McpContent = Array<{ type: "text"; text: string }>;

export type ToolResponse = {
  content: McpContent;
  isError?: boolean;
};

export function okResponse(text: string): ToolResponse {
  return { content: [{ type: "text" as const, text }] };
}

export function errResponse(err: unknown): ToolResponse {
  // Apply displayMsg at the single MCP error-display boundary so backend-originated
  // "namespace" error text (from lib/*.ts) is translated to "address" for users.
  // lib/* functions stay raw (for testability and correctness); translation happens here.
  return {
    content: [{ type: "text" as const, text: displayMsg((err as Error).message) }],
    isError: true,
  };
}

/**
 * Wraps a tool handler so any throw or rejection becomes an errResponse.
 * `return await` is load-bearing: without it a rejection escapes the try.
 */
export function guarded<A extends unknown[]>(
  handler: (...args: A) => Promise<ToolResponse>,
): (...args: A) => Promise<ToolResponse> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      return errResponse(err);
    }
  };
}

/**
 * Rebinds server.registerTool so every tool callback registered afterwards has
 * its result passed through `transform`. A result without a `content` array is
 * returned untouched. Wrappers compose: each new one wraps the callback before the earlier ones do, so the earliest installed sees the result last.
 */
export function wrapToolResults(
  server: McpServer,
  transform: (result: ToolResponse) => ToolResponse,
): void {
  const register = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    cb: (...args: unknown[]) => unknown,
  ) => unknown;
  (server as { registerTool: unknown }).registerTool = (
    name: string,
    config: unknown,
    cb: (...args: unknown[]) => unknown,
  ) =>
    register(name, config, async (...args: unknown[]) => {
      const result = (await cb(...args)) as ToolResponse;
      return Array.isArray(result?.content) ? transform(result) : result;
    });
}
