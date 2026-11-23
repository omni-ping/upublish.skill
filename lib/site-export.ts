/**
 * Site export — download a version's published files into a local directory.
 *
 * The API (`GET /api/ns/:nsId/sites/:slug/export`) lists a version's files in pages with short-lived presigned
 * GET URLs. This module pages through it, downloads with bounded concurrency, verifies size + MD5 and writes
 * the files inside one target directory. Everything the server sends is hostile input: paths are validated
 * and collision-checked across the WHOLE export before anything is written, bodies are streamed and aborted
 * when they exceed the manifest size, and nothing is ever written through a symlink.
 *
 * Flow:
 *   1. refuse a non-empty target (unless overwrite) before any request;
 *   2. scan pass: fetch every page (metadata only), validate every entry, detect collisions, write nothing;
 *   3. create the directory, refuse pre-existing symlinks/type conflicts under it;
 *   4. download pass: fetch each page just in time, download its files, write temp + rename.
 *
 * Presigned URLs are bearer capabilities: no error or report string may carry their query string (`redact`).
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ApiClient } from "./api-client.ts";
import { ApiError } from "./api-client.ts";
import type { FetchFn } from "./types.ts";
import { log } from "./log.ts";
import { fetchPage } from "./site-export-page.ts";
import type { ExportEntry, ExportPage } from "./site-export-page.ts";
import { findPathCollision, foldKey, show, validateExportPath } from "./site-export-paths.ts";

// The pure path checks live in site-export-paths.ts; re-exported so this module's surface is unchanged.
export { findPathCollision, validateExportPath } from "./site-export-paths.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExportArgs {
  slug: string;
  /** Target directory (relative paths resolve against the process cwd). Created when missing. */
  directory: string;
  /** Version to export; omitted = the live version. */
  version?: number;
  /** Allow a non-empty target directory (files with the same path are replaced). */
  overwrite?: boolean;
}

export interface ExportDeps {
  fetchFn: FetchFn;
  /** Parallel downloads (default 8). */
  concurrency?: number;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Per-file download timeout (default 10 min, the URL lifetime). */
  fileTimeoutMs?: number;
  /** Total-size cap (default MAX_EXPORT_BYTES). */
  maxBytes?: number;
}

interface ExportFailure {
  path: string;
  reason: string;
}

