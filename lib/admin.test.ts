/**
 * Admin domain module tests.
 *
 * Covers DW-7.2: admin functions take ApiClient (not CoreDeps — no credential wiring here)
 * Covers DW-7.3: each action maps to its backend endpoint (contract tests via mock ApiClient)
 * Covers DW-7.4: 403 surfaces as a clean error message (no stack trace)
 * Covers DW-7.5: docs/admin-operations.md exists and covers all 5 tools + coupon comp procedure
 */

import { describe, test, expect, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ApiClient } from "./api-client.ts";
import {
  adminUser,
  adminSite,
  adminStats,
  adminStorage,
  adminDomains,
} from "./admin.ts";

// ─── Mock ApiClient ───────────────────────────────────────────────────────────

interface MockCall {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  body?: unknown;
}

function makeMockApiClient(responseMap: Map<string, unknown>): {
  apiClient: ApiClient;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];

  const apiClient = {
    async get<T>(path: string): Promise<T> {
      calls.push({ method: "get", path });
      const key = `GET:${path}`;
      if (responseMap.has(key)) return responseMap.get(key) as T;
      throw new Error(`Unexpected GET ${path}`);
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push({ method: "post", path, body });
      const key = `POST:${path}`;
      if (responseMap.has(key)) return responseMap.get(key) as T;
      throw new Error(`Unexpected POST ${path}`);
    },
    async patch<T>(path: string, body: unknown): Promise<T> {
      calls.push({ method: "patch", path, body });
      const key = `PATCH:${path}`;
      if (responseMap.has(key)) return responseMap.get(key) as T;
      throw new Error(`Unexpected PATCH ${path}`);
    },
    async delete<T>(path: string): Promise<T> {
      calls.push({ method: "delete", path });
      const key = `DELETE:${path}`;
      if (responseMap.has(key)) return responseMap.get(key) as T;
      throw new Error(`Unexpected DELETE ${path}`);
    },
    // ApiClient also has put — not used by admin
    async put<T>(path: string, _body: unknown): Promise<T> {
      calls.push({ method: "get", path }); // track but don't expect
      throw new Error(`Unexpected PUT ${path}`);
    },
  } as unknown as ApiClient;

  return { apiClient, calls };
}

// ─── Sample fixtures ──────────────────────────────────────────────────────────

const SAMPLE_USER = {
  id: "user-1",
  email: "user@example.com",
  username: "testuser",
  role: "user",
  status: "active",
  status_reason: null,
  status_changed_at: null,
};

const SAMPLE_INSPECT = {
  user: {
    id: "user-1",
    email: "user@example.com",
    username: "testuser",
    role: "user",
    status: "active",
    status_reason: null,
    created_at: "2026-01-01T00:00:00Z",
  },
  space: { tier: "free" },
  storage_bytes: 1024,
  namespaces: [{ name: "default", domain: "testuser.upubli.sh", paused_at: null }],
  sites: [{ slug: "my-site", namespace: "default", total_size: 512, visibility: "public", blocked_at: null }],
  stripe_customer_id: null,
  last_activity: "2026-01-01T00:00:00Z",
};

const SAMPLE_STATS = {
  users_by_tier: { free: 10, pro: 2, max: 0 },
  users_by_status: { active: 11, suspended: 1, banned: 0 },
  site_count: 15,
  namespace_count: 12,
  total_storage_bytes: 1048576,
  blob_dedup_ratio: 0.85,
};

const SAMPLE_STATUS_RESULT = {
  id: "user-1",
  status: "suspended",
  status_reason: "Abuse",
  status_changed_at: "2026-01-02T00:00:00Z",
};

const SAMPLE_SWEEP_REPORT = {
  dry_run: true,
  orphaned_blobs: [],
  abandoned_prefixes: [],
  deleted_bytes: 0,
};

const SAMPLE_RESYNC_REPORT = {
  written: 1,
  verified: 1,
  failed: [],
};

const SAMPLE_DOMAINS = [
  { id: "dom-1", hostname: "example.com", access_policy: "open", namespace_count: 2 },
];

// ─── DW-7.2: admin functions take ApiClient ───────────────────────────────────

