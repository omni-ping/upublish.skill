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
import { ApiError } from "./api-client.ts";
import type { FetchFn, Site, Visibility } from "./types.ts";
import { log } from "./log.ts";

// ─── Storage pack approval error ──────────────────────────────────────────────

/** Fallback approval URL when the 402 body omits it. */
const STORAGE_APPROVAL_URL_FALLBACK =
  "https://upubli.sh/profile/settings?storage_request=1";

/** Upgrade URL for analytics-disable tier gate messages. */
const ANALYTICS_UPGRADE_URL = "https://upubli.sh/pricing";

/**
 * Thrown when the API returns 402 `needs_storage_approval`. Carries the
 * structured fields from the backend response so the adapter can surface the
 * approval URL and pack pricing without reformatting the generic error message.
 *
 * `approval_url` is defensively defaulted to the canonical fallback when the
 * backend body is malformed or missing it — the caller always receives a usable
 * approval URL even on a partial/unexpected body.
 *
 * `price`, `block_gb`, `blocks_needed`, and `interval` are nullable: when the
 * body omits them, the adapter renders pack-language copy without hardcoded
 * price literals.
 */
export class StorageApprovalError extends Error {
  constructor(
    public readonly approval_url: string,
    /** USD price for one 10GB storage block, or null when absent from the 402 body. */
    public readonly price: number | null,
    /** Block size in GB (always 10 per contract), or null when absent. */
    public readonly block_gb: number | null,
    /** Number of blocks needed to cover the overage, or null when absent. */
    public readonly blocks_needed: number | null,
    /** Billing interval of the base subscription, or null when unknown/absent. */
    public readonly interval: "month" | "year" | null,
    message: string,
  ) {
    super(message);
    this.name = "StorageApprovalError";
  }
}

/**
 * Enriches API errors at the publish barricade with storage-pack guidance.
 *
 * - 402 `needs_storage_approval`: converts to `StorageApprovalError` carrying
 *   the approval URL, block price, block size, blocks needed, and billing
 *   interval from the body. All fields are defensively narrowed — a malformed
 *   or partial body still produces a usable error with the canonical fallback
 *   URL and pack wording (no hardcoded price literal).
 * - 403 analytics-gate (body.error contains "analytics"): rewrites to a
 *   friendly upgrade message. The body check disambiguates from a
 *   suspended-user 403 (different body) — the gate only fires when
 *   `analyticsEnabled: false` is in the manifest, so ownership 404s are
 *   separate. A suspended-user 403 body does NOT contain "analytics".
 * - All other errors: pass through unchanged — backend text is already
 *   actionable for the adapter.
 */
export function enrichPublishError(err: Error): Error {
  if (err instanceof ApiError && err.status === 402) {
    const body = err.rawBodyData as Record<string, unknown> | null;
    const code = typeof body?.code === "string" ? body.code : "";
    if (code === "needs_storage_approval") {
      const approvalUrl =
        typeof body?.approval_url === "string" && body.approval_url
          ? body.approval_url
          : STORAGE_APPROVAL_URL_FALLBACK;
      // All pack fields are nullable — a missing/malformed body must not
      // produce a hardcoded price literal. The adapter renders pack copy.
      const price =
        typeof body?.price === "number" && isFinite(body.price) ? body.price : null;
      const block_gb =
        typeof body?.block_gb === "number" && Number.isInteger(body.block_gb) && body.block_gb > 0
          ? body.block_gb
          : null;
      const blocks_needed =
        typeof body?.blocks_needed === "number" && Number.isInteger(body.blocks_needed) && body.blocks_needed > 0
          ? body.blocks_needed
          : null;
      const rawInterval = body?.interval;
      const interval: "month" | "year" | null =
        rawInterval === "month" || rawInterval === "year" ? rawInterval : null;
      return new StorageApprovalError(
        approvalUrl,
        price,
        block_gb,
        blocks_needed,
        interval,
        `Storage pack approval required. Approve at ${approvalUrl}`,
      );
    }
    // 402 with an unexpected code — fall through to pass-through below.
  }

  // 403 analytics-gate: rewrite to a friendly upgrade message.
  // Body check disambiguates from suspended-user 403 (different body text).
  if (err instanceof ApiError && err.status === 403) {
    const body = err.rawBodyData as Record<string, unknown> | null;
    const serverMsg = typeof body?.error === "string" ? body.error : "";
    if (serverMsg.toLowerCase().includes("analytics")) {
      return new Error(
        `${serverMsg} Upgrade to a Pro or Max plan at ${ANALYTICS_UPGRADE_URL} to disable analytics.`,
      );
    }
    // 403 with a non-analytics body (e.g. suspended user) — pass through unchanged.
  }

  return err;
}

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

