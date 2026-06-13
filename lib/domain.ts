/**
 * Custom domains — connect/check/list/remove a domain you own, agent-driven.
 *
 * A single action-dispatch `domain` fn taking an injectable ApiClient, mirroring
 * lib/admin.ts (adminDomains) and lib/namespace.ts. Wraps the existing
 * space-level /api/domains endpoints — no backend change. These routes are NOT
 * namespace-scoped, so (unlike analytics/gate) no namespace is resolved; the core
 * wrapper builds the ApiClient and calls straight through.
 *
 * Hexagonal rule: this module takes an injected ApiClient and is re-exported via
 * lib/core.ts; adapters (mcp/index.ts) import only from core.
 *
 * Errors surface as thrown Errors with friendly, actionable messages (matching
 * lib/namespace.ts): ApiClient collapses non-2xx to
 * `API error <status>: <backend message>`; mapDomainError() rewrites the common
 * tier/quota/conflict/upstream cases so the adapter just renders `err.message`.
 *
 * DNS-record handling honors the Phase-4 backend shape:
 *   - apex hostname    ⇒ dns_instructions = { apex: A@→ip, www: CNAME→target }
 *   - subdomain        ⇒ dns_instructions = { cname: CNAME→target }
 * The add formatter renders whatever the server returns, so a subdomain yields a
 * SINGLE CNAME and never echoes an apex A-record (research §1 gotcha).
 */

import type { ApiClient } from "./api-client.ts";

// ─── Where custom domains live in the product (rendered into the add note). ───
const PRICING_URL = "https://upubli.sh/pricing";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** A custom domain record as returned by the API (toPublicDomain shape). */
export interface CustomDomain {
  id: string;
  hostname: string;
  verified: boolean;
  hostname_status?: string | null;
  ssl_status?: string | null;
  verified_at?: string | null;
  error_message?: string | null;
  cname_target?: string | null;
}

/** A single copy-paste DNS record for the customer to add at their registrar. */
export interface DnsRecord {
  type: "A" | "CNAME";
  /** The record name/host (e.g. "@", "www", "blog.example.com"). */
  name: string;
  /** The record value (an IP for A, a hostname for CNAME). */
  value: string;
}

/** One leg of the backend's dns_instructions object. */
interface DnsLeg {
  type: string;
  hostname: string;
  value: string;
}

interface AddDomainResponse {
  domain: CustomDomain;
  namespace: { id: string; name: string; domain: string; paused_at?: string | null };
  a_record_ip: string;
  dns_instructions:
    | { apex: DnsLeg; www: DnsLeg }
    | { cname: DnsLeg };
}

interface StatusResponse {
  domain: CustomDomain;
}

interface ListResponse {
  domains: CustomDomain[];
}

interface RemoveResponse {
  message: string;
}

// ─── Args / Results ──────────────────────────────────────────────────────────

export type DomainArgs =
  | { action: "add"; hostname: string }
  | { action: "status"; id: string }
  | { action: "list" }
  | { action: "remove"; id: string };

export interface DomainAddResult {
  action: "add";
  /** The hostname that was connected. */
  hostname: string;
  /** The DNS records the customer must add at their registrar (copy-paste). */
  records: DnsRecord[];
  /** The namespace this domain became. */
  namespace: { id: string; name: string; domain: string };
  /** Plain-language note: pro/max + becomes its own namespace. */
  note: string;
}

export interface DomainStatusResult {
  action: "status";
  hostname: string;
  /** true once the hostname AND SSL are active (verified). */
  active: boolean;
  /** Any provider validation errors (CAA, etc.), or null. */
  validationErrors: string | null;
}

export interface DomainListResult {
  action: "list";
  domains: CustomDomain[];
}

export interface DomainRemoveResult {
  action: "remove";
  message: string;
}

export type DomainResult =
  | DomainAddResult
  | DomainStatusResult
  | DomainListResult
  | DomainRemoveResult;

// ─── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Connect/check/list/remove a custom domain.
 *
 * @param apiClient - Authenticated API client.
 * @param args - Discriminated union of domain arguments (action + params).
 * @returns A discriminated result carrying the action field for narrowing.
 * @throws Error with a friendly message on API failure (mapped from the status).
 */
