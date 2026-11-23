/**
 * Core publish logic — collects files from a local directory, diffs against
 * the server manifest, uploads only changed files via presigned R2 URLs, then
 * finalizes. Returns structured data ({ url, site, warnings, excluded,
 * uploadedFiles, skippedFiles }) — formatting is the adapter's job.
 *
 * Throws on validation failures and API errors. Manifest errors propagate
 * directly — there is no fallback path.
 *
 * Also exports utilities:
 *   collectFilesWithHashes()  — directory walk with MD5 per file
 *   uploadChangedFiles()      — PUT files to presigned URLs with retry
 */


import { statSync } from "fs";
import type { ApiClient } from "./api-client.ts";
import type { NamespaceRole } from "./types.ts";
import type { PublishOpts, PublishResult } from "./publish-types.ts";
import { log } from "./log.ts";
import { enrichPublishError } from "./publish-errors.ts";
import { classifyFilenames, isValidSlug, listFiles, preflightCheck } from "./publish-files.ts";
import { hashFiles } from "./publish-hash.ts";
import { uploadChangedFiles } from "./publish-upload.ts";

// Re-exports keep every name this module exported before the split.
export { StorageApprovalError, enrichPublishError } from "./publish-errors.ts";
export {
  classifyFilenames,
  isValidSlug,
  listFiles,
  parseIgnoreFile,
  preflightCheck,
  renderFilenameWarning,
} from "./publish-files.ts";
export type { FileEntry, FilenameWarnings, ListFilesResult } from "./publish-files.ts";
export { collectFilesWithHashes, hashFiles } from "./publish-hash.ts";
export type { CollectedFile, CollectWithHashesResult, HashProgress } from "./publish-hash.ts";
export { uploadChangedFiles } from "./publish-upload.ts";
export type { UploadChangedFilesOpts, UploadProgress } from "./publish-upload.ts";

export type { PublishOpts, PublishResult } from "./publish-types.ts";

// ─── Publish ─────────────────────────────────────────────────────────────────

/**
 * Resolves the title to send on the manifest request when the caller
 * supplied none. Mirrors the backend's `resolveSiteTitle` rule (Phase 1) so
 * a skill publish composes correctly with it regardless of whether that
 * backend fix has deployed: explicit title always wins upstream, so this
 * function must decide the *right* title itself rather than defer.
 *
 * - Any slug other than `_root` → the slug itself, unchanged (mirrors the
 *   pre-fix behavior for the general case — non-`_root` publishes never
 *   leak into the `_root` branch).
 * - `_root` with a meaningful `existingTitle` (non-blank after trimming, and
 *   not the literal sentinel `"_root"`) → that title, preserved byte-for-byte
 *   (the original, un-trimmed string — trimming is only used to decide
 *   whether it's meaningful). This is what stops a user's hand-set `_root`
 *   title from being reset to the namespace name on every re-publish: since
 *   an explicit title always wins on the backend, sending it back verbatim
 *   here reproduces the backend's own preservation behavior even against a
 *   backend that hasn't deployed it.
 * - `_root` with no usable `existingTitle` (`undefined`, `null`, blank, or
 *   exactly `"_root"` after trimming) → `namespaceName`, so a home-page
 *   publish carries a real name instead of the raw sentinel `"_root"` —
 *   independent of whether the backend has deployed its own fix (an absent
 *   title there still resolves through `?? slug`, which would otherwise
 *   store `"_root"` literally).
 * - `_root` with `namespaceName` also unavailable → falls back to `slug` (the
 *   pre-fix behavior). Documented, not silent: this branch is reachable only
 *   by a caller that invokes `publish()` directly without going through
 *   `lib/core.ts`'s namespace resolution — see {@link PublishOpts.namespaceName}.
 */
function resolveDefaultTitle(
  slug: string,
  namespaceName?: string,
  existingTitle?: string | null,
): string {
  if (slug !== "_root") return slug;
  if (existingTitle != null) {
    const trimmed = existingTitle.trim();
    if (trimmed !== "" && trimmed !== "_root") return existingTitle;
  }
  return namespaceName ?? slug;
}

/** Upper bound on the post-finalize plan-tier read; a hung call must not delay a finished publish. */
const PLAN_TIER_TIMEOUT_MS = 3000;

/**
 * Reads the caller's plan for the undo note. Only a live republish by the
 * namespace owner needs it; a member's `/api/space` is their own space, not the
 * owner's. Never throws: any failure or unrecognized tier yields null so the
 * publish (already finalized) is unaffected and the neutral wording is used.
 */
