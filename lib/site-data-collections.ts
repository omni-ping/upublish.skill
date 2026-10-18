/**
 * Site data collections (the `data_collection` tool): list | get | set | delete.
 *
 * Callers name sites by slug; the server wants site ids. Inputs are resolved
 * through `site-data-sites.ts` and outputs are rendered back to slugs, so the
 * AI never handles a site_id.
 *
 * `set` is one action over two server routes (POST create, PATCH update):
 * it tries PATCH first and, only when the collection does not exist, creates
 * it with POST. The result says which happened (`created`).
 */

import type { ApiClient } from "./api-client.ts";
import { guard, requireArg, SiteDataError } from "./site-data-errors.ts";
import { dataBase } from "./site-data.ts";
import { parseCollectionBody, parseCollectionList } from "./site-data-shape.ts";
import {
  loadSiteDirectory, loadSiteDirectoryForDisplay, resolveConfigSites, slugifyConfig,
} from "./site-data-sites.ts";
import { assertCollectionName } from "./site-data-types.ts";
import type { CollectionInput, CollectionPatch, CollectionView, WipeResponse } from "./site-data-types.ts";
import type { Namespace } from "./types.ts";

// ─── Args / results ──────────────────────────────────────────────────────────

/** Flat arguments; which are required depends on `action` (checked here). */
export interface DataCollectionArgs extends CollectionPatch {
  action: "list" | "get" | "set" | "delete";
  namespace?: string;
  /** get/set/delete: the collection name. */
  collection?: string;
}

/** Collections as returned to callers: `sites` and passcode `site` claims are slugs where known. */
export type DataCollectionResult =
  | { action: "list"; collections: CollectionView[] }
  | { action: "get"; collection: CollectionView }
  | { action: "set"; created: boolean; collection: CollectionView }
  | ({ action: "delete"; name: string } & WipeResponse);

const CREATE_FIELDS = ["rule", "sites", "writers"] as const;
const PATCH_FIELDS = [
  "rule", "sites", "writers", "per_identity_limit", "write_claims", "admin_claims",
  "max_rows", "max_row_bytes", "writes_per_min",
] as const;

const validName = (args: DataCollectionArgs): string =>
  assertCollectionName(requireArg(args.collection, "collection", args.action));

/** The mutable fields the caller actually supplied. */
function pickPatch(args: DataCollectionArgs): CollectionPatch {
  const patch: Record<string, unknown> = {};
  for (const f of PATCH_FIELDS) if (args[f] !== undefined) patch[f] = args[f];
  return patch as CollectionPatch;
}

async function setCollection(apiClient: ApiClient, ns: Namespace, args: DataCollectionArgs): Promise<DataCollectionResult> {
  const name = validName(args);
  const patch = pickPatch(args);
  if (Object.keys(patch).length === 0) {
    throw new Error(`Nothing to set: pass at least one of ${PATCH_FIELDS.join(", ")} (rule, sites and writers are required to create a new collection).`);
  }
  const dir = await loadSiteDirectory(apiClient, ns.id);
  const resolved = resolveConfigSites(dir, patch);
  const base = `${dataBase(ns.id)}/collections`;
  try {
    const view = await guard("owner", async () => parseCollectionBody(await apiClient.patch<unknown>(`${base}/${name}`, resolved)));
    return { action: "set", created: false, collection: slugifyConfig(dir, view) };
  } catch (err) {
    if (!(err instanceof SiteDataError) || err.code !== "collection_not_found") throw err;
  }
  const missing = CREATE_FIELDS.filter((f) => resolved[f] === undefined);
  if (missing.length > 0) {
    throw new Error(`Collection '${name}' does not exist; creating it requires ${missing.join(", ")}.`);
  }
  const input = { name, ...resolved } as CollectionInput;
  const view = await guard("owner", async () => parseCollectionBody(await apiClient.post<unknown>(base, input)));
  return { action: "set", created: true, collection: slugifyConfig(dir, view) };
}

/**
 * Runs one `data_collection` action.
 * @throws SiteDataError on API failure; Error for a missing/invalid argument or an unknown site.
 */
export async function runDataCollection(
  apiClient: ApiClient,
  ns: Namespace,
  args: DataCollectionArgs,
): Promise<DataCollectionResult> {
  const base = `${dataBase(ns.id)}/collections`;
  switch (args.action) {
    case "list": {
      const list = await guard("admin", async () => parseCollectionList(await apiClient.get<unknown>(base)));
      const dir = await loadSiteDirectoryForDisplay(apiClient, ns.id);
      return { action: "list", collections: list.map((c) => slugifyConfig(dir, c)) };
    }
    case "get": {
      const name = validName(args);
      const view = await guard("admin", async () => parseCollectionBody(await apiClient.get<unknown>(`${base}/${name}`)));
      const dir = await loadSiteDirectoryForDisplay(apiClient, ns.id);
      return { action: "get", collection: slugifyConfig(dir, view) };
    }
    case "set":
      return setCollection(apiClient, ns, args);
    case "delete": {
      const name = validName(args);
      const res = await guard("owner", () => apiClient.delete<WipeResponse>(`${base}/${name}`));
      return { action: "delete", name, ...res };
    }
  }
}