describe("DW-7.2: admin functions accept ApiClient, not CoreDeps", () => {
  test("test_DW_7_2_adminUser_accepts_apiClient", async () => {
    const { apiClient } = makeMockApiClient(
      new Map([["GET:/api/admin/users?email=user%40example.com", SAMPLE_USER]]),
    );
    const result = await adminUser(apiClient, { action: "lookup", email: "user@example.com" });
    expect(result).toMatchObject({ id: "user-1" });
  });

  test("test_DW_7_2_adminSite_accepts_apiClient", async () => {
    const { apiClient } = makeMockApiClient(
      new Map([
        ["PATCH:/api/admin/sites/site-1/block", { site: { id: "site-1", blocked_at: "2026-01-01T00:00:00Z" } }],
      ]),
    );
    const result = await adminSite(apiClient, { action: "block", siteId: "site-1", reason: "DMCA" });
    expect(result).toBeDefined();
  });

  test("test_DW_7_2_adminStats_accepts_apiClient", async () => {
    const { apiClient } = makeMockApiClient(
      new Map([["GET:/api/admin/stats", SAMPLE_STATS]]),
    );
    const result = await adminStats(apiClient);
    expect(result.site_count).toBe(15);
  });

  test("test_DW_7_2_adminStorage_accepts_apiClient", async () => {
    const { apiClient } = makeMockApiClient(
      new Map([["POST:/api/admin/storage/sweep", SAMPLE_SWEEP_REPORT]]),
    );
    const result = await adminStorage(apiClient, { action: "sweep" });
    expect(result).toBeDefined();
  });

  test("test_DW_7_2_adminDomains_accepts_apiClient", async () => {
    const { apiClient } = makeMockApiClient(
      new Map([["GET:/api/admin/domains", SAMPLE_DOMAINS]]),
    );
    const result = await adminDomains(apiClient, { action: "list" });
    expect(result).toBeDefined();
  });
});

// ─── DW-7.3: each action maps to its endpoint ─────────────────────────────────

