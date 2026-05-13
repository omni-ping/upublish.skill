#!/usr/bin/env bun
/**
 * upubli.sh MCP Server entrypoint.
 *
 * Reads a refresh token from ~/.upublish/credentials at startup.
 * If no token is found, all tools return a "not authenticated" error
 * pointing to the `upublish login` CLI command.
 *
 * The refresh token is exchanged for a short-lived access token before
 * the first API call. The access token is refreshed automatically when it
 * expires — tool callers see no interruption.
 *
 * Configuration:
 *   UPUBLISH_API_URL  (optional) — API base URL, defaults to https://api.upubli.sh
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ApiClient } from "../lib/api-client.ts";
import {
  createTokenProvider,
  readCredentials,
  defaultCredentialsPath,
} from "../lib/auth.ts";
import { publish } from "../lib/publish.ts";
import { listSites } from "../lib/list.ts";
import { deleteSite } from "../lib/delete.ts";
import { generate } from "../lib/generate.ts";
import type { FetchFn } from "../lib/types.ts";
import type { Site } from "../lib/types.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

export const PACKAGE_NAME = "@upublish/mcp-skills";
export const PACKAGE_VERSION = "0.1.0";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Configuration read at startup.
 */
export interface McpServerConfig {
  /** API base URL (defaults to https://api.upubli.sh) */
  apiBaseUrl: string;
  /** Refresh token from credentials file, or null if not authenticated */
  refreshToken: string | null;
}

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

// ─── Tool handler factories ───────────────────────────────────────────────────

/**
 * Creates the publish tool handler. Delegates to lib/publish.ts.
 * Formats the result as the monorepo publish tool does.
 */
export function makePublishHandler(
  apiClient: ApiClient,
  publishFn = publish,
): (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  return async ({
    directory,
    slug,
    title,
    visibility,
    passcode,
  }: Record<string, unknown>) => {
    try {
      const result = await publishFn({
        apiClient,
        directory: directory as string,
        slug: slug as string,
        title: title as string | undefined,
        visibility: visibility as
          | "public"
          | "unlisted"
          | "passcode"
          | undefined,
        passcode: passcode as string | undefined,
      });

      const site = result.site;
      const visibilityLine =
        visibility && visibility !== "public"
          ? `\nVisibility: ${visibility as string}`
          : "";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Site published successfully!\n` +
              `URL: ${result.url}\n` +
              `Slug: ${site.slug}\n` +
              `Files: ${site.file_count}\n` +
              `Size: ${formatBytes(site.total_size)}` +
              visibilityLine,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: (err as Error).message },
        ],
        isError: true,
      };
    }
  };
}

/**
 * Creates the list tool handler. Delegates to lib/list.ts.
 * Formats the result as the monorepo list tool does.
 */
export function makeListHandler(
  apiClient: ApiClient,
  listFn = listSites,
): (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  return async (_args: Record<string, unknown>) => {
    try {
      const result = await listFn(apiClient);
      const { sites } = result;

      if (sites.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No sites published yet. Use the `publish` tool to deploy your first site.",
            },
          ],
        };
      }

      const lines = sites.map((site) => formatSiteEntry(site));

      return {
        content: [
          {
            type: "text" as const,
            text: `Published sites (${sites.length}):\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: (err as Error).message },
        ],
        isError: true,
      };
    }
  };
}

/**
 * Creates the delete tool handler. Delegates to lib/delete.ts.
 */
export function makeDeleteHandler(
  apiClient: ApiClient,
  deleteFn = deleteSite,
): (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  return async ({ slug }: Record<string, unknown>) => {
    try {
      const result = await deleteFn(apiClient, slug as string);
      return {
        content: [
          { type: "text" as const, text: result.message },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: (err as Error).message },
        ],
        isError: true,
      };
    }
  };
}

/**
 * Creates the generate tool handler. Delegates to lib/generate.ts.
 */
