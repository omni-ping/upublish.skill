import { z } from "zod";
import {
  publish,
  appendUpgradeHint,
  renderFilenameWarning,
  renderReplaceLine,
  storageApprovalPriceLine,
  storageChargeLine,
  StorageApprovalError,
  log,
} from "../../lib/core.ts";
import type { CoreDeps } from "../../lib/core.ts";
import { formatBytes } from "../format.ts";
import { createProgressReporter } from "../progress.ts";
import type { ProgressExtra } from "../progress.ts";
import { errResponse, okResponse } from "../tool-response.ts";
import type { ToolResponse } from "../tool-response.ts";
import type { ToolContext } from "../context.ts";

type PublishArgs = {
  directory: string;
  slug: string;
  path_prefix?: string;
  title?: string;
  visibility?: "public" | "passcode";
  passcode?: string;
  namespace?: string;
  preview?: boolean;
  force?: boolean;
  analytics_enabled?: boolean;
  spa?: boolean;
  allow_no_index?: boolean;
  allow_project_files?: boolean;
  include_sourcemaps?: boolean;
};

type Reporter = ReturnType<typeof createProgressReporter>;
type PublishResult = Awaited<ReturnType<typeof publish>>;

/** Maps the tool's snake_case input onto `publish()`'s options. */
function toPublishOptions(args: PublishArgs, reporter: Reporter): Parameters<typeof publish>[0] {
  return {
    directory: args.directory,
    slug: args.slug,
    pathPrefix: args.path_prefix,
    title: args.title,
    visibility: args.visibility,
    passcode: args.passcode,
    namespace: args.namespace,
    preview: args.preview,
    force: args.force,
    analyticsEnabled: args.analytics_enabled,
    spa: args.spa,
    allowNoIndex: args.allow_no_index,
    allowProjectFiles: args.allow_project_files,
    includeSourcemaps: args.include_sourcemaps,
    onProgress: reporter.onProgress,
    onHashProgress: reporter.onHashProgress,
  };
}

/** The optional trailing lines shared by the live and preview success texts. */
function detailLines(result: PublishResult, visibility: PublishArgs["visibility"]): string {
  const visibilityLine = visibility && visibility !== "public" ? `\nVisibility: ${visibility}` : "";

  const excludedLine =
    result.excluded.length > 0
      ? `\nExcluded: ${result.excluded.length} file(s) (${result.excluded.join(", ")})`
      : "";

  const warningLine =
    result.warnings.length > 0
      ? `\nWarning: Included files that may not be site content: ${result.warnings.join(", ")}` +
        `\n  Add them to .upublishignore in the publish directory to exclude.`
      : "";

  let incrementalLine = "";
  if (result.forced && result.uploadedFiles !== undefined) {
    incrementalLine = `\nForce: verified ${result.uploadedFiles.length + (result.skippedFiles?.length ?? 0)} file(s), re-uploaded ${result.uploadedFiles.length}`;
  } else if (result.uploadedFiles !== undefined && result.skippedFiles !== undefined) {
    incrementalLine = `\nUploaded: ${result.uploadedFiles.length} file(s), skipped ${result.skippedFiles.length} unchanged file(s)`;
  }

  // Storage-pack block charge, rendered interval-aware from server-returned values only, never hardcoded.
  const ov = result.storage_overage;
  const storageOverageLine = ov?.charged === true ? `\n\n${storageChargeLine(ov)}` : "";

  return (
    visibilityLine +
    renderReplaceLine(result) +
    excludedLine +
    warningLine +
    // Advisory, non-blocking note for URL-fragile (#/?/control) and spaces/non-ASCII filenames.
    renderFilenameWarning(result.filenameWarnings) +
    incrementalLine +
    storageOverageLine
  );
}

function renderPublishSuccess(result: PublishResult, visibility: PublishArgs["visibility"]): ToolResponse {
  const site = result.site;
  const head =
    `Slug: ${site.slug}\n` + `Files: ${site.file_count}\n` + `Size: ${formatBytes(site.total_size)}`;
  const details = detailLines(result, visibility);

  if (result.preview_url) {
    log(`[publish] tool done slug=${site.slug} preview_url=${result.preview_url}`);
    return okResponse(
      `Preview published!\nPreview URL: ${result.preview_url}\n${head}${details}` +
        `\nUse the promote tool to make this preview live.`,
    );
  }
  log(`[publish] tool done slug=${site.slug} url=${result.url}`);
  return okResponse(`Site published successfully!\nURL: ${result.url}\n${head}${details}`);
}

