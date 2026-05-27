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

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import type { ApiClient } from "./api-client.ts";
import type { FetchFn, Site, Visibility } from "./types.ts";
import { log } from "./log.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PublishOpts {
  /** Authenticated API client. */
  apiClient: ApiClient;
  /** Namespace ID to publish the site into. */
  nsId: string;
  /** Path to the directory containing files to publish. */
  directory: string;
  /** URL-safe identifier for the site. */
  slug: string;
  /** Optional human-readable title (defaults to slug). */
  title?: string;
  /** Site visibility mode. */
  visibility?: Visibility;
  /** Passcode for passcode-protected sites. */
  passcode?: string;
  /**
   * Label for the initial passcode. Defaults to "default" when
   * visibility is "passcode" and no label is provided.
   */
  passcodeLabel?: string;
  /**
   * When true, creates a staging version instead of going live immediately.
   * The API returns a preview_url where the staging version can be reviewed.
   */
  preview?: boolean;
  /**
   * When true, sends randomized hashes so the server treats every file as changed.
   * Bypasses the diff — all files are uploaded regardless of whether they exist.
   */
  force?: boolean;
  /**
   * Injectable fetch function for presigned R2 uploads.
   * Presigned URLs are self-authenticating — no Bearer token is needed.
   * Defaults to global fetch. Injected in tests to avoid real network calls.
   */
  fetchFn?: FetchFn;
}

export interface PublishResult {
  /** Public URL where the site is live. */
  url: string;
  /** Preview URL for staging versions. Present only when preview=true was requested. */
  preview_url?: string;
  /** Full site object returned by the API. */
  site: Site;
  /** Suspicious files that were included but may not be site content. */
  warnings: string[];
  /** Files/directories that were excluded by default rules or .upublishignore. */
  excluded: string[];
  /**
   * Files that were uploaded to R2 via presigned URL.
   */
  uploadedFiles?: string[];
  /**
   * Files that were copied server-side from the previous version.
   * These files were unchanged and did not need to be re-uploaded.
   */
  skippedFiles?: string[];
}

// ─── Incremental publish types ────────────────────────────────────────────────

/** Result of collecting files with MD5 hashes. */
export interface CollectWithHashesResult {
  /** Map of relative path → raw file bytes. */
  fileMap: Record<string, Uint8Array>;
  /**
   * Map of relative path → MD5 hex digest.
   * Matches R2 ETag for single-part uploads.
   */
  hashes: Record<string, string>;
  /** Files/directories excluded by default rules or .upublishignore. */
  excluded: string[];
  /** Suspicious files included that may not be site content. */
  warnings: string[];
}

/** Options for uploadChangedFiles(). */
export interface UploadChangedFilesOpts {
  /**
   * Files that need to be uploaded, with their presigned PUT URLs.
   * Returned by the manifest endpoint.
   */
  needed: Array<{ path: string; upload_url: string }>;
  /** Map of relative path → raw bytes, used to supply PUT body. */
  fileMap: Record<string, Uint8Array>;
  /**
   * Injectable fetch function. Defaults to global fetch.
   * Injected in tests to avoid real R2 calls.
   */
  fetchFn?: FetchFn;
}

interface PublishResponse {
  site: Site;
  url: string;
  preview_url?: string;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** Returns true if the slug matches the upubli.sh slug rules. */
export function isValidSlug(slug: string): boolean {
  if (slug.length < 3 || slug.length > 63) return false;
  return (
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) || /^[a-z0-9]{3}$/.test(slug)
  );
}

// ─── File Exclusion ──────────────────────────────────────────────────────────

const EXCLUDED_DIRS = new Set([".git", "node_modules", ".svn", ".hg"]);
const EXCLUDED_FILES = new Set([".DS_Store", "Thumbs.db", ".upublishignore"]);

function isDefaultExcluded(name: string, isDir: boolean): boolean {
  if (isDir) return EXCLUDED_DIRS.has(name);
  if (EXCLUDED_FILES.has(name)) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (name.endsWith(".pem") || name.endsWith(".key")) return true;
  return false;
}

const SUSPICIOUS_NAMES = new Set([
  "nginx.conf",
  "apache.conf",
  ".htaccess",
  "Makefile",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "package.json",
  "package-lock.json",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
]);

function isSuspicious(name: string): boolean {
  if (SUSPICIOUS_NAMES.has(name)) return true;
  if (name.endsWith(".sh")) return true;
  return false;
}

// ─── .upublishignore ─────────────────────────────────────────────────────────

