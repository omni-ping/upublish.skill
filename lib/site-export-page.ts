/**
 * Site export: parsing and requesting listing pages. The export API's responses are external input, so every
 * field is shape-checked here before anything else in the export trusts it.
 */

import type { ApiClient } from "./api-client.ts";
import { ApiError } from "./api-client.ts";
import { log } from "./log.ts";

export interface ExportEntry {
  path: string;
  size: number;
  md5: string;
  url: string;
}

export interface ExportPage {
  version: number;
  fileCount: number;
  files: ExportEntry[];
  nextCursor: string | null;
  expiresAtMs: number;
}

/** Longest Retry-After we are willing to sleep through; a longer one is reported instead. */
const MAX_RETRY_WAIT_S = 120;
const DEFAULT_RETRY_WAIT_S = 5;
const MD5_RE = /^[0-9a-f]{32}$/;

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function urlOk(u: unknown): u is string {
  if (typeof u !== "string") return false;
  try {
    const url = new URL(u);
    if (url.username || url.password) return false; // no embedded credentials / host-confusion (https://good@evil)
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

function parsePage(raw: unknown): ExportPage {
  const bad = (why: string): never => {
    throw new Error(`The export API returned a malformed page (${why}).`);
  };
  if (typeof raw !== "object" || raw === null) return bad("not an object");
  const r = raw as Record<string, unknown>;
  if (!isInt(r.version) || r.version < 1) bad("version");
  if (!isInt(r.file_count)) bad("file_count");
  if (!Array.isArray(r.files)) bad("files");
  if (r.next_cursor !== null && (typeof r.next_cursor !== "string" || r.next_cursor === "")) bad("next_cursor");
  const expiresAtMs = typeof r.expires_at === "string" ? Date.parse(r.expires_at) : NaN;
  if (Number.isNaN(expiresAtMs)) bad("expires_at");
  const files: ExportEntry[] = (r.files as unknown[]).map((f) => {
    const e = (typeof f === "object" && f !== null ? f : {}) as Record<string, unknown>;
    // The path is validated separately (with a precise reason) by the caller; only the shape is checked here.
    if (typeof e.path !== "string" || !isInt(e.size) || typeof e.md5 !== "string" || !MD5_RE.test(e.md5) || !urlOk(e.url)) {
      return bad("a file entry has a missing or invalid field");
    }
    return { path: e.path, size: e.size, md5: e.md5, url: e.url };
  });
  return { version: r.version as number, fileCount: r.file_count as number, files, nextCursor: r.next_cursor as string | null, expiresAtMs };
}

// ─── Page requests ───────────────────────────────────────────────────────────

export async function fetchPage(
  api: ApiClient,
  nsId: string,
  slug: string,
  q: { version?: number; cursor?: string },
  deps: { sleep: (ms: number) => Promise<void> },
): Promise<ExportPage> {
  const params = new URLSearchParams();
  if (q.version !== undefined) params.set("version", String(q.version));
  if (q.cursor !== undefined) params.set("cursor", q.cursor);
  const qs = params.toString() ? `?${params}` : "";
  const url = `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/export${qs}`;
  for (let attempt = 0; ; attempt++) {
    try {
      return parsePage(await api.get<unknown>(url));
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 429) throw err;
      const wait = err.retryAfterSeconds ?? DEFAULT_RETRY_WAIT_S;
      if (attempt >= 1 || wait > MAX_RETRY_WAIT_S) {
        throw new Error(`Export is rate limited; try again in about ${wait}s.`);
      }
      log(`[export] rate limited; waiting ${wait}s`);
      await deps.sleep(wait * 1000);
    }
  }
}