function renderPublishError(err: unknown, slug: string): ToolResponse {
  log(`[publish] tool error slug=${slug} err=${(err as Error).message}`);
  // 402 needs_storage_approval: surface the approval URL and pack pricing.
  // Never send accept_overage — that flag is reserved for explicit human consent on a surface we control.
  // Agents must always forward the approval URL to the user and wait for them to authorize the charge manually.
  if (err instanceof StorageApprovalError) {
    // Interval-aware, total-first price copy from server values only (lib/billing-text.ts).
    const priceLine = storageApprovalPriceLine(err);
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
  // Free-tier TIER-LIMIT 403 (body has limit+usage, no `code`): append a one-line hint to run the `upgrade`
  // tool. hard_max / admin / auth 403s are excluded by the discriminator, so the hint never appears there.
  return errResponse(new Error(appendUpgradeHint((err as Error).message, err)));
}

/** Runs one publish. Own catch (not guarded()): it logs, renders StorageApprovalError, and always stops the heartbeat. */
async function handlePublish(
  args: PublishArgs,
  extra: ProgressExtra | undefined,
  coreDeps: CoreDeps,
  heartbeatIntervalMs: number,
): Promise<ToolResponse> {
  log(`[publish] tool entry slug=${args.slug} dir=${args.directory}`);
  // Progress is emitted only when the client supplied a progressToken (extra may be omitted, e.g. in tests).
  const reporter = createProgressReporter(extra, heartbeatIntervalMs);
  try {
    const result = await publish(toPublishOptions(args, reporter), coreDeps);
    return renderPublishSuccess(result, args.visibility);
  } catch (err) {
    return renderPublishError(err, args.slug);
  } finally {
    // Always stop the heartbeat timer — no leak on success, error, or throw.
    reporter.stop();
  }
}

/** The tool's registration metadata: title, description and the zod input schema. */
const PUBLISH_CONFIG = {
    title: "Publish Site",
    description:
      "Publishes a local directory as a static website to upubli.sh. " +
      "Hashes files locally, uploads only changed files via presigned R2 URLs, " +
      "automatically excluding .git, node_modules, .env, SSH/AWS keys, .npmrc and other credential files, " +
      "source maps (*.map), .DS_Store, and other non-site files. " +
      "Add a .upublishignore file to the directory for custom exclusions. " +
      "Publish the BUILD OUTPUT folder (the one with index.html), not a repo root: a folder with no top-level " +
      "index.html, or one that looks like a project (package.json, src/, lockfiles, Dockerfile, .git), is refused " +
      "before anything is uploaded (override with allow_no_index / allow_project_files). " +
      "A new site is live at its URL right after upload, with the visibility you set (public by default). " +
      "Publishing to an existing slug REPLACES the live version immediately; the output reports the replaced and new " +
      "version, and on paid plans the previous version can be restored with versions_restore (free plans cannot restore). " +
      "visibility:\"public\" never removes protection from an existing passcode-protected site; use the visibility tool " +
      "to change a site's access. For a single-page app pass spa:true on EVERY publish of it " +
      "(a republish without spa that also sets a non-public visibility, such as a passcode, clears SPA mode).",
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
      path_prefix: z
        .string()
        .optional()
        .describe(
          "Optional nested path prefix so the site publishes at " +
          "'{path_prefix}/{slug}' instead of the address root, e.g. " +
          "'2026/q3/code-report'. Multiple slash-separated segments are " +
          "allowed (lowercase letters, numbers, and hyphens per segment). " +
          "Omit for a normal top-level site. The server rejects a prefix " +
          "that collides with another site's address.",
        ),
      title: z
        .string()
        .optional()
        .describe(
          "Optional human-readable title for the site. Defaults to the slug " +
          "— or, for the '_root' slug (address root), the site's existing " +
          "title if it already has a meaningful one, else the address's name.",
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
          "Re-checks every stored file and re-uploads any that are missing or corrupt; healthy files are never re-uploaded. " +
          "Use this when a site is broken or out of sync.",
        ),
      spa: z
        .boolean()
        .optional()
        .describe(
          "Single-page app mode: unknown paths serve index.html. Pass true on EVERY publish of an SPA; " +
          "a republish without it that also sets a non-public visibility (such as a passcode) turns SPA mode off.",
        ),
      allow_no_index: z
        .boolean()
        .optional()
        .describe(
          "Publish even though the directory has no top-level index.html. Only for folders that are intentionally not a web page (e.g. downloads).",
        ),
      allow_project_files: z
        .boolean()
        .optional()
        .describe(
          "Publish even though the directory looks like a project root (two or more of package.json, tsconfig.json, lockfiles, Dockerfile, src/, .git/). Usually you want the build output folder instead.",
        ),
      include_sourcemaps: z
        .boolean()
        .optional()
        .describe("Include *.map source maps, which are excluded by default."),
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
};

export function registerPublish(ctx: ToolContext): void {
  ctx.local.registerTool(
    "publish",
    PUBLISH_CONFIG,
    async (args, extra) =>
      handlePublish(args as PublishArgs, extra, ctx.coreDeps, ctx.heartbeatIntervalMs),
  );
}
