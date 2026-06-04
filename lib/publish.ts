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
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "fs";
import { join, relative } from "path";
import type { ApiClient } from "./api-client.ts";
import type { FetchFn, Site, Visibility } from "./types.ts";
import { log } from "./log.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Upload progress snapshot reported during the upload phase.
 *
 * `completed`/`total` count files, and `completedBytes`/`totalBytes` count the
 * raw bytes of those files — both scoped to the manifest's `needed` set (the
 * files that actually require uploading), NOT the site's full file count or
 * size. Byte counts are the better denominator for a progress bar when file
 * sizes vary widely (one large asset dwarfs many small ones); file counts read
 * better as text. Both `completed` and `completedBytes` are cumulative and
 * monotonically increasing, reaching their totals on the final report.
 */
export interface UploadProgress {
  /** Files uploaded so far (cumulative). Starts at 0, ends at `total`. */
  completed: number;
  /** Total files that need uploading (manifest `needed` count). */
  total: number;
  /** Bytes uploaded so far (cumulative). Starts at 0, ends at `totalBytes`. */
  completedBytes: number;
  /** Total bytes that need uploading (sum of `needed`-file sizes). */
  totalBytes: number;
}

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
  /**
   * Optional synchronous progress callback fired during the upload phase.
   * Must be synchronous and non-throwing — lib/ stays platform-agnostic and
   * does not depend on async notification machinery. The MCP adapter wraps an
   * async sendNotification behind this sync callback. Omitting it is a no-op.
   */
  onProgress?: (progress: UploadProgress) => void;
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

/**
 * One collected file: its MD5 digest, byte size, and absolute path on disk.
 *
 * `fullPath` lets the uploader read/stream the body without knowing the
 * directory root — the collection layer owns all path-join knowledge, so the
 * upload layer stays a deep module behind this seam.
 */
export interface CollectedFile {
  /**
   * MD5 hex digest of the file's bytes.
   * Matches the R2 ETag for single-part uploads (enables manifest diffing).
   */
  hash: string;
  /** Byte size of the file, counted while hashing (no separate stat). */
  size: number;
  /** Absolute path to the file on disk. */
  fullPath: string;
}

/** Result of collecting files with MD5 hashes. */
export interface CollectWithHashesResult {
  /** Map of relative path → collected file metadata (hash, size, fullPath). */
  files: Record<string, CollectedFile>;
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
  /**
   * Map of relative path → { size, fullPath }. `size` feeds byte-accurate
   * progress; `fullPath` supplies the PUT body (read from disk).
   */
  files: Record<string, { size: number; fullPath: string }>;
  /**
   * Injectable fetch function. Defaults to global fetch.
   * Injected in tests to avoid real R2 calls.
   */
  fetchFn?: FetchFn;
  /**
   * Optional synchronous progress callback. Fired once with everything at zero
   * before any upload starts, then once after EACH file finishes uploading with
   * the cumulative file and byte counts (the final call equals the totals).
   * Files within a batch upload concurrently, so a file's report fires in
   * completion order, not `needed` order — but the cumulative counts stay
   * monotonic regardless. When `needed` is empty, the early-return path is taken
   * and NO progress fires (not even the initial zero report).
   */
  onProgress?: (progress: UploadProgress) => void;
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
  /** Map of relative path → collected file metadata (hash, size, fullPath). */
  files: Record<string, CollectedFile>;
  excluded: string[];
  warnings: string[];
}

/**
 * Chunk size for streamed file hashing. Bounds collection memory: a file is
 * never read whole into memory — it is hashed through a single reused buffer of
 * this size, regardless of file size.
 */
const HASH_CHUNK_BYTES = 64 * 1024;

/**
 * Computes a file's MD5 digest by streaming it through a fixed-size buffer with
 * chunked synchronous reads. Memory stays bounded by HASH_CHUNK_BYTES even for
 * gigabyte files. The byte count is accumulated during the read, so `size`
 * reflects exactly the bytes hashed (no separate stat / TOCTOU race).
 *
 * The file descriptor is closed in a `finally` so a read error mid-walk never
 * leaks an fd.
 *
 * @param fullPath - Absolute path to the file to hash.
 * @returns The MD5 hex digest and the number of bytes read.
 */
function hashFileChunked(fullPath: string): { hash: string; size: number } {
  const fd = openSync(fullPath, "r");
  try {
    const md5 = createHash("md5");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let size = 0;
    let bytesRead: number;
    // readSync(..., null) advances the fd offset; returns 0 at EOF (and for an
    // empty file on the first call → size 0, canonical empty-file MD5).
    while ((bytesRead = readSync(fd, buffer, 0, HASH_CHUNK_BYTES, null)) > 0) {
      md5.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    return { hash: md5.digest("hex"), size };
  } finally {
    closeSync(fd);
  }
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
      // Stream-hash the file (bounded memory); MD5 matches the R2 ETag for
      // single-part uploads. `size` is the bytes actually hashed.
      const { hash, size } = hashFileChunked(fullPath);
      state.files[relPath] = { hash, size, fullPath };
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
 * @returns files (path → { hash, size, fullPath }), excluded, warnings.
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
    files: {},
    excluded: [],
    warnings: [],
  };
  collectFiles(dirPath, dirPath, state, ignorePatterns);

  return {
    files: state.files,
    excluded: state.excluded,
    warnings: state.warnings,
  };
}

// Number of files to upload concurrently in the publish flow.
const UPLOAD_CONCURRENCY = 5;
// Maximum retry attempts per file upload before failing.
const UPLOAD_MAX_RETRIES = 3;
/**
 * Upload window duration in hours — must match the backend UPLOAD_WINDOW_SECONDS
 * constant in packages/server/src/api/manifest-diff.ts (6 h).
 * Used in the expired-URL error message so users know how to recover.
 */