/**
 * Hashing progress snapshot reported during the hashing phase (before any
 * upload). Mirrors {@link UploadProgress}: `completed`/`total` count files and
 * `completedBytes`/`totalBytes` count the raw bytes of those files. Both pairs
 * are cumulative and monotonically non-decreasing, reaching their totals on the
 * final report.
 *
 * `completedBytes` and the reported `totalBytes` are AUTHORITATIVE — they are the
 * bytes actually streamed through the hash, not a `statSync` size (no TOCTOU). A
 * downstream consumer renders a byte-weighted bar from these; when `totalBytes`
 * is 0 (all-empty files) it falls back to the file counts. The opening report is
 * `{ completed: 0, total, completedBytes: 0, totalBytes }` — `total`/`totalBytes`
 * are already known (enumeration ran first), so for a non-empty directory they
 * are non-zero and a percentage needs no divide-by-zero guard (the all-empty
 * `totalBytes === 0` case still needs the file-count fallback).
 */
export interface HashProgress {
  /** Files hashed so far (cumulative). Starts at 0, ends at `total`. */
  completed: number;
  /** Total files to hash. */
  total: number;
  /** Bytes hashed so far (cumulative, from streamed content — not stat). */
  completedBytes: number;
  /** Total bytes to hash (sum of every file's hashed-byte count). */
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
   * Per-site analytics opt-out (Phase 3). When false, the published site will
   * NOT get the analytics script injected at the edge. Omit to leave the default
   * (analytics ON — opt-out, not opt-in). Threaded into the manifest body.
   */
  analyticsEnabled?: boolean;
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
  /**
   * Optional synchronous progress callback fired during the hashing phase —
   * BEFORE the manifest/upload phase. Same contract as {@link onProgress}: must
   * be synchronous and non-throwing (lib/ stays platform-agnostic; the MCP
   * adapter wraps an async sendNotification behind it). Fires once at
   * `{0, total, 0, totalBytes}` after enumeration, then monotonically per
   * yield-batch, reaching the totals on the final report. Omitting it is a no-op
   * — publish behavior is byte-identical to pre-instrumentation.
   */
  onHashProgress?: (progress: HashProgress) => void;
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
  /**
   * Present when this publish charged storage-pack blocks. The backend bills
   * recurring packs of `block_gb` GB at `price` USD per `interval`.
   * Absent on a normal within-cap publish.
   */
  storage_overage?: {
    charged: boolean;
    /** Block size in GB (always 10). */
    block_gb: number;
    /** Number of blocks charged to cover the overage. */
    blocks: number;
    /** USD price per block for this interval. */
    price: number;
    /** Billing interval matching the base subscription. */
    interval: "month" | "year";
  };
}

// ─── Incremental publish types ────────────────────────────────────────────────

/**
 * One enumerated file, pre-hash: where it lives and its `statSync` size.
 *
 * Produced by {@link listFiles} (a stat-only walk — no content is read). `size`
 * here is the DENOMINATOR ESTIMATE for a hashing progress bar; the AUTHORITATIVE
 * byte count is the size returned later by the hash (the bytes actually streamed),
 * which is what {@link CollectedFile.size} carries.
 */
