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
import { z } from "zod";
import open from "open";
import {
  checkBunRuntime,
  namespaceCreate,
  OverageApprovalError,
  packChargeLine,
  packApprovalPriceLine,
  domain,
  rename,
  adminUser,
  adminSite,
  adminStats,
  adminStorage,
  adminDomains,
  checkForUpdate,
  formatUpdateNote,
  setFileLogging,
} from "../lib/core.ts";
import { errResponse, guarded, okResponse, wrapToolResults } from "./tool-response.ts";
import { type ToolContext, LOCAL_ONLY_MESSAGE, hostOnly } from "./context.ts";
import { formatBytes } from "./format.ts";
import { registerLogin, registerLogout, registerStatus, registerTemplate, registerUpgrade } from "./tools/account.ts";
import { registerMembers } from "./tools/members.ts";
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
import type {
  CoreDeps,
  TokenProvider,
  Site,
  NamespaceCreateResult,
  AdminUserSummary,
  AdminUserInspect,
  AdminStatusResult,
  AdminSiteBlockResult,
  AdminStats,
  AdminSweepReport,
  AdminResyncReport,
  AdminDomain,
} from "../lib/core.ts";

// ─── Public package API ───────────────────────────────────────────────────────
// Re-export types that external consumers (e.g. the backend MCP router) need
// to import from the package entry without reaching into internal submodules.
export type { CoreDeps, TokenProvider };

/**
 * Tools that read or write the machine the server runs on, spawn a browser or bind a port. They exist only on a
 * LOCAL server (`opts.localFiles === true`, i.e. stdio). A hosted server must never register or run them.
 */
export const LOCAL_ONLY_TOOLS = ["publish", "qrcode", "login", "logout", "upgrade", "template", "export"] as const;
/** The env-gated admin tools: registered only on a local server with UPUBLISH_ADMIN=1. */
export const ADMIN_TOOLS = ["admin_user", "admin_site", "admin_stats", "admin_storage", "admin_domains"] as const;

