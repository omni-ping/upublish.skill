import { z } from "zod";
import { listSiteVersions, deleteSiteVersion, restoreSiteVersion, setSiteVersionsLimit } from "../../lib/core.ts";
import type { SetVersionsLimitResult } from "../../lib/core.ts";
import { siteNamespaceField, siteSlugField } from "../fields.ts";
import { formatBytes, formatUsage, formatVersionEntry } from "../format.ts";
import { guarded, okResponse } from "../tool-response.ts";
import type { ToolContext } from "../context.ts";

export function registerVersionsList(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
    "versions_list",
    {
      title: "List Site Versions",
      description:
        "Lists all deploy versions of a published site on upubli.sh. " +
        "Shows each version's number, status, and which one is currently live. " +
        "Use `versions_delete` to remove an archived version and reclaim storage.",
      inputSchema: {
        slug: siteSlugField,
        namespace: siteNamespaceField,
      },
    },
    guarded(async ({ slug, namespace }) => {
      const result = await listSiteVersions(
        slug,
        namespace,
        coreDeps,
      );

      if (result.versions.length === 0) {
        return okResponse(`No versions found for site '${slug}'.`);
      }

      const header = `Versions for '${slug}'`;
      const lines = result.versions.map((version) => formatVersionEntry(version));
      return okResponse(`${header}\n\n${lines.join("\n")}`);
    }),
  );
}

export function registerVersionsDelete(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
    "versions_delete",
    {
      title: "Delete Site Version",
      description:
        "Deletes a single archived version of a published site on upubli.sh to " +
        "reclaim storage. The currently live version cannot be deleted. " +
        "Returns the space reclaimed and your updated storage usage.",
      inputSchema: {
        slug: siteSlugField,
        versionNumber: z
          .number()
          .int()
          .positive()
          .describe(
            "The version number to delete (a positive integer). " +
            "Use `versions_list` to see available version numbers.",
          ),
        namespace: siteNamespaceField,
      },
    },
    guarded(async ({ slug, versionNumber, namespace }) => {
      const result = await deleteSiteVersion(
        slug,
        versionNumber,
        namespace,
        coreDeps,
      );
      return okResponse(
        `Deleted version v${result.version_number} of '${slug}'.\n` +
        `Reclaimed: ${formatBytes(result.freed_bytes)}\n` +
        `Usage: ${formatUsage(result.usage)}`,
      );
    }),
  );
}

export function registerVersionsRestore(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
    "versions_restore",
    {
      title: "Restore Site Version",
      description:
        "Rolls a published site on upubli.sh back to a previous version, making " +
        "that version live again. Use `versions_list` first to see version numbers " +
        "and their dates/sizes. Returns the now-live version number and live URL. " +
        "Restoring versions requires a paid plan.",
      inputSchema: {
        slug: siteSlugField,
        version: z
          .number()
          .int()
          .positive()
          .describe(
            "The version number to restore (a positive integer). " +
            "Use `versions_list` to see available version numbers.",
          ),
        namespace: siteNamespaceField,
      },
    },
    guarded(async ({ slug, version, namespace }) => {
      const result = await restoreSiteVersion(
        slug,
        version,
        namespace,
        coreDeps,
      );
      return okResponse(
        `Restored '${slug}' to version v${result.version_number}, now live.\n` +
        `URL: ${result.url}`,
      );
    }),
  );
}

export function registerVersionsLimit(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
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
        slug: siteSlugField,
        limit: z
          .union([z.number().int().min(1), z.null()])
          .optional()
          .describe(
            "Maximum number of non-staging versions to retain (integer ≥ 1). " +
            "Omit or pass null to clear the limit (unlimited retention). " +
            "The live version is always preserved regardless of the limit.",
          ),
        namespace: siteNamespaceField,
      },
    },
    guarded(async ({ slug, limit, namespace }) => {
      const result: SetVersionsLimitResult = await setSiteVersionsLimit(
        slug,
        limit ?? null,
        namespace,
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
    }),
  );
}