export interface FileEntry {
  /** Path relative to the walk root (the map key in the hashed result). */
  relPath: string;
  /** Absolute path to the file on disk. */
  fullPath: string;
  /** `statSync` byte size — denominator estimate only, not the hashed size. */
  size: number;
}

/** Result of enumerating a directory with {@link listFiles} (no hashing). */
export interface ListFilesResult {
  /** Publishable files in walk order, each with its stat size. */
  files: FileEntry[];
  /** Files/directories excluded by default rules or .upublishignore. */
  excluded: string[];
  /** Suspicious files included that may not be site content. */
  warnings: string[];
}

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

/**
 * Chunk size for streamed file hashing. Bounds collection memory: a file is
 * never read whole into memory — it is hashed through a single reused buffer of
 * this size, regardless of file size.
 */
const HASH_CHUNK_BYTES = 64 * 1024;

/**
 * Bytes hashed between mid-file event-loop yields in the async hasher. A large
 * file (e.g. 387 MB) would otherwise block the loop for its entire hash with no
 * yield, freezing any queued progress notifications. Yielding every 4 MiB gives
 * ~96 progress updates on a 387 MB file at a measured ~1% throughput cost — the
 * bar stays live without a yield per 64 KiB chunk. Sized as a multiple of
 * HASH_CHUNK_BYTES so the yield check lands on a chunk boundary.
 */
const HASH_YIELD_BYTES = 4 * 1024 * 1024;

/** Awaits a macrotask, draining the event loop so queued I/O (e.g. a pending
 * progress notification send) can run. A microtask (`await Promise.resolve()`)
 * would NOT release the loop to that I/O — `setImmediate` is the real yield. */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

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

/**
 * Async sibling of {@link hashFileChunked}: same bounded-buffer chunked-read
 * loop and the same fd-in-`finally` close, but it `await`s a macrotask whenever
 * `yieldEvery` bytes have been hashed since the last yield, so a single
 * multi-hundred-MB file does not block the event loop for its whole hash.
 * Returns the identical `{ hash, size }` (verified against the sync version) —
 * `size` is the authoritative bytes streamed.
 *
 * The byte budget is carried IN and OUT (`bytesSinceYield`) so the yield cadence
 * is global across a multi-file run — a single giant file yields mid-file, and a
 * run of medium files yields once the cumulative budget is reached, independent
 * of file boundaries.
 *
 * @param fullPath - Absolute path to the file to hash.
 * @param yieldEvery - Bytes hashed between event-loop yields.
 * @param bytesSinceYield - Bytes hashed since the last yield (carried across files).
 * @returns The MD5 hex digest, the bytes read, and the carried-out byte budget.
 */
async function hashFileChunkedYielding(
  fullPath: string,
  yieldEvery: number,
  bytesSinceYield: number,
): Promise<{ hash: string; size: number; bytesSinceYield: number }> {
  const fd = openSync(fullPath, "r");
  try {
    const md5 = createHash("md5");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let size = 0;
    let sinceYield = bytesSinceYield;
    let bytesRead: number;
    while ((bytesRead = readSync(fd, buffer, 0, HASH_CHUNK_BYTES, null)) > 0) {
      md5.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
      sinceYield += bytesRead;
      if (sinceYield >= yieldEvery) {
        // Mid-file yield — release the loop so a pending notification flushes.
        await yieldToEventLoop();
        sinceYield = 0;
      }
    }
    return { hash: md5.digest("hex"), size, bytesSinceYield: sinceYield };
  } finally {
    closeSync(fd);
  }
}

/**
 * Recursively walks `currentDir`, applying the default + .upublishignore
 * exclusion rules and flagging suspicious files. STAT-ONLY — it never opens or
 * reads file content; each kept file's `size` is its `statSync` size (the
 * progress denominator estimate, not the authoritative hashed size).
 */
