/** Uploads changed files to presigned PUT URLs in concurrent batches, with per-file retry. */

import type { FetchFn } from "./types.ts";
import { log } from "./log.ts";

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
 * Makes ONE PUT attempt for a file. Returns true on success and false for a
 * retryable failure (network error or non-2xx). Throws on the fatal outcomes: HTTP
 * 403 (expired or invalid presigned URL; retrying the same dead URL always fails),
 * or any failure on the final attempt.
 */
async function putOnce(
  item: { path: string; upload_url: string },
  fileInfo: { size: number; fullPath: string },
  fetchFn: FetchFn,
  attempt: number,
): Promise<boolean> {
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
    return false;
  }

  if (response.ok) {
    log(`[upload] file=${item.path} attempt=${attempt} status=${response.status} ok`);
    return true;
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
  return false;
}

/**
 * Uploads a single file to its presigned URL, retrying on transient failures.
 *
 * HTTP 403 is treated as non-retryable (see {@link putOnce}): the presigned URL
 * has expired, so retrying wastes bandwidth. All other non-2xx responses and
 * network errors are retried up to UPLOAD_MAX_RETRIES times.
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
    if (await putOnce(item, fileInfo, fetchFn, attempt)) return;
  }
}
