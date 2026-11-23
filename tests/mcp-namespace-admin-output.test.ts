/**
 * Output pins for the namespace_create / domain / rename / admin_* tools.
 * Written against the pre-D7 inline handlers; they must stay green when the handlers move to mcp/tools/.
 */
import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../mcp/index.ts";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
type Route = (url: string, init?: RequestInit) => { status?: number; body: unknown };

const NS_ID = "ns-1";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let cred = "";
afterEach(() => {
  if (cred) fs.rmSync(cred, { force: true });
  delete process.env.UPUBLISH_ADMIN;
});

function tools(route: Route): Record<string, { handler: Handler }> {
  cred = path.join(os.tmpdir(), `d7-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(cred, "refresh", { mode: 0o600 });
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("/auth/token/refresh")) return json(200, { access_token: "a", expires_in: 3600 });
    if (url.endsWith("/api/space")) return json(200, { space: { id: "sp", default_namespace_id: NS_ID, tier: "free" } });
    if (/\/api\/ns$/.test(url) && (init?.method ?? "GET") === "GET") {
      return json(200, { namespaces: [{ id: NS_ID, name: "default", domain: "upubli.sh" }] });
    }
    const r = route(url, init);
    return json(r.status ?? 200, r.body);
  };
  process.env.UPUBLISH_ADMIN = "1";
  const server = createServer({ credentialsPath: cred, fetchFn }, { localFiles: true });
  return (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
}

const call = async (route: Route, name: string, args: Record<string, unknown>) =>
  tools(route)[name].handler(args);
const text = (r: ToolResult) => r.content[0].text;
const none: Route = () => ({ body: {} });

describe("namespace_create output", () => {
  test("charged overage appends the pack line", async () => {
    const r = await call(
      () => ({ status: 201, body: { namespace: { id: "n9", name: "x", domain: "pinn.sh" }, overage: { charged: true, price: 1, pack_size: 5, interval: "month" } } }),
      "namespace_create",
      { name: "x", domain: "pinn.sh" },
    );
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/^Address created\.\nID: n9\nDomain: pinn\.sh\n\n\+\$/);
    expect(text(r)).toContain("a pack of 5 address slots.");
  });

  test("402 needs_overage_approval renders the approval page, isError", async () => {
    const r = await call(
      () => ({ status: 402, body: { code: "needs_overage_approval", approval_url: "https://upubli.sh/approve/1", price: 1, pack_size: 5, interval: "month" } }),
      "namespace_create",
      { name: "x" },
    );
    expect(r.isError).toBe(true);
    const t = text(r);
    expect(t).toStartWith("Address pack approval required. Adding this address requires a pack of 5 address slots at ");
    expect(t).toContain("To authorize this charge, open the approval page:\n  https://upubli.sh/approve/1\n\nOnce approved, retry this tool — no extra flag needed.");
  });
});

describe("domain output", () => {
  test("list empty / list populated / remove / status pending / missing id", async () => {
    expect(text(await call(() => ({ body: { domains: [] } }), "domain", { action: "list" }))).toBe(
      "No custom domains connected. Use the 'add' action to connect one.",
    );
    const list = await call(
      () => ({ body: { domains: [{ id: "d1", hostname: "a.com", verified: true }, { id: "d2", hostname: "b.com", verified: false }] } }),
      "domain",
      { action: "list" },
    );
    expect(text(list)).toBe("Custom domains (2):\n  a.com — active (id: d1)\n  b.com — pending (id: d2)");
    expect(text(await call(() => ({ body: { message: "Removed." } }), "domain", { action: "remove", id: "d1" }))).toBe("Removed.");
    const pending = await call(() => ({ body: { domain: { id: "d", hostname: "c.com", verified: false, error_message: "CAA" } } }), "domain", { action: "status", id: "d" });
    expect(text(pending)).toBe(
      `Custom domain "c.com" is PENDING. DNS is still propagating, or the record(s) need a fix. Re-check shortly.\nValidation errors: CAA`,
    );
    const noId = await call(none, "domain", { action: "status" });
    expect(noId.isError).toBe(true);
    expect(text(noId)).toBe("id is required when action is 'status'");
    expect(text(await call(none, "domain", { action: "remove" }))).toBe("id is required when action is 'remove'");
  });
});

describe("rename output", () => {
  const ok = (extra: Record<string, unknown> = {}): Route => () => ({ body: { url: "https://u.upubli.sh/n/", ...extra } });
  test("redirect lines: expiry, off, default, permanent; site vs address target", async () => {
    expect(text(await call(ok({ redirect_expires_at: "2027-01-01" }), "rename", { nsId: NS_ID, site: "s", newName: "n" }))).toBe(
      "Renamed site 's' to 'n'.\nNew URL: https://u.upubli.sh/n/\nRedirect expires: 2027-01-01",
    );
    expect(text(await call(ok(), "rename", { nsId: NS_ID, newName: "n", redirect: "off" }))).toBe(
      "Renamed address to 'n'.\nNew URL: https://u.upubli.sh/n/\nRedirect: none",
    );
    expect(text(await call(ok(), "rename", { nsId: NS_ID, newName: "n" }))).toBe(
      "Renamed address to 'n'.\nNew URL: https://u.upubli.sh/n/\nRedirect: permanent",
    );
    expect(text(await call(ok(), "rename", { nsId: NS_ID, newName: "n", redirect: "permanent" }))).toContain("\nRedirect: permanent");
  });
  test("empty newName / nsId are refused before any request", async () => {
    const a = await call(none, "rename", { nsId: NS_ID, newName: "" });
    expect([a.isError, text(a)]).toEqual([true, "newName is required"]);
    const b = await call(none, "rename", { nsId: "", newName: "n" });
    expect([b.isError, text(b)]).toEqual([true, "nsId is required"]);
  });
  test("path_prefix null is forwarded as an explicit clear", async () => {
    let body: unknown;
    await call((_u, init) => ((body = JSON.parse(String(init?.body))), { body: { url: "u" } }), "rename", { nsId: NS_ID, site: "s", newName: "n", path_prefix: null });
    expect(body).toMatchObject({ new_slug: "n", path_prefix: null });
  });
});

describe("admin_user output", () => {
  const user = { id: "u1", username: "bob", email: "b@x.io", role: "user", status: "suspended", status_reason: "spam" };
  test("lookup / inspect", async () => {
    expect(text(await call(() => ({ body: user }), "admin_user", { action: "lookup", email: "b@x.io" }))).toBe(
      "User: bob (b@x.io)\nID: u1\nRole: user\nStatus: suspended — spam",
    );
    const inspect = (sites: unknown[], space: unknown) => () => ({ body: { user, space, storage_bytes: 2048, sites } });
    expect(text(await call(inspect([{ slug: "a" }, { slug: "b" }], { tier: "pro" }), "admin_user", { action: "inspect", userId: "u1" }))).toBe(
      "User: bob (b@x.io)\nStatus: suspended — spam\nTier: pro\nStorage: 2.0 KB\nSites (2): a, b",
    );
    expect(text(await call(inspect([], null), "admin_user", { action: "inspect", userId: "u1" }))).toBe(
      "User: bob (b@x.io)\nStatus: suspended — spam\nTier: none\nStorage: 2.0 KB\nSites: none",
    );
  });
  test("role / suspend / ban / reinstate", async () => {
    expect(text(await call(() => ({ body: { id: "u1", role: "admin" } }), "admin_user", { action: "role", userId: "u1", role: "admin" }))).toBe("Role updated: u1 → admin");
    expect(text(await call(() => ({ body: { id: "u1", status: "suspended", status_reason: "x" } }), "admin_user", { action: "suspend", userId: "u1", reason: "x" }))).toBe("User u1 suspended.\nReason: x");
    expect(text(await call(() => ({ body: { id: "u1", status: "suspended" } }), "admin_user", { action: "suspend", userId: "u1" }))).toBe("User u1 suspended.\nReason: (none)");
    const ban = await call(() => ({ body: { id: "u1", status: "banned", status_reason: "r", reconcile: { written: 3, verified: 3, failed: ["k"] } } }), "admin_user", { action: "ban", userId: "u1", reason: "r" });
    expect(text(ban)).toBe("User u1 banned.\nReason: r\nKV reconcile: written=3 verified=3 failed=1");
    expect(text(await call(() => ({ body: { id: "u1", status: "banned" } }), "admin_user", { action: "ban", userId: "u1" }))).toBe("User u1 banned.\nReason: (none)");
    expect(text(await call(() => ({ body: { id: "u1", status: "active" } }), "admin_user", { action: "reinstate", userId: "u1" }))).toBe("User u1 reinstated (status: active).");
  });
  test("missing-argument errors name the action", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: "lookup" }, "email is required for lookup action"],
      [{ action: "inspect" }, "userId is required for inspect action"],
      [{ action: "role" }, "userId is required for role action"],
      [{ action: "role", userId: "u" }, "role is required for role action"],
      [{ action: "suspend" }, "userId is required for suspend action"],
      [{ action: "ban" }, "userId is required for ban action"],
      [{ action: "reinstate" }, "userId is required for reinstate action"],
    ];
    for (const [args, msg] of cases) {
      const r = await call(none, "admin_user", args);
      expect([r.isError, text(r)]).toEqual([true, msg]);
    }
  });
});

describe("admin_site / admin_stats / admin_storage / admin_domains output", () => {
  test("admin_site block and unblock", async () => {
    expect(text(await call(() => ({ body: { site: { blocked_at: "T" } } }), "admin_site", { action: "block", siteId: "s1", reason: "r" }))).toBe("Site s1 blocked.\nBlocked at: T");
    expect(text(await call(() => ({ body: { site: {} } }), "admin_site", { action: "block", siteId: "s1" }))).toBe("Site s1 blocked.\nBlocked at: unknown");
    expect(text(await call(() => ({ body: { site: { blocked_at: null } } }), "admin_site", { action: "unblock", siteId: "s1" }))).toBe("Site s1 unblocked (blocked_at: null).");
  });
  test("admin_stats", async () => {
    const body = { users_by_tier: { free: 3, pro: 1 }, users_by_status: { active: 4 }, site_count: 9, namespace_count: 5, total_storage_bytes: 1024, blob_dedup_ratio: 0.256 };
    expect(text(await call(() => ({ body }), "admin_stats", {}))).toBe(
      "Platform Stats\n\nUsers by tier:\n  free: 3\n  pro: 1\n\nUsers by status:\n  active: 4\n\nSites: 9\nAddresses: 5\nTotal storage: 1.0 KB\nBlob dedup ratio: 25.6%",
    );
  });
  test("admin_storage sweep / resync / missing scope", async () => {
    const sweep = { dry_run: true, orphaned_blobs: ["a"], abandoned_prefixes: [], deleted_bytes: 0 };
    expect(text(await call(() => ({ body: sweep }), "admin_storage", { action: "sweep" }))).toBe(
      "Storage sweep (DRY RUN)\nOrphaned blobs: 1\nAbandoned prefixes: 0\nDeleted bytes: 0 B",
    );
    expect(text(await call(() => ({ body: { ...sweep, dry_run: false } }), "admin_storage", { action: "sweep", dryRun: false }))).toContain("Storage sweep (LIVE)");
    expect(text(await call(() => ({ body: { written: 2, verified: 2, failed: [] } }), "admin_storage", { action: "resync", scope: "all" }))).toBe(
      "KV resync complete\nWritten: 2\nVerified: 2\nFailed: 0",
    );
    expect(text(await call(() => ({ body: { written: 2, verified: 1, failed: ["x", "y"] } }), "admin_storage", { action: "resync", scope: "user", id: "u" }))).toBe(
      "KV resync complete\nWritten: 2\nVerified: 1\nFailed: 2\n  x\n  y",
    );
    const r = await call(none, "admin_storage", { action: "resync" });
    expect([r.isError, text(r)]).toEqual([true, "scope is required for resync action"]);
  });
  test("admin_domains list / empty / add / remove / missing args", async () => {
    expect(text(await call(() => ({ body: [] }), "admin_domains", { action: "list" }))).toBe("No custom domains registered.");
    expect(text(await call(() => ({ body: [{ id: "d", hostname: "a.com", access_policy: "open", namespace_count: 2 }] }), "admin_domains", { action: "list" }))).toBe(
      "Custom domains (1):\n  a.com (open) — 2 address(es) [id: d]",
    );
    expect(text(await call(() => ({ body: { id: "d", hostname: "a.com", access_policy: "open" } }), "admin_domains", { action: "add", hostname: "a.com", accessPolicy: "open" }))).toBe(
      "Domain registered: a.com\nID: d\nAccess policy: open",
    );
    expect(text(await call(() => ({ body: { ok: true } }), "admin_domains", { action: "remove", domainId: "d" }))).toBe("Domain d removed.");
    for (const [args, msg] of [
      [{ action: "add" }, "hostname is required for add action"],
      [{ action: "add", hostname: "a.com" }, "accessPolicy is required for add action"],
      [{ action: "remove" }, "domainId is required for remove action"],
    ] as Array<[Record<string, unknown>, string]>) {
      const r = await call(none, "admin_domains", args);
      expect([r.isError, text(r)]).toEqual([true, msg]);
    }
  });
});
