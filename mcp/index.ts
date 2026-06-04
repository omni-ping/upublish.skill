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
  login,
  status,
  logout,
  addPasscode,
  listPasscodes,
  revokePasscode,
  gate,
  members,
  qrCode,
} from "../lib/core.ts";
import type {
  CoreDeps,
  Site,
  SiteVersion,
  CallbackServer,
  TokenResponse,
  GateSubmission,
  UploadProgress,
  Member,
} from "../lib/core.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

export const PACKAGE_NAME = "@omniping/upublish";
export const PACKAGE_VERSION = "0.10.2";

// ─── Formatting helpers ───────────────────────────────────────────────────────

/** Formats bytes into a human-readable string (B / KB / MB / GB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Formats a single site version as a one-line entry with status + live marker. */
function formatVersionEntry(version: SiteVersion): string {
  const liveMarker = version.is_live ? " (LIVE)" : "";
  return `v${version.version_number} — ${version.status}${liveMarker}`;
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
  return {
    content: [{ type: "text" as const, text: (err as Error).message }],
    isError: true,
  };
}

// ─── Callback server (for OAuth login) ───────────────────────────────────────

/**
 * Creates a localhost HTTP server that waits for the OAuth callback redirect.
 * The server reads tokens from query params on the /callback path.
 * Returns port, a promise that resolves on first callback, and a close fn.
 */
async function createCallbackServer(): Promise<CallbackServer> {
  let resolveTokens: (tokens: TokenResponse) => void;
  let rejectTokens: (err: Error) => void;

  const tokenPromise = new Promise<TokenResponse>(
    (resolve, reject) => {
      resolveTokens = resolve;
      rejectTokens = reject;
    },
  );

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/callback") {
        const accessToken = url.searchParams.get("access_token");
        const refreshToken = url.searchParams.get("refresh_token");
        const expiresIn = url.searchParams.get("expires_in");
        const username = url.searchParams.get("username");
        const error = url.searchParams.get("error");

        if (error) {
          rejectTokens(new Error(`OAuth error: ${error}`));
          return new Response(
            "<html><body><h2>Authentication failed.</h2><p>You can close this tab.</p></body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        }

        if (!accessToken || !refreshToken || !expiresIn || !username) {
          rejectTokens(new Error("OAuth callback missing required parameters"));
          return new Response(
            "<html><body><h2>Authentication error.</h2><p>Missing parameters. You can close this tab.</p></body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        }

        resolveTokens({
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: parseInt(expiresIn, 10),
          username,
        });

        return new Response(
          "<html><body><h2>Authenticated!</h2><p>You can close this tab and return to your terminal.</p></body></html>",
          { headers: { "Content-Type": "text/html" } },
        );
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return {
    port: server.port,
    waitForTokens: () => tokenPromise,
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
            "URL-safe identifier for the site. Must be 3-63 characters: " +
            "lowercase letters, numbers, and hyphens only, starting and ending " +
            "with a letter or number. Use '_root' to publish at the " +
            "namespace/domain root (e.g. vibeandscribe.xyz/).",
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
            "Namespace name to publish into. When omitted, the default namespace is used.",
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
      },
    },
    async ({ directory, slug, title, visibility, passcode, namespace, preview, force }, extra) => {
      log(`[publish] tool entry slug=${slug as string} dir=${directory as string}`);

      // Only emit MCP progress when the client supplied a progressToken in _meta.
      // When absent (or extra is omitted, e.g. in tests), onProgress stays
      // undefined so publish behaves exactly as before.
      const progressToken = extra?._meta?.progressToken;

      // Heartbeat state: tracks the last seen progress snapshot so the interval
      // can re-emit it with a "still uploading" suffix. Both are null before any
      // progress fires (i.e., before uploads begin).
      let lastProgress: UploadProgress | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      /** Sends a single best-effort MCP progress notification. Never throws. */
      function sendProgress(p: UploadProgress, message: string): void {
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

      const onProgress =
        progressToken !== undefined
          ? (p: UploadProgress) => {
              lastProgress = p;
              // Drive the percentage off bytes when we have them — file counts
              // mislead when sizes vary (one big asset vs many tiny files).
              // Fall back to file counts if every needed file is zero-length
              // (totalBytes === 0 would make the bar divide by zero).
              const msg = `${formatBytes(p.completedBytes)} / ${formatBytes(p.totalBytes)} (${p.completed}/${p.total} files)`;
              sendProgress(p, msg);

              // Start heartbeat on first progress event (uploads have begun).
              // If no file completes within heartbeatIntervalMs, re-emit the last
              // progress snapshot so clients with idle-timeout logic stay active.
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
            onProgress,
          },
          coreDeps,
        );
        stopHeartbeat();

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
          incrementalLine,
        );
      } catch (err) {
        stopHeartbeat();
        log(`[publish] tool error slug=${slug as string} err=${(err as Error).message}`);
        return errResponse(err);
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
            "Namespace name to list sites from. When omitted, the default namespace is used.",
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
            `No sites published yet in namespace "${ns.name}" (${ns.domain})${roleMarker}. ` +
            "Use the `publish` tool to deploy your first site.",
          );
        }
        const header = `Sites in namespace "${ns.name}" (${ns.domain})${roleMarker}`;
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
            "Namespace name the site belongs to. When omitted, the default namespace is used.",
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
            "Namespace name the site belongs to. When omitted, the default namespace is used.",
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
            "Namespace name the site belongs to. When omitted, the default namespace is used.",
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
            "Namespace name the site belongs to. When omitted, the default namespace is used.",
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
            "Namespace name the site belongs to. When omitted, the default namespace is used.",
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
            "Namespace name the site belongs to. When omitted, the default namespace is used.",
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
            "Namespace name the site belongs to. When omitted, the default namespace is used.",
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
      title: "Namespace Members",
      description:
        "Manages members of a shared namespace on upubli.sh. " +
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
            "Namespace name to manage members for. When omitted, the default namespace is used.",
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
            return okResponse("No members found. The namespace owner has sole access.");
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
          return okResponse(`Removed ${usernameStr} from namespace`);
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
            "Namespace name the site belongs to. When omitted, the default namespace is used.",
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
            "Namespace name the site belongs to. When omitted, the default namespace is used.",
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
        "Authenticates with upubli.sh via Google OAuth. " +
        "Opens a browser for sign-in and waits for the OAuth callback. " +
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
    "status",
    {
      title: "Auth Status",
      description:
        "Checks whether you are currently authenticated with upubli.sh. " +
        "Returns your username and available namespaces (with domains) if authenticated, " +
        "or a not-authenticated message.",
      inputSchema: {},
    },
    async () => {
      const result = await status(coreDeps);

      if (result.authenticated) {
        const lines = [`Authenticated as: ${result.username}`];

        if (result.namespaces.length > 0) {
          lines.push("", "Namespaces:");
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
