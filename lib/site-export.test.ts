/**
 * Site export (skill side). Nothing here touches the network: one stub fetch plays both the export API and
 * R2 (blob URLs under https://r2.test/blob/<md5>?X-Amz-Signature=...).
 *
 * DW-2.1 paging + verified bytes, DW-2.2 path/collision/symlink/oversize vectors, DW-2.3 expiry + MD5,
 * DW-2.4 non-empty directory, DW-2.7 no presigned query string in any error or report.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApiClient } from "./api-client.ts";
import {
  EXPORT_CONCURRENCY,
  findPathCollision,
  formatExportResult,
  redact,
  runSiteExport,
  validateExportPath,
} from "./site-export.ts";
import type { ExportArgs, ExportDeps } from "./site-export.ts";

const md5 = (b: string | Uint8Array): string => createHash("md5").update(b).digest("hex");
const SECRET = "SECRETSIG123";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "site-export-")));
  tmpDirs.push(d);
  return d;
}

interface FileSpec {
  path: string;
  body: string | Uint8Array;
  /** Override the manifest (to lie about size/md5). */
  size?: number;
  md5?: string;
}

interface Harness {
  api: ApiClient;
  deps: ExportDeps;
  /** Every export-route request URL (path + query). */
  pageRequests: string[];
  /** Every blob URL fetched. */
  blobRequests: string[];
  slept: number[];
  /** Make the next `n` page requests fail with this status/headers before serving normally. */
  pageFailures: Array<{ status: number; headers?: Record<string, string>; body?: unknown }>;
  /** Per-blob override: return a Response to replace normal serving; `gen` is the page generation of the URL. */
  blobOverride?: (url: string, gen: number, spec: FileSpec | undefined) => Response | Promise<Response | null> | null;
  /** Number of times a page has been (re)issued: URLs carry `g<gen>` so tests can tell links apart. */
  pageIssue: Map<string, number>;
  now: { t: number };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** A server with `files` paginated `pageSize` at a time. */
function harness(files: FileSpec[], opts: { pageSize?: number; version?: number; fileCount?: number; concurrency?: number } = {}): Harness {
  const pageSize = opts.pageSize ?? 1000;
  const version = opts.version ?? 3;
  const sorted = [...files];
  const byMd5 = new Map<string, FileSpec>();
  for (const f of sorted) byMd5.set(f.md5 ?? md5(f.body), f);
  const h: Harness = {
    api: undefined as never,
    deps: undefined as never,
    pageRequests: [],
    blobRequests: [],
    slept: [],
    pageFailures: [],
    pageIssue: new Map(),
    now: { t: 1_000_000 },
  };
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.startsWith("https://r2.test/blob/")) {
      h.blobRequests.push(url);
      const u = new URL(url);
      const hash = u.pathname.split("/").pop()!;
      const gen = Number(u.searchParams.get("g"));
      const spec = byMd5.get(hash);
      const over = await h.blobOverride?.(url, gen, spec);
      if (over) return over;
      if (!spec) return new Response("<Error>NoSuchKey</Error>", { status: 404 });
      return new Response(typeof spec.body === "string" ? spec.body : (spec.body as unknown as BodyInit));
    }
    const u = new URL(url);
    if (!u.pathname.endsWith("/export")) throw new Error(`unexpected request ${url}`);
    h.pageRequests.push(u.pathname + u.search);
    const fail = h.pageFailures.shift();
    if (fail) return json(fail.body ?? { error: "slow down", code: "rate_limited" }, fail.status, fail.headers);
    const cursor = u.searchParams.get("cursor");
    const start = cursor === null ? 0 : Number(cursor);
    const key = String(start);
    const gen = (h.pageIssue.get(key) ?? -1) + 1;
    h.pageIssue.set(key, gen);
    const slice = sorted.slice(start, start + pageSize);
    return json({
      version,
      file_count: opts.fileCount ?? sorted.length,
      total_size: 0,
      files: slice.map((f) => ({ path: f.path, size: f.size ?? (typeof f.body === "string" ? Buffer.byteLength(f.body) : f.body.length), md5: f.md5 ?? md5(f.body), url: `https://r2.test/blob/${f.md5 ?? md5(f.body)}?X-Amz-Signature=${SECRET}&g=${gen}` })),
      next_cursor: start + pageSize < sorted.length ? String(start + pageSize) : null,
      expires_at: new Date(h.now.t + 600_000).toISOString(),
    });
  };
  h.api = new ApiClient("https://api.test", async () => "tok", (u, i) => h.deps.fetchFn(u, i)); // late-bound so tests can wrap deps.fetchFn
  h.deps = { fetchFn, sleep: async (ms) => void h.slept.push(ms), now: () => h.now.t, concurrency: opts.concurrency };
  return h;
}

const run = (h: Harness, dir: string, extra: Partial<ExportArgs> = {}) =>
  runSiteExport(h.api, "ns1", { slug: "site", directory: dir, ...extra }, h.deps);