export async function readPlanTier(
  apiClient: ApiClient,
  { replacesLive, namespaceRole }: { replacesLive: boolean; namespaceRole?: NamespaceRole },
  timeoutMs = PLAN_TIER_TIMEOUT_MS,
): Promise<"free" | "paid" | null> {
  if (!replacesLive || (namespaceRole !== undefined && namespaceRole !== "owner")) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = apiClient.get<{ space?: { tier?: unknown } }>("/api/space");
    read.catch(() => {}); // a rejection after the timeout must not surface as unhandled
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    const res = await Promise.race([read, timeout]);
    const tier = res?.space?.tier;
    if (tier === "free") return "free";
    return tier === "pro" || tier === "max" ? "paid" : null;
  } catch (err) {
    log(`[publish] plan tier read failed: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Renders the overwrite-awareness line (leading newline) for the publish output.
 * Preview: live is untouched. First publish (null base): nothing. Otherwise the
 * replaced/new versions plus undo guidance matching the plan: paid names the
 * restore call, free says it can't be restored, unknown stays neutral.
 */
export function renderReplaceLine(
  r: Pick<PublishResult, "preview_url" | "replacedVersion" | "version" | "planTier" | "site">,
): string {
  if (r.preview_url) return "\nLive site unchanged (preview)";
  const base = r.replacedVersion;
  if (base === null || base === undefined) return "";
  const head = `\nReplaced live version v${base} → v${r.version}`;
  if (r.planTier === "paid") return `${head}. Undo: versions_restore(${r.site.slug}, ${base})`;
  if (r.planTier === "free") return `${head} (free plan: the previous version can't be restored)`;
  return `${head} (restoring needs a paid plan)`;
}

/** Throws on a bad directory, slug or passcode combination. Runs before any file is read or request sent. */
function validatePublishInput({ directory, slug, visibility, passcode }: Pick<PublishOpts, "directory" | "slug" | "visibility" | "passcode">): void {
  // Validate directory exists and is a directory
  try {
    const stat = statSync(directory);
    if (!stat.isDirectory()) {
      throw new Error(`'${directory}' is not a directory`);
    }
  } catch (err) {
    if ((err as Error).message.includes("not a directory")) {
      throw err;
    }
    throw new Error(`Directory '${directory}' does not exist`);
  }

  // _root is a reserved system slug that bypasses normal format validation —
  // it publishes at the namespace/domain root (e.g. vibeandscribe.xyz/).
  if (slug !== "_root" && !isValidSlug(slug)) {
    throw new Error(
      "Invalid slug. Must be 1-255 characters: lowercase letters, " +
        "numbers, and hyphens, starting and ending with a letter or number.",
    );
  }

  if (visibility === "passcode" && !passcode) {
    throw new Error("passcode is required when visibility is 'passcode'");
  }
}

/** Enumerates, guards and hashes the directory; the manifest entries are always real MD5s (the server rejects anything else). */
async function buildManifest(opts: Pick<PublishOpts, "directory" | "includeSourcemaps" | "allowNoIndex" | "allowProjectFiles" | "onHashProgress">) {
  // Enumerate files (stat-only), then hash them on the async, event-loop-yielding
  // path so progress can fire from the first file during the multi-minute hash.
  const { files: fileList, excluded, warnings } = listFiles(opts.directory, { includeSourcemaps: opts.includeSourcemaps });

  if (fileList.length === 0) {
    throw new Error("Directory is empty — no files to publish");
  }

  // Wrong-folder / project-root guard: runs before any byte is hashed or sent.
  preflightCheck(fileList, excluded, { allowNoIndex: opts.allowNoIndex, allowProjectFiles: opts.allowProjectFiles });

  const collectedFiles = await hashFiles(fileList, { onHashProgress: opts.onHashProgress });
  const files = Object.entries(collectedFiles).map(([path, file]) => ({
    path,
    hash: file.hash,
    size: file.size,
  }));
  return { collectedFiles, files, excluded, warnings };
}

/**
 * Sends the manifest — the server diffs against the previous version and returns presigned URLs.
 * A 402 needs_storage_approval is enriched into a StorageApprovalError so the
 * adapter can surface the approval URL and pack price without re-parsing the body.
 * force=true is sent as an explicit manifest flag: the server re-checks every stored blob and presigns
 * only the missing/corrupt ones.
 */
async function sendManifest(opts: PublishOpts, files: Array<{ path: string; hash: string; size: number }>) {
  const { apiClient, nsId, slug, pathPrefix, title, namespaceName, existingTitle, visibility, passcode, passcodeLabel, preview, force, analyticsEnabled, spa } = opts;
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  log(`[publish] slug=${slug} files=${files.length} totalBytes=${totalBytes}${force ? " FORCE" : ""}`);

  let manifestResult: Awaited<ReturnType<typeof apiClient.manifest>>;
  try {
    manifestResult = await apiClient.manifest(nsId, slug, {
      files,
      title: title ?? resolveDefaultTitle(slug, namespaceName, existingTitle),
      visibility,
      passcode: visibility === "passcode" ? passcode : undefined,
      passcode_label:
        visibility === "passcode" ? (passcodeLabel ?? "default") : undefined,
      preview,
      // Only sent when true; an older server ignores it and diffs normally.
      force: force === true ? true : undefined,
      analytics_enabled: analyticsEnabled,
      // Omitted (undefined) unless set, so the body is unchanged for non-SPA publishes.
      spa,
      // Omitted (undefined) when the caller doesn't pass pathPrefix — JSON.stringify
      // drops undefined properties, so the request body stays byte-identical to a
      // pre-nested-path-publishing publish. See PublishOpts.pathPrefix's doc comment.
      path_prefix: pathPrefix,
    });
  } catch (err) {
    throw enrichPublishError(err as Error);
  }

  log(`[manifest] version=${manifestResult.version} session_id=${manifestResult.session_id} base_version=${manifestResult.base_version} needed=${manifestResult.needed.length} total=${files.length}`);
  return manifestResult;
}

/** Finalizes the session, then assembles the result (plan tier, overage, advisory filename warnings). */
async function finalizeAndReport(
  opts: PublishOpts,
  manifestResult: Awaited<ReturnType<ApiClient["manifest"]>>,
  files: Array<{ path: string }>,
  scan: { excluded: PublishResult["excluded"]; warnings: PublishResult["warnings"] },
): Promise<PublishResult> {
  const { apiClient, nsId, slug, preview, force, namespaceRole } = opts;

  // Determine which files were uploaded vs skipped (server-side copied)
  const neededPaths = new Set(manifestResult.needed.map((f) => f.path));
  const uploadedFiles = manifestResult.needed.map((f) => f.path);
  const skippedFiles = files
    .map((f) => f.path)
    .filter((p) => !neededPaths.has(p));

  // Finalize: server verifies uploads, creates DB records, goes live
  // Finalize is where a past-due account is refused, so it gets the same enrichment as the manifest call.
  const finalizeResult = await apiClient.finalize(nsId, slug, manifestResult.session_id).catch((err: unknown) => {
    throw enrichPublishError(err as Error);
  });

  log(`[finalize] slug=${slug} uploaded=${uploadedFiles.length} skipped=${skippedFiles.length} url=${finalizeResult.url}`);

  const result: PublishResult = {
    url: finalizeResult.url,
    preview_url: finalizeResult.preview_url,
    site: finalizeResult.site,
    version: manifestResult.version,
    replacedVersion: manifestResult.base_version ?? null,
    planTier: await readPlanTier(apiClient, {
      replacesLive: manifestResult.base_version != null && !preview,
      namespaceRole,
    }),
    warnings: scan.warnings,
    excluded: scan.excluded,
    uploadedFiles,
    skippedFiles,
    ...(force === true ? { forced: true } : {}),
  };

  // Thread storage_overage from the manifest response when present and charged.
  if (manifestResult.storage_overage?.charged === true) {
    result.storage_overage = manifestResult.storage_overage;
  }

  // Advisory, non-blocking filename scan over the exact paths we sent to the
  // server. Warn-and-continue: this never blocks the publish (it runs only after
  // a successful finalize) and never renames a file or alters the manifest.
  // Attached only when something qualifies, so a clean tree omits the field.
  const filenameWarnings = classifyFilenames(files.map((f) => f.path));
  if (filenameWarnings.fragile.length > 0 || filenameWarnings.fyi.length > 0 || filenameWarnings.reserved || filenameWarnings.reservedApi) {
    result.filenameWarnings = filenameWarnings;
  }

  return result;
}

/**
 * Publishes a directory via presigned-URL flow: hash files, diff against server
 * manifest, upload only changed files via presigned R2 URLs, then finalize.
 *
 * @param opts - Publish options including apiClient, directory, slug, etc.
 * @returns PublishResult with uploadedFiles and skippedFiles populated.
 * @throws Error on validation failure (bad directory, invalid slug, empty dir).
 * @throws Error if manifest call fails (propagated, no fallback).
 * @throws Error if presigned uploads fail after retries.
 * @throws Error if finalize fails (e.g., missing files).
 */
export async function publish(opts: PublishOpts): Promise<PublishResult> {
  validatePublishInput(opts);
  const { collectedFiles, files, excluded, warnings } = await buildManifest(opts);
  const manifestResult = await sendManifest(opts, files);

  // Upload only the files the server says it needs.
  // Presigned URLs are self-authenticating — no Bearer token required.
  await uploadChangedFiles({
    needed: manifestResult.needed,
    files: collectedFiles,
    fetchFn: opts.fetchFn ?? fetch,
    onProgress: opts.onProgress,
  });

  return finalizeAndReport(opts, manifestResult, files, { excluded, warnings });
}