export function parseIgnoreFile(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function matchesIgnore(
  relPath: string,
  name: string,
  patterns: string[],
): boolean {
  for (const p of patterns) {
    if (p === name) return true;
    if (p.endsWith("/") && name === p.slice(0, -1)) return true;
    if (p.startsWith("*.") && name.endsWith(p.slice(1))) return true;
  }
  return false;
}

// ─── File Collection ──────────────────────────────────────────────────────────

interface CollectState {
  fileMap: Record<string, Uint8Array>;
  /** MD5 hex digests per file. */
  hashes: Record<string, string>;
  excluded: string[];
  warnings: string[];
}

/** Recursively collects files, applying exclusion rules and flagging suspicious files. */
function collectFiles(
  rootDir: string,
  currentDir: string,
  state: CollectState,
  ignorePatterns: string[],
): void {
  const entries = readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    const relPath = relative(rootDir, fullPath);

    if (isDefaultExcluded(entry.name, entry.isDirectory())) {
      state.excluded.push(entry.isDirectory() ? `${relPath}/` : relPath);
      continue;
    }

    if (matchesIgnore(relPath, entry.name, ignorePatterns)) {
      state.excluded.push(entry.isDirectory() ? `${relPath}/` : relPath);
      continue;
    }

    if (entry.isDirectory()) {
      collectFiles(rootDir, fullPath, state, ignorePatterns);
    } else if (entry.isFile()) {
      if (isSuspicious(entry.name)) {
        state.warnings.push(relPath);
      }
      const data = readFileSync(fullPath);
      const bytes = new Uint8Array(data);
      state.fileMap[relPath] = bytes;
      // MD5 matches R2 ETag for single-part uploads
      state.hashes[relPath] = createHash("md5").update(bytes).digest("hex");
    }
  }
}

/**
 * Recursively collects files from a directory, applying exclusion rules,
 * and computes an MD5 hash for each file.
 *
 * The MD5 hash matches the R2 ETag for single-part uploads, enabling the
 * publish flow to diff client files against the server manifest.
 *
 * @param dirPath - Root directory to walk.
 * @returns fileMap (path → bytes), hashes (path → MD5 hex), excluded, warnings.
 */
export function collectFilesWithHashes(dirPath: string): CollectWithHashesResult {
  let ignorePatterns: string[] = [];
  const ignoreFile = join(dirPath, ".upublishignore");
  try {
    if (existsSync(ignoreFile)) {
      ignorePatterns = parseIgnoreFile(readFileSync(ignoreFile, "utf-8"));
    }
  } catch {
    // No readable .upublishignore — use defaults only
  }

  const state: CollectState = {
    fileMap: {},
    hashes: {},
    excluded: [],
    warnings: [],
  };
  collectFiles(dirPath, dirPath, state, ignorePatterns);

  return {
    fileMap: state.fileMap,
    hashes: state.hashes,
    excluded: state.excluded,
    warnings: state.warnings,
  };
}

// Number of files to upload concurrently in the publish flow.
const UPLOAD_CONCURRENCY = 5;
// Maximum retry attempts per file upload before failing.
const UPLOAD_MAX_RETRIES = 3;

/**
 * Uploads files to presigned R2 PUT URLs in parallel batches with retry.
 *
 * Files are uploaded in batches of UPLOAD_CONCURRENCY. Each individual file
 * upload is retried up to UPLOAD_MAX_RETRIES times on non-2xx response before
 * throwing. This is safe to retry because presigned PUT is idempotent.
 *
 * @param opts.needed     - Files to upload with their presigned PUT URLs.
 * @param opts.fileMap    - Map of path → bytes, supplies PUT body.
 * @param opts.fetchFn    - Injectable fetch function (defaults to global fetch).
 * @throws Error with the file path if a file fails after all retry attempts.
 */
export async function uploadChangedFiles(
  opts: UploadChangedFilesOpts,
): Promise<void> {
  const { needed, fileMap, fetchFn = fetch } = opts;

  if (needed.length === 0) {
    return;
  }

  const totalBatches = Math.ceil(needed.length / UPLOAD_CONCURRENCY);

  // Upload files in concurrent batches
  for (
    let batchStart = 0;
    batchStart < needed.length;
    batchStart += UPLOAD_CONCURRENCY
  ) {
    const batchNum = Math.floor(batchStart / UPLOAD_CONCURRENCY) + 1;
    const batch = needed.slice(batchStart, batchStart + UPLOAD_CONCURRENCY);
    log(`[upload] batch=${batchNum}/${totalBatches} files=${batch.map((f) => f.path).join(",")}`);
    await Promise.all(
      batch.map((item) => uploadOneFile(item, fileMap, fetchFn)),
    );
  }
}