function listAll(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(path.relative(dir, p));
      if (e.isDirectory()) walk(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

// ─── DW-2.1 ──────────────────────────────────────────────────────────────────

describe("DW-2.1: two pages are downloaded, verified and reported", () => {
  const files: FileSpec[] = [
    { path: "index.html", body: "<h1>hi</h1>" },
    { path: "css/site.css", body: "body{}" },
    { path: "img/logo.bin", body: new Uint8Array([0, 1, 2, 255, 254]) },
  ];

  test("DW_2_1_every_file_written_with_correct_bytes_and_report_counts", async () => {
    const h = harness(files, { pageSize: 2 });
    const dir = path.join(tmp(), "out");
    const r = await run(h, dir);
    expect(r).toMatchObject({ slug: "site", version: 3, fileCount: 3, written: 3, bytes: 11 + 6 + 5, failed: [] });
    expect(r.directory).toBe(dir);
    expect(fs.readFileSync(path.join(dir, "index.html"), "utf8")).toBe("<h1>hi</h1>");
    expect(fs.readFileSync(path.join(dir, "css/site.css"), "utf8")).toBe("body{}");
    expect([...fs.readFileSync(path.join(dir, "img/logo.bin"))]).toEqual([0, 1, 2, 255, 254]);
    expect(listAll(dir)).toEqual(["css", "css/site.css", "img", "img/logo.bin", "index.html"]); // no temp files left
    expect(h.blobRequests).toHaveLength(3);
  });

  test("pages after the first pin the resolved version and carry the cursor; the first request has neither", async () => {
    const h = harness(files, { pageSize: 2 });
    await run(h, path.join(tmp(), "out"));
    expect(h.pageRequests[0]).toMatch(/\/api\/ns\/ns1\/sites\/site\/export$/);
    expect(h.pageRequests[1]).toBe("/api/ns/ns1/sites/site/export?version=3&cursor=2");
  });

  test("an explicit version is requested and a different version in the answer is refused", async () => {
    const h = harness(files, { version: 3 });
    await expect(run(h, path.join(tmp(), "out"), { version: 2 })).rejects.toThrow(/version 3, not 2/);
    expect(h.pageRequests[0]).toContain("version=2");
    await run(harness(files, { version: 2 }), path.join(tmp(), "ok"), { version: 2 });
  });

  test("a single-page export fetches its page once (the scan page is reused)", async () => {
    const h = harness(files);
    await run(h, path.join(tmp(), "out"));
    expect(h.pageRequests).toHaveLength(1);
  });

  test("an empty site creates the directory and writes nothing", async () => {
    const h = harness([]);
    const dir = path.join(tmp(), "a", "b");
    const r = await run(h, dir);
    expect(r).toMatchObject({ fileCount: 0, written: 0, bytes: 0, failed: [] });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("files are mode 0644 whatever the umask", async () => {
    const h = harness(files);
    const dir = path.join(tmp(), "out");
    const old = process.umask(0o027);
    try {
      await run(h, dir);
    } finally {
      process.umask(old);
    }
    expect(fs.statSync(path.join(dir, "index.html")).mode & 0o777).toBe(0o644);
  });

  test("downloads never run more than `concurrency` at once, and the default is 8", async () => {
    expect(EXPORT_CONCURRENCY).toBe(8);
    const many = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.txt`, body: `body-${i}` }));
    const h = harness(many, { concurrency: 3 });
    let inFlight = 0;
    let peak = 0;
    h.blobOverride = async (url) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return null;
    };
    const r = await run(h, path.join(tmp(), "out"));
    expect(r.written).toBe(12);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  test("the download request carries no Authorization header (presigned links are the credential)", async () => {
    const h = harness(files);
    const seen: Array<RequestInit | undefined> = [];
    const inner = h.deps.fetchFn;
    h.deps.fetchFn = async (u, init) => {
      if (u.startsWith("https://r2.test/")) seen.push(init);
      return inner(u, init);
    };
    await run(h, path.join(tmp(), "out"));
    expect(seen).toHaveLength(3);
    for (const init of seen) expect(JSON.stringify(init?.headers)).not.toMatch(/authorization/i);
  });
});

// ─── DW-2.2 ──────────────────────────────────────────────────────────────────

describe("DW-2.2: every path-safety vector is refused before anything is written", () => {
  const long = "a/".repeat(2049) + "x"; // > 4096 bytes
  const vectors: Array<[string, string]> = [
    ["dot-dot", "../evil.txt"],
    ["dot-dot in the middle", "a/../../evil.txt"],
    ["absolute", "/etc/passwd"],
    ["backslash", "a\\b.txt"],
    ["windows drive", "C:\\x.txt"],
    ["colon / ADS", "a:b"],
    ["NUL", "a\0b.txt"],
    ["control char", "a\u0007b.txt"],
    ["reserved name CON", "CON"],
    ["reserved name with extension", "dir/con.txt"],
    ["reserved name LPT1 in a directory", "lpt1/x.html"],
    ["trailing dot", "x."],
    ["trailing space", "dir/x "],
    ["over-long path", long],
    ["over-long segment", `${"s".repeat(256)}.txt`],
    ["UNC", "//server/share/x"],
    ["empty segment", "a//b"],
    ["dot segment", "./a"],
    ["empty path", ""],
  ];

  test.each(vectors)("DW_2_2_refuses %s", async (_label, bad) => {
    const h = harness([{ path: "ok.txt", body: "ok" }, { path: bad, body: "evil" }]);
    // The server lists them in this order; the bad one must stop the whole export, including `ok.txt`.
    const base = tmp();
    const dir = path.join(base, "out");
    await expect(run(h, dir)).rejects.toThrow(/Refusing to export/);
    expect(h.blobRequests).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(listAll(base)).toEqual([]);
  });

  test.each([
    ["case-fold", [{ path: "A.html", body: "1" }, { path: "a.html", body: "2" }]],
    ["case-fold in a directory", [{ path: "Docs/x.md", body: "1" }, { path: "docs/x.md", body: "2" }]],
    ["NFC vs NFD", [{ path: "caf\u00e9.txt", body: "1" }, { path: "cafe\u0301.txt", body: "2" }]],
    ["file vs directory prefix", [{ path: "a", body: "1" }, { path: "a/b", body: "2" }]],
    ["exact duplicate path", [{ path: "dup.txt", body: "1" }, { path: "dup.txt", body: "2" }]],
  ] as Array<[string, FileSpec[]]>)("DW_2_2_collision_%s is refused up front across the whole export", async (_label, files) => {
    // Put the collision on different pages: pageSize 1 forces the scan pass to catch it across pages.
    const h = harness(files, { pageSize: 1 });
    const base = tmp();
    await expect(run(h, path.join(base, "out"))).rejects.toThrow(/Refusing to export: (path collision|duplicate path)/);
    expect(h.blobRequests).toEqual([]);
    expect(listAll(base)).toEqual([]);
  });

  test("DW_2_2_valid awkward-but-safe paths are accepted (unicode, dotfiles, names that merely contain reserved words)", async () => {
    const files = [".well-known/x.json", "caf\u00e9/\u00e9.txt", "console.js", "aux-file.txt", "a b/c d.txt", "日本語.html"].map((p) => ({ path: p, body: p }));
    const dir = path.join(tmp(), "out");
    const r = await run(harness(files), dir);
    expect(r.written).toBe(files.length);
    expect(fs.readFileSync(path.join(dir, "日本語.html"), "utf8")).toBe("日本語.html");
  });

  test("DW_2_2_a_pre_existing_symlink_in_the_target_is_never_followed (directory component, overwrite:true)", async () => {
    const base = tmp();
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    const dir = path.join(base, "out");
    fs.mkdirSync(dir);
    fs.symlinkSync(outside, path.join(dir, "link"));
    const h = harness([{ path: "link/pwned.txt", body: "x" }]);
    await expect(run(h, dir, { overwrite: true })).rejects.toThrow(/symlink/);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(h.blobRequests).toEqual([]);
  });

  test("DW_2_2_a_pre_existing_symlink_at_the_file_path_is_not_replaced (overwrite:true)", async () => {
    const base = tmp();
    const secret = path.join(base, "secret.txt");
    fs.writeFileSync(secret, "keep");
    const dir = path.join(base, "out");
    fs.mkdirSync(dir);
    fs.symlinkSync(secret, path.join(dir, "x.txt"));
    await expect(run(harness([{ path: "x.txt", body: "overwritten" }]), dir, { overwrite: true })).rejects.toThrow(/symlink/);
    expect(fs.readFileSync(secret, "utf8")).toBe("keep");
    expect(fs.lstatSync(path.join(dir, "x.txt")).isSymbolicLink()).toBe(true);
  });

  test("DW_2_2_a_symlink_swapped_in_after_the_preflight_is_caught_before_the_rename", async () => {
    const base = tmp();
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    const dir = path.join(base, "out");
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, "sub")); // exists and is a real directory at preflight time
    const h = harness([{ path: "sub/x.txt", body: "payload" }]);
    h.blobOverride = () => {
      fs.rmSync(path.join(dir, "sub"), { recursive: true });
      fs.symlinkSync(outside, path.join(dir, "sub")); // attacker races the download
      return null;
    };
    const r = await run(h, dir, { overwrite: true });
    expect(r.written).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.reason).toMatch(/changed during export|symlink/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test("DW_2_2_a_directory_where_a_file_should_go_and_a_file_where_a_directory_should_go_are_refused", async () => {
    const base = tmp();
    const dir = path.join(base, "out");
    fs.mkdirSync(path.join(dir, "a"), { recursive: true });
    await expect(run(harness([{ path: "a", body: "x" }]), dir, { overwrite: true })).rejects.toThrow(/directory exists there/);
    fs.writeFileSync(path.join(dir, "f"), "x");
    await expect(run(harness([{ path: "f/g.txt", body: "x" }]), dir, { overwrite: true })).rejects.toThrow(/needs a directory/);
  });

  test("DW_2_2_a_body_longer_than_its_manifest_size_is_aborted_and_leaves_nothing", async () => {
    const dir = path.join(tmp(), "out");
    const h = harness([{ path: "big.bin", body: "tiny", size: 4 }, { path: "ok.txt", body: "fine" }]);
    h.blobOverride = (url, _g, spec) => (spec?.path === "big.bin" ? new Response("this body is far longer than four bytes") : null);
    const r = await run(h, dir);
    expect(r.written).toBe(1);
    expect(r.failed).toEqual([{ path: "big.bin", reason: expect.stringMatching(/larger than the manifest size \(4 bytes\)/) }]);
    expect(listAll(dir)).toEqual(["ok.txt"]); // no big.bin, no temp file
  });

  test("DW_2_2_the_overrun_is_cut_off_mid_stream_not_after_buffering_the_whole_body", async () => {
    const dir = path.join(tmp(), "out");
    const h = harness([{ path: "big.bin", body: "abcd", size: 4 }]);
    let pulls = 0;
    h.blobOverride = () =>
      new Response(
        new ReadableStream({
          pull(c) {
            pulls++;
            c.enqueue(new Uint8Array(1024));
            if (pulls > 1000) c.close();
          },
        }),
      );
    const r = await run(h, dir);
    expect(r.failed).toHaveLength(1);
    expect(pulls).toBeLessThan(10); // aborted right after the first chunk(s), not drained
    expect(listAll(dir)).toEqual([]);
  });

  test("a declared Content-Length above the manifest size is refused without reading the body", async () => {
    const dir = path.join(tmp(), "out");
    const h = harness([{ path: "a.txt", body: "abcd" }]);
    h.blobOverride = () => new Response("abcd", { headers: { "Content-Length": "999999" } });
    const r = await run(h, dir);
    expect(r.failed[0]!.reason).toMatch(/larger than the manifest size/);
    expect(listAll(dir)).toEqual([]);
  });

  test("a body shorter than the manifest size is a size mismatch", async () => {
    const dir = path.join(tmp(), "out");
    const h = harness([{ path: "a.txt", body: "abcd", size: 10 }]);
    const r = await run(h, dir);
    expect(r.failed[0]!.reason).toMatch(/size mismatch \(got 4 bytes, expected 10\)/);
    expect(listAll(dir)).toEqual([]);
  });
});

describe("path helpers", () => {
  test("validateExportPath accepts ordinary paths and names its reason otherwise", () => {
    for (const ok of ["index.html", "a/b/c.txt", ".well-known/security.txt", "a.b.c", "com10.txt", "nul-x"]) expect(validateExportPath(ok)).toBeNull();
    expect(validateExportPath("a/../b")).toMatch(/'\.\.'/);
    expect(validateExportPath(42)).toMatch(/empty/);
    expect(validateExportPath("NUL.txt")).toMatch(/reserved/);
    expect(validateExportPath("COM1")).toMatch(/reserved/);
    expect(validateExportPath("x.")).toMatch(/dot or space/);
  });

  test("findPathCollision: none for distinct paths; names both sides otherwise", () => {
    expect(findPathCollision(["a", "b/c", "b/d"])).toBeNull();
    expect(findPathCollision(["a.txt", "A.TXT"])).toMatch(/collides/);
    expect(findPathCollision(["d", "D/x"])).toMatch(/needs it to be a directory/);
    expect(findPathCollision(["x/y/z", "x/y"])).toMatch(/is a file/);
  });
});

// ─── DW-2.7 ──────────────────────────────────────────────────────────────────

describe("DW-2.7: no error or report string carries a presigned URL's query string", () => {
  const dump = (v: unknown) => JSON.stringify(v) + String(v);

  test("DW_2_7_a_failing_fetch_whose_error_embeds_the_url_is_reported_without_the_query", async () => {
    const dir = path.join(tmp(), "out");
    const h = harness([{ path: "a.txt", body: "a" }, { path: "b.txt", body: "b" }]);
    const inner = h.deps.fetchFn;
    h.deps.fetchFn = async (u, init) => {
      if (u.startsWith("https://r2.test/")) throw new Error(`fetch failed: GET ${u} ECONNRESET (retry ${u})`);
      return inner(u, init);
    };
    const r = await run(h, dir);
    expect(r.failed).toHaveLength(2);
    const text = dump(r) + formatExportResult(r);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("X-Amz");
    expect(text).toContain("https://r2.test/blob/"); // the URL's origin and path survive, only the query goes
    expect(text).toContain("ECONNRESET");
  });

  test("DW_2_7_a_thrown_top_level_error_that_embeds_the_url_is_redacted", async () => {
    const h = harness([{ path: "a.txt", body: "a" }]);
    const api = new ApiClient("https://api.test", async () => "t", async (u) => {
      throw new Error(`socket closed for https://r2.test/blob/abc?X-Amz-Signature=${SECRET}&X-Amz-Credential=cc#frag`);
    });
    const err = await runSiteExport(api, "ns1", { slug: "s", directory: path.join(tmp(), "o") }, h.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(SECRET);
    expect((err as Error).message).not.toMatch(/X-Amz|#frag/);
    expect((err as Error).message).toContain("https://r2.test/blob/abc");
  });

  test("redact strips queries and fragments from every URL and stray signing parameters", () => {
    expect(redact("a https://x.test/p?q=1&r=2 b http://y.test/z#f c")).toBe("a https://x.test/p b http://y.test/z c");
    expect(redact("bare X-Amz-Signature=abc123&other")).toBe("bare [redacted]&other");
    expect(redact("no urls here")).toBe("no urls here");
    expect(redact('quoted "https://x.test/p?sig=1" end')).toBe('quoted "https://x.test/p" end');
  });
});

// ─── DW-2.3 ──────────────────────────────────────────────────────────────────

describe("DW-2.3: expiry re-requests the page once; MD5 mismatch leaves no partial file", () => {
  const files: FileSpec[] = [1, 2, 3, 4].map((i) => ({ path: `f${i}.txt`, body: `content-${i}` }));
  const expired = (): Response => new Response("<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>", { status: 403 });

  test("DW_2_3_an_expired_url_triggers_exactly_one_page_re_request_and_then_succeeds", async () => {
    const h = harness(files);
    h.blobOverride = (_u, gen) => (gen === 0 ? expired() : null); // original links are dead; refreshed links work
    const dir = path.join(tmp(), "out");
    const r = await run(h, dir);
    expect(r).toMatchObject({ written: 4, failed: [] });
    // scan pass (1) + exactly one re-request (1), however many of the 4 concurrent files saw the expiry
    expect(h.pageRequests).toHaveLength(2);
    expect(fs.readFileSync(path.join(dir, "f3.txt"), "utf8")).toBe("content-3");
  });

  test("a 400 after expires_at counts as expiry even with an opaque body", async () => {
    const h = harness(files.slice(0, 1));
    h.blobOverride = (_u, gen) => {
      if (gen !== 0) return null;
      h.now.t += 700_000; // the clock passes expires_at
      return new Response("denied", { status: 400 });
    };
    const r = await run(h, path.join(tmp(), "out"));
    expect(r.written).toBe(1);
    expect(h.pageRequests).toHaveLength(2);
  });

  test("a 403 BEFORE expires_at with an opaque body is a plain failure and does not re-request", async () => {
    const h = harness(files.slice(0, 1));
    h.blobOverride = () => new Response("denied", { status: 403 });
    const r = await run(h, path.join(tmp(), "out"));
    expect(r.failed[0]!.reason).toBe("download failed (HTTP 403)");
    expect(h.pageRequests).toHaveLength(1);
  });

  test("if the refreshed links expire too, the files fail and the page is not requested a third time", async () => {
    const h = harness(files);
    h.blobOverride = () => expired();
    const r = await run(h, path.join(tmp(), "out"));
    expect(r.written).toBe(0);
    expect(r.failed).toHaveLength(4);
    for (const f of r.failed) expect(f.reason).toMatch(/expired again/);
    expect(h.pageRequests).toHaveLength(2);
  });

  test("a failed page re-request fails the page's files with the error, without a loop", async () => {
    const h = harness(files.slice(0, 2));
    h.blobOverride = (_u, gen) => (gen === 0 ? expired() : null);
    const inner = h.deps.fetchFn;
    let exportCalls = 0;
    h.deps.fetchFn = async (u, init) => {
      if (!u.startsWith("https://r2.test/") && ++exportCalls === 2) return json({ error: "boom" }, 500);
      return inner(u, init);
    };
    const r = await run(h, path.join(tmp(), "out"));
    expect(r.failed).toHaveLength(2);
    expect(r.failed[0]!.reason).toMatch(/API error 500/);
    expect(exportCalls).toBe(2);
  });

  test("with several pages, only the page that saw the expiry is re-requested", async () => {
    const h = harness(files, { pageSize: 2 });
    // page 2's download-pass links are its 2nd issue (gen 1); the refreshed ones are gen 2
    h.blobOverride = (_u, gen, spec) => (gen === 1 && spec?.path === "f3.txt" ? expired() : null);
    const r = await run(h, path.join(tmp(), "out"));
    expect(r.written).toBe(4);
    // scan: 2 pages; download: 2 pages; one refresh of page 2
    expect(h.pageRequests).toHaveLength(5);
    expect(h.pageRequests.filter((p) => p.includes("cursor=2"))).toHaveLength(3);
  });

  test("DW_2_3_an_md5_mismatch_is_reported_and_leaves_no_partial_file", async () => {
    const dir = path.join(tmp(), "out");
    const h = harness([{ path: "good.txt", body: "good" }, { path: "bad.txt", body: "AAAA", md5: md5("expected-content") }]);
    h.blobOverride = (_u, _g, spec) => (spec?.path === "bad.txt" ? new Response("AAAA") : null);
    // size must match so only the MD5 differs
    const r = await run(h, dir);
    expect(r.written).toBe(1);
    expect(r.failed).toEqual([{ path: "bad.txt", reason: expect.stringMatching(/MD5 mismatch|size mismatch/) }]);
    expect(listAll(dir)).toEqual(["good.txt"]);
  });

  test("an md5 mismatch with the right size says MD5 mismatch", async () => {
    const dir = path.join(tmp(), "out");
    const h = harness([{ path: "bad.txt", body: "AAAA", md5: md5("BBBB") }]);
    h.blobOverride = () => new Response("AAAA");
    const r = await run(h, dir);
    expect(r.failed[0]!.reason).toBe("MD5 mismatch");
    expect(listAll(dir)).toEqual([]);
  });

  test("a blob 404 is a per-file failure with no page re-request", async () => {
    const dir = path.join(tmp(), "out");
    const h = harness([{ path: "gone.txt", body: "x" }, { path: "here.txt", body: "y" }]);
    h.blobOverride = (_u, _g, spec) => (spec?.path === "gone.txt" ? new Response("<Error>NoSuchKey</Error>", { status: 404 }) : null);
    const r = await run(h, dir);
    expect(r.failed).toEqual([{ path: "gone.txt", reason: "blob not found (HTTP 404)" }]);
    expect(r.written).toBe(1);
    expect(h.pageRequests).toHaveLength(1);
  });

  test("a 500 from the blob store is a plain per-file failure", async () => {
    const h = harness([{ path: "a.txt", body: "x" }]);
    h.blobOverride = () => new Response("oops", { status: 500 });
    const r = await run(h, path.join(tmp(), "out"));
    expect(r.failed[0]!.reason).toBe("download failed (HTTP 500)");
    expect(h.pageRequests).toHaveLength(1);
  });

  test("the file list changing between the scan and the download pass fails those files, not the export", async () => {
    const h = harness(files, { pageSize: 2 });
    const inner = h.deps.fetchFn;
    let exportCalls = 0;
    h.deps.fetchFn = async (u, init) => {
      const res = await inner(u, init);
      if (u.startsWith("https://r2.test/") || ++exportCalls <= 2) return res;
      const body = (await res.json()) as { files: Array<{ path: string; md5: string }> };
      if (u.includes("cursor=2")) body.files[0]!.md5 = "0".repeat(32); // page 2, second pass: a file's hash moved
      return json(body);
    };
    const r = await run(h, path.join(tmp(), "out"));
    expect(r.written).toBe(3);
    expect(r.failed).toEqual([{ path: "f3.txt", reason: "the file list changed between requests" }]);
  });
});

// ─── 429 ─────────────────────────────────────────────────────────────────────

describe("rate limiting: wait Retry-After once, then report", () => {
  const one: FileSpec[] = [{ path: "a.txt", body: "a" }];

  test("a 429 with Retry-After: 3 sleeps 3000 ms once and then succeeds", async () => {
    const h = harness(one);
    h.pageFailures.push({ status: 429, headers: { "Retry-After": "3" } });
    const r = await run(h, path.join(tmp(), "out"));
    expect(h.slept).toEqual([3000]);
    expect(r.written).toBe(1);
    expect(h.pageRequests).toHaveLength(2);
  });

  test("a second 429 is reported, with a single sleep", async () => {
    const h = harness(one);
    h.pageFailures.push({ status: 429, headers: { "Retry-After": "2" } }, { status: 429, headers: { "Retry-After": "2" } });
    const base = tmp();
    await expect(run(h, path.join(base, "out"))).rejects.toThrow(/rate limited.*about 2s/);
    expect(h.slept).toEqual([2000]);
    expect(h.pageRequests).toHaveLength(2);
  });

  test("a Retry-After beyond the cap is reported without sleeping", async () => {
    const h = harness(one);
    h.pageFailures.push({ status: 429, headers: { "Retry-After": "600" } });
    await expect(run(h, path.join(tmp(), "out"))).rejects.toThrow(/about 600s/);
    expect(h.slept).toEqual([]);
  });

  test("a 429 without a usable Retry-After waits a short default", async () => {
    const h = harness(one);
    h.pageFailures.push({ status: 429 });
    await run(h, path.join(tmp(), "out"));
    expect(h.slept).toEqual([5000]);
  });

  test("other API errors (403 upgrade_required) pass through with the server's message", async () => {
    const h = harness(one);
    h.pageFailures.push({ status: 403, body: { error: "Exporting a non-live version requires a paid plan", code: "upgrade_required" } });
    await expect(run(h, path.join(tmp(), "out"), { version: 1 })).rejects.toThrow(/403.*paid plan/);
    expect(h.slept).toEqual([]);
  });
});

// ─── DW-2.4 ──────────────────────────────────────────────────────────────────

describe("DW-2.4: target directory rules", () => {
  const one: FileSpec[] = [{ path: "a.txt", body: "new" }];

  test("DW_2_4_a_non_empty_directory_without_overwrite_is_refused_before_any_request", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "keep.txt"), "mine");
    const h = harness(one);
    await expect(run(h, dir)).rejects.toThrow(/not empty.*overwrite: true/);
    expect(h.pageRequests).toEqual([]);
    expect(h.blobRequests).toEqual([]);
    expect(listAll(dir)).toEqual(["keep.txt"]);
  });

  test("a dotfile counts as non-empty", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".hidden"), "x");
    await expect(run(harness(one), dir)).rejects.toThrow(/not empty/);
  });

  test("overwrite:true exports into a non-empty directory, replaces same-path files and keeps others", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "keep.txt"), "mine");
    fs.writeFileSync(path.join(dir, "a.txt"), "old");
    const r = await run(harness(one), dir, { overwrite: true });
    expect(r.written).toBe(1);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(dir, "keep.txt"), "utf8")).toBe("mine");
    expect(listAll(dir)).toEqual(["a.txt", "keep.txt"]);
  });

  test("an existing empty directory is fine", async () => {
    const dir = tmp();
    expect((await run(harness(one), dir)).written).toBe(1);
  });

  test("a target that is a file is refused", async () => {
    const f = path.join(tmp(), "file");
    fs.writeFileSync(f, "x");
    const h = harness(one);
    await expect(run(h, f)).rejects.toThrow(/not a directory/);
    expect(h.pageRequests).toEqual([]);
  });

  test("a missing nested target is created", async () => {
    const dir = path.join(tmp(), "x", "y", "z");
    expect((await run(harness(one), dir)).written).toBe(1);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("new");
  });

  test("a symlinked target directory resolves and the report names the real directory", async () => {
    const base = tmp();
    const real = path.join(base, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(base, "link"));
    const r = await run(harness(one), path.join(base, "link"));
    expect(r.directory).toBe(real);
    expect(fs.existsSync(path.join(real, "a.txt"))).toBe(true);
  });

  test("a failed refused export does not create the missing target directory", async () => {
    const base = tmp();
    await expect(run(harness([{ path: "../x", body: "x" }]), path.join(base, "new"))).rejects.toThrow();
    expect(fs.existsSync(path.join(base, "new"))).toBe(false);
  });

  test.each([
    ["empty directory argument", { directory: "  " }],
    ["NUL in directory", { directory: "a\0b" }],
    ["empty slug", { slug: "" }],
    ["version 0", { version: 0 }],
    ["fractional version", { version: 1.5 }],
  ] as Array<[string, Partial<ExportArgs>]>)("invalid argument: %s", async (_l, extra) => {
    const h = harness(one);
    await expect(run(h, path.join(tmp(), "o"), extra)).rejects.toThrow();
    expect(h.pageRequests).toEqual([]);
  });
});

