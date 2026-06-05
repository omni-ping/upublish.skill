/**
 * Admin domain module.
 *
 * Provides operator-level admin operations: user lookup/inspect/suspend/ban,
 * site block/unblock, platform stats, storage sweep/resync, and domain management.
 *
 * All functions accept an authenticated ApiClient and never read credentials
 * directly — credential wiring is the responsibility of lib/core.ts.
 *
 * Throws on API errors (propagated from ApiClient). 403 responses surface as
 * Error("403 ...") messages — MCP handlers catch and return errResponse().
 *
 * Requires admin role on the authenticated user. Non-admin callers receive
 * a 403 from the API which propagates as a thrown Error with the 403 message.
 */

import type { ApiClient } from "./api-client.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Admin user summary (lookup result). */
export interface AdminUserSummary {
  id: string;
  email: string;
  username: string;
  role: string;
  status: string;
  status_reason: string | null;
  status_changed_at: string | null;
}

/** Admin user inspect result — full user context. */
export interface AdminUserInspect {
  user: {
    id: string;
    email: string;
    username: string;
    role: string;
    status: string;
    status_reason: string | null;
    created_at: string;
  };
  space: { tier: string } | null;
  storage_bytes: number;
  namespaces: Array<{ name: string; domain: string; paused_at: string | null }>;
  sites: Array<{
    slug: string;
    namespace: string;
    total_size: number;
    visibility: string;
    blocked_at: string | null;
  }>;
  stripe_customer_id: string | null;
  last_activity: string;
}

/** Result of a status change (suspend/ban/reinstate). */
export interface AdminStatusResult {
  id: string;
  status: string;
  status_reason: string | null;
  status_changed_at: string;
  reconcile?: { written: number; verified: number; failed: string[] };
}

/** Result of a role change. */
export interface AdminRoleResult {
  id: string;
  role: string;
}

/** Result of a site block/unblock. */
export interface AdminSiteBlockResult {
  site: {
    id: string;
    blocked_at: string | null;
    [key: string]: unknown;
  };
}

/** Platform stats. */
export interface AdminStats {
  users_by_tier: Record<string, number>;
  users_by_status: Record<string, number>;
  site_count: number;
  namespace_count: number;
  total_storage_bytes: number;
  blob_dedup_ratio: number;
}

/** Storage sweep report. */
export interface AdminSweepReport {
  dry_run: boolean;
  orphaned_blobs: string[];
  abandoned_prefixes: string[];
  deleted_bytes: number;
}

/** KV resync report. */
export interface AdminResyncReport {
  written: number;
  verified: number;
  failed: string[];
}

/** Domain entry. */
export interface AdminDomain {
  id: string;
  hostname: string;
  access_policy: string;
  namespace_count: number;
}

// ─── Discriminated union args ─────────────────────────────────────────────────

export type AdminUserArgs =
  | { action: "lookup"; email: string }
  | { action: "inspect"; userId: string }
  | { action: "role"; userId: string; role: "user" | "admin" }
  | { action: "suspend"; userId: string; reason?: string }
  | { action: "ban"; userId: string; reason?: string }
  | { action: "reinstate"; userId: string };

export type AdminSiteArgs =
  | { action: "block"; siteId: string; reason?: string }
  | { action: "unblock"; siteId: string };

export type AdminStorageArgs =
  | { action: "sweep"; dryRun?: boolean; graceSeconds?: number }
  | { action: "resync"; scope: "site" | "user" | "all"; id?: string };

export type AdminDomainsArgs =
  | { action: "list" }
  | { action: "add"; hostname: string; accessPolicy: string }
  | { action: "remove"; domainId: string };

// ─── adminUser ────────────────────────────────────────────────────────────────

/**
 * Dispatches user admin operations: lookup, inspect, role, suspend, ban, reinstate.
 *
 * @param apiClient - Authenticated API client (must have admin role).
 * @param args - Discriminated union of user admin arguments.
 * @returns The result appropriate to the action.
 * @throws Error on API failure (including 403 for non-admin callers).
 */