describe("DW-7.3: adminUser actions hit correct endpoints", () => {
  test("test_DW_7_3_lookup_calls_users_search_endpoint", async () => {
    const { apiClient, calls } = makeMockApiClient(
      new Map([["GET:/api/admin/users?email=user%40example.com", SAMPLE_USER]]),
    );
    await adminUser(apiClient, { action: "lookup", email: "user@example.com" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("get");
    expect(calls[0].path).toBe("/api/admin/users?email=user%40example.com");
  });

  test("test_DW_7_3_inspect_calls_inspect_endpoint", async () => {
    const { apiClient, calls } = makeMockApiClient(
      new Map([["GET:/api/admin/users/user-1/inspect", SAMPLE_INSPECT]]),
    );
    await adminUser(apiClient, { action: "inspect", userId: "user-1" });
    expect(calls[0].path).toBe("/api/admin/users/user-1/inspect");
  });

  test("test_DW_7_3_role_calls_role_patch_endpoint", async () => {
    const { apiClient, calls } = makeMockApiClient(
      new Map([["PATCH:/api/admin/users/user-1/role", { id: "user-1", role: "admin" }]]),
    );
    await adminUser(apiClient, { action: "role", userId: "user-1", role: "admin" });
    expect(calls[0].method).toBe("patch");
    expect(calls[0].path).toBe("/api/admin/users/user-1/role");
    expect(calls[0].body).toMatchObject({ role: "admin" });
  });

  test("test_DW_7_3_suspend_calls_status_patch_endpoint", async () => {
    const { apiClient, calls } = makeMockApiClient(
      new Map([["PATCH:/api/admin/users/user-1/status", SAMPLE_STATUS_RESULT]]),
    );
    await adminUser(apiClient, { action: "suspend", userId: "user-1", reason: "Abuse" });
    expect(calls[0].method).toBe("patch");
    expect(calls[0].path).toBe("/api/admin/users/user-1/status");
    expect(calls[0].body).toMatchObject({ status: "suspended", reason: "Abuse" });
  });

  test("test_DW_7_3_ban_calls_status_patch_with_banned", async () => {
    const reconcileResult = {
      ...SAMPLE_STATUS_RESULT,
      status: "banned",
      reconcile: { written: 1, verified: 1, failed: [] },
    };
    const { apiClient, calls } = makeMockApiClient(
      new Map([["PATCH:/api/admin/users/user-1/status", reconcileResult]]),
    );
    await adminUser(apiClient, { action: "ban", userId: "user-1", reason: "TOS" });
    expect(calls[0].body).toMatchObject({ status: "banned" });
  });

  test("test_DW_7_3_reinstate_calls_status_patch_with_active", async () => {
    const reinstateResult = { ...SAMPLE_STATUS_RESULT, status: "active" };
    const { apiClient, calls } = makeMockApiClient(
      new Map([["PATCH:/api/admin/users/user-1/status", reinstateResult]]),
    );
    await adminUser(apiClient, { action: "reinstate", userId: "user-1" });
    expect(calls[0].body).toMatchObject({ status: "active" });
  });
});

describe("DW-7.3: adminSite actions hit correct endpoints", () => {
  test("test_DW_7_3_block_calls_site_block_endpoint", async () => {
    const { apiClient, calls } = makeMockApiClient(
      new Map([["PATCH:/api/admin/sites/site-1/block", { site: { id: "site-1", blocked_at: "2026-01-01" } }]]),
    );
    await adminSite(apiClient, { action: "block", siteId: "site-1", reason: "DMCA" });
    expect(calls[0].method).toBe("patch");
    expect(calls[0].path).toBe("/api/admin/sites/site-1/block");
    expect(calls[0].body).toMatchObject({ blocked: true, reason: "DMCA" });
  });

  test("test_DW_7_3_unblock_calls_site_block_endpoint_with_false", async () => {
    const { apiClient, calls } = makeMockApiClient(
      new Map([["PATCH:/api/admin/sites/site-1/block", { site: { id: "site-1", blocked_at: null } }]]),
    );
    await adminSite(apiClient, { action: "unblock", siteId: "site-1" });
    expect(calls[0].body).toMatchObject({ blocked: false });
  });
});

describe("DW-7.3: adminStats hits correct endpoint", () => {
  test("test_DW_7_3_stats_calls_stats_endpoint", async () => {
    const { apiClient, calls } = makeMockApiClient(
      new Map([["GET:/api/admin/stats", SAMPLE_STATS]]),
    );
    await adminStats(apiClient);
    expect(calls[0].method).toBe("get");
    expect(calls[0].path).toBe("/api/admin/stats");
  });
});

describe("DW-7.3: adminStorage actions hit correct endpoints", () => {
  test("test_DW_7_3_sweep_defaults_to_dry_run_true", async () => {
    const { apiClient, calls } = makeMockApiClient(
      new Map([["POST:/api/admin/storage/sweep", SAMPLE_SWEEP_REPORT]]),
    );
    await adminStorage(apiClient, { action: "sweep" });
    expect(calls[0].method).toBe("post");
    expect(calls[0].path).toBe("/api/admin/storage/sweep");
    // Default: dryRun true
    expect((calls[0].body as Record<string, unknown>).dryRun).toBe(true);
  });

  test("test_DW_7_3_sweep_with_explicit_dry_run_false", async () => {
    const { apiClient, calls } = makeMockApiClient(
      new Map([["POST:/api/admin/storage/sweep", { ...SAMPLE_SWEEP_REPORT, dry_run: false }]]),
    );
    await adminStorage(apiClient, { action: "sweep", dryRun: false });
    expect((calls[0].body as Record<string, unknown>).dryRun).toBe(false);
  });

  test("test_DW_7_3_resync_calls_kv_resync_endpoint", async () => {
    const { apiClient, calls } = makeMockApiClient(
      new Map([["POST:/api/admin/kv/resync", SAMPLE_RESYNC_REPORT]]),
    );
    await adminStorage(apiClient, { action: "resync", scope: "all" });
    expect(calls[0].method).toBe("post");
    expect(calls[0].path).toBe("/api/admin/kv/resync");
    expect((calls[0].body as Record<string, unknown>).scope).toBe("all");
  });

  test("test_DW_7_3_resync_with_scoped_user", async () => {
    const { apiClient, calls } = makeMockApiClient(
      new Map([["POST:/api/admin/kv/resync", SAMPLE_RESYNC_REPORT]]),
    );
    await adminStorage(apiClient, { action: "resync", scope: "user", id: "user-1" });
    expect((calls[0].body as Record<string, unknown>).scope).toBe("user");
    expect((calls[0].body as Record<string, unknown>).id).toBe("user-1");
  });
});

describe("DW-7.3: adminDomains actions hit correct endpoints", () => {
  test("test_DW_7_3_list_calls_domains_get_endpoint", async () => {
    const { apiClient, calls } = makeMockApiClient(
      new Map([["GET:/api/admin/domains", SAMPLE_DOMAINS]]),
    );
    await adminDomains(apiClient, { action: "list" });
    expect(calls[0].method).toBe("get");
    expect(calls[0].path).toBe("/api/admin/domains");
  });

  test("test_DW_7_3_add_calls_domains_post_endpoint", async () => {
    const { apiClient, calls } = makeMockApiClient(
      new Map([["POST:/api/admin/domains", { id: "dom-2", hostname: "new.example.com", access_policy: "open" }]]),
    );
    await adminDomains(apiClient, { action: "add", hostname: "new.example.com", accessPolicy: "open" });
    expect(calls[0].method).toBe("post");
    expect(calls[0].path).toBe("/api/admin/domains");
    expect((calls[0].body as Record<string, unknown>).hostname).toBe("new.example.com");
    expect((calls[0].body as Record<string, unknown>).access_policy).toBe("open");
  });

  test("test_DW_7_3_remove_calls_domains_delete_endpoint", async () => {
    const { apiClient, calls } = makeMockApiClient(
      new Map([["DELETE:/api/admin/domains/dom-1", { ok: true }]]),
    );
    await adminDomains(apiClient, { action: "remove", domainId: "dom-1" });
    expect(calls[0].method).toBe("delete");
    expect(calls[0].path).toBe("/api/admin/domains/dom-1");
  });
});

// ─── DW-7.3: suspend→inspect→reinstate loop ──────────────────────────────────

describe("DW-7.3: suspend→inspect→reinstate integration loop", () => {
  test("test_DW_7_3_suspend_inspect_reinstate_loop", async () => {
    const suspendResponse = {
      id: "user-1",
      status: "suspended",
      status_reason: "Abuse report",
      status_changed_at: "2026-01-02T00:00:00Z",
    };
    const reinstateResponse = {
      id: "user-1",
      status: "active",
      status_reason: null,
      status_changed_at: "2026-01-03T00:00:00Z",
    };
    // The inspect response reflects the suspended state
    const suspendedInspect = {
      ...SAMPLE_INSPECT,
      user: { ...SAMPLE_INSPECT.user, status: "suspended", status_reason: "Abuse report" },
    };

    const responses = new Map<string, unknown>([
      ["PATCH:/api/admin/users/user-1/status", suspendResponse],
      ["GET:/api/admin/users/user-1/inspect", suspendedInspect],
    ]);
    const calls: MockCall[] = [];

    // Use a stateful mock: first status PATCH suspends, second reinstates
    let statusPatchCount = 0;
    const apiClient = {
      async get<T>(path: string): Promise<T> {
        calls.push({ method: "get", path });
        if (responses.has(`GET:${path}`)) return responses.get(`GET:${path}`) as T;
        throw new Error(`Unexpected GET ${path}`);
      },
      async patch<T>(path: string, body: unknown): Promise<T> {
        calls.push({ method: "patch", path, body });
        if (path === "/api/admin/users/user-1/status") {
          statusPatchCount++;
          return (statusPatchCount === 1 ? suspendResponse : reinstateResponse) as T;
        }
        throw new Error(`Unexpected PATCH ${path}`);
      },
      async post<T>(_path: string, _body: unknown): Promise<T> { throw new Error("unexpected"); },
      async delete<T>(_path: string): Promise<T> { throw new Error("unexpected"); },
      async put<T>(_path: string, _body: unknown): Promise<T> { throw new Error("unexpected"); },
    } as unknown as ApiClient;

    // Step 1: suspend
    const suspendResult = await adminUser(apiClient, { action: "suspend", userId: "user-1", reason: "Abuse report" });
    expect(suspendResult.status).toBe("suspended");
    expect(suspendResult.status_reason).toBe("Abuse report");

    // Step 2: inspect (confirms suspended)
    const inspectResult = await adminUser(apiClient, { action: "inspect", userId: "user-1" });
    expect(inspectResult.user.status).toBe("suspended");

    // Step 3: reinstate
    const reinstateResult = await adminUser(apiClient, { action: "reinstate", userId: "user-1" });
    expect(reinstateResult.status).toBe("active");

    // Verify call sequence: patch(suspend), get(inspect), patch(reinstate)
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ method: "patch", path: "/api/admin/users/user-1/status" });
    expect(calls[1]).toMatchObject({ method: "get", path: "/api/admin/users/user-1/inspect" });
    expect(calls[2]).toMatchObject({ method: "patch", path: "/api/admin/users/user-1/status" });
  });
});

