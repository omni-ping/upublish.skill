import { z } from "zod";
import { list, deleteOp, promote, qrCode, analytics, exportSite, formatExportResult } from "../../lib/core.ts";
import { siteNamespaceField, siteSlugField } from "../fields.ts";
import { formatSiteEntry } from "../format.ts";
import { errResponse, guarded, okResponse } from "../tool-response.ts";
import type { ToolContext } from "../context.ts";

export function registerList(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
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
    guarded(async ({ namespace }) => {
      const result = await list(namespace, coreDeps);
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
    }),
  );
}

export function registerDelete(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
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
        namespace: siteNamespaceField,
      },
    },
    guarded(async ({ slug, namespace }) => {
      const result = await deleteOp(slug, namespace, coreDeps);
      return okResponse(result.message);
    }),
  );
}

export function registerPromote(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
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
        namespace: siteNamespaceField,
      },
    },
    guarded(async ({ slug, namespace }) => {
      const result = await promote(
        slug,
        namespace,
        coreDeps,
      );
      return okResponse(
        `Preview promoted to live!\n` +
        `URL: ${result.url}`,
      );
    }),
  );
}

export function registerQrcode(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.local.registerTool(
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
        namespace: siteNamespaceField,
        outputDir: z
          .string()
          .optional()
          .describe(
            "Directory to write qr.svg and qr.png into. " +
            "Defaults to the current working directory.",
          ),
      },
    },
    guarded(async ({ slug, namespace, outputDir }) => {
      const result = await qrCode(
        {
          slug,
          namespace,
          outputDir,
        },
        coreDeps,
      );
      return okResponse(
        `QR code for: ${result.siteUrl}\n\n` +
        `${result.unicodeQr}\n` +
        `SVG: ${result.svgPath}\n` +
        `PNG: ${result.pngPath}`,
      );
    }),
  );
}

export function registerAnalytics(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
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
        slug: siteSlugField,
        enabled: z
          .boolean()
          .describe(
            "true to enable analytics (inject the script), false to disable it.",
          ),
        namespace: siteNamespaceField,
      },
    },
    guarded(async ({ slug, enabled, namespace }) => {
      const result = await analytics(
        slug,
        enabled,
        namespace,
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
    }),
  );
}

export function registerExport(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.local.registerTool(
    "export",
    {
      title: "Export Site",
      description:
        "Downloads a published site's original files from upubli.sh into a local directory and verifies each " +
        "file's size and MD5. Local only. The live version by default; a specific version needs a paid plan. " +
        "Refuses a non-empty directory unless `overwrite` is true, and refuses unsafe or colliding file paths " +
        "before writing anything. Partial failures are listed in the report.",
      inputSchema: {
        slug: z.string().describe("The URL-safe identifier of the site to export. Use the `list` tool to find slugs."),
        directory: z.string().describe("Directory to write the files into. Created if missing; must be empty unless `overwrite` is true."),
        version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Version number to export (see `versions_list`). Defaults to the live version; non-live versions need a paid plan."),
        namespace: siteNamespaceField,
        overwrite: z.boolean().optional().describe("Export into a non-empty directory, replacing files with the same path. Never follows or replaces symlinks."),
      },
    },
    guarded(async ({ slug, directory, version, namespace, overwrite }) => {
      const result = await exportSite(
        {
          slug,
          directory,
          version,
          namespace,
          overwrite: overwrite === true,
        },
        coreDeps,
      );
      const response = okResponse(formatExportResult(result));
      return result.failed.length > 0 ? { ...response, isError: true } : response;
    }),
  );
}