export async function adminUser(
  apiClient: ApiClient,
  args: AdminUserArgs,
): Promise<AdminUserSummary | AdminUserInspect | AdminStatusResult | AdminRoleResult> {
  switch (args.action) {
    case "lookup": {
      const qs = `?email=${encodeURIComponent(args.email)}`;
      return apiClient.get<AdminUserSummary>(`/api/admin/users${qs}`);
    }
    case "inspect": {
      return apiClient.get<AdminUserInspect>(`/api/admin/users/${args.userId}/inspect`);
    }
    case "role": {
      return apiClient.patch<AdminRoleResult>(`/api/admin/users/${args.userId}/role`, {
        role: args.role,
      });
    }
    case "suspend": {
      const body: Record<string, unknown> = { status: "suspended" };
      if (args.reason !== undefined) body.reason = args.reason;
      return apiClient.patch<AdminStatusResult>(`/api/admin/users/${args.userId}/status`, body);
    }
    case "ban": {
      const body: Record<string, unknown> = { status: "banned" };
      if (args.reason !== undefined) body.reason = args.reason;
      return apiClient.patch<AdminStatusResult>(`/api/admin/users/${args.userId}/status`, body);
    }
    case "reinstate": {
      return apiClient.patch<AdminStatusResult>(`/api/admin/users/${args.userId}/status`, {
        status: "active",
      });
    }
  }
}

// ─── adminSite ────────────────────────────────────────────────────────────────

/**
 * Dispatches site admin operations: block, unblock.
 *
 * @param apiClient - Authenticated API client (must have admin role).
 * @param args - Discriminated union of site admin arguments.
 * @returns The site block result.
 * @throws Error on API failure (including 403 for non-admin callers).
 */
export async function adminSite(
  apiClient: ApiClient,
  args: AdminSiteArgs,
): Promise<AdminSiteBlockResult> {
  switch (args.action) {
    case "block": {
      const body: Record<string, unknown> = { blocked: true };
      if (args.reason !== undefined) body.reason = args.reason;
      return apiClient.patch<AdminSiteBlockResult>(`/api/admin/sites/${args.siteId}/block`, body);
    }
    case "unblock": {
      return apiClient.patch<AdminSiteBlockResult>(`/api/admin/sites/${args.siteId}/block`, {
        blocked: false,
      });
    }
  }
}

// ─── adminStats ───────────────────────────────────────────────────────────────

/**
 * Fetches platform-wide statistics.
 *
 * @param apiClient - Authenticated API client (must have admin role).
 * @returns Platform stats object.
 * @throws Error on API failure (including 403 for non-admin callers).
 */
export async function adminStats(apiClient: ApiClient): Promise<AdminStats> {
  return apiClient.get<AdminStats>("/api/admin/stats");
}

// ─── adminStorage ─────────────────────────────────────────────────────────────

/**
 * Dispatches storage admin operations: sweep (orphan cleanup) and resync (KV sync).
 *
 * sweep defaults to dryRun=true. Pass dryRun=false explicitly for live runs.
 *
 * @param apiClient - Authenticated API client (must have admin role).
 * @param args - Discriminated union of storage admin arguments.
 * @returns Sweep report or resync report.
 * @throws Error on API failure (including 403 for non-admin callers).
 */
export async function adminStorage(
  apiClient: ApiClient,
  args: AdminStorageArgs,
): Promise<AdminSweepReport | AdminResyncReport> {
  switch (args.action) {
    case "sweep": {
      const body: Record<string, unknown> = {
        dryRun: args.dryRun !== false, // default true
      };
      if (args.graceSeconds !== undefined) body.graceSeconds = args.graceSeconds;
      return apiClient.post<AdminSweepReport>("/api/admin/storage/sweep", body);
    }
    case "resync": {
      const body: Record<string, unknown> = { scope: args.scope };
      if (args.id !== undefined) body.id = args.id;
      return apiClient.post<AdminResyncReport>("/api/admin/kv/resync", body);
    }
  }
}

// ─── adminDomains ─────────────────────────────────────────────────────────────

/**
 * Dispatches domain admin operations: list, add, remove.
 *
 * @param apiClient - Authenticated API client (must have admin role).
 * @param args - Discriminated union of domain admin arguments.
 * @returns Domain list, new domain record, or deletion confirmation.
 * @throws Error on API failure (including 403 for non-admin callers).
 */
export async function adminDomains(
  apiClient: ApiClient,
  args: AdminDomainsArgs,
): Promise<AdminDomain[] | AdminDomain | { ok: true }> {
  switch (args.action) {
    case "list": {
      return apiClient.get<AdminDomain[]>("/api/admin/domains");
    }
    case "add": {
      return apiClient.post<AdminDomain>("/api/admin/domains", {
        hostname: args.hostname,
        access_policy: args.accessPolicy,
      });
    }
    case "remove": {
      return apiClient.delete<{ ok: true }>(`/api/admin/domains/${args.domainId}`);
    }
  }
}
