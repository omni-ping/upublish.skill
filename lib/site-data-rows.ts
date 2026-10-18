/**
 * Site data rows (the `data_rows` tool), operated as the owner through the
 * server-proxied admin channel:
 *
 *   list | export | archive | delete | create | put | import
 *
 * `export` streams the NDJSON body straight to a file; it never holds the
 * export in memory (a collection can hold up to 100,000 rows).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ApiClient } from "./api-client.ts";
import { guard, requireArg } from "./site-data-errors.ts";
import { parseAdminRow, parseArchiveResponse, parseDeleteRowResponse, parseImportResponse, parseRowList } from "./site-data-shape.ts";
import { safeText } from "./site-data-text.ts";
import { dataBase } from "./site-data.ts";
import { assertCollectionName, isValidRowId, SITE_DATA_LIMITS } from "./site-data-types.ts";
import type { AdminRow, ImportResponse, ImportRow, JsonObject } from "./site-data-types.ts";
import type { Namespace } from "./types.ts";

// ─── Args / results ──────────────────────────────────────────────────────────

/** Flat arguments; which are required depends on `action` (checked here). */
export interface DataRowsArgs {
  action: "list" | "export" | "archive" | "delete" | "create" | "put" | "import";
  namespace?: string;
  collection?: string;
  /** delete/put: the row id. */
  id?: string;
  /** create/put: the row's `data` object. */
  data?: JsonObject;
  /** list: page size 1..100. */
  limit?: number;
  /** list: `next_cursor` from the previous page. */
  cursor?: string;
  /** list/delete: restrict to an author's `identityKey` (e.g. `passcode:{id}`); required to delete an own-rows row. */
  author?: string;
  /** list: also return archived rows. */
  include_archived?: boolean;
  /** export: destination file path, must end in .ndjson or .jsonl (relative paths resolve against the working directory). */
  path?: string;
  /** export: allow replacing an existing destination file. */
  overwrite?: boolean;
  /** import: up to 500 rows with explicit authors and timestamps. */
  rows?: ImportRow[];
}

export type DataRowsResult =
  | { action: "list"; collection: string; rows: AdminRow[]; next_cursor: string | null }
  | { action: "export"; collection: string; path: string; rows: number; bytes: number }
  | { action: "archive"; collection: string; archived: number }
  | { action: "delete"; collection: string; id: string }
  | { action: "create" | "put"; collection: string; row: AdminRow }
  | ({ action: "import"; collection: string } & ImportResponse);

// ─── Validation ──────────────────────────────────────────────────────────────

/** Collection and row ids go into URL paths unescaped by encodeURIComponent (dots), so validate them first. */
const validCollection = (args: DataRowsArgs): string =>
  assertCollectionName(requireArg(args.collection, "collection", args.action));

function validRowId(id: string): string {
  if (!isValidRowId(id)) {
    throw new Error(`Invalid row id '${safeText(id)}': use 1-128 letters, digits and . _ ~ - (not '.' or '..').`);
  }
  return id;
}

// ─── Export ──────────────────────────────────────────────────────────────────

/** Counts newline-terminated lines (plus a final unterminated one) in the bytes passing through. */
function lineCounter() {
  const state = { lines: 0, bytes: 0, lastByte: 0x0a };
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, i + 1)) state.lines++;
      state.bytes += chunk.length;
      state.lastByte = chunk[chunk.length - 1] ?? state.lastByte;
      cb(null, chunk);
    },
  });
  return { stream, state };
}

/** Case-insensitive: `.NDJSON` is as clearly an export file as `.ndjson`. */
const EXPORT_EXTENSION = /\.(ndjson|jsonl)$/i;

const exists = async (p: string): Promise<boolean> =>
  fs.promises.lstat(p).then(() => true, (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return false;
    throw err;
  });

const partialExistsError = (partial: string): Error =>
  new Error(`'${safeText(partial)}' already exists: a previous export may be running or failed; remove ${safeText(partial)} first. Nothing was written.`);

/**
 * Streams a collection's NDJSON export (every row incl. archived) to `dest`.
 *
 * Safety: the destination must be a .ndjson/.jsonl file and is never replaced
 * unless `overwrite` is true. Data goes to `<dest>.partial`, created
 * exclusively (a pre-existing partial is refused and left alone, even with
 * `overwrite`) with mode 0600, then published: without `overwrite` by a hard
 * link, which fails instead of replacing a file that appeared meanwhile; with
 * `overwrite` by rename. A failure removes only the partial this call created.
 */
