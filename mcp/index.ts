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
import type { ProgressNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import open from "open";
import { log } from "../lib/log.ts";
import {
  list,
  publish,
  promote,
  deleteOp,
  listSiteVersions,
  deleteSiteVersion,
  restoreSiteVersion,
  setSiteVersionsLimit,
  analytics,
  login,
  status,
  logout,
  namespaceCreate,
  OverageApprovalError,
  StorageApprovalError,
  domain,
  addPasscode,
  listPasscodes,
  revokePasscode,
  gate,
  members,
  qrCode,
  rename,
  upgrade,
  adminUser,
  adminSite,
  adminStats,
  adminStorage,
  adminDomains,
  displayMsg,
  appendUpgradeHint,
} from "../lib/core.ts";
import type {
  CoreDeps,
  TokenProvider,
  Site,
  SiteVersion,
  SetVersionsLimitResult,
  CallbackServer,
  NamespaceCreateResult,
  HashProgress,
  GateSubmission,
  UploadProgress,
  Member,
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

// ─── Constants ────────────────────────────────────────────────────────────────

export const PACKAGE_NAME = "@omniping/upublish";
export const PACKAGE_VERSION = "0.12.25";

// ─── Formatting helpers ───────────────────────────────────────────────────────

/** Formats bytes into a human-readable string (B / KB / MB / GB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Formats a single site version as a one-line entry: number, status, live
 * marker, and — when the backend supplies them — the metadata a user needs to
 * pick a version to restore (created date, file count, size).
 */
function formatVersionEntry(version: SiteVersion): string {
  const liveMarker = version.is_live ? " (LIVE)" : "";
  const meta: string[] = [];
  if (version.created_at) meta.push(new Date(version.created_at).toLocaleString());
  if (typeof version.file_count === "number") meta.push(`${version.file_count} files`);
  if (typeof version.total_size === "number") meta.push(formatBytes(version.total_size));
  const metaSuffix = meta.length > 0 ? `\n    ${meta.join(" · ")}` : "";
  return `v${version.version_number} — ${version.status}${liveMarker}${metaSuffix}`;
}

/**
 * Formats the storage-usage object echoed by a version delete into a readable
 * line. Renders used/limit as a "X of Y" byte figure when both are present,
 * otherwise falls back to whatever numeric fields the API returned.
 */
function formatUsage(usage: Record<string, number | undefined>): string {
  if (typeof usage.used_bytes === "number" && typeof usage.limit_bytes === "number") {
    return `${formatBytes(usage.used_bytes)} of ${formatBytes(usage.limit_bytes)}`;
  }
  if (typeof usage.used_bytes === "number") {
    return formatBytes(usage.used_bytes);
  }
  const parts = Object.entries(usage)
    .filter(([, value]) => typeof value === "number")
    .map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join(", ") : "(unavailable)";
}

/** Formats a single site as a human-readable block with labeled fields. */
function formatSiteEntry(site: Site): string {
  const size = formatBytes(site.total_size);
  const updated = new Date(site.updated_at).toLocaleDateString();
  const visibility =
    site.visibility !== "public" ? `\nVisibility: ${site.visibility}` : "";

  return (
    `Title: ${site.title}\n` +
    `Slug: ${site.slug}\n` +
    `URL: ${site.url ?? `(URL unavailable — check slug: ${site.slug})`}\n` +
    `Files: ${site.file_count} (${size})\n` +
    `Updated: ${updated}` +
    visibility
  );
}

// ─── MCP content helpers ──────────────────────────────────────────────────────

type McpContent = Array<{ type: "text"; text: string }>;

type ToolResponse = {
  content: McpContent;
  isError?: boolean;
};

function okResponse(text: string): ToolResponse {
  return { content: [{ type: "text" as const, text }] };
}

function errResponse(err: unknown): ToolResponse {
  // Apply displayMsg at the single MCP error-display boundary so backend-originated
  // "namespace" error text (from lib/*.ts) is translated to "address" for users.
  // lib/* functions stay raw (for testability and correctness); translation happens here.
  return {
    content: [{ type: "text" as const, text: displayMsg((err as Error).message) }],
    isError: true,
  };
}

// ─── Callback server (for OAuth login) ───────────────────────────────────────

/**
 * Creates a localhost HTTP server that waits for the unified OAuth callback.
 * The unified flow redirects back with a single-use authorization `code` (or an
 * `error`) on the /callback path — never tokens. The server resolves with that
 * code; login() exchanges it for tokens out of band. New users finish browser
 * onboarding first, so this may wait a while; there is no hard timeout.
 * Returns port, a promise that resolves with the code, and a close fn.
 */
async function createCallbackServer(): Promise<CallbackServer> {
  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          rejectCode(new Error(`OAuth error: ${error}`));
          return new Response(
            "<html><body><h2>Sign-in failed.</h2><p>You can close this tab and return to your terminal.</p></body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        }

        if (!code) {
          rejectCode(new Error("OAuth callback missing the authorization code"));
          return new Response(
            "<html><body><h2>Sign-in error.</h2><p>Missing authorization code. You can close this tab.</p></body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        }

        resolveCode(code);

        return new Response(
          "<html><body><h2>Signed in!</h2><p>You can close this tab and return to your terminal.</p></body></html>",
          { headers: { "Content-Type": "text/html" } },
        );
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return {
    port: server.port,
    waitForCode: () => codePromise,
    close: async () => server.stop(),
  };
}

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
export function createServer(coreDeps?: CoreDeps, opts?: CreateServerOpts): McpServer {
  const heartbeatIntervalMs = opts?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const openBrowser = opts?.openBrowser ?? ((url: string) => open(url).then(() => undefined));
  const server = new McpServer({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  });

  server.registerTool(
    "publish",
    {
      title: "Publish Site",
      description:
        "Publishes a local directory as a static website to upubli.sh. " +
        "Hashes files locally, uploads only changed files via presigned R2 URLs, " +
        "automatically excluding .git, node_modules, .env, .DS_Store, and other non-site files. " +
        "Add a .upublishignore file to the directory for custom exclusions. " +
        "The site will be available at a public URL immediately after upload. " +
        "If a site with the same slug already exists, it will be updated efficiently.",
      inputSchema: {
        directory: z
          .string()
          .describe(
            "Path to the directory containing the files to publish. " +
            "Can be absolute or relative to the current working directory.",
          ),
        slug: z
          .string()
          .describe(
            "URL-safe identifier for the site. Must be 1-255 characters: " +
            "lowercase letters, numbers, and hyphens only, starting and ending " +
            "with a letter or number. Use '_root' to publish at the " +
            "address/domain root (e.g. vibeandscribe.xyz/).",
          ),
        title: z
          .string()
          .optional()
          .describe(
            "Optional human-readable title for the site. Defaults to the slug.",
          ),
        visibility: z
          .enum(["public", "passcode"])
          .optional()
          .describe(
            "Site visibility mode. 'public' (default) or 'passcode'.",
          ),
        passcode: z
          .string()
          .optional()
          .describe(
            "Passcode for passcode-protected sites. Required when visibility is 'passcode'.",
          ),
        namespace: z
          .string()
          .optional()
          .describe(
            "Address name to publish into. When omitted, the default address is used.",
          ),
        preview: z
          .boolean()
          .optional()
          .describe(
            "When true, publishes as a staging preview instead of going live immediately. " +
            "The response includes a preview_url where the staging version can be reviewed. " +
            "Use the promote tool to promote the staging version to live.",
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "When true, uploads all files regardless of whether they changed. " +
            "Use this to force a full re-upload when the site is broken or out of sync.",
          ),
        analytics_enabled: z
          .boolean()
          .optional()
          .describe(
            "Per-site analytics. Defaults to on. Set false to publish WITHOUT the " +
            "analytics script (e.g. \"publish ... with no analytics\"). To toggle " +
            "analytics on an already-published site without republishing, use the " +
            "analytics tool instead.",
          ),
      },
    },
    async ({ directory, slug, title, visibility, passcode, namespace, preview, force, analytics_enabled }, extra) => {
      log(`[publish] tool entry slug=${slug as string} dir=${directory as string}`);

      // Only emit MCP progress when the client supplied a progressToken in _meta.
      // When absent (or extra is omitted, e.g. in tests), onProgress stays
      // undefined so publish behaves exactly as before.
      const progressToken = extra?._meta?.progressToken;

      // Heartbeat state: tracks the last seen progress snapshot so the interval
      // can re-emit it with a "still hashing…" / "still uploading…" suffix.
      // lastHashProgress holds the hashing snapshot; lastProgress the upload one.
      // Both are null before any progress fires for their respective phase.
      let lastProgress: UploadProgress | null = null;
      let lastHashProgress: HashProgress | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      /** Sends a single best-effort MCP progress notification. Never throws. */
      function sendProgress(
        p: { completed: number; total: number; completedBytes: number; totalBytes: number },
        message: string,
      ): void {
        const useBytes = p.totalBytes > 0;
        const notification: ProgressNotification = {
          method: "notifications/progress",
          params: {
            progressToken: progressToken as string | number,
            progress: useBytes ? p.completedBytes : p.completed,
            total: useBytes ? p.totalBytes : p.total,
            // Human-readable detail; clients that render the optional
            // message field show it next to the bar, others ignore it.
            message,
          },
        };
        // Best-effort: a dropped notification (e.g. client gone, transport
        // closed) must never break the publish, so swallow the rejection.
        extra
          .sendNotification(notification)
          .catch((err: unknown) =>
            log(`[publish] progress notification failed: ${(err as Error).message}`),
          );
      }

      // onHashProgress: wires the hashing phase into MCP notifications/progress.
      // Mirrors onProgress: byte-weighted with file-count fallback when totalBytes===0.
      // Starts the single heartbeat timer on the first hashing event so it fires
      // during any long hash gap too.
      const onHashProgress =
        progressToken !== undefined
          ? (p: HashProgress) => {
              lastHashProgress = p;
              const msg = `Hashing ${formatBytes(p.completedBytes)} / ${formatBytes(p.totalBytes)} (${p.completed}/${p.total} files)`;
              sendProgress(p, msg);

              // Start heartbeat on first hashing event (one timer for both phases).
              if (heartbeatTimer === null) {
                heartbeatTimer = setInterval(() => {
                  if (lastProgress !== null) {
                    const hbMsg =
                      `${formatBytes(lastProgress.completedBytes)} / ${formatBytes(lastProgress.totalBytes)} ` +
                      `(${lastProgress.completed}/${lastProgress.total} files) — still uploading…`;
                    sendProgress(lastProgress, hbMsg);
                  } else if (lastHashProgress !== null) {
                    const hbMsg =
                      `Hashing ${formatBytes(lastHashProgress.completedBytes)} / ${formatBytes(lastHashProgress.totalBytes)} ` +
                      `(${lastHashProgress.completed}/${lastHashProgress.total} files) — still hashing…`;
                    sendProgress(lastHashProgress, hbMsg);
                  }
                }, heartbeatIntervalMs);
              }
            }
          : undefined;

      const onProgress =
        progressToken !== undefined
          ? (p: UploadProgress) => {
              // Reset lastHashProgress at the phase transition — the heartbeat
              // switches to "still uploading…" as soon as the first upload fires.
              lastHashProgress = null;
              lastProgress = p;
              // Drive the percentage off bytes when we have them — file counts
              // mislead when sizes vary (one big asset vs many tiny files).
              // Fall back to file counts if every needed file is zero-length
              // (totalBytes === 0 would make the bar divide by zero).
              const msg = `${formatBytes(p.completedBytes)} / ${formatBytes(p.totalBytes)} (${p.completed}/${p.total} files)`;
              sendProgress(p, msg);

              // Heartbeat may already be running from the hashing phase.
              // Start it now only if hashing emitted nothing (no progressToken
              // at hash time, or hashing was skipped entirely).
              if (heartbeatTimer === null) {
                heartbeatTimer = setInterval(() => {
                  if (lastProgress !== null) {
                    const hbMsg =
                      `${formatBytes(lastProgress.completedBytes)} / ${formatBytes(lastProgress.totalBytes)} ` +
                      `(${lastProgress.completed}/${lastProgress.total} files) — still uploading…`;
                    sendProgress(lastProgress, hbMsg);
                  }
                }, heartbeatIntervalMs);
              }
            }
          : undefined;

      /** Stops the heartbeat timer. Safe to call multiple times. */
      function stopHeartbeat(): void {
        if (heartbeatTimer !== null) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      }

      try {
        const result = await publish(
          {
            directory: directory as string,
            slug: slug as string,
            title: title as string | undefined,
            visibility: visibility as "public" | "passcode" | undefined,
            passcode: passcode as string | undefined,
            namespace: namespace as string | undefined,
            preview: preview as boolean | undefined,
            force: force as boolean | undefined,
            analyticsEnabled: analytics_enabled as boolean | undefined,
            onProgress,
            onHashProgress,
          },
          coreDeps,
        );

        const site = result.site;
        const visibilityLine =
          visibility && visibility !== "public"
            ? `\nVisibility: ${visibility as string}`
            : "";

        const excludedLine =
          result.excluded.length > 0
            ? `\nExcluded: ${result.excluded.length} file(s) (${result.excluded.join(", ")})`
            : "";

        const warningLine =
          result.warnings.length > 0
            ? `\nWarning: Included files that may not be site content: ${result.warnings.join(", ")}` +
              `\n  Add them to .upublishignore in the publish directory to exclude.`
            : "";

        // Show uploaded vs skipped file counts
        const incrementalLine =
          result.uploadedFiles !== undefined && result.skippedFiles !== undefined
            ? `\nUploaded: ${result.uploadedFiles.length} file(s), skipped ${result.skippedFiles.length} unchanged file(s)`
            : "";

        // Surface storage-pack block charge when the manifest response included one.
        // Render interval-aware copy from server-returned values only — never hardcode.
        const storageOverageLine = (() => {
          const ov = result.storage_overage;
          if (ov?.charged !== true) return "";
          const intervalSuffix = ov.interval === "year" ? "/yr" : "/mo";
          return (
            `\n\n+$${ov.price.toFixed(2)}${intervalSuffix} added to your bill — ` +
            `${ov.blocks} x ${ov.block_gb}GB storage block${ov.blocks !== 1 ? "s" : ""}.`
          );
        })();

        if (result.preview_url) {
          log(`[publish] tool done slug=${site.slug} preview_url=${result.preview_url}`);
          return okResponse(
            `Preview published!\n` +
            `Preview URL: ${result.preview_url}\n` +
            `Slug: ${site.slug}\n` +
            `Files: ${site.file_count}\n` +
            `Size: ${formatBytes(site.total_size)}` +
            visibilityLine +
            excludedLine +
            warningLine +
            incrementalLine +
            storageOverageLine +
            `\nUse the promote tool to make this preview live.`,
          );
        }

        log(`[publish] tool done slug=${site.slug} url=${result.url}`);
        return okResponse(
          `Site published successfully!\n` +
          `URL: ${result.url}\n` +
          `Slug: ${site.slug}\n` +
          `Files: ${site.file_count}\n` +
          `Size: ${formatBytes(site.total_size)}` +
          visibilityLine +
          excludedLine +
          warningLine +
          incrementalLine +
          storageOverageLine,
        );
      } catch (err) {
        log(`[publish] tool error slug=${slug as string} err=${(err as Error).message}`);
        // 402 needs_storage_approval: surface the approval URL and pack pricing.
        // Never send accept_overage — that flag is reserved for explicit human
        // consent on a surface we control. Agents must always forward the approval
        // URL to the user and wait for them to authorize the charge manually.
        if (err instanceof StorageApprovalError) {
          // Render interval-aware price copy when the server supplied it.
          // Omit the price line entirely when the body was malformed/missing it —
          // never fall back to a hardcoded literal.
          const priceLine =
            err.price !== null
              ? `Approving adds a ${err.block_gb ?? 10}GB storage block ` +
                `at $${err.price.toFixed(2)}${err.interval === "year" ? "/yr" : "/mo"}.`
              : `Approving adds a storage block to your subscription.`;
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `Storage pack approval required. ${priceLine}`,
                  `To authorize this charge, open the approval page:`,
                  `  ${err.approval_url}`,
                  ``,
                  `Once approved, retry the publish — no extra flag needed.`,
                ].join("\n"),
              },
            ],
            isError: true,
          };
        }
        // Free-tier TIER-LIMIT 403 (body has limit+usage, no `code`): append a
        // one-line hint to run the `upgrade` tool. hard_max / admin / auth 403s
        // are excluded by the discriminator, so the hint never appears there.
        const e = err as Error;
        return errResponse(new Error(appendUpgradeHint(e.message, err)));
      } finally {
        // Always stop the heartbeat timer — no leak on success, error, or throw.
        stopHeartbeat();
      }
    },
  );

  server.registerTool(
    "list",
    {
      title: "List Sites",
      description:
        "Lists all static websites you have published to upubli.sh. " +
        "Shows each site's name, URL, file count, and total size.",
      inputSchema: {
        namespace: z
          .string()
          .optional()
          .describe(
            "Address name to list sites from. When omitted, the default address is used.",
          ),
      },
    },
    async ({ namespace }) => {
      try {
        const result = await list(namespace as string | undefined, coreDeps);
        const { sites } = result;

        const ns = result.namespace;
        // Show role marker for shared namespaces (admin/user). Owner is the
        // default state — no marker keeps the output clean for most users.
        const roleMarker = ns.role && ns.role !== "owner" ? ` [${ns.role}]` : "";

        if (sites.length === 0) {
          return okResponse(
            `No sites published yet in address "${ns.name}" (${ns.domain})${roleMarker}. ` +
            "Use the `publish` tool to deploy your first site.",
          );
        }
        const header = `Sites in address "${ns.name}" (${ns.domain})${roleMarker}`;
        const lines = sites.map((site) => formatSiteEntry(site));
        return okResponse(`${header}\n\n${lines.join("\n\n")}`);
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.registerTool(
    "delete",
    {
      title: "Delete Site",
      description:
        "Permanently deletes a published site from upubli.sh. " +
        "This action cannot be undone.",
      inputSchema: {
        slug: z
          .string()
          .describe(
            "The URL-safe identifier of the site to delete. " +
            "Use the `list` tool to find available slugs.",
          ),
        namespace: z
          .string()
          .optional()
          .describe(
            "Address name the site belongs to. When omitted, the default address is used.",
          ),
      },
    },
    async ({ slug, namespace }) => {
      try {
        const result = await deleteOp(slug as string, namespace as string | undefined, coreDeps);
        return okResponse(result.message);
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.registerTool(
    "versions_list",
    {
      title: "List Site Versions",
      description:
        "Lists all deploy versions of a published site on upubli.sh. " +
        "Shows each version's number, status, and which one is currently live. " +
        "Use `versions_delete` to remove an archived version and reclaim storage.",
      inputSchema: {
        slug: z
          .string()
          .describe(
            "The URL-safe identifier of the site. " +
            "Use the `list` tool to find available slugs.",
          ),
        namespace: z
          .string()
          .optional()
          .describe(
            "Address name the site belongs to. When omitted, the default address is used.",
          ),
      },
    },
    async ({ slug, namespace }) => {
      try {
        const result = await listSiteVersions(
          slug as string,
          namespace as string | undefined,
          coreDeps,
        );

        if (result.versions.length === 0) {
          return okResponse(`No versions found for site '${slug as string}'.`);
        }

        const header = `Versions for '${slug as string}'`;
        const lines = result.versions.map((version) => formatVersionEntry(version));
        return okResponse(`${header}\n\n${lines.join("\n")}`);
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.registerTool(
    "versions_delete",
    {
      title: "Delete Site Version",
      description:
        "Deletes a single archived version of a published site on upubli.sh to " +
        "reclaim storage. The currently live version cannot be deleted. " +
        "Returns the space reclaimed and your updated storage usage.",
      inputSchema: {
        slug: z
          .string()
          .describe(
            "The URL-safe identifier of the site. " +
            "Use the `list` tool to find available slugs.",
          ),
        versionNumber: z
          .number()
          .int()
          .positive()
          .describe(
            "The version number to delete (a positive integer). " +
            "Use `versions_list` to see available version numbers.",
          ),
        namespace: z
          .string()
          .optional()
          .describe(
            "Address name the site belongs to. When omitted, the default address is used.",
          ),
      },
    },
    async ({ slug, versionNumber, namespace }) => {
      try {
        const result = await deleteSiteVersion(
          slug as string,
          versionNumber as number,
          namespace as string | undefined,
          coreDeps,
        );
        return okResponse(
          `Deleted version v${result.version_number} of '${slug as string}'.\n` +
          `Reclaimed: ${formatBytes(result.freed_bytes)}\n` +
          `Usage: ${formatUsage(result.usage)}`,
        );
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.registerTool(
    "versions_restore",
    {
      title: "Restore Site Version",
      description:
        "Rolls a published site on upubli.sh back to a previous version, making " +
        "that version live again. Use `versions_list` first to see version numbers " +
        "and their dates/sizes. Returns the now-live version number and live URL. " +
        "Restoring versions requires a paid plan.",
      inputSchema: {
        slug: z
          .string()
          .describe(
            "The URL-safe identifier of the site. " +
            "Use the `list` tool to find available slugs.",
          ),
        version: z
          .number()
          .int()
          .positive()
          .describe(
            "The version number to restore (a positive integer). " +
            "Use `versions_list` to see available version numbers.",
          ),
        namespace: z
          .string()
          .optional()
          .describe(
            "Address name the site belongs to. When omitted, the default address is used.",
          ),
      },
    },
    async ({ slug, version, namespace }) => {
      try {
        const result = await restoreSiteVersion(
          slug as string,
          version as number,
          namespace as string | undefined,
          coreDeps,
        );
        return okResponse(
          `Restored '${slug as string}' to version v${result.version_number}, now live.\n` +
          `URL: ${result.url}`,
        );
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.registerTool(
    "versions_limit",
    {
      title: "Set Version Retention Limit",
      description:
        "Sets or clears the version retention limit for a published site on upubli.sh. " +
        "When a limit is set, the oldest archived versions beyond that count are pruned " +
        "immediately, and future publishes will prune automatically. " +
        "Omit or pass null for `limit` to clear the limit (unlimited retention). " +
        "Returns the updated limit, pruned version numbers, and storage freed.",
      inputSchema: {
        slug: z
          .string()
          .describe(
            "The URL-safe identifier of the site. " +
            "Use the `list` tool to find available slugs.",
          ),
        limit: z
          .union([z.number().int().min(1), z.null()])
          .optional()
          .describe(
            "Maximum number of non-staging versions to retain (integer ≥ 1). " +
            "Omit or pass null to clear the limit (unlimited retention). " +
            "The live version is always preserved regardless of the limit.",
          ),
        namespace: z
          .string()
          .optional()
          .describe(
            "Address name the site belongs to. When omitted, the default address is used.",
          ),
      },
    },
    async ({ slug, limit, namespace }) => {
      try {
        const resolvedLimit: number | null = (limit === undefined ? null : limit) as number | null;
        const result: SetVersionsLimitResult = await setSiteVersionsLimit(
          slug as string,
          resolvedLimit,
          namespace as string | undefined,
          coreDeps,
        );
        const limitDisplay =
          result.site.max_versions !== null
            ? `Limit set to ${result.site.max_versions} version${result.site.max_versions === 1 ? "" : "s"}.`
            : "Retention limit cleared (unlimited).";
        const prunedDisplay =
          result.pruned.length > 0
            ? `Pruned versions: ${result.pruned.map((v) => `v${v}`).join(", ")}\n` +
              `Reclaimed: ${formatBytes(result.freed_bytes)}\n` +
              `Usage: ${formatUsage(result.usage)}`
            : "No versions were pruned.";
        return okResponse(`${limitDisplay}\n${prunedDisplay}`);
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.registerTool(
    "analytics",
    {
      title: "Toggle Site Analytics",
      description:
        "Turns the per-site analytics script on or off for an already-published " +
        "site on upubli.sh — WITHOUT republishing. Use for requests like " +
        "\"turn off analytics for my-portfolio\" or \"turn analytics back on for my-portfolio\". " +
        "Analytics is on by default; to publish a new site with analytics off, use the " +
        "publish tool's analytics_enabled option instead.",
      inputSchema: {
        slug: z
          .string()
          .describe(
            "The URL-safe identifier of the site. Use the `list` tool to find available slugs.",
          ),
        enabled: z
          .boolean()
          .describe(
            "true to enable analytics (inject the script), false to disable it.",
          ),
        namespace: z
          .string()
          .optional()
          .describe(
            "Address name the site belongs to. When omitted, the default address is used.",
          ),
      },
    },
    async ({ slug, enabled, namespace }) => {
      try {
        const result = await analytics(
          slug as string,
          enabled as boolean,
          namespace as string | undefined,
          coreDeps,
        );
        const state = result.site.analytics_enabled === false ? "OFF" : "ON";
        return okResponse(
          `Analytics is now ${state} for "${result.site.slug}". ` +
          (state === "OFF"
            ? "New page views will no longer be tracked; the analytics script is no longer injected."
            : "The analytics script will be injected on future page loads.") +
          "\nNo republish was needed — this took effect immediately.",
        );
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.registerTool(
    "passcode_add",
    {
      title: "Add Passcode",
      description:
        "Adds a passcode to a passcode-protected site on upubli.sh. " +
        "Each passcode can have a unique label for identification (e.g. 'Client A'). " +
        "The site must already have visibility set to 'passcode'.",
      inputSchema: {
        slug: z
          .string()
          .describe("The URL-safe identifier of the site to add a passcode to."),
        code: z
          .string()
          .describe("The passcode string that visitors will use to access the site."),
        label: z
          .string()
          .describe(
            "Human-readable label for this passcode (e.g. 'Client A', 'Team B'). " +
            "Used to identify and revoke specific passcodes.",
          ),
        namespace: z
          .string()
          .optional()
          .describe(
            "Address name the site belongs to. When omitted, the default address is used.",
          ),
      },
    },
    async ({ slug, code, label, namespace }) => {
      try {
        const result = await addPasscode(
          slug as string,
          code as string,
          label as string,
          namespace as string | undefined,
          coreDeps,
        );
        return okResponse(
          `Passcode added to ${slug as string}\n` +
          `ID:    ${result.passcode.id}\n` +
          `Label: ${result.passcode.label}`,
        );
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.registerTool(
    "passcode_list",
    {
      title: "List Passcodes",
      description:
        "Lists all passcodes for a passcode-protected site on upubli.sh. " +
        "Shows each passcode's ID, label, and creation date.",
      inputSchema: {
        slug: z
          .string()
          .describe("The URL-safe identifier of the site to list passcodes for."),
        namespace: z
          .string()
          .optional()
          .describe(
            "Address name the site belongs to. When omitted, the default address is used.",
          ),
      },
    },
    async ({ slug, namespace }) => {
      try {
        const result = await listPasscodes(
          slug as string,
          namespace as string | undefined,
          coreDeps,
        );

        if (result.passcodes.length === 0) {
          return okResponse(`No passcodes found for site '${slug as string}'.`);
        }

        const lines = result.passcodes.map((pc) => {
          const created = new Date(pc.created_at).toLocaleDateString();
          return `  ID: ${pc.id}\n  Label: ${pc.label}\n  Created: ${created}`;
        });

        return okResponse(
          `Passcodes for ${slug as string} (${result.passcodes.length}):\n\n` +
          lines.join("\n\n"),
        );
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.registerTool(
    "passcode_revoke",
    {
      title: "Revoke Passcode",
      description:
        "Revokes (removes) a passcode from a passcode-protected site on upubli.sh. " +
        "Specify either the passcode ID or its label. " +
        "Use the passcode_list tool to find available IDs and labels.",
      inputSchema: {
        slug: z
          .string()
          .describe("The URL-safe identifier of the site to revoke a passcode from."),
        id: z
          .string()
          .optional()
          .describe("The passcode ID to revoke. Takes precedence over label."),
        label: z
          .string()
          .optional()
          .describe(
            "The passcode label to revoke (resolved to ID via list). " +
            "Used only when id is not provided.",
          ),
        namespace: z
          .string()
          .optional()
          .describe(
            "Address name the site belongs to. When omitted, the default address is used.",
          ),
      },
    },
    async ({ slug, id, label, namespace }) => {
      try {
        const result = await revokePasscode(
          slug as string,
          { id: id as string | undefined, label: label as string | undefined },
          namespace as string | undefined,
          coreDeps,
        );
        const identifier = id ? `id=${id as string}` : `label="${label as string}"`;
        return okResponse(
          `Passcode revoked from ${slug as string} (${identifier})\n${result.message}`,
        );
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.registerTool(
    "gate",
    {
      title: "Form Gate",
      description:
        "Manages a form gate for a site on upubli.sh. " +
        "A form gate prompts visitors to submit information (email, name, etc.) " +
        "before accessing the site. Use this tool to set up, inspect, remove, " +
        "view submissions from, or clear submissions for a gate.\n\n" +
        "Actions:\n" +
        "  set         — Create or update a form gate with the given fields\n" +
        "  get         — Get the current gate config and submission count\n" +
        "  remove      — Remove the gate from a site\n" +
        "  submissions — List visitor submissions captured by the gate\n" +
        "  clear       — Delete all submissions for a gate",
      inputSchema: {
        action: z
          .enum(["set", "get", "remove", "submissions", "clear"])
          .describe(
            "The gate operation to perform: " +
            "'set' to create/update, 'get' to retrieve config, " +
            "'remove' to delete the gate, 'submissions' to list visitor data, " +
            "'clear' to delete all submissions.",
          ),
        slug: z
          .string()
          .describe("The URL-safe identifier of the site."),
        fields: z
          .array(z.enum(["email", "name", "company", "phone", "message"]))
          .optional()
          .describe(
            "Fields to collect from visitors. Required when action is 'set'. " +
            "Valid values: 'email', 'name', 'company', 'phone', 'message'.",
          ),
        namespace: z
          .string()
          .optional()
          .describe(
            "Address name the site belongs to. When omitted, the default address is used.",
          ),
      },
    },
    async ({ action, slug, fields, namespace }) => {
      try {
        const actionStr = action as "set" | "get" | "remove" | "submissions" | "clear";
        const slugStr = slug as string;

        if (actionStr === "set") {
          const fieldsArr = fields as string[] | undefined;
          if (!fieldsArr || fieldsArr.length === 0) {
            return errResponse(new Error("fields is required when action is 'set'"));
          }
          const result = await gate(
            { action: "set", slug: slugStr, fields: fieldsArr, namespace: namespace as string | undefined },
            coreDeps,
          );
          if (result.action !== "set") return errResponse(new Error("Unexpected result"));
          const fieldsList = result.gate.fields.join(", ");
          return okResponse(
            `Gate set for '${slugStr}'\nFields: ${fieldsList}`,
          );
        }

        if (actionStr === "get") {
          const result = await gate(
            { action: "get", slug: slugStr, namespace: namespace as string | undefined },
            coreDeps,
          );
          if (result.action !== "get") return errResponse(new Error("Unexpected result"));
          const fieldsList = result.gate.fields.join(", ");
          return okResponse(
            `Gate for '${slugStr}'\nFields: ${fieldsList}\nSubmissions: ${result.submission_count}`,
          );
        }

        if (actionStr === "remove") {
          const result = await gate(
            { action: "remove", slug: slugStr, namespace: namespace as string | undefined },
            coreDeps,
          );
          if (result.action !== "remove") return errResponse(new Error("Unexpected result"));
          return okResponse(result.message);
        }

        if (actionStr === "submissions") {
          const result = await gate(
            { action: "submissions", slug: slugStr, namespace: namespace as string | undefined },
            coreDeps,
          );
          if (result.action !== "submissions") return errResponse(new Error("Unexpected result"));
          const { submissions } = result;
          if (submissions.length === 0) {
            return okResponse(`No submissions found for gate on '${slugStr}'.`);
          }
          const lines = submissions.map((sub: GateSubmission) => {
            const date = new Date(sub.submitted_at).toLocaleDateString();
            const fields = Object.entries(sub.data)
              .map(([k, v]) => `  ${k}: ${v}`)
              .join("\n");
            return `Submitted: ${date}\n${fields}`;
          });
          return okResponse(
            `Gate submissions for '${slugStr}' (${submissions.length}):\n\n` +
            lines.join("\n\n"),
          );
        }

        // action === "clear"
        const result = await gate(
          { action: "clear", slug: slugStr, namespace: namespace as string | undefined },
          coreDeps,
        );
        if (result.action !== "clear") return errResponse(new Error("Unexpected result"));
        return okResponse(result.message);
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.registerTool(
    "members",
    {
      title: "Address Members",
      description:
        "Manages members of a shared address on upubli.sh. " +
        "Owners and admins can add, remove, and change member roles. " +
        "Any member can list the current member roster.\n\n" +
        "Actions:\n" +
        "  list   — List all members and their roles\n" +
        "  add    — Add a user by username with a given role (admin|user)\n" +
        "  remove — Remove a member by username\n" +
        "  role   — Change a member's role (admin|user)",
      inputSchema: {
        action: z
          .enum(["list", "add", "remove", "role"])
          .describe(
            "The member operation to perform: " +
            "'list' to show all members, 'add' to grant access, " +
            "'remove' to revoke access, 'role' to change a member's role.",
          ),
        username: z
          .string()
          .optional()
          .describe(
            "The username to add, remove, or change role for. " +
            "Required for add, remove, and role actions.",
          ),
        role: z
          .enum(["admin", "user"])
          .optional()
          .describe(
            "The role to assign. Required for add and role actions. " +
            "'admin' can manage members; 'user' can publish and gate only.",
          ),
        namespace: z
          .string()
          .optional()
          .describe(
            "Address name to manage members for. When omitted, the default address is used.",
          ),
      },
    },
    async ({ action, username, role, namespace }) => {
      try {
        const actionStr = action as "list" | "add" | "remove" | "role";
        const nsStr = namespace as string | undefined;

        if (actionStr === "list") {
          const result = await members({ action: "list", namespace: nsStr }, coreDeps);
          if (result.action !== "list") return errResponse(new Error("Unexpected result"));
          if (result.members.length === 0) {
            return okResponse("No members found. The address owner has sole access.");
          }
          const lines = result.members.map(
            (m: Member) => `  ${m.username} — ${m.role}`,
          );
          return okResponse(`Members:\n${lines.join("\n")}`);
        }

        if (actionStr === "add") {
          const usernameStr = username as string | undefined;
          const roleStr = role as "admin" | "user" | undefined;
          if (!usernameStr) {
            return errResponse(new Error("username is required for the add action"));
          }
          if (!roleStr) {
            return errResponse(new Error("role is required for the add action"));
          }
          const result = await members(
            { action: "add", username: usernameStr, role: roleStr, namespace: nsStr },
            coreDeps,
          );
          if (result.action !== "add") return errResponse(new Error("Unexpected result"));
          return okResponse(
            `Added ${result.member.username} as ${result.member.role}`,
          );
        }

        if (actionStr === "remove") {
          const usernameStr = username as string | undefined;
          if (!usernameStr) {
            return errResponse(new Error("username is required for the remove action"));
          }
          const result = await members(
            { action: "remove", username: usernameStr, namespace: nsStr },
            coreDeps,
          );
          if (result.action !== "remove") return errResponse(new Error("Unexpected result"));
          return okResponse(`Removed ${usernameStr} from address`);
        }

        // action === "role"
        const usernameStr = username as string | undefined;
        const roleStr = role as "admin" | "user" | undefined;
        if (!usernameStr) {
          return errResponse(new Error("username is required for the role action"));
        }
        if (!roleStr) {
          return errResponse(new Error("role is required for the role action"));
        }
        const result = await members(
          { action: "role", username: usernameStr, role: roleStr, namespace: nsStr },
          coreDeps,
        );
        if (result.action !== "role") return errResponse(new Error("Unexpected result"));
        return okResponse(
          `Changed ${usernameStr} role to ${result.member.role}`,
        );
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.registerTool(
    "promote",
    {
      title: "Promote Preview",
      description:
        "Promotes a staging preview version of a site to live on upubli.sh. " +
        "Use this after publishing with preview=true to make the staged version " +
        "available at the site's public URL. " +
        "Returns the live URL of the promoted site.",
      inputSchema: {
        slug: z
          .string()
          .describe(
            "The URL-safe identifier of the site to promote. " +
            "Use the list tool to find available slugs.",
          ),
        namespace: z
          .string()
          .optional()
          .describe(
            "Address name the site belongs to. When omitted, the default address is used.",
          ),
      },
    },
    async ({ slug, namespace }) => {
      try {
        const result = await promote(
          slug as string,
          namespace as string | undefined,
          coreDeps,
        );
        return okResponse(
          `Preview promoted to live!\n` +
          `URL: ${result.url}`,
        );
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.registerTool(
    "qrcode",
    {
      title: "QR Code",
      description:
        "Generates a QR code for a published site on upubli.sh. " +
        "Displays a scannable unicode QR in the agent output and writes " +
        "qr.svg and qr.png files to the specified directory (defaults to cwd). " +
        "The QR encodes the site's canonical URL + ?ref=qr for analytics tracking. " +
        "Regenerating overwrites prior output — the QR is deterministic.",
      inputSchema: {
        slug: z
          .string()
          .describe(
            "The URL-safe identifier of the site to generate a QR code for. " +
            "Use the list tool to find available slugs.",
          ),
        namespace: z
          .string()
          .optional()
          .describe(
            "Address name the site belongs to. When omitted, the default address is used.",
          ),
        outputDir: z
          .string()
          .optional()
          .describe(
            "Directory to write qr.svg and qr.png into. " +
            "Defaults to the current working directory.",
          ),
      },
    },
    async ({ slug, namespace, outputDir }) => {
      try {
        const result = await qrCode(
          {
            slug: slug as string,
            namespace: namespace as string | undefined,
            outputDir: outputDir as string | undefined,
          },
          coreDeps,
        );
        return okResponse(
          `QR code for: ${result.siteUrl}\n\n` +
          `${result.unicodeQr}\n` +
          `SVG: ${result.svgPath}\n` +
          `PNG: ${result.pngPath}`,
        );
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  server.registerTool(
    "logout",
    {
      title: "Logout",
      description:
        "Signs out of upubli.sh by revoking the refresh token server-side and " +
        "deleting local credentials. Safe to call even when not logged in or " +
        "when the server is unreachable (local credentials are always cleared).",
      inputSchema: {},
    },
    async () => {
      const result = await logout(coreDeps);
      if (result.loggedOut) {
        return okResponse("Logged out successfully. Local credentials have been removed.");
      }
      return {
        content: [{ type: "text" as const, text: `Logout failed: ${result.error}` }],
        isError: true,
      };
    },
  );

  server.registerTool(
    "login",
    {
      title: "Login",
      description:
        "Authenticates with upubli.sh. " +
        "Opens a browser sign-in page where you choose a provider and waits for the OAuth callback. " +
        "The auth URL is always included in the response so you can open " +
        "it in a different browser profile if needed.",
      inputSchema: {},
    },
    async () => {
      let capturedAuthUrl = "";

      try {
        const result = await login(
          {
            apiBaseUrl: process.env.UPUBLISH_API_URL ?? "https://api.upubli.sh",
            siteBaseUrl: (process.env.UPUBLISH_SITE_URL ?? "https://upubli.sh").replace(/\/$/, ""),
            openBrowser: async (url: string) => {
              capturedAuthUrl = url;
              await open(url);
            },
            startCallbackServer: createCallbackServer,
            log: () => {},
          },
          coreDeps,
        );

        const lines = [
          `Authenticated as: ${result.username}`,
          `Credentials stored at: ${result.credentialsFilePath}`,
        ];
        if (capturedAuthUrl) {
          lines.push("", `Auth URL: ${capturedAuthUrl}`);
        }
        return okResponse(lines.join("\n"));
      } catch (err) {
        const lines = [(err as Error).message];
        if (capturedAuthUrl) {
          lines.push("", `Auth URL (open manually if needed): ${capturedAuthUrl}`);
        }
        return errResponse(new Error(lines.join("\n")));
      }
    },
  );

  server.registerTool(
    "upgrade",
    {
      title: "Upgrade Plan",
      description:
        "Opens the Stripe Checkout page for a paid plan (pro or max) in your browser " +
        "so the user can enter payment and upgrade their upubli.sh account. " +
        "Use this when an agent hits a free-tier wall (file-size or storage tier limit) " +
        "and the user wants more capacity. Card entry is browser-only by design — this " +
        "tool only opens the right page, it cannot complete payment. The checkout URL is " +
        "always included in the response so it can be opened manually (e.g. headless envs). " +
        "Defaults to the pro plan billed monthly.",
      inputSchema: {
        plan: z
          .enum(["pro", "max"])
          .optional()
          .describe("Which paid plan to check out. Defaults to 'pro'."),
        interval: z
          .enum(["month", "year"])
          .optional()
          .describe("Billing interval. Defaults to 'month'."),
      },
    },
    async (args: { plan?: "pro" | "max"; interval?: "month" | "year" }) => {
      // Mirror the login tool: capture the URL the moment the opener is invoked
      // so it survives an open() rejection (headless / no DISPLAY) — DW-2.3.
      let capturedUrl = "";

      const result = await upgrade(
        async (url: string) => {
          capturedUrl = url;
          await openBrowser(url);
        },
        { plan: args.plan, interval: args.interval },
        coreDeps,
      );

      if (result.ok) {
        return okResponse(
          [
            `Opening the checkout page in your browser to upgrade.`,
            `Enter your payment details there to complete the upgrade.`,
            ``,
            `Checkout URL: ${result.url}`,
          ].join("\n"),
        );
      }

      // Failure: always echo the URL when we have one (browser failed to open
      // after a successful checkout) so headless users can open it manually.
      const url = result.url ?? capturedUrl;
      const lines = [result.error];
      if (url) {
        lines.push("", `Checkout URL (open manually if needed): ${url}`);
      }
      return errResponse(new Error(lines.join("\n")));
    },
  );

  server.registerTool(
    "status",
    {
      title: "Auth Status",
      description:
        "Checks whether you are currently authenticated with upubli.sh. " +
        "Returns your username and available addresses (with domains) if authenticated, " +
        "or a not-authenticated message.",
      inputSchema: {},
    },
    async () => {
      const result = await status(coreDeps);

      if (result.authenticated) {
        const lines = [`Authenticated as: ${result.username}`];

        if (result.namespaces.length > 0) {
          lines.push("", "Addresses:");
          for (const ns of result.namespaces) {
            // Show role marker for shared namespaces (admin/user). Owner is the
            // default state — no marker for clean output.
            const roleMarker = ns.role && ns.role !== "owner" ? ` [${ns.role}]` : "";
            lines.push(`  ${ns.name} (${ns.domain})${roleMarker}`);
          }
        }

        return okResponse(lines.join("\n"));
      }

      const msg = result.error
        ? `Not authenticated. ${result.error}`
        : "Not authenticated. Use the login tool to sign in.";
      return okResponse(msg);
    },
  );

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
          // Render interval-aware pack copy from server-returned values.
          // Never hardcode a price — use whatever the backend returned.
          const intervalSuffix = result.overage.interval === "year" ? "/yr" : "/mo";
          lines.push(
            ``,
            `+$${result.overage.price.toFixed(2)}${intervalSuffix} added to your bill — ` +
            `a pack of ${result.overage.pack_size} address slots.`,
          );
        }
        return okResponse(lines.join("\n"));
      } catch (err) {
        // 402 needs_overage_approval: surface the approval URL and pack price so
        // the agent can forward them to the user. Never send accept_overage — that
        // flag is reserved for explicit human consent on a surface we control.
        if (err instanceof OverageApprovalError) {
          // Render interval-aware price copy when the server supplied it.
          // Omit the price line entirely when the body was malformed/missing it —
          // never fall back to a hardcoded literal.
          const priceLine =
            err.price !== null
              ? `Adding this address requires a pack of ${err.pack_size ?? 5} address slots ` +
                `at $${err.price.toFixed(2)}${err.interval === "year" ? "/yr" : "/mo"}.`
              : `Adding this address requires an address pack.`;
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
    async ({ action, hostname, id }) => {
      try {
        const act = action as "add" | "status" | "list" | "remove";

        if (act === "add") {
          if (!hostname) {
            return errResponse(new Error("hostname is required when action is 'add'"));
          }
          const result = await domain({ action: "add", hostname: hostname as string }, coreDeps);
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
          const result = await domain({ action: "status", id: id as string }, coreDeps);
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
          const result = await domain({ action: "remove", id: id as string }, coreDeps);
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
      } catch (err) {
        return errResponse(err);
      }
    },
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
    async ({ nsId, site, newName, redirect }) => {
      try {
        const nsIdStr = nsId as string;
        const newNameStr = newName as string | undefined;

        if (!newNameStr) {
          return errResponse(new Error("newName is required"));
        }

        if (!nsIdStr) {
          return errResponse(new Error("nsId is required"));
        }

        const result = await rename(
          {
            nsId: nsIdStr,
            site: site as string | undefined,
            newName: newNameStr,
            redirect: redirect as "off" | "30d" | "permanent" | undefined,
          },
          coreDeps,
        );

        if (!result.success) {
          return errResponse(new Error(result.error));
        }

        const target = site ? `site '${site as string}'` : "address";
        const effectiveRedirect = (redirect as string | undefined) ?? "30d";
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
      } catch (err) {
        return errResponse(err);
      }
    },
  );

  // ─── Admin tools (env-gated) ────────────────────────────────────────────────
  // Only registered when UPUBLISH_ADMIN=1. Without the env var, the tool
  // registry is byte-identical to the 18-tool baseline — existing tests pass.

  if (process.env.UPUBLISH_ADMIN === "1") {
    server.registerTool(
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
      async ({ action, email, userId, role, reason }) => {
        try {
          const actionStr = action as "lookup" | "inspect" | "role" | "suspend" | "ban" | "reinstate";

          if (actionStr === "lookup") {
            if (!email) return errResponse(new Error("email is required for lookup action"));
            const result = await adminUser(
              { action: "lookup", email: email as string },
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
              { action: "inspect", userId: userId as string },
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
              { action: "role", userId: userId as string, role: role as "user" | "admin" },
              coreDeps,
            ) as { id: string; role: string };
            return okResponse(`Role updated: ${result.id} → ${result.role}`);
          }

          if (actionStr === "suspend") {
            if (!userId) return errResponse(new Error("userId is required for suspend action"));
            const result = await adminUser(
              { action: "suspend", userId: userId as string, reason: reason as string | undefined },
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
              { action: "ban", userId: userId as string, reason: reason as string | undefined },
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
            { action: "reinstate", userId: userId as string },
            coreDeps,
          ) as AdminStatusResult;
          return okResponse(`User ${result.id} reinstated (status: ${result.status}).`);
        } catch (err) {
          return errResponse(err);
        }
      },
    );

    server.registerTool(
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
      async ({ action, siteId, reason }) => {
        try {
          const actionStr = action as "block" | "unblock";
          const siteIdStr = siteId as string;

          if (actionStr === "block") {
            const result = await adminSite(
              { action: "block", siteId: siteIdStr, reason: reason as string | undefined },
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
        } catch (err) {
          return errResponse(err);
        }
      },
    );

    server.registerTool(
      "admin_stats",
      {
        title: "Admin: Platform Stats",
        description:
          "Fetches platform-wide statistics. Requires admin role.\n\n" +
          "Returns: users by tier, users by status, site count, address count, " +
          "total storage, and blob deduplication ratio.",
        inputSchema: {},
      },
      async () => {
        try {
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
        } catch (err) {
          return errResponse(err);
        }
      },
    );

    server.registerTool(
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
      async ({ action, dryRun, graceSeconds, scope, id }) => {
        try {
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
              id: id as string | undefined,
            },
            coreDeps,
          ) as AdminResyncReport;
          return okResponse(
            `KV resync complete\n` +
            `Written: ${result.written}\n` +
            `Verified: ${result.verified}\n` +
            `Failed: ${result.failed.length}${result.failed.length > 0 ? `\n  ${result.failed.join("\n  ")}` : ""}`,
          );
        } catch (err) {
          return errResponse(err);
        }
      },
    );

    server.registerTool(
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
      async ({ action, hostname, accessPolicy, domainId }) => {
        try {
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
              { action: "add", hostname: hostname as string, accessPolicy: accessPolicy as string },
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
          await adminDomains({ action: "remove", domainId: domainId as string }, coreDeps);
          return okResponse(`Domain ${domainId as string} removed.`);
        } catch (err) {
          return errResponse(err);
        }
      },
    );
  }

  return server;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Main entry point — creates server with default CoreDeps and starts stdio transport.
 * Credentials are read fresh per tool call; no startup credential read needed.
 */
async function main(): Promise<void> {
  const server = createServer();
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
