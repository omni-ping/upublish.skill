/**
 * Text rendering of site-data results for the MCP adapter.
 *
 * Each `format*` takes the discriminated result of one tool and returns the
 * text the AI reads. They live in lib (re-exported by core.ts, like
 * `formatGateFields`) so the adapter stays a pass-through and the wording is
 * unit-tested.
 */

import { quoteText, safeText as t, hasControlChars, sanitizeOutput } from "./site-data-text.ts";
import type { DataCollectionResult } from "./site-data-collections.ts";
import type { DataJwtResult, DataResult } from "./site-data.ts";
import type { DataRowsResult } from "./site-data-rows.ts";
import type { AdminRow, BillingInterval, ClaimMatcher, CollectionConfig, CollectionStats, CollectionView, JwtIssuerConfig } from "./site-data-types.ts";

/** Cents as dollars, e.g. 200 -> "$2.00". */
const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

// ─── Output boundary ─────────────────────────────────────────────────────────
// Each exported formatter runs its text through `sanitizeOutput` last, so a
// control character that slipped past a per-field escape (or comes from JSON
// output such as row data: JSON.stringify leaves NEL, LS and PS raw) still
// cannot add a line. Per-field escaping remains responsible for `\n`.

// ─── data ────────────────────────────────────────────────────────────────────

function priceText(price: { month_cents: number | null; year_cents: number | null }, interval: BillingInterval | null): string {
  const month = price.month_cents === null ? null : `${usd(price.month_cents)}/month`;
  const year = price.year_cents === null ? null : `${usd(price.year_cents)}/year`;
  const shown = interval === "month" ? [month] : interval === "year" ? [year] : [month, year];
  return shown.filter(Boolean).join(" or ") || "price unavailable";
}

const NO_CHARGE_TEXT = "Enabling will not charge this account.";

const statsText = (s: CollectionStats | null): string =>
  s ? `${s.rows} rows, ${s.archived_rows} archived, ${s.bytes} bytes` : "stats unavailable";

function dataText(r: DataResult): string {
  switch (r.action) {
    case "status": {
      if (!r.available) return "Site data is not available for this account.";
      const s = r.status;
      const lines = [`Site data for '${t(r.namespace)}': ${s.entitled ? "ENABLED" : "not enabled"}${s.activating ? " (activating; can take up to a minute)" : ""}`];
      if (s.entitlement_source) lines.push(`Entitlement: ${t(s.entitlement_source)}`);
      if (s.billing.past_due) lines.push("Billing: PAST DUE");
      if (!s.entitled) {
        lines.push(s.billing.would_charge ? `Price if enabled: ${priceText(s.price, s.billing.interval)}` : NO_CHARGE_TEXT);
      }
      if (s.billing.wipe_after) lines.push(`Data is retained until ${t(s.billing.wipe_after)}, then permanently deleted.`);
      const names = Object.keys(s.collections);
      lines.push(names.length === 0 ? "Collections: none" : "Collections:");
      for (const n of names) {
        const c = s.collections[n]!;
        lines.push(`  ${t(n)} (${t(c.config.rule)}; sites: ${c.config.sites.map(t).join(", ")}; ${statsText(c.stats)})`);
      }
      if (s.stats_state === "unavailable") lines.push("Note: row statistics are temporarily unavailable.");
      if (s.kv.drift !== "none") lines.push(`Edge sync: ${t(s.kv.drift)} (it can lag by up to a minute after changes)`);
      lines.push(`JWT issuer: ${s.jwt_issuer ? t(s.jwt_issuer.issuer) : "none"}`);
      return lines.join("\n");
    }
    case "enable":
      if (r.state === "already_enabled") return "Site data is already enabled. Nothing was charged.";
      if (r.state === "consent_needed") {
        const cost = r.wouldCharge
          ? `Enabling site data is a paid add-on: ${priceText(r.price, r.interval)}, billed to match your subscription ` +
            `and charged now (prorated) on your existing payment method. NOTHING HAS BEEN CHARGED.`
          : `${NO_CHARGE_TEXT} NOTHING HAS BEEN CHARGED.`;
        return `${cost}\nAsk the user to confirm, then call data again with action 'enable' and accept_charge: true.`;
      }
      return (
        "Site data enabled." +
        (r.charge ? ` Charged ${usd(r.charge.price_cents)} (prorated, ${r.charge.interval}ly plan).` : " No charge (included with your account).") +
        (r.activating ? " It can take up to a minute to become active on your sites." : "")
      );
    case "disable":
      return `Site data disabled. Visitor access stops now. Data is retained until ${t(r.wipe_after)}, then permanently deleted.`;
    case "wipe":
      return `Deleted ALL site data for '${t(r.namespace)}': ${r.collections} collection(s), ${r.rows} row(s).`;
  }
}

