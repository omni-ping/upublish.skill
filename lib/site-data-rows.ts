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
import { dataBase } from "./site-data.ts";
import { isValidCollectionName, isValidRowId, SITE_DATA_LIMITS } from "./site-data-types.ts";
import type { AdminRow, ImportResponse, ImportRow, JsonObject, RowList } from "./site-data-types.ts";
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
  /** export: destination file path (relative paths resolve against the working directory). */
  path?: string;
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
function validCollection(args: DataRowsArgs): string {
  const name = requireArg(args.collection, "collection", args.action);
  if (!isValidCollectionName(name)) throw new Error(`Invalid collection name '${name}'.`);
  return name;
}

function validRowId(id: string): string {
  if (!isValidRowId(id)) {
    throw new Error(`Invalid row id '${id}': use 1-128 letters, digits and . _ ~ - (not '.' or '..').`);
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

/**
 * Streams a collection's NDJSON export (every row incl. archived) to `dest`.
 * Writes to `<dest>.partial` and renames on success, so a failed or
 * interrupted export never leaves a truncated file at `dest`.
 */
async function exportRows(apiClient: ApiClient, ns: Namespace, collection: string, dest: string): Promise<DataRowsResult> {
  const target = path.resolve(dest);
  const response = await guard("admin", () => apiClient.getRaw(`${dataBase(ns.id)}/collections/${collection}/export`));
  if (!response.body) throw new Error("The export response had no body.");
  const partial = `${target}.partial`;
  const counter = lineCounter();
  try {
    await pipeline(
      // Not Readable.fromWeb: Bun's version can drop the last chunk of a closing stream.
      Readable.from(response.body, { objectMode: false }),
      counter.stream,
      fs.createWriteStream(partial),
    );
    await fs.promises.rename(partial, target);
  } catch (err) {
    await fs.promises.rm(partial, { force: true });
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
      const res = await guard("admin", () => apiClient.get<RowList>(`${base}/rows${qs}`));
      return { action: "list", collection, rows: res.rows, next_cursor: res.next_cursor };
    }
    case "export":
      return exportRows(apiClient, ns, collection, requireArg(args.path, "path", "export"));
    case "archive": {
      const res = await guard("admin", () => apiClient.post<{ archived: number }>(`${base}/archive`, {}));
      return { action: "archive", collection, archived: res.archived };
    }
    case "delete": {
      const id = validRowId(requireArg(args.id, "id", "delete"));
      const qs = args.author !== undefined ? `?${new URLSearchParams({ author: args.author })}` : "";
      await guard("admin", () => apiClient.delete<{ deleted: true }>(`${base}/rows/${id}${qs}`));
      return { action: "delete", collection, id };
    }
    case "create": {
      const data = requireArg(args.data, "data", "create");
      const row = await guard("admin", () => apiClient.post<AdminRow>(`${base}/rows`, { data }));
      return { action: "create", collection, row };
    }
    case "put": {
      const id = validRowId(requireArg(args.id, "id", "put"));
      const data = requireArg(args.data, "data", "put");
      const row = await guard("admin", () => apiClient.put<AdminRow>(`${base}/rows/${id}`, { data }));
      return { action: "put", collection, row };
    }
    case "import": {
      const rows = requireArg(args.rows, "rows", "import");
      if (rows.length < 1 || rows.length > SITE_DATA_LIMITS.maxImportRowsPerCall) {
        throw new Error(`rows must contain 1 to ${SITE_DATA_LIMITS.maxImportRowsPerCall} rows per call; split larger imports into several calls.`);
      }
      rows.forEach((r) => validRowId(r.id));
      const res = await guard("owner", () => apiClient.post<ImportResponse>(`${base}/import`, { rows }));
      return { action: "import", collection, ...res };
    }
  }
}