const UPLOAD_WINDOW_HOURS = 6;

/**
 * Uploads files to presigned R2 PUT URLs in parallel batches with retry.
 *
 * Files are uploaded in batches of UPLOAD_CONCURRENCY. Each individual file
 * upload is retried up to UPLOAD_MAX_RETRIES times on non-2xx response before
 * throwing. This is safe to retry because presigned PUT is idempotent.
 *
 * @param opts.needed     - Files to upload with their presigned PUT URLs.
 * @param opts.files      - Map of path → { size, fullPath }; fullPath supplies the PUT body.
 * @param opts.fetchFn    - Injectable fetch function (defaults to global fetch).
 * @throws Error with the file path if a file fails after all retry attempts.
 */
export async function uploadChangedFiles(
  opts: UploadChangedFilesOpts,
): Promise<void> {
  const { needed, files, fetchFn = fetch, onProgress } = opts;

  // Empty upload: early-return BEFORE any progress fires — no onProgress call
  // is made for a no-op upload (not even the initial zero report).
  if (needed.length === 0) {
    return;
  }

  const total = needed.length;
  const totalBatches = Math.ceil(total / UPLOAD_CONCURRENCY);
  const sizeOf = (path: string) => files[path]?.size ?? 0;
  const totalBytes = needed.reduce((sum, item) => sum + sizeOf(item.path), 0);

  // Cumulative counters advanced as each file lands. Mutated from within the
  // concurrent batch below; safe because JS is single-threaded — the increment
  // and the onProgress call run to completion before any other file's do.
  let completed = 0;
  let completedBytes = 0;

  // Report progress: nothing uploaded yet.
  onProgress?.({ completed: 0, total, completedBytes: 0, totalBytes });

  // Upload files in concurrent batches, reporting after each file resolves so
  // the bar advances per-file rather than per-batch.
  for (
    let batchStart = 0;
    batchStart < total;
    batchStart += UPLOAD_CONCURRENCY
  ) {
    const batchNum = Math.floor(batchStart / UPLOAD_CONCURRENCY) + 1;
    const batch = needed.slice(batchStart, batchStart + UPLOAD_CONCURRENCY);
    log(`[upload] batch=${batchNum}/${totalBatches} files=${batch.map((f) => f.path).join(",")}`);
    await Promise.all(
      batch.map(async (item) => {
        await uploadOneFile(item, files, fetchFn);
        completed += 1;
        completedBytes += sizeOf(item.path);
        onProgress?.({ completed, total, completedBytes, totalBytes });
      }),
    );
  }
}

/**
 * Uploads a single file to its presigned URL, retrying on transient failures.
 *
 * HTTP 403 is treated as non-retryable: it means the presigned URL has expired
 * or is otherwise invalid. Retrying the same dead URL wastes bandwidth (up to
 * UPLOAD_MAX_RETRIES × file size) and always fails. The caller must start a
 * new publish to obtain fresh presigned URLs.
 *
 * All other non-2xx responses (5xx, network errors, etc.) are retried up to
 * UPLOAD_MAX_RETRIES times — they indicate transient server or network issues
 * that may resolve on the next attempt.
 *
 * @throws Error immediately on HTTP 403 with an actionable message.
 * @throws Error with the file path after UPLOAD_MAX_RETRIES failed attempts.
 */
async function uploadOneFile(
  item: { path: string; upload_url: string },
  files: Record<string, { size: number; fullPath: string }>,
  fetchFn: FetchFn,
): Promise<void> {
  // Transitional: eagerly read the body from disk. Phase 2 replaces this with a
  // streamed Bun.file(fullPath) Blob constructed fresh per attempt.
  const bytes = new Uint8Array(readFileSync(files[item.path].fullPath));

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetchFn(item.upload_url, {
        method: "PUT",
        // Cast required: tsc's Uint8Array<ArrayBufferLike> doesn't satisfy
        // BodyInit's ArrayBufferView<ArrayBuffer> — works at runtime in Bun/browsers
        body: bytes as unknown as BodyInit,
      });
    } catch (networkErr) {
      // Network-level failure (DNS, timeout, connection reset). Retry — may be transient.
      log(`[upload] file=${item.path} attempt=${attempt} network_error=${(networkErr as Error).message}`);
      if (attempt === UPLOAD_MAX_RETRIES) {
        throw new Error(
          `Failed to upload '${item.path}' after ${UPLOAD_MAX_RETRIES} attempts: ${(networkErr as Error).message}`,
        );
      }
      continue;
    }

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

    // 403 = expired or invalid presigned URL. Retrying the same URL never helps —
    // fail fast with an actionable message so the user knows to re-publish.
    if (response.status === 403) {
      throw new Error(
        `Failed to upload '${item.path}': presigned URL expired or invalid (HTTP 403). ` +
        `The upload window is ${UPLOAD_WINDOW_HOURS} hours — start a new publish to get fresh URLs.`,
      );
    }

    // On the last attempt, throw so the caller knows this file failed
    if (attempt === UPLOAD_MAX_RETRIES) {
      throw new Error(
        `Failed to upload '${item.path}' after ${UPLOAD_MAX_RETRIES} attempts (HTTP ${response.status})`,
      );
    }
    // Otherwise retry — presigned PUT is idempotent for transient failures
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
    onProgress,
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

  if (Object.keys(collected.files).length === 0) {
    throw new Error("Directory is empty — no files to publish");
  }

  // Build file manifest to send to server.
  // When force=true, use random hashes so the server treats every file as changed.
  const files = Object.entries(collected.files).map(([path, file]) => ({
    path,
    hash: force ? crypto.randomUUID() : file.hash,
    size: file.size,
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
    files: collected.files,
    fetchFn,
    onProgress,
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