export interface ExportResult {
  slug: string;
  version: number;
  /** Real (symlink-resolved) target directory. */
  directory: string;
  /** Files the version has. */
  fileCount: number;
  written: number;
  bytes: number;
  failed: ExportFailure[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const EXPORT_CONCURRENCY = 8;
const MAX_PAGES = 10_000;
/** Refuse an export whose listed files total more than this (a hostile or buggy listing must not fill the disk). */
const MAX_EXPORT_BYTES = 5 * 1024 ** 3;

// ─── Redaction (R8) ──────────────────────────────────────────────────────────

/** Strips query strings / fragments from every URL in `text`, plus any stray X-Amz-* parameter. */
export function redact(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s"'<>?#]*)[?#][^\s"'<>]*/gi, "$1")
    .replace(/X-Amz-[A-Za-z-]+=[^&\s"'<>]*/gi, "[redacted]");
}

function errMsg(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}

/** A per-file problem (reported, does not stop the export). */
class FileError extends Error {}
/** The presigned URL looks expired (R9): the only failure that triggers a page re-request. */
class ExpiredError extends Error {}

// ─── Existing-tree preflight (R12) ───────────────────────────────────────────

/** Refuses a symlink, or a file/directory type conflict, anywhere along an export path that already exists. */
async function checkExistingTree(root: string, paths: readonly string[]): Promise<void> {
  const verifiedDirs = new Set<string>();
  for (const p of paths) {
    const segs = p.split("/");
    let cur = root;
    for (let i = 0; i < segs.length; i++) {
      cur = path.join(cur, segs[i]!);
      const last = i === segs.length - 1;
      if (!last && verifiedDirs.has(cur)) continue;
      let st;
      try {
        st = await fs.lstat(cur);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") break; // nothing deeper exists either
        throw err;
      }
      if (st.isSymbolicLink()) throw new Error(`Refusing to export: ${show(p)} passes through an existing symlink in the target directory.`);
      if (!last && !st.isDirectory()) throw new Error(`Refusing to export: ${show(p)} needs a directory where a file already exists.`);
      if (last && st.isDirectory()) throw new Error(`Refusing to export: ${show(p)} is a file but a directory exists there.`);
      if (!last) verifiedDirs.add(cur);
    }
  }
}

// ─── Download + safe write (R12) ─────────────────────────────────────────────

/** `parent` must still resolve (symlinks included) to exactly `root` + its relative segments. */
async function assertParentInside(parent: string, expected: string): Promise<void> {
  const real = await fs.realpath(parent);
  if (foldKey(real) !== foldKey(expected)) throw new FileError("target directory changed during export (symlink?); refused");
}

async function writeAll(fh: fs.FileHandle, chunk: Uint8Array): Promise<void> {
  let off = 0;
  while (off < chunk.byteLength) {
    const { bytesWritten } = await fh.write(chunk, off, chunk.byteLength - off);
    off += bytesWritten;
  }
}

/** Streams `res` into a random temp file next to `dest`, verifies size + MD5, then renames it into place. */
async function writeVerified(res: Response, entry: ExportEntry, rootReal: string): Promise<void> {
  const segs = entry.path.split("/");
  const expectedParent = path.join(rootReal, ...segs.slice(0, -1));
  const dest = path.join(rootReal, ...segs);
  await fs.mkdir(expectedParent, { recursive: true });
  await assertParentInside(expectedParent, expectedParent);

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > entry.size) throw new FileError(`body larger than the manifest size (${entry.size} bytes)`);

  const tmp = path.join(expectedParent, `.upublish-export-${randomBytes(8).toString("hex")}.tmp`);
  const fh = await fs.open(tmp, "wx", 0o644);
  let closed = false;
  try {
    const md5 = createHash("md5");
    let n = 0;
    if (res.body) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          n += value.byteLength;
          if (n > entry.size) throw new FileError(`body larger than the manifest size (${entry.size} bytes)`);
          md5.update(value);
          await writeAll(fh, value);
        }
      } catch (err) {
        await reader.cancel().catch((e: unknown) => log(`[export] reader cancel: ${errMsg(e)}`));
        throw err;
      }
    }
    if (n !== entry.size) throw new FileError(`size mismatch (got ${n} bytes, expected ${entry.size})`);
    if (md5.digest("hex") !== entry.md5) throw new FileError("MD5 mismatch");
    await fh.chmod(0o644); // independent of umask and of anything the server could imply
    await fh.close();
    closed = true;
    await assertParentInside(expectedParent, expectedParent);
    const existing = await fs.lstat(dest).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (existing?.isSymbolicLink()) throw new FileError("destination is a symlink; not replaced");
    if (existing?.isDirectory()) throw new FileError("destination is a directory; not replaced");
    await fs.rename(tmp, dest);
  } catch (err) {
    if (!closed) await fh.close().catch((e: unknown) => log(`[export] close: ${errMsg(e)}`));
    await fs.unlink(tmp).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") log(`[export] temp cleanup failed: ${errMsg(e)}`);
    });
    throw err;
  }
}

interface PageCtx {
  cursor: string | undefined;
  urls: Map<string, string>;
  expiresAtMs: number;
  /** 0 = original links, 1 = after the single allowed re-request. */
  gen: number;
  refresh?: Promise<void>;
}

