import { z } from "zod";
import { adminUser, adminSite, adminStats, adminStorage, adminDomains } from "../../lib/core.ts";
import type {
  CoreDeps,
  AdminUserSummary,
  AdminUserInspect,
  AdminStatusResult,
  AdminSiteBlockResult,
  AdminStats,
  AdminSweepReport,
  AdminResyncReport,
  AdminDomain,
} from "../../lib/core.ts";
import { errResponse, guarded, okResponse, type ToolResponse } from "../tool-response.ts";
import type { ToolContext } from "../context.ts";
import { formatBytes } from "../format.ts";

// The admin tools are registered through `ctx.admin`: only on a local server with UPUBLISH_ADMIN=1.
// Without both, the tool registry is byte-identical to the 33-tool baseline.

const need = (message: string): ToolResponse => errResponse(new Error(message));

// ─── admin_user ───────────────────────────────────────────────────────────────

const ADMIN_USER_INPUT = {
  action: z
    .enum(["lookup", "inspect", "role", "suspend", "ban", "reinstate"])
    .describe("The admin user operation to perform."),
  email: z
    .string()
    .optional()
    .describe("User email address. Required for lookup action."),
  userId: z
    .string()
    .optional()
    .describe(
      "User ID. Required for inspect, role, suspend, ban, and reinstate actions.",
    ),
  role: z
    .enum(["user", "admin"])
    .optional()
    .describe("New platform role. Required for role action."),
  reason: z
    .string()
    .optional()
    .describe("Reason for status change. Recommended for suspend and ban actions."),
};

/** The validated arguments every admin_user action reads (the tool's schema minus `action`). */
type AdminUserArgs = Omit<z.infer<z.ZodObject<typeof ADMIN_USER_INPUT>>, "action">;

const statusSuffix = (u: { status: string; status_reason?: string | null }): string =>
  `Status: ${u.status}${u.status_reason ? ` — ${u.status_reason}` : ""}`;

async function userLookup({ email }: AdminUserArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  if (!email) return need("email is required for lookup action");
  const result = await adminUser({ action: "lookup", email }, coreDeps) as AdminUserSummary;
  return okResponse(
    `User: ${result.username} (${result.email})\n` +
    `ID: ${result.id}\n` +
    `Role: ${result.role}\n` +
    statusSuffix(result),
  );
}

async function userInspect({ userId }: AdminUserArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  if (!userId) return need("userId is required for inspect action");
  const result = await adminUser({ action: "inspect", userId }, coreDeps) as AdminUserInspect;
  const sitesLine = result.sites.length > 0
    ? `\nSites (${result.sites.length}): ${result.sites.map((s) => s.slug).join(", ")}`
    : "\nSites: none";
  return okResponse(
    `User: ${result.user.username} (${result.user.email})\n` +
    `${statusSuffix(result.user)}\n` +
    `Tier: ${result.space?.tier ?? "none"}\n` +
    `Storage: ${formatBytes(result.storage_bytes)}` +
    sitesLine,
  );
}

async function userRole({ userId, role }: AdminUserArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  if (!userId) return need("userId is required for role action");
  if (!role) return need("role is required for role action");
  const result = await adminUser({ action: "role", userId, role }, coreDeps) as { id: string; role: string };
  return okResponse(`Role updated: ${result.id} → ${result.role}`);
}

async function userSuspend({ userId, reason }: AdminUserArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  if (!userId) return need("userId is required for suspend action");
  const result = await adminUser({ action: "suspend", userId, reason }, coreDeps) as AdminStatusResult;
  return okResponse(`User ${result.id} suspended.\nReason: ${result.status_reason ?? "(none)"}`);
}

async function userBan({ userId, reason }: AdminUserArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  if (!userId) return need("userId is required for ban action");
  const result = await adminUser({ action: "ban", userId, reason }, coreDeps) as AdminStatusResult;
  const reconcileLine = result.reconcile
    ? `\nKV reconcile: written=${result.reconcile.written} verified=${result.reconcile.verified} failed=${result.reconcile.failed.length}`
    : "";
  return okResponse(
    `User ${result.id} banned.\n` +
    `Reason: ${result.status_reason ?? "(none)"}` +
    reconcileLine,
  );
}