// ─── hostile / malformed API responses ───────────────────────────────────────

describe("hostile or malformed export responses", () => {
  async function withPage(mutate: (page: Record<string, unknown>) => void, expectMsg: RegExp): Promise<void> {
    const h = harness([{ path: "a.txt", body: "a" }]);
    const inner = h.deps.fetchFn;
    h.deps.fetchFn = async (u, init) => {
      const res = await inner(u, init);
      if (u.startsWith("https://r2.test/")) return res;
      const body = (await res.json()) as Record<string, unknown>;
      mutate(body);
      return json(body);
    };
    const base = tmp();
    await expect(run(h, path.join(base, "o"))).rejects.toThrow(expectMsg);
    expect(h.blobRequests).toEqual([]);
    expect(listAll(base)).toEqual([]);
  }
  const first = (b: Record<string, unknown>) => (b.files as Array<Record<string, unknown>>)[0]!;

  test("an entry without an md5", () => withPage((b) => delete first(b).md5, /malformed page/));
  test("an md5 that is not 32 lowercase hex", () => withPage((b) => (first(b).md5 = "../../etc"), /malformed page/));
  test("a negative size", () => withPage((b) => (first(b).size = -1), /malformed page/));
  test("a non-integer size", () => withPage((b) => (first(b).size = 1.5), /malformed page/));
  test("a file:// URL", () => withPage((b) => (first(b).url = "file:///etc/passwd"), /malformed page/));
  test("a plain http URL to a non-local host", () => withPage((b) => (first(b).url = "http://evil.test/x"), /malformed page/));
  test("a non-string path", () => withPage((b) => (first(b).path = 7), /malformed page/));
  test("files that is not an array", () => withPage((b) => (b.files = "nope"), /malformed page/));
  test("a missing expires_at", () => withPage((b) => delete b.expires_at, /malformed page/));
  test("a garbage next_cursor type", () => withPage((b) => (b.next_cursor = 5), /malformed page/));
  test("a version of 0", () => withPage((b) => (b.version = 0), /malformed page/));
  test("a page that is not an object", async () => {
    const h = harness([]);
    const dir = path.join(tmp(), "o");
    h.deps.fetchFn = async () => json([1, 2]);
    h.api = new ApiClient("https://api.test", async () => "t", h.deps.fetchFn);
    await expect(run(h, dir)).rejects.toThrow(/malformed page/);
  });

  test("a file_count that does not match what was listed", () => withPage((b) => (b.file_count = 5), /incomplete \(1 listed, 5 expected\)/));

  test("a repeated next_cursor aborts instead of looping", async () => {
    const h = harness([{ path: "a.txt", body: "a" }]);
    const inner = h.deps.fetchFn;
    h.deps.fetchFn = async (u, init) => {
      const res = await inner(u, init);
      if (u.startsWith("https://r2.test/")) return res;
      const body = (await res.json()) as Record<string, unknown>;
      body.next_cursor = "same";
      return json(body);
    };
    h.api = new ApiClient("https://api.test", async () => "t", h.deps.fetchFn);
    await expect(run(h, path.join(tmp(), "o"))).rejects.toThrow(/repeated a page cursor/);
  });

  test("a server that changes version between pages is refused in the download pass", async () => {
    const files = [{ path: "a.txt", body: "a" }, { path: "b.txt", body: "b" }];
    const h = harness(files, { pageSize: 1 });
    const inner = h.deps.fetchFn;
    let calls = 0;
    h.deps.fetchFn = async (u, init) => {
      const res = await inner(u, init);
      if (u.startsWith("https://r2.test/")) return res;
      calls++;
      if (calls <= 2) return res; // scan pass is consistent
      const body = (await res.json()) as Record<string, unknown>;
      body.version = 9;
      return json(body);
    };
    h.api = new ApiClient("https://api.test", async () => "t", h.deps.fetchFn);
    await expect(run(h, path.join(tmp(), "o"))).rejects.toThrow(/changed version|version 9/);
  });

  test("a redirecting blob response is refused by the fetch options (redirect: error) and timeouts are set", async () => {
    const h = harness([{ path: "a.txt", body: "a" }]);
    const seen: RequestInit[] = [];
    const inner = h.deps.fetchFn;
    h.deps.fetchFn = async (u, init) => {
      if (u.startsWith("https://r2.test/")) seen.push(init!);
      return inner(u, init);
    };
    await run(h, path.join(tmp(), "o"));
    expect(seen[0]!.redirect).toBe("error");
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  test("an empty body for an empty file writes a zero-byte file", async () => {
    const dir = path.join(tmp(), "o");
    const h = harness([{ path: "empty.txt", body: "" }]);
    h.blobOverride = () => new Response(null);
    const r = await run(h, dir);
    expect(r).toMatchObject({ written: 1, bytes: 0, failed: [] });
    expect(fs.statSync(path.join(dir, "empty.txt")).size).toBe(0);
  });
});

// ─── report ──────────────────────────────────────────────────────────────────

describe("formatExportResult", () => {
  const base = { slug: "s", version: 4, directory: "/d", fileCount: 3, written: 3, bytes: 2048 };

  test("success summary: counts, bytes, version", () => {
    const t = formatExportResult({ ...base, failed: [] });
    expect(t).toContain("Exported 's' v4 to /d");
    expect(t).toContain("Files written: 3 of 3 (2.0 KB)");
    expect(t).not.toContain("Failed");
  });

  test("failures are listed with JSON-quoted paths and capped at 20", () => {
    const failed = Array.from({ length: 25 }, (_, i) => ({ path: `f${i}\n.txt`, reason: `bad https://r2.test/b?sig=${SECRET}` }));
    const t = formatExportResult({ ...base, written: 0, failed });
    expect(t).toContain("finished with failures");
    expect(t).toContain("Failed: 25");
    expect(t).toContain('"f0\\n.txt"'); // control characters are escaped, not printed raw
    expect(t).toContain("...and 5 more");
    expect(t).not.toContain(SECRET);
    expect(t.split("\n").filter((l) => l.startsWith("  - "))).toHaveLength(20);
  });

  test("byte formatting spans B, KB and MB", () => {
    expect(formatExportResult({ ...base, bytes: 12, failed: [] })).toContain("(12 B)");
    expect(formatExportResult({ ...base, bytes: 5 * 1024 * 1024, failed: [] })).toContain("(5.0 MB)");
  });
});