async function exportRows(apiClient: ApiClient, ns: Namespace, collection: string, dest: string, overwrite: boolean): Promise<DataRowsResult> {
  const target = path.resolve(dest);
  if (!EXPORT_EXTENSION.test(target)) {
    throw new Error(`export path must end in .ndjson or .jsonl (got '${safeText(dest)}'). Nothing was written.`);
  }
  const partial = `${target}.partial`;
  if (await exists(partial)) throw partialExistsError(partial);
  if (!overwrite && (await exists(target))) {
    throw new Error(`'${safeText(target)}' already exists. Choose another path, or pass overwrite: true to replace it. Nothing was written.`);
  }
  const response = await guard("admin", () => apiClient.getRaw(`${dataBase(ns.id)}/collections/${collection}/export`));
  if (!response.body) throw new Error("The export response had no body.");
  const counter = lineCounter();
  let createdPartial = true;
  try {
    await pipeline(
      // Not Readable.fromWeb: Bun's version can drop the last chunk of a closing stream.
      Readable.from(response.body, { objectMode: false }),
      counter.stream,
      fs.createWriteStream(partial, { flags: "wx", mode: 0o600 }),
    );
    if (overwrite) {
      await fs.promises.rename(partial, target);
    } else {
      await fs.promises.link(partial, target);
      await fs.promises.rm(partial);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" && (err as NodeJS.ErrnoException).syscall === "open") {
      createdPartial = false; // someone else's partial appeared after our check: leave it
      throw partialExistsError(partial);
    }
    if (createdPartial) await fs.promises.rm(partial, { force: true });
    if (code === "EEXIST") throw new Error(`'${safeText(target)}' appeared during the export and was not replaced. Pass overwrite: true to replace it.`);
    throw err;
  }
  const { lines, bytes, lastByte } = counter.state;
  return { action: "export", collection, path: target, rows: lastByte === 0x0a ? lines : lines + 1, bytes };
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Runs one `data_rows` action.
 * @throws SiteDataError on API failure; Error for a missing/invalid argument.
 */
export async function runDataRows(apiClient: ApiClient, ns: Namespace, args: DataRowsArgs): Promise<DataRowsResult> {
  const collection = validCollection(args);
  const base = `${dataBase(ns.id)}/collections/${collection}`;
  switch (args.action) {
    case "list": {
      const q = new URLSearchParams();
      if (args.limit !== undefined) {
        if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > SITE_DATA_LIMITS.maxPageSize) {
          throw new Error(`limit must be an integer from 1 to ${SITE_DATA_LIMITS.maxPageSize}.`);
        }
        q.set("limit", String(args.limit));
      }
      if (args.cursor !== undefined) q.set("cursor", args.cursor);
      if (args.author !== undefined) q.set("author", args.author);
      if (args.include_archived !== undefined) q.set("include_archived", String(args.include_archived));
      const qs = q.size > 0 ? `?${q}` : "";
      const res = await guard("admin", async () => parseRowList(await apiClient.get<unknown>(`${base}/rows${qs}`)));
      return { action: "list", collection, rows: res.rows, next_cursor: res.next_cursor };
    }
    case "export":
      return exportRows(apiClient, ns, collection, requireArg(args.path, "path", "export"), args.overwrite === true);
    case "archive": {
      const res = await guard("admin", async () => parseArchiveResponse(await apiClient.post<unknown>(`${base}/archive`, {})));
      return { action: "archive", collection, archived: res.archived };
    }
    case "delete": {
      const id = validRowId(requireArg(args.id, "id", "delete"));
      const qs = args.author !== undefined ? `?${new URLSearchParams({ author: args.author })}` : "";
      await guard("admin", async () => parseDeleteRowResponse(await apiClient.delete<unknown>(`${base}/rows/${id}${qs}`)));
      return { action: "delete", collection, id };
    }
    case "create": {
      const data = requireArg(args.data, "data", "create");
      const row = await guard("admin", async () => parseAdminRow(await apiClient.post<unknown>(`${base}/rows`, { data })));
      return { action: "create", collection, row };
    }
    case "put": {
      const id = validRowId(requireArg(args.id, "id", "put"));
      const data = requireArg(args.data, "data", "put");
      const row = await guard("admin", async () => parseAdminRow(await apiClient.put<unknown>(`${base}/rows/${id}`, { data })));
      return { action: "put", collection, row };
    }
    case "import": {
      const rows = requireArg(args.rows, "rows", "import");
      if (rows.length < 1 || rows.length > SITE_DATA_LIMITS.maxImportRowsPerCall) {
        throw new Error(`rows must contain 1 to ${SITE_DATA_LIMITS.maxImportRowsPerCall} rows per call; split larger imports into several calls.`);
      }
      rows.forEach((r) => validRowId(r.id));
      const res = await guard("owner", async () => parseImportResponse(await apiClient.post<unknown>(`${base}/import`, { rows })));
      return { action: "import", collection, ...res };
    }
  }
}
