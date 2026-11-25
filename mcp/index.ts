#!/usr/bin/env bun
/**
 * upubli.sh MCP Server entrypoint.
 *
 * Each tool handler calls the corresponding core function, which reads
 * credentials fresh from disk on every invocation. This means the server
 * automatically picks up new credentials written by `upublish login` without
 * requiring a session restart — the stale-state bug is eliminated by design.
 *
 * Configuration:
 *   UPUBLISH_API_URL  (optional) — API base URL, defaults to https://api.upubli.sh
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import open from "open";
import { checkBunRuntime, checkForUpdate, formatUpdateNote } from "../lib/core.ts";
import { wrapToolResults } from "./tool-response.ts";
import { type ToolContext, LOCAL_ONLY_MESSAGE, hostOnly } from "./context.ts";
import { registerLogin, registerLogout, registerStatus, registerTemplate, registerUpgrade } from "./tools/account.ts";
import { registerMembers } from "./tools/members.ts";
import {
  registerAdminDomains,
  registerAdminSite,
  registerAdminStats,
  registerAdminStorage,
  registerAdminUser,
} from "./tools/admin.ts";
import { registerDomain, registerNamespaceCreate, registerRename } from "./tools/namespace.ts";
import {
  registerGate,
  registerPasscodeAdd,
  registerPasscodeList,
  registerPasscodeRevoke,
  registerVisibility,
} from "./tools/access.ts";
import { registerData, registerDataCollection, registerDataJwt, registerDataRows } from "./tools/data.ts";
import { registerBackend, registerBackendLogs, registerBackendSecret, registerPublishBackend } from "./tools/backend.ts";
import { registerPublish } from "./tools/publish.ts";
import {
  registerAnalytics,
  registerDelete,
  registerExport,
  registerList,
  registerPromote,
  registerQrcode,
} from "./tools/sites.ts";
import {
  registerVersionsDelete,
  registerVersionsLimit,
  registerVersionsList,
  registerVersionsRestore,
} from "./tools/versions.ts";
import type { CoreDeps } from "../lib/core.ts";

/**
 * Tools that read or write the machine the server runs on, spawn a browser or bind a port. They exist only on a
 * LOCAL server (`opts.localFiles === true`, i.e. stdio); the default createServer() (localFiles off) never registers or runs them.
 */
export const LOCAL_ONLY_TOOLS = ["publish", "qrcode", "login", "logout", "upgrade", "template", "export"] as const;
/** The env-gated admin tools: registered only on a local server with UPUBLISH_ADMIN=1. */
export const ADMIN_TOOLS = ["admin_user", "admin_site", "admin_stats", "admin_storage", "admin_domains"] as const;

/**
 * The default browser opener: launches the system browser only when `localFiles` is on. Otherwise it
 * rejects, because the "system" would be the host running the server. `opener` is a test seam.
 */
