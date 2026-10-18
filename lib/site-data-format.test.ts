/**
 * DW-6.1: text rendering of site-data results.
 */

import { describe, it, expect } from "bun:test";
import { formatCollectionResult, formatDataResult, formatJwtResult, formatRowsResult } from "./site-data-format.ts";
import type { CollectionView, DataStatus } from "./site-data-types.ts";
import { fixtureResponse, loadRoute } from "../tests/helpers/site-data.ts";

const status = fixtureResponse(loadRoute("api.status"), "enabled").body as DataStatus;
const view = fixtureResponse(loadRoute("api.get_collection"), "found").body as CollectionView;
const row = { id: "item-17", author: { kind: "passcode" as const, subject: "p1", label: "her" }, data: { val: "y" }, created_at: "2026-10-18T12:00:00.000Z", updated_at: "x", archived_at: null };

describe("DW-6.1: formatDataResult", () => {
  it("test_DW_6_1_format_status_unavailable_does_not_advertise", () => {
    expect(formatDataResult({ action: "status", available: false })).toBe("Site data is not available for this account.");
  });

  it("test_DW_6_1_format_status_enabled_lists_collections_and_issuer", () => {
    const out = formatDataResult({ action: "status", available: true, namespace: "ryan", status });
    expect(out).toContain("Site data for 'ryan': ENABLED");
    expect(out).toContain("Entitlement: paid");
    expect(out).toContain("votes (own-rows; sites: ");
    expect(out).toContain("JWT issuer: none");
  });

  it("test_DW_6_1_format_status_not_enabled_shows_price_and_flags", () => {
    const s: DataStatus = {
      ...status, entitled: false, entitlement_source: null, activating: true, collections: {}, stats_state: "unavailable",
      kv: { drift: "stale", checked_at: null },
      billing: { ...status.billing, past_due: true, wipe_after: "2026-11-17T00:00:00.000Z", interval: null },
      jwt_issuer: { issuer: "https://i", jwks_uri: "https://i/j", audience: "a", algorithms: ["ES256"] },
    };
    const out = formatDataResult({ action: "status", available: true, namespace: "ryan", status: s });
    expect(out).toContain("not enabled (activating");
    expect(out).toContain("Billing: PAST DUE");
    expect(out).toContain("Price if enabled: $2.00/month or $20.00/year");
    expect(out).toContain("retained until 2026-11-17");
    expect(out).toContain("Collections: none");
    expect(out).toContain("row statistics are temporarily unavailable");
    expect(out).toContain("Edge sync: stale");
    expect(out).toContain("JWT issuer: https://i");
  });

  it("test_DW_6_1_format_status_collection_without_stats", () => {
    const s: DataStatus = { ...status, collections: { votes: { config: status.collections["votes"]!.config, stats: null } } };
    expect(formatDataResult({ action: "status", available: true, namespace: "r", status: s })).toContain("stats unavailable");
  });

  it("test_DW_6_1_format_enable_consent_needed_says_nothing_charged_and_how_to_confirm", () => {
    const out = formatDataResult({ action: "enable", state: "consent_needed", price: { month_cents: 200, year_cents: 2000 }, interval: null });
    expect(out).toContain("$2.00/month or $20.00/year");
    expect(out).toContain("NOTHING HAS BEEN CHARGED");
    expect(out).toContain("accept_charge: true");
  });

  it("test_DW_6_1_format_enable_consent_price_follows_known_interval_and_missing_prices", () => {
    const p = { month_cents: 200, year_cents: 2000 };
    expect(formatDataResult({ action: "enable", state: "consent_needed", price: p, interval: "year" })).toContain("$20.00/year,");
    expect(formatDataResult({ action: "enable", state: "consent_needed", price: p, interval: "month" })).not.toContain("/year");
    expect(formatDataResult({ action: "enable", state: "consent_needed", price: { month_cents: null, year_cents: null }, interval: null })).toContain("price unavailable");
  });

  it("test_DW_6_1_format_enable_outcomes", () => {
    expect(formatDataResult({ action: "enable", state: "already_enabled" })).toContain("already enabled");
    const paid = formatDataResult({ action: "enable", state: "enabled", activating: true, charge: { interval: "month", price_cents: 140 } });
    expect(paid).toContain("Charged $1.40 (prorated, monthly plan)");
    expect(paid).toContain("up to a minute");
    const comped = formatDataResult({ action: "enable", state: "enabled", activating: false, charge: null });
    expect(comped).toContain("No charge");
    expect(comped).not.toContain("up to a minute");
  });

  it("test_DW_6_1_format_disable_and_wipe", () => {
    expect(formatDataResult({ action: "disable", entitled: false, wipe_after: "2026-11-17T12:00:00.000Z" })).toContain("retained until 2026-11-17T12:00:00.000Z, then permanently deleted");
    expect(formatDataResult({ action: "wipe", namespace: "ryan", collections: 2, rows: 5 })).toBe("Deleted ALL site data for 'ryan': 2 collection(s), 5 row(s).");
  });
});