// ─── data_collection ─────────────────────────────────────────────────────────

const matcherText = (m: ClaimMatcher): string =>
  `${t(m.kind)}{${Object.entries(m.claims).map(([k, v]) => `${t(k)}=${t(v)}`).join(", ")}}`;

const claimsText = (ms: ClaimMatcher[]): string => (ms.length === 0 ? "none" : ms.map(matcherText).join(" OR "));

function collectionText(name: string, c: CollectionConfig): string {
  return [
    `Collection '${t(name)}' (${t(c.rule)})`,
    `  Sites: ${c.sites.map(t).join(", ")}`,
    `  Writers: ${c.writers.map(t).join(", ")}`,
    `  Write claims: ${claimsText(c.write_claims)}`,
    `  Admin claims: ${claimsText(c.admin_claims)}`,
    `  Limits: max_rows ${c.max_rows}, max_row_bytes ${c.max_row_bytes}, writes_per_min ${c.writes_per_min}, per_identity_limit ${c.per_identity_limit ?? "none"}`,
  ].join("\n");
}

const viewText = (v: CollectionView): string => collectionText(v.name, v);

function collectionResultText(r: DataCollectionResult): string {
  switch (r.action) {
    case "list":
      return r.collections.length === 0 ? "No collections." : r.collections.map(viewText).join("\n\n");
    case "get":
      return viewText(r.collection);
    case "set":
      return `${r.created ? "Created" : "Updated"} collection '${t(r.collection.name)}'.\n${viewText(r.collection)}`;
    case "delete":
      return `Deleted collection '${t(r.name)}' and its data (${r.rows} row(s)).`;
  }
}

// ─── data_rows ───────────────────────────────────────────────────────────────

/**
 * `author:` is the copyable identity key (`kind:subject`) to pass as the
 * `author` argument; `label:` is display-only and never part of the key.
 * Both come from visitors or token issuers, so neither may add a line: the
 * label is always JSON-quoted, and a subject with control characters is
 * quoted and flagged as not copyable (a forged key would target other rows).
 */
const authorLines = (a: AdminRow["author"]): string => {
  const key = `${t(a.kind)}:`;
  const author = hasControlChars(a.subject)
    ? `${key}${quoteText(a.subject)}  (contains control characters: not copyable as an author key)`
    : `${key}${a.subject}`;
  return `  author: ${author}${a.label ? `\n  label: ${quoteText(a.label)}` : ""}`;
};

const rowText = (r: AdminRow): string =>
  `${t(r.id)}  ${t(r.created_at)}${r.archived_at ? "  ARCHIVED" : ""}\n${authorLines(r.author)}\n  ${JSON.stringify(r.data)}`;

function rowsText(r: DataRowsResult): string {
  switch (r.action) {
    case "list": {
      const body = r.rows.length === 0 ? `No rows in '${t(r.collection)}'.` : r.rows.map(rowText).join("\n");
      return r.next_cursor ? `${body}\n\nMore rows: pass cursor ${quoteText(r.next_cursor)}.` : body;
    }
    case "export":
      return `Exported ${r.rows} row(s) (including archived) from '${t(r.collection)}' to ${t(r.path)} (${r.bytes} bytes, NDJSON: one row per line).`;
    case "archive":
      return `Archived ${r.archived} active row(s) in '${t(r.collection)}'. They are kept as history and no longer count or show to visitors.`;
    case "delete":
      return `Deleted row '${t(r.id)}' from '${t(r.collection)}'.`;
    case "create":
    case "put":
      return `${r.action === "create" ? "Created" : "Saved"} row '${t(r.row.id)}' in '${t(r.collection)}'.\n${rowText(r.row)}`;
    case "import":
      return `Imported ${r.imported} row(s) into '${t(r.collection)}' (${r.skipped} skipped because the id already existed).`;
  }
}

// ─── data_jwt ────────────────────────────────────────────────────────────────

const issuerText = (j: JwtIssuerConfig): string =>
  `issuer ${t(j.issuer)}\n  jwks_uri ${t(j.jwks_uri)}\n  audience ${t(j.audience)}\n  algorithms ${j.algorithms.map(t).join(", ")}`;

function jwtText(r: DataJwtResult): string {
  return r.jwt_issuer ? `JWT issuer set:\n  ${issuerText(r.jwt_issuer)}` : "JWT issuer cleared. Visitors can no longer authenticate with a bearer token.";
}

export const formatDataResult = (r: DataResult): string => sanitizeOutput(dataText(r));
export const formatCollectionResult = (r: DataCollectionResult): string => sanitizeOutput(collectionResultText(r));
export const formatRowsResult = (r: DataRowsResult): string => sanitizeOutput(rowsText(r));
export const formatJwtResult = (r: DataJwtResult): string => sanitizeOutput(jwtText(r));
