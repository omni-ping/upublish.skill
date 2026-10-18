/**
 * DW-6.1: slug <-> site_id translation for site data.
 */

import { describe, it, expect } from "bun:test";
import {
  loadSiteDirectory, loadSiteDirectoryForDisplay, resolveConfigSites, resolveSiteRef, slugifyConfig,
} from "./site-data-sites.ts";
import { NS, SITE_FOR_HER, SITE_RESULTS, jsonResponse, makeClient, withSites } from "../tests/helpers/site-data.ts";
import type { ClaimMatcher } from "./site-data-types.ts";

const dir = async () => loadSiteDirectory(makeClient(withSites(() => undefined)).client, NS.id);

describe("DW-6.1: site directory", () => {
  it("test_DW_6_1_sites_load_maps_both_directions", async () => {
    const d = await dir();
    expect(d.idBySlug.get("for-her")).toBe(SITE_FOR_HER);
    expect(d.slugById.get(SITE_RESULTS)).toBe("results");
    expect(d.idBySlug.has("_root")).toBe(true);
  });

  it("test_DW_6_1_sites_display_load_degrades_to_empty_on_failure", async () => {
    const { client } = makeClient(() => jsonResponse(500, { error: "down", code: "unavailable" }));
    const d = await loadSiteDirectoryForDisplay(client, NS.id);
    expect(d.idBySlug.size).toBe(0);
    expect(d.slugById.size).toBe(0);
  });

  it("test_DW_6_1_sites_display_load_returns_directory_on_success", async () => {
    const { client } = makeClient(withSites(() => undefined));
    expect((await loadSiteDirectoryForDisplay(client, NS.id)).idBySlug.size).toBe(3);
  });
});

describe("DW-6.1: resolveSiteRef", () => {
  it("test_DW_6_1_sites_resolve_slug_id_and_root", async () => {
    const d = await dir();
    expect(resolveSiteRef(d, "for-her")).toBe(SITE_FOR_HER);
    expect(resolveSiteRef(d, SITE_RESULTS)).toBe(SITE_RESULTS);
    expect(resolveSiteRef(d, "_root")).toBe("5b0e3c1a-0000-4000-8000-00000000b003");
  });

  it("test_DW_6_1_sites_unknown_ref_lists_known_slugs", async () => {
    const d = await dir();
    expect(() => resolveSiteRef(d, "nope")).toThrow("Unknown site 'nope'. Sites in this address: for-her, results, _root");
  });

  it("test_DW_6_1_sites_unknown_ref_with_no_sites", async () => {
    const { client } = makeClient(() => jsonResponse(200, { sites: [] }));
    const d = await loadSiteDirectory(client, NS.id);
    expect(() => resolveSiteRef(d, "x")).toThrow("(none published)");
  });
});

describe("DW-6.1: config translation", () => {
  const passcode = (site: string): ClaimMatcher => ({ kind: "passcode", claims: { site, label: "her" } });

  it("test_DW_6_1_sites_resolve_config_sites_and_passcode_site_claims", async () => {
    const d = await dir();
    const out = resolveConfigSites(d, {
      sites: ["for-her", "results"],
      write_claims: [passcode("for-her")],
      admin_claims: [passcode("results"), { kind: "jwt", claims: { site: "keep-me", admin: true } }],
      max_rows: 5,
    });
    expect(out.sites).toEqual([SITE_FOR_HER, SITE_RESULTS]);
    expect(out.write_claims).toEqual([passcode(SITE_FOR_HER)]);
    // jwt matchers' claims are the token's, not site references.
    expect(out.admin_claims).toEqual([passcode(SITE_RESULTS), { kind: "jwt", claims: { site: "keep-me", admin: true } }]);
    expect(out.max_rows).toBe(5);
  });

  it("test_DW_6_1_sites_resolve_leaves_absent_fields_absent", async () => {
    const out = resolveConfigSites(await dir(), { max_rows: 5 });
    expect(out).toEqual({ max_rows: 5 });
  });

  it("test_DW_6_1_sites_resolve_unknown_site_in_claim_throws", async () => {
    expect(() => resolveConfigSites({ idBySlug: new Map(), slugById: new Map() }, { write_claims: [passcode("zzz")] })).toThrow("Unknown site 'zzz'");
  });

  it("test_DW_6_1_sites_slugify_renders_slugs_and_keeps_unknown_ids", async () => {
    const d = await dir();
    const out = slugifyConfig(d, {
      sites: [SITE_FOR_HER, "deleted-site-id"],
      write_claims: [passcode(SITE_FOR_HER)],
      admin_claims: [],
    });
    expect(out.sites).toEqual(["for-her", "deleted-site-id"]);
    expect(out.write_claims).toEqual([passcode("for-her")]);
  });
});

describe("review R-2: unknown-site error escapes server slugs", () => {
  it("test_R2_sites_unknown_ref_escapes_control_characters_in_known_slugs", () => {
    const dir = { idBySlug: new Map([["a\nb", "id1"]]), slugById: new Map([["id1", "a\nb"]]) };
    expect(() => resolveSiteRef(dir, "zzz")).toThrow('"a\\nb"');
  });
});