export async function domain(
  apiClient: ApiClient,
  args: DomainArgs,
): Promise<DomainResult> {
  try {
    switch (args.action) {
      case "add":
        return await add(apiClient, args.hostname);
      case "status":
        return await status(apiClient, args.id);
      case "list":
        return await list(apiClient);
      case "remove":
        return await remove(apiClient, args.id);
    }
  } catch (err) {
    throw mapDomainError(err as Error);
  }
}

// ─── Per-action handlers ───────────────────────────────────────────────────────

async function add(apiClient: ApiClient, hostname: string): Promise<DomainAddResult> {
  const res = await apiClient.post<AddDomainResponse>("/api/domains", { hostname });
  return {
    action: "add",
    hostname: res.domain.hostname,
    records: toRecords(res.dns_instructions),
    namespace: {
      id: res.namespace.id,
      name: res.namespace.name,
      domain: res.namespace.domain,
    },
    note:
      `Custom domains are a pro/max feature. "${res.domain.hostname}" becomes its own ` +
      `namespace — its landing page is at ${res.domain.hostname}/ and everything you ` +
      `publish to it serves at ${res.domain.hostname}/slug/. Add the DNS record(s) above ` +
      `at your registrar (only you can do that), then check status until it goes active. ` +
      `Plans: ${PRICING_URL}`,
  };
}

async function status(apiClient: ApiClient, id: string): Promise<DomainStatusResult> {
  const res = await apiClient.get<StatusResponse>(`/api/domains/${encodeURIComponent(id)}/status`);
  const d = res.domain;
  const active =
    d.verified === true ||
    !!d.verified_at ||
    (d.hostname_status === "active" && d.ssl_status === "active");
  return {
    action: "status",
    hostname: d.hostname,
    active,
    validationErrors: d.error_message ?? null,
  };
}

async function list(apiClient: ApiClient): Promise<DomainListResult> {
  const res = await apiClient.get<ListResponse>("/api/domains");
  return { action: "list", domains: res.domains };
}

async function remove(apiClient: ApiClient, id: string): Promise<DomainRemoveResult> {
  const res = await apiClient.delete<RemoveResponse>(`/api/domains/${encodeURIComponent(id)}`);
  return { action: "remove", message: res.message };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts the backend's dns_instructions into copy-paste DnsRecord rows.
 *
 * Renders exactly what the server returns, so the apex/subdomain branching from
 * Phase 4 is honored: a subdomain (`{ cname }`) yields a single CNAME and never
 * an apex A-record; an apex (`{ apex, www }`) yields the A + the www CNAME. The
 * record `name` is derived from the hostname leg (apex ⇒ "@", "www.<h>" ⇒ "www",
 * otherwise the leftmost label).
 */
function toRecords(
  instructions: { apex: DnsLeg; www: DnsLeg } | { cname: DnsLeg },
): DnsRecord[] {
  if ("cname" in instructions) {
    const leg = instructions.cname;
    return [{ type: "CNAME", name: recordName(leg), value: leg.value }];
  }
  return [
    { type: "A", name: recordName(instructions.apex), value: instructions.apex.value },
    { type: "CNAME", name: recordName(instructions.www), value: instructions.www.value },
  ];
}

/** Reduces a fully-qualified record host to the short name a registrar expects. */
function recordName(leg: DnsLeg): string {
  const labels = leg.hostname.split(".");
  // Apex A-record: the root host is the bare domain (2 labels) ⇒ "@".
  if (leg.type === "A" && labels.length === 2) return "@";
  // www / subdomain CNAME ⇒ leftmost label.
  return labels[0];
}

/**
 * Rewrites the common API failures into friendly, actionable text. ApiClient
 * collapses non-2xx to `API error <status>: <backend message>`; we key off the
 * status substring. Unmatched errors pass through unchanged (their backend text
 * is already actionable — e.g. 400 validation, 404 not-found, 410).
 */
function mapDomainError(err: Error): Error {
  const m = err.message;
  if (/API error 403/.test(m)) {
    return new Error(
      `Custom domains are a pro or max feature. Upgrade at ${PRICING_URL} to connect your own domain.`,
    );
  }
  if (/API error 429/.test(m)) {
    return new Error(
      "Cloudflare's custom-hostname quota is temporarily exceeded. Wait a moment and try again.",
    );
  }
  if (/API error 409/.test(m)) {
    return new Error("That hostname is already connected (or registered elsewhere on Cloudflare).");
  }
  if (/API error 502/.test(m)) {
    return new Error("Cloudflare is unreachable right now — try again in a moment.");
  }
  return err;
}