async function downloadOnce(entry: ExportEntry, url: string, ctx: PageCtx, rootReal: string, deps: Required<Omit<ExportDeps, "maxBytes">>): Promise<void> {
  const res = await deps.fetchFn(url, {
    redirect: "error",
    headers: { "Accept-Encoding": "identity" },
    signal: AbortSignal.timeout(deps.fileTimeoutMs),
  });
  if (!res.ok) {
    if (res.status === 404) throw new FileError("blob not found (HTTP 404)");
    if (res.status === 400 || res.status === 403) {
      const body = (await res.text().catch(() => "")).slice(0, 2048);
      if (deps.now() >= ctx.expiresAtMs || /expired|signature/i.test(body)) throw new ExpiredError(`HTTP ${res.status}`);
    }
    await res.body?.cancel().catch(() => log("[export] body cancel failed"));
    throw new FileError(`download failed (HTTP ${res.status})`);
  }
  await writeVerified(res, entry, rootReal);
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export async function runSiteExport(api: ApiClient, nsId: string, args: ExportArgs, userDeps: ExportDeps): Promise<ExportResult> {
  try {
    return await runInner(api, nsId, args, userDeps);
  } catch (err) {
    // Fetch errors embed the presigned URL; nothing leaves this module with a query string.
    throw new Error(errMsg(err));
  }
}

type DlDeps = Required<Omit<ExportDeps, "maxBytes">>;
type ListedFiles = Map<string, { size: number; md5: string }>;

function resolveDeps(userDeps: ExportDeps): DlDeps {
  return {
    concurrency: Math.max(1, userDeps.concurrency ?? EXPORT_CONCURRENCY),
    sleep: userDeps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: userDeps.now ?? Date.now,
    fileTimeoutMs: userDeps.fileTimeoutMs ?? 600_000,
    fetchFn: userDeps.fetchFn,
  };
}

function validateArgs(args: ExportArgs): void {
  if (!args.slug) throw new Error("slug is required");
  if (args.version !== undefined && !(Number.isSafeInteger(args.version) && args.version >= 1)) throw new Error("version must be a positive integer");
  if (typeof args.directory !== "string" || args.directory.trim() === "" || args.directory.includes("\0")) throw new Error("directory is required");
}

/** Step 1: refuses a bad or non-empty target before any request. Returns whether the directory already existed. */
async function checkTarget(target: string, overwrite: boolean | undefined): Promise<boolean> {
  try {
    const st = await fs.stat(target);
    if (!st.isDirectory()) throw new Error(`${target} exists and is not a directory.`);
    if (!overwrite && (await fs.readdir(target)).length > 0) {
      throw new Error(`${target} is not empty. Pass overwrite: true to export into it, or choose an empty or new directory.`);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return false;
  }
}

/** Step 2a: pages through the whole listing (metadata only), validating every entry. Nothing is written. */
async function scanListing(api: ApiClient, nsId: string, args: ExportArgs, deps: DlDeps) {
  const manifest: ListedFiles = new Map();
  let first: ExportPage | undefined;
  let last: ExportPage | undefined;
  let pageCount = 0;
  let version = args.version;
  let cursor: string | undefined;
  for (const seen = new Set<string>(); ; ) {
    if (++pageCount > MAX_PAGES) throw new Error("The export listing has too many pages; aborting.");
    const page = await fetchPage(api, nsId, args.slug, { version, cursor }, deps);
    if (args.version !== undefined && page.version !== args.version) throw new Error(`The export API returned version ${page.version}, not ${args.version}.`);
    version = page.version; // pin: the live version may flip while we page
    first ??= page;
    last = page;
    for (const f of page.files) {
      const bad = validateExportPath(f.path);
      if (bad) throw new Error(`Refusing to export: unsafe path ${show(f.path)} (${bad}). Nothing was written.`);
      if (manifest.has(f.path)) throw new Error(`Refusing to export: duplicate path ${show(f.path)}. Nothing was written.`);
      manifest.set(f.path, { size: f.size, md5: f.md5 });
    }
    if (page.nextCursor === null) break;
    if (seen.has(page.nextCursor)) throw new Error("The export API repeated a page cursor; aborting.");
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return { manifest, first: first!, last: last!, version: version! };
}

/** Step 2b: whole-listing checks (size cap, collisions, completeness) before anything is written. */
function assertListingSafe(manifest: ListedFiles, fileCount: number, maxBytes: number): void {
  const allPaths = [...manifest.keys()];
  const totalBytes = [...manifest.values()].reduce((n, f) => n + f.size, 0);
  if (totalBytes > maxBytes) throw new Error(`Refusing to export: the site is ${fmtBytes(totalBytes)}, over the ${fmtBytes(maxBytes)} export limit. Nothing was written.`);
  const collision = findPathCollision(allPaths);
  if (collision) throw new Error(`Refusing to export: path collision (${collision}). Nothing was written.`);
  if (allPaths.length !== fileCount) throw new Error(`The export listing is incomplete (${allPaths.length} listed, ${fileCount} expected). Nothing was written.`);
}

/** Step 4: downloads page by page, just in time. A single-page export reuses the scan page (it is seconds old). */
async function downloadPages(
  api: ApiClient,
  nsId: string,
  args: ExportArgs,
  scan: { manifest: ListedFiles; first: ExportPage; last: ExportPage; version: number },
  rootReal: string,
  deps: DlDeps,
): Promise<{ written: number; bytes: number; failed: ExportFailure[] }> {
  const { manifest, first, last, version } = scan;
  const failed: ExportFailure[] = [];
  let written = 0;
  let bytes = 0;
  const reuse = first === last && first.nextCursor === null ? first : undefined;
  let pageCursor: string | undefined;
  for (let pages = 0; ; pages++) {
    const page: ExportPage = pages === 0 && reuse ? reuse : await fetchPage(api, nsId, args.slug, { version, cursor: pageCursor }, deps);
    if (page.version !== version) throw new Error("The export API changed version mid-export; aborting.");
    const ctx: PageCtx = { cursor: pageCursor, urls: new Map(page.files.map((f) => [f.path, f.url])), expiresAtMs: page.expiresAtMs, gen: 0 };
    await processPage(api, nsId, args.slug, version, page.files, manifest, ctx, rootReal, deps, (n) => {
      written++;
      bytes += n;
    }, failed);
    if (page.nextCursor === null) break;
    pageCursor = page.nextCursor;
  }
  return { written, bytes, failed };
}

async function runInner(api: ApiClient, nsId: string, args: ExportArgs, userDeps: ExportDeps): Promise<ExportResult> {
  const deps = resolveDeps(userDeps);
  validateArgs(args);

  const target = path.resolve(args.directory);
  const rootExisted = await checkTarget(target, args.overwrite);

  const scan = await scanListing(api, nsId, args, deps);
  const fileCount = scan.first.fileCount;
  assertListingSafe(scan.manifest, fileCount, userDeps.maxBytes ?? MAX_EXPORT_BYTES);

  // 3. Create the directory; refuse symlinks/type conflicts that already exist under it.
  await fs.mkdir(target, { recursive: true });
  const rootReal = await fs.realpath(target);
  if (rootExisted) await checkExistingTree(rootReal, [...scan.manifest.keys()]);

  const { written, bytes, failed } = await downloadPages(api, nsId, args, scan, rootReal, deps);
  return { slug: args.slug, version: scan.version, directory: rootReal, fileCount, written, bytes, failed };
}

async function processPage(
  api: ApiClient,
  nsId: string,
  slug: string,
  version: number,
  files: ExportEntry[],
  manifest: ListedFiles,
  ctx: PageCtx,
  rootReal: string,
  deps: Required<Omit<ExportDeps, "maxBytes">>,
  onDone: (bytes: number) => void,
  failed: ExportFailure[],
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const entry = files[next++]!;
      try {
        const known = manifest.get(entry.path);
        if (validateExportPath(entry.path) || !known || known.size !== entry.size || known.md5 !== entry.md5) {
          throw new FileError("the file list changed between requests");
        }
        await attempt(entry);
        onDone(entry.size);
      } catch (err) {
        failed.push({ path: entry.path, reason: errMsg(err) });
      }
    }
  };

  const attempt = async (entry: ExportEntry): Promise<void> => {
    for (let n = 0; n < 2; n++) {
      const seenGen = ctx.gen;
      const url = ctx.urls.get(entry.path);
      if (!url) throw new FileError("no download link after the page was re-requested");
      try {
        return await downloadOnce(entry, url, ctx, rootReal, deps);
      } catch (err) {
        if (!(err instanceof ExpiredError)) throw err;
        if (n === 1) throw new FileError("download link expired again after the page was re-requested");
        await refreshOnce(seenGen);
      }
    }
  };

  /** Re-requests this page at most once, however many files saw an expired link (R9). */
  const refreshOnce = async (seenGen: number): Promise<void> => {
    if (ctx.gen > seenGen) return; // already refreshed since this attempt began
    if (ctx.gen >= 1) throw new FileError("download link expired again after the page was re-requested");
    ctx.refresh ??= (async () => {
      const page = await fetchPage(api, nsId, slug, { version, cursor: ctx.cursor }, deps);
      if (page.version !== version) throw new FileError("the export version changed; aborting this page");
      ctx.urls = new Map(page.files.map((f) => [f.path, f.url]));
      ctx.expiresAtMs = page.expiresAtMs;
      ctx.gen = 1;
    })();
    await ctx.refresh;
  };

  await Promise.all(Array.from({ length: Math.min(deps.concurrency, files.length) }, worker));
}

// ─── Report ──────────────────────────────────────────────────────────────────

const MAX_LISTED_FAILURES = 20;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Human-readable report. Paths are JSON-quoted (they came from the server); reasons are already redacted. */
export function formatExportResult(r: ExportResult): string {
  const lines = [
    r.failed.length === 0 ? `Exported '${r.slug}' v${r.version} to ${r.directory}` : `Export of '${r.slug}' v${r.version} to ${r.directory} finished with failures`,
    `Files written: ${r.written} of ${r.fileCount} (${fmtBytes(r.bytes)})`,
  ];
  if (r.failed.length > 0) {
    lines.push(`Failed: ${r.failed.length}`);
    for (const f of r.failed.slice(0, MAX_LISTED_FAILURES)) lines.push(`  - ${show(f.path)}: ${redact(f.reason)}`);
    if (r.failed.length > MAX_LISTED_FAILURES) lines.push(`  ...and ${r.failed.length - MAX_LISTED_FAILURES} more`);
  }
  return lines.join("\n");
}