/**
 * Uploads a single file to its presigned URL, retrying on failure.
 *
 * @throws Error with the file path after UPLOAD_MAX_RETRIES failed attempts.
 */
async function uploadOneFile(
  item: { path: string; upload_url: string },
  fileMap: Record<string, Uint8Array>,
  fetchFn: FetchFn,
): Promise<void> {
  const bytes = fileMap[item.path];

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    const response = await fetchFn(item.upload_url, {
      method: "PUT",
      // Cast required: tsc's Uint8Array<ArrayBufferLike> doesn't satisfy
      // BodyInit's ArrayBufferView<ArrayBuffer> — works at runtime in Bun/browsers
      body: bytes as unknown as BodyInit,
    });

    if (response.ok) {
      log(`[upload] file=${item.path} attempt=${attempt} status=${response.status} ok`);
      return;
    }

    let responseBody = "";
    try {
      responseBody = await response.text();
    } catch {
      // ignore — body read is best-effort for logging
    }
    log(`[upload] file=${item.path} attempt=${attempt} status=${response.status} body=${responseBody}`);

    // On the last attempt, throw so the caller knows this file failed
    if (attempt === UPLOAD_MAX_RETRIES) {
      throw new Error(
        `Failed to upload '${item.path}' after ${UPLOAD_MAX_RETRIES} attempts (HTTP ${response.status})`,
      );
    }
    // Otherwise retry — presigned PUT is idempotent
  }
}

// ─── Publish ─────────────────────────────────────────────────────────────────

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
  const {
    apiClient,
    nsId,
    directory,
    slug,
    title,
    visibility,
    passcode,
    passcodeLabel,
    preview,
    force,
    fetchFn = fetch,
  } = opts;

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
      "Invalid slug. Must be 3-63 characters: lowercase letters, " +
        "numbers, and hyphens, starting and ending with a letter or number.",
    );
  }

  if (visibility === "passcode" && !passcode) {
    throw new Error("passcode is required when visibility is 'passcode'");
  }

  // Collect files and compute MD5 hashes
  const collected = collectFilesWithHashes(directory);

  if (Object.keys(collected.fileMap).length === 0) {
    throw new Error("Directory is empty — no files to publish");
  }

  // Build file manifest to send to server.
  // When force=true, use random hashes so the server treats every file as changed.
  const files = Object.entries(collected.hashes).map(([path, hash]) => ({
    path,
    hash: force ? crypto.randomUUID() : hash,
    size: collected.fileMap[path].byteLength,
  }));

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  log(`[publish] slug=${slug} files=${files.length} totalBytes=${totalBytes}${force ? " FORCE" : ""}`);

  // Send manifest — server diffs against previous version and returns presigned URLs.
  // Errors propagate directly to the caller (no fallback path).
  const manifestResult = await apiClient.manifest(nsId, slug, {
    files,
    title: title ?? slug,
    visibility,
    passcode: visibility === "passcode" ? passcode : undefined,
    passcode_label:
      visibility === "passcode" ? (passcodeLabel ?? "default") : undefined,
    preview,
  });

  log(`[manifest] version=${manifestResult.version} session_id=${manifestResult.session_id} base_version=${manifestResult.base_version} needed=${manifestResult.needed.length} total=${files.length}`);

  // Upload only the files the server says it needs.
  // Presigned URLs are self-authenticating — no Bearer token required.
  await uploadChangedFiles({
    needed: manifestResult.needed,
    fileMap: collected.fileMap,
    fetchFn,
  });

  // Determine which files were uploaded vs skipped (server-side copied)
  const neededPaths = new Set(manifestResult.needed.map((f) => f.path));
  const uploadedFiles = manifestResult.needed.map((f) => f.path);
  const skippedFiles = files
    .map((f) => f.path)
    .filter((p) => !neededPaths.has(p));

  // Finalize: server verifies uploads, creates DB records, goes live
  const finalizeResult = await apiClient.finalize(nsId, slug, manifestResult.session_id);

  log(`[finalize] slug=${slug} uploaded=${uploadedFiles.length} skipped=${skippedFiles.length} url=${finalizeResult.url}`);

  return {
    url: finalizeResult.url,
    preview_url: finalizeResult.preview_url,
    site: finalizeResult.site,
    warnings: collected.warnings,
    excluded: collected.excluded,
    uploadedFiles,
    skippedFiles,
  };
}
