/**
 * Text rendering of site-data results for the MCP adapter.
 *
 * Each `format*` takes the discriminated result of one tool and returns the
 * text the AI reads. They live in lib (re-exported by core.ts, like
 * `formatGateFields`) so the adapter stays a pass-through and the wording is
 * unit-tested.
 */

import type { DataCollectionResult } from "./site-data-collections.ts";
import type { DataJwtResult, DataResult } from "./site-data.ts";
import type { DataRowsResult } from "./site-data-rows.ts";
import type { AdminRow, BillingInterval, ClaimMatcher, CollectionConfig, CollectionStats, CollectionView, JwtIssuerConfig } from "./site-data-types.ts";

/** Cents as dollars, e.g. 200 -> "$2.00". */
const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

// ─── data ────────────────────────────────────────────────────────────────────

function priceText(price: { month_cents: number | null; year_cents: number | null }, interval: BillingInterval | null): string {
  const month = price.month_cents === null ? null : `${usd(price.month_cents)}/month`;
  const year = price.year_cents === null ? null : `${usd(price.year_cents)}/year`;
  const shown = interval === "month" ? [month] : interval === "year" ? [year] : [month, year];
  return shown.filter(Boolean).join(" or ") || "price unavailable";
}

const statsText = (s: CollectionStats | null): string =>
  s ? `${s.rows} rows, ${s.archived_rows} archived, ${s.bytes} bytes` : "stats unavailable";

export function formatDataResult(r: DataResult): string {
  switch (r.action) {
    case "status": {
      if (!r.available) return "Site data is not available for this account.";
      const s = r.status;
      const lines = [`Site data for '${r.namespace}': ${s.entitled ? "ENABLED" : "not enabled"}${s.activating ? " (activating; can take up to a minute)" : ""}`];
      if (s.entitlement_source) lines.push(`Entitlement: ${s.entitlement_source}`);
      if (s.billing.past_due) lines.push("Billing: PAST DUE");
      if (!s.entitled) lines.push(`Price if enabled: ${priceText(s.price, s.billing.interval)}`);
      if (s.billing.wipe_after) lines.push(`Data is retained until ${s.billing.wipe_after}, then permanently deleted.`);
      const names = Object.keys(s.collections);
      lines.push(names.length === 0 ? "Collections: none" : "Collections:");
      for (const n of names) {
        const c = s.collections[n]!;
        lines.push(`  ${n} (${c.config.rule}; sites: ${c.config.sites.join(", ")}; ${statsText(c.stats)})`);
      }
      if (s.stats_state === "unavailable") lines.push("Note: row statistics are temporarily unavailable.");
      if (s.kv.drift !== "none") lines.push(`Edge sync: ${s.kv.drift} (it can lag by up to a minute after changes)`);
      lines.push(`JWT issuer: ${s.jwt_issuer ? s.jwt_issuer.issuer : "none"}`);
      return lines.join("\n");
    }
    case "enable":
      if (r.state === "already_enabled") return "Site data is already enabled. Nothing was charged.";
      if (r.state === "consent_needed") {
        return (
          `Enabling site data is a paid add-on: ${priceText(r.price, r.interval)}, billed to match your subscription ` +
          `and charged now (prorated) on your existing payment method. NOTHING HAS BEEN CHARGED.\n` +
          `Ask the user to confirm, then call data again with action 'enable' and accept_charge: true.`
        );
      }
      return (
        "Site data enabled." +
        (r.charge ? ` Charged ${usd(r.charge.price_cents)} (prorated, ${r.charge.interval}ly plan).` : " No charge (included with your account).") +
        (r.activating ? " It can take up to a minute to become active on your sites." : "")
      );
    case "disable":
      return `Site data disabled. Visitor access stops now. Data is retained until ${r.wipe_after}, then permanently deleted.`;
    case "wipe":
      return `Deleted ALL site data for '${r.namespace}': ${r.collections} collection(s), ${r.rows} row(s).`;
  }
}

// ─── data_collection ─────────────────────────────────────────────────────────

const matcherText = (m: ClaimMatcher): string =>
  `${m.kind}{${Object.entries(m.claims).map(([k, v]) => `${k}=${v}`).join(", ")}}`;

const claimsText = (ms: ClaimMatcher[]): string => (ms.length === 0 ? "none" : ms.map(matcherText).join(" OR "));

function collectionText(name: string, c: CollectionConfig): string {
  return [
    `Collection '${name}' (${c.rule})`,
    `  Sites: ${c.sites.join(", ")}`,
    `  Writers: ${c.writers.join(", ")}`,
    `  Write claims: ${claimsText(c.write_claims)}`,
    `  Admin claims: ${claimsText(c.admin_claims)}`,
    `  Limits: max_rows ${c.max_rows}, max_row_bytes ${c.max_row_bytes}, writes_per_min ${c.writes_per_min}, per_identity_limit ${c.per_identity_limit ?? "none"}`,
  ].join("\n");
}

const viewText = (v: CollectionView): string => collectionText(v.name, v);

export function formatCollectionResult(r: DataCollectionResult): string {
  switch (r.action) {
    case "list":
      return r.collections.length === 0 ? "No collections." : r.collections.map(viewText).join("\n\n");
    case "get":
      return viewText(r.collection);
    case "set":
      return `${r.created ? "Created" : "Updated"} collection '${r.collection.name}'.\n${viewText(r.collection)}`;
    case "delete":
      return `Deleted collection '${r.name}' and its data (${r.rows} row(s)).`;
  }
}

// ─── data_rows ───────────────────────────────────────────────────────────────

const authorText = (a: AdminRow["author"]): string => `${a.kind}:${a.subject}${a.label ? ` (${a.label})` : ""}`;

const rowText = (r: AdminRow): string =>
  `${r.id}  by ${authorText(r.author)}  ${r.created_at}${r.archived_at ? "  ARCHIVED" : ""}\n  ${JSON.stringify(r.data)}`;

export function formatRowsResult(r: DataRowsResult): string {
  switch (r.action) {
    case "list": {
      const body = r.rows.length === 0 ? `No rows in '${r.collection}'.` : r.rows.map(rowText).join("\n");
      return r.next_cursor ? `${body}\n\nMore rows: pass cursor "${r.next_cursor}".` : body;
    }
    case "export":
      return `Exported ${r.rows} row(s) (including archived) from '${r.collection}' to ${r.path} (${r.bytes} bytes, NDJSON: one row per line).`;
    case "archive":
      return `Archived ${r.archived} active row(s) in '${r.collection}'. They are kept as history and no longer count or show to visitors.`;
    case "delete":
      return `Deleted row '${r.id}' from '${r.collection}'.`;
    case "create":
    case "put":
      return `${r.action === "create" ? "Created" : "Saved"} row '${r.row.id}' in '${r.collection}'.\n${rowText(r.row)}`;
    case "import":
      return `Imported ${r.imported} row(s) into '${r.collection}' (${r.skipped} skipped because the id already existed).`;
  }
}

// ─── data_jwt ────────────────────────────────────────────────────────────────

const issuerText = (j: JwtIssuerConfig): string =>
  `issuer ${j.issuer}\n  jwks_uri ${j.jwks_uri}\n  audience ${j.audience}\n  algorithms ${j.algorithms.join(", ")}`;

export function formatJwtResult(r: DataJwtResult): string {
  return r.jwt_issuer ? `JWT issuer set:\n  ${issuerText(r.jwt_issuer)}` : "JWT issuer cleared. Visitors can no longer authenticate with a bearer token.";
}