function walkFiles(
  rootDir: string,
  currentDir: string,
  result: ListFilesResult,
  ignorePatterns: string[],
): void {
  const entries = readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    const relPath = relative(rootDir, fullPath);

    if (isDefaultExcluded(entry.name, entry.isDirectory())) {
      result.excluded.push(entry.isDirectory() ? `${relPath}/` : relPath);
      continue;
    }

    if (matchesIgnore(relPath, entry.name, ignorePatterns)) {
      result.excluded.push(entry.isDirectory() ? `${relPath}/` : relPath);
      continue;
    }

    if (entry.isDirectory()) {
      walkFiles(rootDir, fullPath, result, ignorePatterns);
    } else if (entry.isFile()) {
      if (isSuspicious(entry.name)) {
        result.warnings.push(relPath);
      }
      // stat-only: record where the file is and its size — no content is read.
      result.files.push({ relPath, fullPath, size: statSync(fullPath).size });
    }
  }
}

/**
 * Enumerates the publishable files under `dirPath` — applying the default and
 * .upublishignore exclusion rules and flagging suspicious files — WITHOUT
 * reading any file's content. This is the stat-only enumeration primitive both
 * hashing paths build on: the synchronous {@link collectFilesWithHashes} loop
 * and the async {@link hashFiles}.
 *
 * @param dirPath - Root directory to walk.
 * @returns files (relPath, fullPath, stat size), excluded, warnings.
 */
export function listFiles(dirPath: string): ListFilesResult {
  let ignorePatterns: string[] = [];
  const ignoreFile = join(dirPath, ".upublishignore");
  try {
    if (existsSync(ignoreFile)) {
      ignorePatterns = parseIgnoreFile(readFileSync(ignoreFile, "utf-8"));
    }
  } catch {
    // No readable .upublishignore — use defaults only
  }

  const result: ListFilesResult = { files: [], excluded: [], warnings: [] };
  walkFiles(dirPath, dirPath, result, ignorePatterns);
  return result;
}

/**
 * Hashes an enumerated file list (from {@link listFiles}), reporting
 * byte-weighted progress as it goes, and yielding to the event loop during the
 * work so queued notifications can flush. Yields MID-FILE once `yieldEvery` bytes
 * have streamed (so one large asset keeps the bar live) AND at every file
 * boundary (so a run of many small files — none reaching `yieldEvery` — still
 * releases the loop). The mid-file byte budget is global across files.
 *
 * `onHashProgress` (if supplied) fires once with everything at zero before any
 * file is hashed — `total`/`totalBytes` come from the list's stat sizes, so for
 * a non-empty list they are already known and non-zero — then after each file
 * completes with cumulative counts. The counts are monotonically non-decreasing.
 * `completedBytes` is AUTHORITATIVE (the bytes actually streamed through the
 * hash); the final report's `totalBytes` equals that cumulative sum, so
 * `completedBytes === totalBytes` holds exactly even if a file's on-disk size
 * changed between the stat and the hash. An EMPTY list fires no progress at all.
 *
 * `onHashProgress` must be synchronous and non-throwing (it is called directly);
 * a throw propagates out, matching `onProgress` semantics.
 *
 * @param list - Files to hash (relPath, fullPath, stat size).
 * @param opts.onHashProgress - Optional sync, non-throwing progress callback.
 * @param opts.yieldEvery - Bytes hashed between event-loop yields (default 4 MiB).
 * @returns Map of relPath → { hash, size, fullPath }; `size` is the hashed bytes.
 */
