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
import {
  list,
  publish,
  deleteOp,
} from "../lib/core.ts";
import type { CoreDeps, Site } from "../lib/core.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

export const PACKAGE_NAME = "@upublish/mcp-skills";
export const PACKAGE_VERSION = "0.1.0";

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
      },
    },
    async ({ directory, slug, title, visibility, passcode }) => {
      try {
        const result = await publish(
          {
            directory: directory as string,
            slug: slug as string,
            title: title as string | undefined,
            visibility: visibility as "public" | "unlisted" | "passcode" | undefined,
            passcode: passcode as string | undefined,
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
      inputSchema: {},
    },
    async (_args) => {
      try {
        const result = await list(coreDeps);
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
      },
    },
    async ({ slug }) => {
      try {
        const result = await deleteOp(slug as string, coreDeps);
        return okResponse(result.message);
      } catch (err) {
        return errResponse(err);
      }
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
