/**
 * Site reference translation for site data.
 *
 * The server identifies sites by `site_id` (a UUID that survives renames) but
 * the AI knows sites by slug (including `_root`). This module is the only
 * place that knows both: inputs accept a slug or an id and are resolved to
 * ids; outputs show slugs wherever the id is still a live site.
 */

import type { ApiClient } from "./api-client.ts";
import { safeText } from "./site-data-text.ts";
import { listSites } from "./list.ts";
import type { ClaimMatcher, CollectionConfig, CollectionPatch } from "./site-data-types.ts";

/** Lookup tables for one namespace's current sites. */
export interface SiteDirectory {
  idBySlug: Map<string, string>;
  slugById: Map<string, string>;
}

/** Loads the namespace's sites. Throws on API failure. */
export async function loadSiteDirectory(apiClient: ApiClient, nsId: string): Promise<SiteDirectory> {
  const { sites } = await listSites(apiClient, nsId);
  return {
    idBySlug: new Map(sites.map((s) => [s.slug, s.id])),
    slugById: new Map(sites.map((s) => [s.id, s.slug])),
  };
}

/** Like loadSiteDirectory, but a listing failure degrades to an empty directory (ids are shown instead of slugs). */
export async function loadSiteDirectoryForDisplay(apiClient: ApiClient, nsId: string): Promise<SiteDirectory> {
  try {
    return await loadSiteDirectory(apiClient, nsId);
  } catch {
    return { idBySlug: new Map(), slugById: new Map() };
  }
}

/** Resolves a slug (or an existing site id) to a site id. Throws, naming the known slugs, when unknown. */
export function resolveSiteRef(dir: SiteDirectory, ref: string): string {
  const bySlug = dir.idBySlug.get(ref);
  if (bySlug !== undefined) return bySlug;
  if (dir.slugById.has(ref)) return ref;
  const known = [...dir.idBySlug.keys()].map(safeText).join(", ") || "(none published)";
  throw new Error(`Unknown site '${ref}'. Sites in this address: ${known}`);
}

const slugOf = (dir: SiteDirectory, id: string): string => dir.slugById.get(id) ?? id;

/** Resolves the `site` claim of passcode matchers; other matchers are unchanged. */
function mapMatchers(matchers: ClaimMatcher[], fn: (site: string) => string): ClaimMatcher[] {
  return matchers.map((m) => {
    const site = m.claims["site"];
    return m.kind === "passcode" && typeof site === "string" ? { ...m, claims: { ...m.claims, site: fn(site) } } : m;
  });
}

/** Rewrites every site reference in a patch/input (`sites` and passcode `site` claims) from slugs to ids. */
export function resolveConfigSites<T extends CollectionPatch>(dir: SiteDirectory, cfg: T): T {
  const resolve = (ref: string) => resolveSiteRef(dir, ref);
  const out: T = { ...cfg };
  if (cfg.sites) out.sites = cfg.sites.map(resolve);
  if (cfg.write_claims) out.write_claims = mapMatchers(cfg.write_claims, resolve);
  if (cfg.admin_claims) out.admin_claims = mapMatchers(cfg.admin_claims, resolve);
  return out;
}

/** Rewrites every site reference in a config from ids to slugs (unknown ids stay as ids). */
export function slugifyConfig<T extends Pick<CollectionConfig, "sites" | "write_claims" | "admin_claims">>(
  dir: SiteDirectory,
  cfg: T,
): T {
  const toSlug = (id: string) => slugOf(dir, id);
  return {
    ...cfg,
    sites: cfg.sites.map(toSlug),
    write_claims: mapMatchers(cfg.write_claims, toSlug),
    admin_claims: mapMatchers(cfg.admin_claims, toSlug),
  };
}