/**
 * The default browser opener: launches the system browser only on a local server. On a hosted server it
 * rejects, because the "system" would be the backend host. `opener` is a test seam.
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
export const PACKAGE_VERSION = "0.12.51";

// ─── Formatting helpers ───────────────────────────────────────────────────────

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
   * OFF; the hosted /mcp router runs on the backend's own runtime, so the note
   * would be wrong there. Only stdioServerOptions() sets it, from `Bun.version`.
   */
  runtimeCheck?: { version: string | undefined };
  /**
   * Opt in to the out-of-date check (GitHub fetch, 24 h cache file, one-time
   * note on a tool response). Defaults to OFF: the backend's hosted /mcp router
   * calls createServer() per request and its users cannot /plugin update. Only
   * the stdio entrypoint turns this on (see stdioServerOptions()).
   */
  updateCheck?: boolean;
  /**
   * Opt in to every tool that touches the machine the server runs on. Defaults to OFF: the hosted /mcp router
   * runs createServer() on the backend's own host, where a path, a browser or a loopback port would be the
   * SERVER's. When off, `publish`, `qrcode`, `login`, `logout`, `upgrade` and the `admin_*` tools are not
   * registered (and refuse if called anyway), `data_rows` drops `path`/`overwrite` and refuses `export`, and
   * `publish_backend` refuses `entry`. Only the stdio entrypoint turns this on (see stdioServerOptions());
   * hosted use passes inline `code`. Use createHostedServer() for a hosted server.
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
  const { admin } = ctx;

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

  server.registerTool(
    "namespace_create",
    {
      title: "Create Address",
      description:
        "Creates a new address (your URL prefix) on a hosted platform domain. " +
        "You can choose between upubli.sh or pinn.sh (both available to all users). " +
        "Sites publish under an address at `name.{domain}/slug/`. " +
        "Your first address is chosen during sign-in onboarding; use this tool " +
        "to add more. Address count is tier-limited — the free plan allows one; " +
        "a tier-limit error includes the upgrade link.",
      inputSchema: {
        name: z
          .string()
          .describe("The address name (3-63 chars, lowercase letters, numbers, hyphens)."),
        domain: z
          .string()
          .optional()
          .describe("Optional hosted domain (upubli.sh or pinn.sh) or custom domain. Defaults to upubli.sh."),
      },
    },
    async (args: { name: string; domain?: string }) => {
      try {
        const result: NamespaceCreateResult = await namespaceCreate(
          args.name,
          args.domain,
          coreDeps,
        );
        const lines = [
          `Address created.`,
          `ID: ${result.namespace_id}`,
          `Domain: ${result.domain}`,
        ];
        if (result.overage?.charged === true) {
          // Interval-aware pack copy from server values only (lib/billing-text.ts).
          lines.push(``, packChargeLine(result.overage));
        }
        return okResponse(lines.join("\n"));
      } catch (err) {
        // 402 needs_overage_approval: surface the approval URL and pack price so
        // the agent can forward them to the user. Never send accept_overage — that
        // flag is reserved for explicit human consent on a surface we control.
        if (err instanceof OverageApprovalError) {
          const priceLine = packApprovalPriceLine(err);
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `Address pack approval required. ${priceLine}`,
                  `To authorize this charge, open the approval page:`,
                  `  ${err.approval_url}`,
                  ``,
                  `Once approved, retry this tool — no extra flag needed.`,
                ].join("\n"),
              },
            ],
            isError: true,
          };
        }
        return errResponse(err);
      }
    },
  );

  server.registerTool(
    "domain",
    {
      title: "Custom Domain",
      description:
        "Connect, check, list, or remove a custom domain on upubli.sh (pro/max). " +
        "A custom domain becomes its own address — sites then serve at " +
        "`yourname.com/slug/` instead of `you.upubli.sh/slug/`.\n\n" +
        "Actions:\n" +
        "  add    — Connect a domain you own. Enter the ROOT (example.com), not " +
        "www.example.com; a subdomain (blog.example.com) works too. Returns the " +
        "DNS record(s) to add at your registrar — only the human can create DNS.\n" +
        "  status — Check whether a connected domain is live yet (pending vs active, " +
        "plus any validation errors like CAA).\n" +
        "  list   — List the account's custom domains.\n" +
        "  remove — Disconnect a custom domain by id.",
      inputSchema: {
        action: z
          .enum(["add", "status", "list", "remove"])
          .describe(
            "The domain operation: 'add' to connect a hostname, 'status' to check " +
            "if it's live, 'list' to see all custom domains, 'remove' to disconnect.",
          ),
        hostname: z
          .string()
          .optional()
          .describe(
            "The domain to connect. Required when action is 'add'. Use the root " +
            "(example.com), not www.example.com; a subdomain (blog.example.com) is fine.",
          ),
        id: z
          .string()
          .optional()
          .describe(
            "The custom-domain id. Required for 'status' and 'remove'. Use 'list' to find ids.",
          ),
      },
    },
    guarded(async ({ action, hostname, id }) => {
      const act = action as "add" | "status" | "list" | "remove";

      if (act === "add") {
        if (!hostname) {
          return errResponse(new Error("hostname is required when action is 'add'"));
        }
        const result = await domain({ action: "add", hostname }, coreDeps);
        if (result.action !== "add") return errResponse(new Error("Unexpected result"));
        const records = result.records
          .map((r) => `  ${r.type}  name: ${r.name}  value: ${r.value}`)
          .join("\n");
        return okResponse(
          `Connected "${result.hostname}" (id: ${result.namespace.id}).\n\n` +
          `Add these DNS record(s) at your registrar:\n${records}\n\n` +
          `${result.note}`,
        );
      }

      if (act === "status") {
        if (!id) {
          return errResponse(new Error("id is required when action is 'status'"));
        }
        const result = await domain({ action: "status", id }, coreDeps);
        if (result.action !== "status") return errResponse(new Error("Unexpected result"));
        const state = result.active ? "ACTIVE" : "PENDING";
        const errLine = result.validationErrors
          ? `\nValidation errors: ${result.validationErrors}`
          : "";
        return okResponse(
          `Custom domain "${result.hostname}" is ${state}.` +
          (result.active
            ? " It's live — publish to it like any address."
            : " DNS is still propagating, or the record(s) need a fix. Re-check shortly.") +
          errLine,
        );
      }

      if (act === "remove") {
        if (!id) {
          return errResponse(new Error("id is required when action is 'remove'"));
        }
        const result = await domain({ action: "remove", id }, coreDeps);
        if (result.action !== "remove") return errResponse(new Error("Unexpected result"));
        return okResponse(result.message);
      }

      // action === "list"
      const result = await domain({ action: "list" }, coreDeps);
      if (result.action !== "list") return errResponse(new Error("Unexpected result"));
      if (result.domains.length === 0) {
        return okResponse("No custom domains connected. Use the 'add' action to connect one.");
      }
      const lines = result.domains.map((d) => {
        const state = d.verified ? "active" : "pending";
        return `  ${d.hostname} — ${state} (id: ${d.id})`;
      });
      return okResponse(
        `Custom domains (${result.domains.length}):\n${lines.join("\n")}`,
      );
    }),
  );

  server.registerTool(
    "rename",
    {
      title: "Rename Site or Address",
      description:
        "Renames a site (slug) or an address on upubli.sh. " +
        "Provide `site` to rename a site within the address; omit `site` to rename the address itself. " +
        "Choose a redirect mode for old URLs: '30d' (default — safest, keeps old URLs working for 30 days), " +
        "'permanent' (301 redirect with no expiry), or 'off' (no redirect, old name released immediately). " +
        "Tier limits apply: Free accounts get one rename per resource lifetime; " +
        "Pro/Max accounts have a 30-day cooldown between renames of the same resource.",
      inputSchema: {
        nsId: z
          .string()
          .describe("The address name (e.g. 'ryan') or its UUID. Use the status or list tool to see your addresses."),
        site: z
          .string()
          .optional()
          .describe(
            "Slug of the site to rename. When provided, the site is renamed within the address. " +
            "When omitted, the address itself is renamed.",
          ),
        newName: z
          .string()
          .describe(
            "New name for the resource being renamed. When renaming a site, this is the " +
            "new slug (1-255 characters). When renaming the address, this is the new address " +
            "name (follows the address-name rules). In both cases: lowercase letters, numbers, " +
            "and hyphens only, starting and ending with a letter or number.",
          ),
        path_prefix: z
          .string()
          .nullable()
          .optional()
          .describe(
            "SITE renames only — set, change, or clear the site's nested path " +
            "prefix so it publishes at '{path_prefix}/{slug}' (e.g. " +
            "'2026/q3/code-report'). Omit to leave the current prefix " +
            "unchanged; pass an empty string or null to CLEAR the prefix " +
            "(move the site to the address root). Multiple slash-separated " +
            "segments are allowed. The server rejects a prefix that collides " +
            "with another site's address. Ignored when renaming an address.",
          ),
        redirect: z
          .enum(["off", "30d", "permanent"])
          .optional()
          .describe(
            "Redirect mode for old URLs. Defaults to '30d' (safest). " +
            "'off' — no redirect, old name released immediately. " +
            "'30d' — 301 redirect for 30 days. " +
            "'permanent' — permanent 301 redirect with no expiry.",
          ),
      },
    },
    guarded(async ({ nsId, site, newName, path_prefix, redirect }) => {
      const nsIdStr = nsId;
      const newNameStr = newName;

      if (!newNameStr) {
        return errResponse(new Error("newName is required"));
      }

      if (!nsIdStr) {
        return errResponse(new Error("nsId is required"));
      }

      const result = await rename(
        {
          nsId: nsIdStr,
          site,
          newName: newNameStr,
          // undefined ⇒ omit (keep prefix); null/"" ⇒ clear; string ⇒ set.
          // The distinction is preserved end-to-end so a client can clear a
          // prefix without accidentally clearing it on every unrelated rename.
          pathPrefix: path_prefix as string | null | undefined,
          redirect: redirect as "off" | "30d" | "permanent" | undefined,
        },
        coreDeps,
      );

      if (!result.success) {
        return errResponse(new Error(result.error));
      }

      const target = site ? `site '${site}'` : "address";
      const effectiveRedirect = redirect ?? "30d";
      const redirectLine =
        result.redirectExpiresAt
          ? `\nRedirect expires: ${result.redirectExpiresAt}`
          : effectiveRedirect === "off"
            ? "\nRedirect: none"
            : "\nRedirect: permanent";

      return okResponse(
        `Renamed ${target} to '${newNameStr}'.\n` +
        `New URL: ${result.url}` +
        redirectLine,
      );
    }),
  );

  // ─── Admin tools (env-gated) ────────────────────────────────────────────────
  // Only registered on a local server (localFiles) with UPUBLISH_ADMIN=1. Without both, the tool
  // registry is byte-identical to the 18-tool baseline — existing tests pass.

  {
    admin.registerTool(
      "admin_user",
      {
        title: "Admin: User",
        description:
          "Admin operations on a user account. Requires admin role.\n\n" +
          "Actions:\n" +
          "  lookup   — Look up a user by email address\n" +
          "  inspect  — Full user context: space, storage, sites, addresses\n" +
          "  role     — Change a user's platform role (user|admin)\n" +
          "  suspend  — Suspend a user account (reversible)\n" +
          "  ban      — Permanently ban a user and block all their sites (triggers KV reconcile)\n" +
          "  reinstate — Reinstate a suspended or banned user",
        inputSchema: {
          action: z
            .enum(["lookup", "inspect", "role", "suspend", "ban", "reinstate"])
            .describe("The admin user operation to perform."),
          email: z
            .string()
            .optional()
            .describe("User email address. Required for lookup action."),
          userId: z
            .string()
            .optional()
            .describe(
              "User ID. Required for inspect, role, suspend, ban, and reinstate actions.",
            ),
          role: z
            .enum(["user", "admin"])
            .optional()
            .describe("New platform role. Required for role action."),
          reason: z
            .string()
            .optional()
            .describe("Reason for status change. Recommended for suspend and ban actions."),
        },
      },
      guarded(async ({ action, email, userId, role, reason }) => {
        const actionStr = action as "lookup" | "inspect" | "role" | "suspend" | "ban" | "reinstate";

        if (actionStr === "lookup") {
          if (!email) return errResponse(new Error("email is required for lookup action"));
          const result = await adminUser(
            { action: "lookup", email },
            coreDeps,
          ) as AdminUserSummary;
          return okResponse(
            `User: ${result.username} (${result.email})\n` +
            `ID: ${result.id}\n` +
            `Role: ${result.role}\n` +
            `Status: ${result.status}${result.status_reason ? ` — ${result.status_reason}` : ""}`,
          );
        }

        if (actionStr === "inspect") {
          if (!userId) return errResponse(new Error("userId is required for inspect action"));
          const result = await adminUser(
            { action: "inspect", userId },
            coreDeps,
          ) as AdminUserInspect;
          const sitesLine = result.sites.length > 0
            ? `\nSites (${result.sites.length}): ${result.sites.map((s) => s.slug).join(", ")}`
            : "\nSites: none";
          return okResponse(
            `User: ${result.user.username} (${result.user.email})\n` +
            `Status: ${result.user.status}${result.user.status_reason ? ` — ${result.user.status_reason}` : ""}\n` +
            `Tier: ${result.space?.tier ?? "none"}\n` +
            `Storage: ${formatBytes(result.storage_bytes)}` +
            sitesLine,
          );
        }

        if (actionStr === "role") {
          if (!userId) return errResponse(new Error("userId is required for role action"));
          if (!role) return errResponse(new Error("role is required for role action"));
          const result = await adminUser(
            { action: "role", userId: userId, role: role as "user" | "admin" },
            coreDeps,
          ) as { id: string; role: string };
          return okResponse(`Role updated: ${result.id} → ${result.role}`);
        }

        if (actionStr === "suspend") {
          if (!userId) return errResponse(new Error("userId is required for suspend action"));
          const result = await adminUser(
            { action: "suspend", userId: userId, reason },
            coreDeps,
          ) as AdminStatusResult;
          return okResponse(
            `User ${result.id} suspended.\n` +
            `Reason: ${result.status_reason ?? "(none)"}`,
          );
        }

        if (actionStr === "ban") {
          if (!userId) return errResponse(new Error("userId is required for ban action"));
          const result = await adminUser(
            { action: "ban", userId: userId, reason },
            coreDeps,
          ) as AdminStatusResult;
          const reconcileLine = result.reconcile
            ? `\nKV reconcile: written=${result.reconcile.written} verified=${result.reconcile.verified} failed=${result.reconcile.failed.length}`
            : "";
          return okResponse(
            `User ${result.id} banned.\n` +
            `Reason: ${result.status_reason ?? "(none)"}` +
            reconcileLine,
          );
        }

        // reinstate
        if (!userId) return errResponse(new Error("userId is required for reinstate action"));
        const result = await adminUser(
          { action: "reinstate", userId },
          coreDeps,
        ) as AdminStatusResult;
        return okResponse(`User ${result.id} reinstated (status: ${result.status}).`);
      }),
    );

    admin.registerTool(
      "admin_site",
      {
        title: "Admin: Site",
        description:
          "Admin operations on a site. Requires admin role.\n\n" +
          "Actions:\n" +
          "  block   — Block a site (removes it from public access)\n" +
          "  unblock — Unblock a previously blocked site",
        inputSchema: {
          action: z
            .enum(["block", "unblock"])
            .describe("The admin site operation to perform."),
          siteId: z
            .string()
            .describe("The site ID to block or unblock."),
          reason: z
            .string()
            .optional()
            .describe("Reason for blocking. Recommended for block action."),
        },
      },
      guarded(async ({ action, siteId, reason }) => {
        const actionStr = action as "block" | "unblock";
        const siteIdStr = siteId;

        if (actionStr === "block") {
          const result = await adminSite(
            { action: "block", siteId: siteIdStr, reason },
            coreDeps,
          ) as AdminSiteBlockResult;
          return okResponse(
            `Site ${siteIdStr} blocked.\n` +
            `Blocked at: ${result.site.blocked_at ?? "unknown"}`,
          );
        }

        // unblock
        const result = await adminSite(
          { action: "unblock", siteId: siteIdStr },
          coreDeps,
        ) as AdminSiteBlockResult;
        return okResponse(`Site ${siteIdStr} unblocked (blocked_at: ${result.site.blocked_at ?? "null"}).`);
      }),
    );

    admin.registerTool(
      "admin_stats",
      {
        title: "Admin: Platform Stats",
        description:
          "Fetches platform-wide statistics. Requires admin role.\n\n" +
          "Returns: users by tier, users by status, site count, address count, " +
          "total storage, and blob deduplication ratio.",
        inputSchema: {},
      },
      guarded(async () => {
        const result = await adminStats(coreDeps) as AdminStats;
        const tierLines = Object.entries(result.users_by_tier)
          .map(([tier, count]) => `  ${tier}: ${count}`)
          .join("\n");
        const statusLines = Object.entries(result.users_by_status)
          .map(([status, count]) => `  ${status}: ${count}`)
          .join("\n");
        return okResponse(
          `Platform Stats\n\n` +
          `Users by tier:\n${tierLines}\n\n` +
          `Users by status:\n${statusLines}\n\n` +
          `Sites: ${result.site_count}\n` +
          `Addresses: ${result.namespace_count}\n` +
          `Total storage: ${formatBytes(result.total_storage_bytes)}\n` +
          `Blob dedup ratio: ${(result.blob_dedup_ratio * 100).toFixed(1)}%`,
        );
      }),
    );

    admin.registerTool(
      "admin_storage",
      {
        title: "Admin: Storage",
        description:
          "Admin storage operations. Requires admin role.\n\n" +
          "Actions:\n" +
          "  sweep  — Scan for and optionally delete orphaned blobs/prefixes. " +
          "Defaults to dry-run=true. Pass confirm=true for live deletion.\n" +
          "  resync — Resync KV access-control metadata for a site, user, or all entries.",
        inputSchema: {
          action: z
            .enum(["sweep", "resync"])
            .describe("The storage admin operation to perform."),
          dryRun: z
            .boolean()
            .optional()
            .describe(
              "For sweep: when true (default), reports orphans without deleting. " +
              "Pass false to actually delete orphaned blobs.",
            ),
          graceSeconds: z
            .number()
            .int()
            .optional()
            .describe(
              "For sweep: grace period in seconds. Blobs newer than this are skipped.",
            ),
          scope: z
            .enum(["site", "user", "all"])
            .optional()
            .describe("For resync: scope of the KV resync. Required for resync action."),
          id: z
            .string()
            .optional()
            .describe(
              "For resync: the site or user ID to resync. Required when scope is site or user.",
            ),
        },
      },
      guarded(async ({ action, dryRun, graceSeconds, scope, id }) => {
        const actionStr = action as "sweep" | "resync";

        if (actionStr === "sweep") {
          const result = await adminStorage(
            {
              action: "sweep",
              dryRun: dryRun as boolean | undefined,
              graceSeconds: graceSeconds as number | undefined,
            },
            coreDeps,
          ) as AdminSweepReport;
          const mode = result.dry_run ? "DRY RUN" : "LIVE";
          return okResponse(
            `Storage sweep (${mode})\n` +
            `Orphaned blobs: ${result.orphaned_blobs.length}\n` +
            `Abandoned prefixes: ${result.abandoned_prefixes.length}\n` +
            `Deleted bytes: ${formatBytes(result.deleted_bytes)}`,
          );
        }

        // resync
        if (!scope) return errResponse(new Error("scope is required for resync action"));
        const result = await adminStorage(
          {
            action: "resync",
            scope: scope as "site" | "user" | "all",
            id,
          },
          coreDeps,
        ) as AdminResyncReport;
        return okResponse(
          `KV resync complete\n` +
          `Written: ${result.written}\n` +
          `Verified: ${result.verified}\n` +
          `Failed: ${result.failed.length}${result.failed.length > 0 ? `\n  ${result.failed.join("\n  ")}` : ""}`,
        );
      }),
    );

    admin.registerTool(
      "admin_domains",
      {
        title: "Admin: Domains",
        description:
          "Admin domain management. Requires admin role.\n\n" +
          "Actions:\n" +
          "  list   — List all registered custom domains\n" +
          "  add    — Register a new custom domain\n" +
          "  remove — Remove a registered custom domain",
        inputSchema: {
          action: z
            .enum(["list", "add", "remove"])
            .describe("The domain admin operation to perform."),
          hostname: z
            .string()
            .optional()
            .describe("Domain hostname (e.g. example.com). Required for add action."),
          accessPolicy: z
            .string()
            .optional()
            .describe("Access policy for the domain (e.g. 'open'). Required for add action."),
          domainId: z
            .string()
            .optional()
            .describe("Domain ID to remove. Required for remove action."),
        },
      },
      guarded(async ({ action, hostname, accessPolicy, domainId }) => {
        const actionStr = action as "list" | "add" | "remove";

        if (actionStr === "list") {
          const result = await adminDomains({ action: "list" }, coreDeps) as AdminDomain[];
          if (result.length === 0) {
            return okResponse("No custom domains registered.");
          }
          const lines = result.map(
            (d) => `  ${d.hostname} (${d.access_policy}) — ${d.namespace_count} address(es) [id: ${d.id}]`,
          );
          return okResponse(`Custom domains (${result.length}):\n${lines.join("\n")}`);
        }

        if (actionStr === "add") {
          if (!hostname) return errResponse(new Error("hostname is required for add action"));
          if (!accessPolicy) return errResponse(new Error("accessPolicy is required for add action"));
          const result = await adminDomains(
            { action: "add", hostname: hostname, accessPolicy },
            coreDeps,
          ) as AdminDomain;
          return okResponse(
            `Domain registered: ${result.hostname}\n` +
            `ID: ${result.id}\n` +
            `Access policy: ${result.access_policy}`,
          );
        }

        // remove
        if (!domainId) return errResponse(new Error("domainId is required for remove action"));
        await adminDomains({ action: "remove", domainId }, coreDeps);
        return okResponse(`Domain ${domainId} removed.`);
      }),
    );
  }

  return server;
}

// ─── Hosted factory ───────────────────────────────────────────────────────────

/** Thrown by createHostedServer when a host-touching tool is registered on what must be a hosted server. */
export class HostedServerUnsafeError extends Error {
  readonly tools: string[];
  constructor(tools: string[]) {
    super(`Hosted MCP server exposes host-only tools: ${tools.join(", ")}`);
    this.name = "HostedServerUnsafeError";
    this.tools = tools;
  }
}