export async function hashFiles(
  list: FileEntry[],
  opts?: {
    onHashProgress?: (progress: HashProgress) => void;
    yieldEvery?: number;
  },
): Promise<Record<string, CollectedFile>> {
  const files: Record<string, CollectedFile> = {};

  // Empty list: fire nothing (mirrors uploadChangedFiles' empty short-circuit).
  if (list.length === 0) return files;

  const onHashProgress = opts?.onHashProgress;
  const yieldEvery = opts?.yieldEvery ?? HASH_YIELD_BYTES;

  const total = list.length;
  // statSync denominator estimate for the opening report; the final report uses
  // the cumulative hashed bytes so completedBytes === totalBytes holds exactly.
  const statTotalBytes = list.reduce((sum, e) => sum + e.size, 0);

  let completed = 0;
  let completedBytes = 0;
  // Carried across files so the mid-file yield cadence is global: one giant file
  // yields mid-stream; medium files yield once the cumulative budget is reached.
  let bytesSinceYield = 0;

  // Opening report: nothing hashed yet. totals are known (enumeration ran first).
  onHashProgress?.({ completed: 0, total, completedBytes: 0, totalBytes: statTotalBytes });

  for (let i = 0; i < total; i++) {
    const entry = list[i];
    const hashed = await hashFileChunkedYielding(entry.fullPath, yieldEvery, bytesSinceYield);
    files[entry.relPath] = { hash: hashed.hash, size: hashed.size, fullPath: entry.fullPath };
    bytesSinceYield = hashed.bytesSinceYield;

    completed += 1;
    completedBytes += hashed.size; // authoritative — bytes actually streamed
    const isLast = i === total - 1;
    // On the final file, pin totalBytes to the real hashed sum so the closing
    // report hits completedBytes === totalBytes exactly (TOCTOU-immune); before
    // that, report the stat estimate as the denominator.
    onHashProgress?.({
      completed,
      total,
      completedBytes,
      totalBytes: isLast ? completedBytes : statTotalBytes,
    });

    // Guarantee a yield at every file boundary (except after the very last file —
    // nothing remains to overlap). This keeps the loop live on the many-small-
    // files path, where no single file reaches `yieldEvery`. It is cheap: a bare
    // macrotask is sub-microsecond against per-file hashing work. Reset the budget
    // so the next file starts a fresh mid-file cadence.
    if (!isLast && bytesSinceYield > 0) {
      await yieldToEventLoop();
      bytesSinceYield = 0;
    }
  }

  return files;
}

/**
 * Recursively collects files from a directory, applying exclusion rules,
 * and computes an MD5 hash for each file.
 *
 * The MD5 hash matches the R2 ETag for single-part uploads, enabling the
 * publish flow to diff client files against the server manifest.
 *
 * Re-expressed as {@link listFiles} (the stat-only walk) plus a synchronous hash
 * loop — the signature and return contract are unchanged and it stays
 * SYNCHRONOUS (returns a non-Promise). The async, progress-instrumented path is
 * {@link hashFiles}; this one is kept for callers that want a blocking collect.
 *
 * @param dirPath - Root directory to walk.
 * @returns files (path → { hash, size, fullPath }), excluded, warnings.
 */