describe("DW-6.1: formatCollectionResult", () => {
  it("test_DW_6_1_format_collection_view_shows_rule_claims_and_limits", () => {
    const out = formatCollectionResult({ action: "get", collection: view });
    expect(out).toContain("Collection 'votes' (own-rows)");
    expect(out).toContain("Write claims: passcode{site=5b0e3c1a-0000-4000-8000-00000000b001, label=her}");
    expect(out).toContain("max_rows 10000, max_row_bytes 16384, writes_per_min 60, per_identity_limit none");
  });

  it("test_DW_6_1_format_collection_list_set_delete", () => {
    expect(formatCollectionResult({ action: "list", collections: [] })).toBe("No collections.");
    expect(formatCollectionResult({ action: "list", collections: [view, { ...view, name: "b", write_claims: [], per_identity_limit: 1 }] })).toContain("Collection 'b'");
    expect(formatCollectionResult({ action: "set", created: true, collection: { ...view, write_claims: [] } })).toMatch(/^Created collection 'votes'\.[\s\S]*Write claims: none/);
    expect(formatCollectionResult({ action: "set", created: false, collection: view })).toMatch(/^Updated collection/);
    expect(formatCollectionResult({ action: "delete", name: "votes", collections: 1, rows: 49 })).toBe("Deleted collection 'votes' and its data (49 row(s)).");
  });
});

describe("DW-6.1: formatRowsResult", () => {
  it("test_DW_6_1_format_rows_list_with_cursor_and_empty", () => {
    const out = formatRowsResult({ action: "list", collection: "votes", rows: [row, { ...row, id: "z", archived_at: "t", author: { kind: "owner", subject: "u" } }], next_cursor: "c2" });
    expect(out).toContain('item-17  by passcode:p1 (her)  2026-10-18T12:00:00.000Z\n  {"val":"y"}');
    expect(out).toContain("by owner:u");
    expect(out).toContain("ARCHIVED");
    expect(out).toContain('pass cursor "c2"');
    expect(formatRowsResult({ action: "list", collection: "votes", rows: [], next_cursor: null })).toBe("No rows in 'votes'.");
  });

  it("test_DW_6_1_format_rows_other_actions", () => {
    expect(formatRowsResult({ action: "export", collection: "votes", path: "/tmp/v.ndjson", rows: 3, bytes: 99 })).toContain("Exported 3 row(s) (including archived) from 'votes' to /tmp/v.ndjson");
    expect(formatRowsResult({ action: "archive", collection: "votes", archived: 4 })).toContain("Archived 4 active row(s)");
    expect(formatRowsResult({ action: "delete", collection: "votes", id: "x" })).toBe("Deleted row 'x' from 'votes'.");
    expect(formatRowsResult({ action: "create", collection: "votes", row })).toContain("Created row 'item-17'");
    expect(formatRowsResult({ action: "put", collection: "votes", row })).toContain("Saved row 'item-17'");
    expect(formatRowsResult({ action: "import", collection: "votes", imported: 2, skipped: 1 })).toContain("Imported 2 row(s) into 'votes' (1 skipped");
  });
});

describe("DW-6.1: formatJwtResult", () => {
  it("test_DW_6_1_format_jwt_set_and_clear", () => {
    const out = formatJwtResult({ action: "set", jwt_issuer: { issuer: "https://i", jwks_uri: "https://i/j", audience: "aud", algorithms: ["ES256", "RS256"] } });
    expect(out).toContain("issuer https://i");
    expect(out).toContain("algorithms ES256, RS256");
    expect(formatJwtResult({ action: "clear", jwt_issuer: null })).toContain("cleared");
  });
});