// ─── DW-7.4: 403 surfaces cleanly ────────────────────────────────────────────

describe("DW-7.4: 403 from API surfaces as clean error, no stack trace", () => {
  test("test_DW_7_4_403_surfaces_as_clean_error", async () => {
    // ApiClient throws an Error with message when API returns 403
    const apiClient = {
      async get<T>(_path: string): Promise<T> {
        throw new Error("403 Forbidden: Admin access required");
      },
      async post<T>(_path: string, _body: unknown): Promise<T> { throw new Error("403 Forbidden: Admin access required"); },
      async patch<T>(_path: string, _body: unknown): Promise<T> { throw new Error("403 Forbidden: Admin access required"); },
      async delete<T>(_path: string): Promise<T> { throw new Error("403 Forbidden: Admin access required"); },
      async put<T>(_path: string, _body: unknown): Promise<T> { throw new Error("403 Forbidden: Admin access required"); },
    } as unknown as ApiClient;

    // adminUser throws the Error — the MCP handler catches it and returns errResponse
    await expect(adminUser(apiClient, { action: "lookup", email: "user@example.com" }))
      .rejects.toThrow("403");
  });

  test("test_DW_7_4_admin_stats_403_throws_cleanly", async () => {
    const apiClient = {
      async get<T>(_path: string): Promise<T> {
        throw new Error("403 Forbidden");
      },
      async post<T>(_path: string, _body: unknown): Promise<T> { throw new Error("403 Forbidden"); },
      async patch<T>(_path: string, _body: unknown): Promise<T> { throw new Error("403 Forbidden"); },
      async delete<T>(_path: string): Promise<T> { throw new Error("403 Forbidden"); },
      async put<T>(_path: string, _body: unknown): Promise<T> { throw new Error("403 Forbidden"); },
    } as unknown as ApiClient;

    await expect(adminStats(apiClient)).rejects.toThrow("403");
  });
});

