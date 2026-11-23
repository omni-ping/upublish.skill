import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CoreDeps } from "../lib/core.ts";
import { errResponse } from "./tool-response.ts";

/** Refusal text for a host-machine tool reached on a server without `localFiles`. */
export const LOCAL_ONLY_MESSAGE = "This tool is only available in the local upublish plugin.";

/** What every tool module's `register<Tool>(ctx)` receives. */
export interface ToolContext {
  /** Always-registered tools. */
  server: McpServer;
  /** Host-only registrar (omitted + refused when !localFiles). */
  local: Pick<McpServer, "registerTool">;
  /** Host-only AND UPUBLISH_ADMIN=1. */
  admin: Pick<McpServer, "registerTool">;
  /** With clientVersion defaulted. */
  coreDeps: CoreDeps;
  /** Read at call time, never captured, so a handler re-checks the flag on every call. */
  localFiles: () => boolean;
  openBrowser: (url: string) => Promise<void>;
  heartbeatIntervalMs: number;
}

/**
 * Registrar for tools that touch the host machine. Omits the tool unless `enabled`, and wraps its handler so
 * a call that still arrives with localFiles off is refused before any work (belt and braces).
 */
export const hostOnly = (
  server: McpServer,
  localFiles: () => boolean,
  enabled: boolean,
): Pick<McpServer, "registerTool"> => ({
  registerTool: ((name: string, config: never, cb: (...a: unknown[]) => unknown) => {
    if (!enabled) return undefined;
    return server.registerTool(
      name,
      config,
      (async (...a: unknown[]) => (localFiles() ? cb(...a) : errResponse(new Error(LOCAL_ONLY_MESSAGE)))) as never,
    );
  }) as McpServer["registerTool"],
});