async function userReinstate({ userId }: AdminUserArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  if (!userId) return need("userId is required for reinstate action");
  const result = await adminUser({ action: "reinstate", userId }, coreDeps) as AdminStatusResult;
  return okResponse(`User ${result.id} reinstated (status: ${result.status}).`);
}

/** One handler per admin_user action; the tool's `action` enum is exactly these keys. */
const ADMIN_USER_ACTIONS: Record<
  "lookup" | "inspect" | "role" | "suspend" | "ban" | "reinstate",
  (args: AdminUserArgs, coreDeps: CoreDeps) => Promise<ToolResponse>
> = {
  lookup: userLookup,
  inspect: userInspect,
  role: userRole,
  suspend: userSuspend,
  ban: userBan,
  reinstate: userReinstate,
};

export function registerAdminUser(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.admin.registerTool(
    "admin_user",
    {
      title: "Admin: User",
      description:
        "Admin operations on a user account. Requires admin role.\n\n" +
        "Actions:\n" +
        "  lookup   — Look up a user by email address\n" +
        "  inspect  — Full user context: space, storage, sites, addresses\n" +
        "  role     — Change a user's platform role (user|admin)\n" +
        "  suspend  — Suspend a user account (reversible)\n" +
        "  ban      — Permanently ban a user and block all their sites (triggers KV reconcile)\n" +
        "  reinstate — Reinstate a suspended or banned user",
      inputSchema: ADMIN_USER_INPUT,
    },
    guarded(async ({ action, ...args }) => ADMIN_USER_ACTIONS[action](args, coreDeps)),
  );
}

// ─── admin_site ───────────────────────────────────────────────────────────────

export function registerAdminSite(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.admin.registerTool(
    "admin_site",
    {
      title: "Admin: Site",
      description:
        "Admin operations on a site. Requires admin role.\n\n" +
        "Actions:\n" +
        "  block   — Block a site (removes it from public access)\n" +
        "  unblock — Unblock a previously blocked site",
      inputSchema: {
        action: z
          .enum(["block", "unblock"])
          .describe("The admin site operation to perform."),
        siteId: z
          .string()
          .describe("The site ID to block or unblock."),
        reason: z
          .string()
          .optional()
          .describe("Reason for blocking. Recommended for block action."),
      },
    },
    guarded(async ({ action, siteId, reason }) => {
      if (action === "block") {
        const result = await adminSite({ action: "block", siteId, reason }, coreDeps) as AdminSiteBlockResult;
        return okResponse(`Site ${siteId} blocked.\nBlocked at: ${result.site.blocked_at ?? "unknown"}`);
      }
      const result = await adminSite({ action: "unblock", siteId }, coreDeps) as AdminSiteBlockResult;
      return okResponse(`Site ${siteId} unblocked (blocked_at: ${result.site.blocked_at ?? "null"}).`);
    }),
  );
}

// ─── admin_stats ──────────────────────────────────────────────────────────────

const countLines = (counts: Record<string, number>): string =>
  Object.entries(counts).map(([key, count]) => `  ${key}: ${count}`).join("\n");

export function registerAdminStats(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.admin.registerTool(
    "admin_stats",
    {
      title: "Admin: Platform Stats",
      description:
        "Fetches platform-wide statistics. Requires admin role.\n\n" +
        "Returns: users by tier, users by status, site count, address count, " +
        "total storage, and blob deduplication ratio.",
      inputSchema: {},
    },
    guarded(async () => {
      const result = await adminStats(coreDeps) as AdminStats;
      return okResponse(
        `Platform Stats\n\n` +
        `Users by tier:\n${countLines(result.users_by_tier)}\n\n` +
        `Users by status:\n${countLines(result.users_by_status)}\n\n` +
        `Sites: ${result.site_count}\n` +
        `Addresses: ${result.namespace_count}\n` +
        `Total storage: ${formatBytes(result.total_storage_bytes)}\n` +
        `Blob dedup ratio: ${(result.blob_dedup_ratio * 100).toFixed(1)}%`,
      );
    }),
  );
}

// ─── admin_storage ────────────────────────────────────────────────────────────