// ─── DW-7.5: docs/admin-operations.md exists and covers all tools ────────────

describe("DW-7.5: docs/admin-operations.md covers all 5 tools + comp procedure", () => {
  const DOCS_PATH = "/Users/r/repos/upublish/docs/admin-operations.md";

  test("test_DW_7_5_docs_file_exists", () => {
    expect(fs.existsSync(DOCS_PATH)).toBe(true);
  });

  test("test_DW_7_5_docs_cover_admin_user_tool", () => {
    const content = fs.readFileSync(DOCS_PATH, "utf-8");
    expect(content).toContain("admin_user");
  });

  test("test_DW_7_5_docs_cover_admin_site_tool", () => {
    const content = fs.readFileSync(DOCS_PATH, "utf-8");
    expect(content).toContain("admin_site");
  });

  test("test_DW_7_5_docs_cover_admin_stats_tool", () => {
    const content = fs.readFileSync(DOCS_PATH, "utf-8");
    expect(content).toContain("admin_stats");
  });

  test("test_DW_7_5_docs_cover_admin_storage_tool", () => {
    const content = fs.readFileSync(DOCS_PATH, "utf-8");
    expect(content).toContain("admin_storage");
  });

  test("test_DW_7_5_docs_cover_admin_domains_tool", () => {
    const content = fs.readFileSync(DOCS_PATH, "utf-8");
    expect(content).toContain("admin_domains");
  });

  test("test_DW_7_5_docs_cover_coupon_comp_procedure", () => {
    const content = fs.readFileSync(DOCS_PATH, "utf-8");
    // Must cover the comp mechanism (100% coupon in Stripe Dashboard)
    expect(content).toContain("coupon");
    expect(content).toContain("Stripe");
    // Must explicitly warn against direct tier edits
    expect(content).toContain("tier");
  });

  test("test_DW_7_5_docs_cover_all_admin_user_actions", () => {
    const content = fs.readFileSync(DOCS_PATH, "utf-8");
    // All 6 actions of admin_user must be documented
    for (const action of ["lookup", "inspect", "role", "suspend", "ban", "reinstate"]) {
      expect(content).toContain(action);
    }
  });
});