export function makeGenerateHandler(
  apiClient: ApiClient,
  generateFn = generate,
): (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  return async ({ context, diagramType, slug }: Record<string, unknown>) => {
    try {
      const result = await generateFn({
        apiClient,
        context: context as string,
        diagramType: diagramType as
          | "flowchart"
          | "sequence"
          | "architecture"
          | undefined,
        slug: slug as string | undefined,
      });

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Diagram generated and published!\n` +
              `URL: ${result.url}\n` +
              `Slug: ${result.slug}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: (err as Error).message },
        ],
        isError: true,
      };
    }
  };
}

// ─── Server factory ───────────────────────────────────────────────────────────

/**
 * Creates and configures the MCP server with all tools registered.
 *
 * Each tool delegates to the corresponding lib/ function — no inline logic.
 *
 * If no refresh token is available, registers stub tools that return a clear
 * "not authenticated" error pointing the user to `upublish login`.
 *
 * @param config   - Server configuration including API base URL and refresh token
 * @param fetchFn  - Injectable fetch function (for tests)
 * @returns Configured McpServer instance ready to connect to a transport
 */
export function createServer(
  config: McpServerConfig,
  fetchFn?: FetchFn,
): McpServer {
  const server = new McpServer({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  });

  // Not authenticated — register stub tools that return a helpful error
  if (!config.refreshToken) {
    const notAuthError = () => ({
      content: [
        {
          type: "text" as const,
          text: "Not authenticated. Run `upublish login` to log in.",
        },
      ],
      isError: true,
    });

    server.registerTool(
      "publish",
      { description: "Publish a site (requires authentication)" },
      notAuthError,
    );
    server.registerTool(
      "list",
      { description: "List sites (requires authentication)" },
      notAuthError,
    );
    server.registerTool(
      "delete",
      { description: "Delete a site (requires authentication)" },
      notAuthError,
    );
    server.registerTool(
      "generate",
      { description: "Generate a diagram (requires authentication)" },
      notAuthError,
    );
    return server;
  }

  // Authenticated — create real API client and register tool handlers
  const tokenProvider = createTokenProvider({
    refreshToken: config.refreshToken,
    apiBaseUrl: config.apiBaseUrl,
    fetchFn,
  });

  const apiClient = new ApiClient(config.apiBaseUrl, tokenProvider, fetchFn);

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
      },
    },
    makePublishHandler(apiClient) as Parameters<
      typeof server.registerTool
    >[2],
  );

  server.registerTool(
    "list",
    {
      title: "List Sites",
      description:
        "Lists all static websites you have published to upubli.sh. " +
        "Shows each site's name, URL, file count, and total size.",
      inputSchema: {},
    },
    makeListHandler(apiClient) as Parameters<typeof server.registerTool>[2],
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
      },
    },
    makeDeleteHandler(apiClient) as Parameters<typeof server.registerTool>[2],
  );

  server.registerTool(
    "generate",
    {
      title: "Generate Diagram",
      description:
        "Generates an Excalidraw diagram from a text description and publishes it " +
        "as a static website on upubli.sh.",
      inputSchema: {
        context: z
          .string()
          .describe(
            "A description of what to visualize — system architecture, workflow, " +
            "process, sequence of steps, or any concept to represent as a diagram.",
          ),
        diagramType: z
          .enum(["flowchart", "sequence", "architecture"])
          .optional()
          .describe(
            "Optional hint for diagram type. If not specified, the server chooses.",
          ),
        slug: z
          .string()
          .optional()
          .describe(
            "Optional URL-safe slug for the published diagram site.",
          ),
      },
    },
    makeGenerateHandler(apiClient) as Parameters<typeof server.registerTool>[2],
  );

  return server;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Main entry point — reads refresh token from credentials file, creates server,
 * and starts stdio transport.
 */
async function main(): Promise<void> {
  const apiBaseUrl =
    process.env.UPUBLISH_API_URL ?? "https://api.upubli.sh";
  const refreshToken = await readCredentials(defaultCredentialsPath());

  const server = createServer({ apiBaseUrl, refreshToken });
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