export function registerAdminStorage(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.admin.registerTool(
    "admin_storage",
    {
      title: "Admin: Storage",
      description:
        "Admin storage operations. Requires admin role.\n\n" +
        "Actions:\n" +
        "  sweep  — Scan for and optionally delete orphaned blobs/prefixes. " +
        "Defaults to dry-run=true. Pass confirm=true for live deletion.\n" +
        "  resync — Resync KV access-control metadata for a site, user, or all entries.",
      inputSchema: {
        action: z
          .enum(["sweep", "resync"])
          .describe("The storage admin operation to perform."),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "For sweep: when true (default), reports orphans without deleting. " +
            "Pass false to actually delete orphaned blobs.",
          ),
        graceSeconds: z
          .number()
          .int()
          .optional()
          .describe(
            "For sweep: grace period in seconds. Blobs newer than this are skipped.",
          ),
        scope: z
          .enum(["site", "user", "all"])
          .optional()
          .describe("For resync: scope of the KV resync. Required for resync action."),
        id: z
          .string()
          .optional()
          .describe(
            "For resync: the site or user ID to resync. Required when scope is site or user.",
          ),
      },
    },
    guarded(async ({ action, dryRun, graceSeconds, scope, id }) => {
      if (action === "sweep") {
        const result = await adminStorage({ action: "sweep", dryRun, graceSeconds }, coreDeps) as AdminSweepReport;
        return okResponse(
          `Storage sweep (${result.dry_run ? "DRY RUN" : "LIVE"})\n` +
          `Orphaned blobs: ${result.orphaned_blobs.length}\n` +
          `Abandoned prefixes: ${result.abandoned_prefixes.length}\n` +
          `Deleted bytes: ${formatBytes(result.deleted_bytes)}`,
        );
      }
      if (!scope) return need("scope is required for resync action");
      const result = await adminStorage({ action: "resync", scope, id }, coreDeps) as AdminResyncReport;
      return okResponse(
        `KV resync complete\n` +
        `Written: ${result.written}\n` +
        `Verified: ${result.verified}\n` +
        `Failed: ${result.failed.length}${result.failed.length > 0 ? `\n  ${result.failed.join("\n  ")}` : ""}`,
      );
    }),
  );
}

// ─── admin_domains ────────────────────────────────────────────────────────────

export function registerAdminDomains(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.admin.registerTool(
    "admin_domains",
    {
      title: "Admin: Domains",
      description:
        "Admin domain management. Requires admin role.\n\n" +
        "Actions:\n" +
        "  list   — List all registered custom domains\n" +
        "  add    — Register a new custom domain\n" +
        "  remove — Remove a registered custom domain",
      inputSchema: {
        action: z
          .enum(["list", "add", "remove"])
          .describe("The domain admin operation to perform."),
        hostname: z
          .string()
          .optional()
          .describe("Domain hostname (e.g. example.com). Required for add action."),
        accessPolicy: z
          .string()
          .optional()
          .describe("Access policy for the domain (e.g. 'open'). Required for add action."),
        domainId: z
          .string()
          .optional()
          .describe("Domain ID to remove. Required for remove action."),
      },
    },
    guarded(async ({ action, hostname, accessPolicy, domainId }) => {
      if (action === "list") {
        const result = await adminDomains({ action: "list" }, coreDeps) as AdminDomain[];
        if (result.length === 0) return okResponse("No custom domains registered.");
        const lines = result.map(
          (d) => `  ${d.hostname} (${d.access_policy}) — ${d.namespace_count} address(es) [id: ${d.id}]`,
        );
        return okResponse(`Custom domains (${result.length}):\n${lines.join("\n")}`);
      }
      if (action === "add") {
        if (!hostname) return need("hostname is required for add action");
        if (!accessPolicy) return need("accessPolicy is required for add action");
        const result = await adminDomains({ action: "add", hostname, accessPolicy }, coreDeps) as AdminDomain;
        return okResponse(
          `Domain registered: ${result.hostname}\n` +
          `ID: ${result.id}\n` +
          `Access policy: ${result.access_policy}`,
        );
      }
      if (!domainId) return need("domainId is required for remove action");
      await adminDomains({ action: "remove", domainId }, coreDeps);
      return okResponse(`Domain ${domainId} removed.`);
    }),
  );
}