/**
 * Names registered on `server`, read from the SDK's private registry. This is the ONLY place that reaches into
 * it (covered by tests); if the SDK renames it, fail closed rather than report an empty list.
 */
function registeredToolNames(server: McpServer): string[] {
  const registry = (server as unknown as { _registeredTools?: unknown })._registeredTools;
  let found: string[] | null = null;
  if (registry instanceof Map) found = [...registry.keys()].map(String);
  else if (Array.isArray(registry)) found = registry.map(String);
  else if (registry !== null && typeof registry === "object") found = Object.keys(registry);
  // Any unrecognised shape, or an empty registry (a hosted server always has tools), is unverifiable: fail closed.
  if (found === null || found.length === 0) {
    throw new HostedServerUnsafeError(["<cannot read the MCP SDK tool registry>"]);
  }
  return found;
}

/** Throws HostedServerUnsafeError naming every local-only or admin tool registered on `server`. */
export function assertHostedServerSafe(server: McpServer): void {
  const forbidden = new Set<string>([...LOCAL_ONLY_TOOLS, ...ADMIN_TOOLS]);
  const found = registeredToolNames(server).filter((n) => forbidden.has(n));
  if (found.length > 0) throw new HostedServerUnsafeError(found);
}

/**
 * Builds the MCP server for a hosted (remote) router: `localFiles` is forced off, update checks are forced off,
 * host file logging is switched off for the process, and the registered tool names are verified, so a
 * registration regression fails closed instead of exposing a host-touching tool.
 *
 * `coreDeps.tokenProvider` is REQUIRED: without it every API tool would fall back to the HOST's credentials file
 * and act as the host's user. `build` is a test seam; production callers pass only `coreDeps`.
 */
export function createHostedServer(
  coreDeps?: CoreDeps,
  build: (deps?: CoreDeps, opts?: CreateServerOpts) => McpServer = createServer,
): McpServer {
  if (typeof coreDeps?.tokenProvider !== "function") {
    throw new HostedServerUnsafeError(["<coreDeps.tokenProvider is required: without it API tools use the host's credentials>"]);
  }
  setFileLogging(false);
  const server = build(coreDeps, { localFiles: false, updateCheck: false });
  assertHostedServerSafe(server);
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