export async function openUrlIfLocal(
  url: string,
  localFiles: boolean,
  opener: (url: string) => Promise<unknown> = open,
): Promise<void> {
  if (!localFiles) throw new Error(LOCAL_ONLY_MESSAGE);
  await opener(url);
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const PACKAGE_NAME = "@omniping/upublish";
export const PACKAGE_VERSION = "0.12.52";

// ─── Server factory ───────────────────────────────────────────────────────────

/**
 * Heartbeat interval for MCP progress notifications during long uploads.
 *
 * When no file completes within this window, a "still uploading…" notification
 * is re-sent so MCP clients with idle-timeout logic stay active. 15 s keeps
 * activity visible well within any 60 s idle cutoff.
 *
 * Whether the SDK resets request timeouts on progress depends on the calling
 * client passing `resetTimeoutOnProgress: true` — that is opt-in and not
 * guaranteed. The heartbeat also serves as a transport-level keepalive (data
 * written to stdout) regardless of SDK timeout semantics.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Starts the out-of-date check (un-awaited, never blocks) and wraps
 * server.registerTool so the first tool response produced after the check
 * resolved `behind` carries a one-line update note, once per server instance.
 * The check uses the raw injected fetch (never the API-header fetch); its cache
 * lives beside an injected credentialsPath (tests) or in ~/.upublish.
 */
function installUpdateNote(server: McpServer, callerDeps?: CoreDeps): void {
  let pendingNote: string | null = null;
  void checkForUpdate(PACKAGE_VERSION, {
    fetchFn: callerDeps?.fetchFn,
    credentialsPath: callerDeps?.credentialsPath,
  }).then(
    (r) => {
      if (r.status === "behind") pendingNote = formatUpdateNote(PACKAGE_VERSION, r.latest);
    },
    () => undefined,
  );

  wrapToolResults(server, (result) => {
    if (pendingNote === null) return result;
    const text = pendingNote;
    pendingNote = null;
    return { ...result, content: [...result.content, { type: "text" as const, text }] };
  });
}

/**
 * Prefixes the old-Bun warning to every tool response (not once: the user must
 * act on it, unlike the update note). A null note (supported/unknown runtime)
 * installs nothing. Composes with installUpdateNote: that note is appended, this
 * one leads.
 */
function installRuntimeNote(server: McpServer, version: string | undefined): void {
  const note = checkBunRuntime(version);
  if (note === null) return;
  wrapToolResults(server, (result) => ({
    ...result,
    content: [{ type: "text" as const, text: note }, ...result.content],
  }));
}

/** Options accepted by createServer() beyond the CoreDeps bag. */
export interface CreateServerOpts {
  /**
   * Heartbeat interval for MCP progress notifications during long uploads.
   * Defaults to DEFAULT_HEARTBEAT_INTERVAL_MS (15 s). Tests inject a shorter
   * value (e.g. 50 ms) to verify heartbeat behavior without real delays.
   */
  heartbeatIntervalMs?: number;
  /**
   * Opens a URL in the default browser. Defaults to the `open` package. Tests
   * inject a stub so the `upgrade` tool's success path can be exercised without
   * actually launching a browser (and to simulate an open() rejection).
   */
  openBrowser?: (url: string) => Promise<void>;
  /**
   * Opt in to the old-Bun warning: every tool response gets a leading note when
   * `version` is older than the supported Bun (see checkBunRuntime). Defaults to
   * OFF: a server not run by the user's own stdio entrypoint may run on another
   * runtime, so the note would be wrong there. Only stdioServerOptions() sets it, from `Bun.version`.
   */
  runtimeCheck?: { version: string | undefined };
  /**
   * Opt in to the out-of-date check (GitHub fetch, 24 h cache file, one-time
   * note on a tool response). Defaults to OFF: an embedded server's users cannot /plugin update. Only
   * the stdio entrypoint turns this on (see stdioServerOptions()).
   */
  updateCheck?: boolean;
  /**
   * Opt in to every tool that touches the machine the server runs on. Defaults to OFF: on a server that is not the
   * user's own machine, a path, a browser or a loopback port would be the SERVER's. When off, `publish`, `qrcode`, `login`, `logout`, `upgrade` and the `admin_*` tools are not
   * registered (and refuse if called anyway), `data_rows` drops `path`/`overwrite` and refuses `export`, and
   * `publish_backend` refuses `entry`. Only the stdio entrypoint turns this on (see stdioServerOptions());
   * inline `code` is the alternative.
   */
  localFiles?: boolean;
}

/** Server options used by the stdio entrypoint (main()). */
export function stdioServerOptions(): CreateServerOpts {
  return { updateCheck: true, localFiles: true, runtimeCheck: { version: typeof Bun !== "undefined" ? Bun.version : undefined } };
}

/**
 * Creates and configures the MCP server with all tools registered.
 *
 * Each tool handler calls the corresponding core function with the provided
 * CoreDeps. Credentials are read fresh on every tool invocation — there is no
 * startup credential read and no stale-state.
 *
 * @param coreDeps - Optional overrides for credentials path and fetch (for tests)
 * @param opts     - Optional server-level configuration (heartbeat interval, etc.)
 * @returns Configured McpServer instance ready to connect to a transport
 */
export function createServer(callerDeps?: CoreDeps, opts?: CreateServerOpts): McpServer {
  // Every API request identifies this client build; a caller-supplied value wins.
  const coreDeps: CoreDeps = { ...callerDeps, clientVersion: callerDeps?.clientVersion ?? PACKAGE_VERSION };
  const heartbeatIntervalMs = opts?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  // Read at call time (not captured) so a handler re-checks the flag on every call.
  const localFiles = (): boolean => opts?.localFiles === true;
  const openBrowser = opts?.openBrowser ?? ((url: string) => openUrlIfLocal(url, localFiles()));
  const server = new McpServer({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  });
  const ctx: ToolContext = {
    server,
    local: hostOnly(server, localFiles, localFiles()),
    admin: hostOnly(server, localFiles, localFiles() && process.env.UPUBLISH_ADMIN === "1"),
    coreDeps,
    localFiles,
    openBrowser,
    heartbeatIntervalMs,
  };

  if (opts?.updateCheck) installUpdateNote(server, callerDeps);
  if (opts?.runtimeCheck) installRuntimeNote(server, opts.runtimeCheck.version);

  registerPublish(ctx);
  registerList(ctx);
  registerDelete(ctx);
  registerVersionsList(ctx);
  registerVersionsDelete(ctx);
  registerVersionsRestore(ctx);
  registerVersionsLimit(ctx);
  registerAnalytics(ctx);
  registerPasscodeAdd(ctx);
  registerVisibility(ctx);
  registerPasscodeList(ctx);
  registerPasscodeRevoke(ctx);
  registerGate(ctx);
  registerData(ctx);
  registerDataCollection(ctx);
  registerDataRows(ctx);
  registerDataJwt(ctx);
  registerPublishBackend(ctx);
  registerBackend(ctx);
  registerBackendSecret(ctx);
  registerBackendLogs(ctx);
  registerMembers(ctx);
  registerPromote(ctx);
  registerQrcode(ctx);
  registerTemplate(ctx);
  registerExport(ctx);
  registerLogout(ctx);
  registerLogin(ctx);
  registerUpgrade(ctx);
  registerStatus(ctx);
  registerNamespaceCreate(ctx);
  registerDomain(ctx);
  registerRename(ctx);
  registerAdminUser(ctx);
  registerAdminSite(ctx);
  registerAdminStats(ctx);
  registerAdminStorage(ctx);
  registerAdminDomains(ctx);

  return server;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Main entry point — creates server with default CoreDeps and starts stdio transport.
 * Credentials are read fresh per tool call; no startup credential read needed.
 */
async function main(): Promise<void> {
  const server = createServer(undefined, stdioServerOptions());
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run if this file is the main module (bun run mcp/index.ts)
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(
      `Failed to start MCP server: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
