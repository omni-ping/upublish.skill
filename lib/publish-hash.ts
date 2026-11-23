/**
 * MD5 hashing of enumerated files: bounded-memory chunked reads, the async
 * event-loop-yielding path with byte-weighted progress, and the sync collect.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "fs";
import { listFiles } from "./publish-files.ts";
import type { FileEntry } from "./publish-files.ts";

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
