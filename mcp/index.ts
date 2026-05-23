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
  list,
  publish,
  deleteOp,
  login,
  status,
  logout,
  addPasscode,
  listPasscodes,
  revokePasscode,
} from "../lib/core.ts";
import type { CoreDeps, Site, CallbackServer, TokenResponse } from "../lib/core.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

export const PACKAGE_NAME = "@omniping/upublish";
export const PACKAGE_VERSION = "0.6.1";

// ─── Formatting helpers ───────────────────────────────────────────────────────

/** Formats bytes into a human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Formats a single site as a human-readable block (matches monorepo output). */
function formatSiteEntry(site: Site): string {
  const size = formatBytes(site.total_size);
  const updated = new Date(site.updated_at).toLocaleDateString();
  const visibility =
    site.visibility !== "public" ? `\nVisibility: ${site.visibility}` : "";

  return (
    `${site.title} (${site.slug})\n` +
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
 * Creates and configures the MCP server with all tools registered.
 *
 * Each tool handler calls the corresponding core function with the provided
 * CoreDeps. Credentials are read fresh on every tool invocation — there is no
 * startup credential read and no stale-state.
 *
 * @param coreDeps - Optional overrides for credentials path and fetch (for tests)
 * @returns Configured McpServer instance ready to connect to a transport
 */
export function createServer(coreDeps?: CoreDeps): McpServer {
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
        "Packages all files in the directory into a zip archive and uploads them. " +
        "The site will be available at a public URL immediately after upload. " +
        "If a site with the same slug already exists, it will be replaced entirely.",
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
            "with a letter or number.",
          ),
        title: z
          .string()
          .optional()
          .describe(
            "Optional human-readable title for the site. Defaults to the slug.",
          ),
        visibility: z
          .enum(["public", "unlisted", "passcode"])
          .optional()
          .describe(
            "Site visibility mode. 'public' (default), 'unlisted', or 'passcode'.",
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
      },
    },
    async ({ directory, slug, title, visibility, passcode, namespace }) => {
      try {
        const result = await publish(
          {
            directory: directory as string,
            slug: slug as string,
            title: title as string | undefined,
            visibility: visibility as "public" | "unlisted" | "passcode" | undefined,
            passcode: passcode as string | undefined,
            namespace: namespace as string | undefined,
          },
          coreDeps,
        );

        const site = result.site;
        const visibilityLine =
          visibility && visibility !== "public"
            ? `\nVisibility: ${visibility as string}`
            : "";

        return okResponse(
          `Site published successfully!\n` +
          `URL: ${result.url}\n` +
          `Slug: ${site.slug}\n` +
          `Files: ${site.file_count}\n` +
          `Size: ${formatBytes(site.total_size)}` +
          visibilityLine,
        );
      } catch (err) {
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

        if (sites.length === 0) {
          return okResponse(
            "No sites published yet. Use the `publish` tool to deploy your first site.",
          );
        }

        const lines = sites.map((site) => formatSiteEntry(site));
        return okResponse(`Published sites (${sites.length}):\n\n${lines.join("\n\n")}`);
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
        "Returns your username if authenticated, or a not-authenticated message.",
      inputSchema: {},
    },
    async () => {
      const result = await status(coreDeps);

      if (result.authenticated) {
        return okResponse(`Authenticated as: ${result.username}`);
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