export function collectFilesWithHashes(dirPath: string): CollectWithHashesResult {
  const { files: list, excluded, warnings } = listFiles(dirPath);

  const files: Record<string, CollectedFile> = {};
  for (const entry of list) {
    const { hash, size } = hashFileChunked(entry.fullPath);
    files[entry.relPath] = { hash, size, fullPath: entry.fullPath };
  }

  return { files, excluded, warnings };
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
  // Guard: file path must be present in the collected files contract. A missing
  // entry is a programmer error (mismatch between needed list and files map) —
  // throw an actionable message naming the path rather than silently sending an
  // empty PUT or crashing with a generic "cannot read fullPath of undefined".
  const fileInfo = files[item.path];
  if (!fileInfo) {
    throw new Error(
      `Cannot upload '${item.path}': path not found in files collection. ` +
      `This is a bug — the needed list and the files map are out of sync.`,
    );
  }

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    // Construct a fresh ReadableStream per attempt. A partially-consumed stream
    // body must never be reused across retries — Bun.file().stream() opens a
    // new read handle each call, so each attempt reads from the start of the file.
    //
    // Why stream() + explicit Content-Length rather than a Blob body:
    //   - Bun.file Blob auto-sets Content-Type from the file extension (e.g.
    //     .html → text/html;charset=utf-8). Presigned R2 PUTs are signed with
    //     a specific ContentType in the PutObjectCommand on the backend; an
    //     unexpected Content-Type header causes a signature 403.
    //   - The current Uint8Array body sends NO Content-Type header (probe-verified).
    //   - Bun.file().stream() also sends no Content-Type (probe-verified).
    //   - R2 presigned PUTs require an explicit Content-Length header when using
    //     a streaming body (no chunked transfer encoding); we supply it from the
    //     contract size already collected in Phase 1.
    const body = Bun.file(fileInfo.fullPath).stream();
    let response: Response;
    try {
      response = await fetchFn(item.upload_url, {
        method: "PUT",
        body,
        headers: { "Content-Length": String(fileInfo.size) },
      });
    } catch (networkErr) {
      // Network-level failure (DNS, timeout, connection reset, or file deleted
      // between collection and PUT). Retry — may be transient.
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
    analyticsEnabled,
    fetchFn = fetch,
    onProgress,
    onHashProgress,
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
      "Invalid slug. Must be 1-255 characters: lowercase letters, " +
        "numbers, and hyphens, starting and ending with a letter or number.",
    );
  }

  if (visibility === "passcode" && !passcode) {
    throw new Error("passcode is required when visibility is 'passcode'");
  }

  // Enumerate files (stat-only), then hash them on the async, event-loop-yielding
  // path so progress can fire from the first file during the multi-minute hash.
  const { files: fileList, excluded, warnings } = listFiles(directory);

  if (fileList.length === 0) {
    throw new Error("Directory is empty — no files to publish");
  }

  const collectedFiles = await hashFiles(fileList, { onHashProgress });

  // Build file manifest to send to server.
  // When force=true, use random hashes so the server treats every file as changed.
  const files = Object.entries(collectedFiles).map(([path, file]) => ({
    path,
    hash: force ? crypto.randomUUID() : file.hash,
    size: file.size,
  }));

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  log(`[publish] slug=${slug} files=${files.length} totalBytes=${totalBytes}${force ? " FORCE" : ""}`);

  // Send manifest — server diffs against previous version and returns presigned URLs.
  // A 402 needs_storage_approval is enriched into a StorageApprovalError so the
  // adapter can surface the approval URL and pack price without re-parsing the body.
  let manifestResult: Awaited<ReturnType<typeof apiClient.manifest>>;
  try {
    manifestResult = await apiClient.manifest(nsId, slug, {
      files,
      title: title ?? slug,
      visibility,
      passcode: visibility === "passcode" ? passcode : undefined,
      passcode_label:
        visibility === "passcode" ? (passcodeLabel ?? "default") : undefined,
      preview,
      analytics_enabled: analyticsEnabled,
    });
  } catch (err) {
    throw enrichPublishError(err as Error);
  }

  log(`[manifest] version=${manifestResult.version} session_id=${manifestResult.session_id} base_version=${manifestResult.base_version} needed=${manifestResult.needed.length} total=${files.length}`);

  // Upload only the files the server says it needs.
  // Presigned URLs are self-authenticating — no Bearer token required.
  await uploadChangedFiles({
    needed: manifestResult.needed,
    files: collectedFiles,
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

  const result: PublishResult = {
    url: finalizeResult.url,
    preview_url: finalizeResult.preview_url,
    site: finalizeResult.site,
    warnings,
    excluded,
    uploadedFiles,
    skippedFiles,
  };

  // Thread storage_overage from the manifest response when present and charged.
  if (manifestResult.storage_overage?.charged === true) {
    result.storage_overage = manifestResult.storage_overage;
  }

  return result;
}
