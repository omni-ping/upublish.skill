/**
 * DW-6.1: backend operations (publish_backend, backend, backend_secret,
 * backend_logs) against a fake server: requests sent, results, consent flow,
 * argument checks, and every API error path.
 */

import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import { BackendError } from "./backend-errors.ts";
import { expectedFor, runBackend, runBackendLogs, runBackendSecret, runPublishBackend, type AddonExpectation } from "./backend.ts";
import { parseAddonStatus } from "./backend-shape.ts";
import { NS, SITES_BODY, jsonResponse, makeClient, type Handler, type Recorded } from "../tests/helpers/site-data.ts";
import { backendResponse, loadBackendRoute, SLUG } from "../tests/helpers/backend.ts";

const BASE = `/api/ns/${NS.id}`;
const BACKEND = `${BASE}/sites/${SLUG}/backend`;
const ADDON = `${BASE}/backend-addon`;
const err = (status: number, code: string, error = "nope") => jsonResponse(status, { error, code });
const fx = (route: string, name: string) => backendResponse(loadBackendRoute(route), name);
const reply = (route: string, name: string) => { const r = fx(route, name); return jsonResponse(r.status, r.body); };
const CODE = "export default { async fetch() { return Response.json({ ok: true }); } };";
const sitesWithUrl = jsonResponse(200, { sites: [...SITES_BODY.sites, { id: "s9", slug: SLUG, title: "Contact", url: "https://ryan.upubli.sh/contact/" }] });

// ─── publish_backend ─────────────────────────────────────────────────────────

describe("DW-6.1: runPublishBackend", () => {
  /** Deploy handler that answers like the server: hash and size of what was received. */
  const echoDeploy: Handler = (req) => {
    if (req.method === "POST" && req.path === BACKEND) {
      const source = (req.body as { source: string }).source;
      return jsonResponse(201, {
        version: 3, deployed_at: "2026-11-06T12:05:00.000Z", access: "site", bundle_bytes: new TextEncoder().encode(source).length,
        bundle_sha256: createHash("sha256").update(source).digest("hex"), warnings: ["server note"],
      });
    }
    if (req.method === "GET" && req.path === `${BASE}/sites`) return sitesWithUrl;
    return undefined;
  };

  it("test_DW_6_1_deploys_inline_code_and_reports_endpoint_version_and_integrity", async () => {
    const { client, calls } = makeClient(echoDeploy);
    const r = await runPublishBackend(client, NS, { site: SLUG, code: CODE, access: "site", vars: { PUBLIC_TO: "a@b.c" } });
    expect(r).toMatchObject({
      state: "deployed", namespace: "ryan", site: SLUG, url: "https://ryan.upubli.sh/contact/_api/", version: 3, access: "site",
      verified: true, var_names: ["PUBLIC_TO"], warnings: ["server note"],
    });
    const post = calls.find((c) => c.method === "POST")!;
    expect(Object.keys(post.body as object).sort()).toEqual(["access", "source", "vars"]);
    expect((post.body as { vars: object }).vars).toEqual({ PUBLIC_TO: "a@b.c" });
  });

  it("test_DW_6_1_omits_access_and_vars_when_not_given_so_the_server_keeps_current_values", async () => {
    const { client, calls } = makeClient(echoDeploy);
    await runPublishBackend(client, NS, { site: SLUG, code: CODE });
    expect(Object.keys(calls.find((c) => c.method === "POST")!.body as object)).toEqual(["source"]);
  });

  it("a server hash or size that differs from the local bundle is flagged (verified: false)", async () => {
    const { client } = makeClient((req) => (req.method === "POST" ? reply("backend.deploy", "deployed") : jsonResponse(200, SITES_BODY)));
    expect((await runPublishBackend(client, NS, { site: SLUG, code: CODE }))).toMatchObject({ verified: false });
  });

  it("the endpoint is null when the site list cannot be read or the site has no url, and the deploy still succeeds", async () => {
    const down = makeClient((req) => (req.method === "POST" ? reply("backend.deploy", "deployed") : jsonResponse(500, { error: "x" })));
    expect(await runPublishBackend(down.client, NS, { site: SLUG, code: CODE })).toMatchObject({ state: "deployed", url: null });
    const noUrl = makeClient((req) => (req.method === "POST" ? reply("backend.deploy", "deployed") : jsonResponse(200, SITES_BODY)));
    expect(await runPublishBackend(noUrl.client, NS, { site: "results", code: CODE })).toMatchObject({ url: null });
  });

  it("the _root site's endpoint has no slug segment", async () => {
    const root = makeClient((req) => (req.method === "POST" ? reply("backend.deploy", "deployed") : jsonResponse(200, { sites: [{ id: "r", slug: "_root", title: "Root", url: "https://ryan.upubli.sh/" }] })));
    expect(await runPublishBackend(root.client, NS, { site: "_root", code: CODE })).toMatchObject({ url: "https://ryan.upubli.sh/_api/" });
    expect(root.calls.find((c) => c.method === "POST")!.path).toBe(`${BASE}/sites/_root/backend`);
  });

  it("test_DW_6_1_a_bundle_failure_is_a_result_and_nothing_is_sent", async () => {
    const { client, calls } = makeClient(() => undefined);
    const r = await runPublishBackend(client, NS, { site: SLUG, code: "export default {{{" });
    expect(r).toMatchObject({ action: "publish_backend", state: "bundle_failed", kind: "compile" });
    if (r.state === "bundle_failed") expect(r.message).toContain("Bundling failed");
    expect(calls).toEqual([]);
  });

  it("test_DW_6_1_a_bundle_over_1mb_is_caught_locally_before_any_request", async () => {
    const { client, calls } = makeClient(() => undefined);
    const r = await runPublishBackend(client, NS, { site: SLUG, code: `export default { fetch() { return new Response("${"a".repeat(1_100_000)}"); } };` });
    expect(r).toMatchObject({ state: "bundle_failed", kind: "too_large" });
    expect(calls).toEqual([]);
  });

  it("a missing entry file is a result, not a throw", async () => {
    const { client, calls } = makeClient(() => undefined);
    expect(await runPublishBackend(client, NS, { site: SLUG, entry: "/definitely/not/here.ts" })).toMatchObject({ state: "bundle_failed", kind: "entry_not_found" });
    expect(calls).toEqual([]);
  });

  it("bundles an entry file relative to the given cwd", async () => {
    const { client } = makeClient(echoDeploy);
    const r = await runPublishBackend(client, NS, { site: SLUG, entry: "backend-template.ts" }, { cwd: `${import.meta.dir}/../references` });
    expect(r).toMatchObject({ state: "deployed" });
  });

  it("requires exactly one of entry and code", async () => {
    const { client } = makeClient(() => undefined);
    await expect(runPublishBackend(client, NS, { site: SLUG })).rejects.toThrow(/exactly one of 'entry'/);
    await expect(runPublishBackend(client, NS, { site: SLUG, entry: "a.ts", code: CODE })).rejects.toThrow(/exactly one of 'entry'/);
  });

  it("validates vars before bundling: count, name, value size (the value is never quoted)", async () => {
    const { client, calls } = makeClient(() => undefined);
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`V${i}`, "x"]));
    await expect(runPublishBackend(client, NS, { site: SLUG, code: CODE, vars: many })).rejects.toThrow(/Too many vars \(33\).*at most 32/);
    await expect(runPublishBackend(client, NS, { site: SLUG, code: CODE, vars: { "bad-name": "x" } })).rejects.toThrow(/Invalid var name 'bad-name'/);
    const big = "v".repeat(5121);
    await expect(runPublishBackend(client, NS, { site: SLUG, code: CODE, vars: { OK: big } })).rejects.toThrow(/Var 'OK' is over 5120 bytes\.$/);
    await expect(runPublishBackend(client, NS, { site: SLUG, code: CODE, vars: { OK: big } })).rejects.not.toThrow(big);
    expect(calls).toEqual([]);
  });

  it("test_DW_6_1_warns_when_a_var_name_looks_like_a_credential", async () => {
    const { client } = makeClient(echoDeploy);
    const r = await runPublishBackend(client, NS, { site: SLUG, code: CODE, vars: { RESEND_API_KEY: "x", PUBLIC_TO: "y", SESSION_TOKEN: "z" } });
    if (r.state !== "deployed") throw new Error("expected deployed");
    const warn = r.warnings.find((w) => w.includes("look like credentials"))!;
    expect(warn).toContain("RESEND_API_KEY");
    expect(warn).toContain("SESSION_TOKEN");
    expect(warn).not.toContain("PUBLIC_TO");
  });

  for (const name of ["addon-off", "too-large", "rejected", "too-many-backends", "too-fast", "cloudflare-down"]) {
    it(`test_DW_6_1_deploy_error_${name}_becomes_a_backend_error_with_its_code`, async () => {
      const { client } = makeClient(() => reply("backend.deploy", name));
      await expect(runPublishBackend(client, NS, { site: SLUG, code: CODE })).rejects.toMatchObject({
        name: "BackendError", code: fx("backend.deploy", name).body.code, status: fx("backend.deploy", name).status,
      });
    });
  }

  it("rejects a malformed deploy response naming the field", async () => {
    const { client } = makeClient(() => jsonResponse(201, { version: 1 }));
    await expect(runPublishBackend(client, NS, { site: SLUG, code: CODE })).rejects.toThrow(/backend deploy endpoint.*deployed_at/);
  });
});

// ─── backend ─────────────────────────────────────────────────────────────────

describe("DW-6.1: runBackend per-site actions", () => {
  const statusBody = fx("backend.status", "deployed").body;
  const patchSeen: Recorded[] = [];
  const handler: Handler = (req) => {
    if (req.path === BACKEND && req.method === "GET") return jsonResponse(200, statusBody);
    if (req.path === BACKEND && req.method === "PATCH") { patchSeen.push(req); return jsonResponse(200, { ...statusBody, ...(req.body as object) }); }
    if (req.path === `${BACKEND}/versions`) return reply("backend.versions", "two-versions");
    if (req.path === `${BACKEND}/rollback`) return reply("backend.rollback", "rolled-back");
    return undefined;
  };

  it("status reads GET /sites/:slug/backend", async () => {
    const { client, calls } = makeClient(handler);
    const r = await runBackend(client, NS, { action: "status", site: SLUG });
    expect(r).toMatchObject({ action: "status", namespace: "ryan", site: SLUG, status: { version: 2, access: "site" } });
    expect(calls).toHaveLength(1);
  });

  it("versions, rollback", async () => {
    const { client, calls } = makeClient(handler);
    expect(await runBackend(client, NS, { action: "versions", site: SLUG })).toMatchObject({ action: "versions", versions: [{ version: 2, live: true }, { version: 1 }] });
    expect(await runBackend(client, NS, { action: "rollback", site: SLUG, version: 1 })).toMatchObject({ action: "rollback", result: { version: 1 } });
    expect(calls[1]!.body).toEqual({ version: 1 });
  });

  it("enable, disable and access send exactly one PATCH field each", async () => {
    patchSeen.length = 0;
    const { client } = makeClient(handler);
    expect(await runBackend(client, NS, { action: "disable", site: SLUG })).toMatchObject({ action: "disable", status: { disabled: true } });
    expect(await runBackend(client, NS, { action: "enable", site: SLUG })).toMatchObject({ action: "enable", status: { disabled: false } });
    expect(await runBackend(client, NS, { action: "access", site: SLUG, access: "public" })).toMatchObject({ action: "access", status: { access: "public" } });
    expect(patchSeen.map((p) => p.body)).toEqual([{ disabled: true }, { disabled: false }, { access: "public" }]);
  });

  it("encodes the slug in the path", async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, statusBody));
    await runBackend(client, NS, { action: "status", site: "a/b c" });
    expect(calls[0]!.path).toBe(`${BASE}/sites/a%2Fb%20c/backend`);
  });

  it("each action names the missing argument", async () => {
    const { client } = makeClient(handler);
    await expect(runBackend(client, NS, { action: "status" })).rejects.toThrow("site is required when action is 'status'");
    await expect(runBackend(client, NS, { action: "rollback", site: SLUG })).rejects.toThrow("version is required when action is 'rollback'");
    await expect(runBackend(client, NS, { action: "access", site: SLUG })).rejects.toThrow("access is required when action is 'access'");
  });

  it("test_DW_6_1_error_paths: forbidden for a non-admin, not found, rollback targets, deploy-in-flight conflict", async () => {
    const forbidden = makeClient(() => reply("backend.update", "not-admin"));
    await expect(runBackend(forbidden.client, NS, { action: "disable", site: SLUG })).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("admin role") });
    const missing = makeClient(() => reply("backend.status", "unknown-site"));
    await expect(runBackend(missing.client, NS, { action: "status", site: "zzz" })).rejects.toMatchObject({ code: "not_found" });
    const noVersion = makeClient(() => reply("backend.rollback", "no-such-version"));
    await expect(runBackend(noVersion.client, NS, { action: "rollback", site: SLUG, version: 9 })).rejects.toMatchObject({ code: "version_not_found" });
    const conflict = makeClient(() => reply("backend.rollback", "conflict"));
    await expect(runBackend(conflict.client, NS, { action: "rollback", site: SLUG, version: 1 })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("DW-6.1: runBackend delete", () => {
  it("test_DW_6_1_delete_requires_the_slug_echoed_and_sends_nothing_otherwise", async () => {
    const { client, calls } = makeClient(() => undefined);
    await expect(runBackend(client, NS, { action: "delete", site: SLUG })).rejects.toThrow("confirm_site is required when action is 'delete'");
    await expect(runBackend(client, NS, { action: "delete", site: SLUG, confirm_site: "other\nx" })).rejects.toThrow(/does not match the site 'contact'\. Nothing was deleted\./);
    await expect(runBackend(client, NS, { action: "delete", site: SLUG, confirm_site: "other\nx" })).rejects.not.toThrow(/\n/);
    expect(calls).toEqual([]);
  });

  it("deletes with DELETE /sites/:slug/backend when the echo matches", async () => {
    const { client, calls } = makeClient(() => reply("backend.delete", "deleted"));
    expect(await runBackend(client, NS, { action: "delete", site: SLUG, confirm_site: SLUG })).toEqual({ action: "delete", namespace: "ryan", site: SLUG });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "DELETE", path: BACKEND });
  });

  it("a missing backend is not_found; a malformed body is rejected", async () => {
    await expect(runBackend(makeClient(() => reply("backend.delete", "none")).client, NS, { action: "delete", site: SLUG, confirm_site: SLUG })).rejects.toMatchObject({ code: "not_found" });
    await expect(runBackend(makeClient(() => jsonResponse(200, { deleted: false })).client, NS, { action: "delete", site: SLUG, confirm_site: SLUG })).rejects.toThrow(/backend delete endpoint.*deleted/);
  });
});

describe("DW-6.1: runBackend add-on", () => {
  const base = fx("addon.status", "not-yet-launched").body;
  /** An available, not-entitled, would-charge status. */
  const offered = { ...base, available: true, billing: { ...base.billing, would_charge: true } };
  const withBilling = (b: object, extra: object = {}) => ({ ...offered, ...extra, billing: { ...offered.billing, ...b } });
  const sample = parseAddonStatus(offered);

  /** Records POSTs; GET returns `status`. */
  function server(status: object, post: Response = reply("addon.enable", "charged")) {
    return makeClient((req) => {
      if (req.method === "GET" && req.path === ADDON) return jsonResponse(200, status);
      if (req.method === "POST" && req.path === `${ADDON}/enable`) return post;
      if (req.method === "POST" && req.path === `${ADDON}/disable`) return reply("addon.disable", "disabled");
      return undefined;
    });
  }
  const posts = (calls: Recorded[]) => calls.filter((c) => c.method === "POST");

  it("addon_status: available and not available", async () => {
    expect(await runBackend(server(fx("addon.status", "enabled").body).client, NS, { action: "addon_status" })).toMatchObject({ available: true, namespace: "ryan" });
    expect(await runBackend(server(fx("addon.status", "not-yet-launched").body).client, NS, { action: "addon_status" })).toEqual({ action: "addon_status", available: false });
  });

  it("test_DW_6_1_enable_without_accept_charge_only_prints_the_consent_and_never_posts", async () => {
    const { client, calls } = server(offered);
    const r = await runBackend(client, NS, { action: "addon_enable" });
    expect(r).toMatchObject({ action: "addon_enable", state: "consent_needed", changed: false, expected: expectedFor(sample) });
    expect(posts(calls)).toEqual([]);
  });

  it("test_DW_6_1_enable_with_accept_charge_but_no_expected_posts_nothing", async () => {
    const { client, calls } = server(offered);
    expect(await runBackend(client, NS, { action: "addon_enable", accept_charge: true })).toEqual({ action: "addon_enable", state: "expected_missing" });
    expect(posts(calls)).toEqual([]);
  });

  it("test_DW_6_1_enable_with_a_stale_expected_prints_a_new_consent_and_posts_nothing", async () => {
    const stale: AddonExpectation = { ...expectedFor(sample), month_cents: 200 };
    const { client, calls } = server(offered);
    const r = await runBackend(client, NS, { action: "addon_enable", accept_charge: true, expected: stale });
    expect(r).toMatchObject({ state: "consent_needed", changed: true });
    expect(posts(calls)).toEqual([]);
    // every field participates in the comparison
    for (const patch of [{ would_charge: false }, { converts_data_addon: true }, { interval: "year" as const }, { price_cents: 1 }, { year_cents: null }]) {
      const s = server(offered);
      const out = await runBackend(s.client, NS, { action: "addon_enable", accept_charge: true, expected: { ...expectedFor(sample), ...patch } });
      expect(out).toMatchObject({ state: "consent_needed", changed: true });
      expect(posts(s.calls)).toEqual([]);
    }
  });

  it("test_DW_6_1_enable_with_accept_charge_and_matching_expected_posts_accept_charge_once", async () => {
    const { client, calls } = server(offered);
    const r = await runBackend(client, NS, { action: "addon_enable", accept_charge: true, expected: expectedFor(sample) });
    expect(r).toMatchObject({ state: "enabled", result: { charge: { interval: "month", price_cents: 300 } } });
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0]!.body).toEqual({ accept_charge: true });
  });

  it("the expected price follows the billing interval and is null when nothing would be charged", () => {
    const monthly = parseAddonStatus(withBilling({ interval: "month" }));
    expect(expectedFor(monthly)).toEqual({ would_charge: true, converts_data_addon: false, interval: "month", price_cents: 300, month_cents: 300, year_cents: 3000 });
    expect(expectedFor(parseAddonStatus(withBilling({ interval: "year" }))).price_cents).toBe(3000);
    expect(expectedFor(parseAddonStatus(withBilling({ interval: null }))).price_cents).toBeNull();
    expect(expectedFor(parseAddonStatus(withBilling({ interval: "month", would_charge: false }))).price_cents).toBeNull();
  });

  it("states that skip the POST: already enabled, activating, paused", async () => {
    const entitled = server(fx("addon.status", "enabled").body);
    expect(await runBackend(entitled.client, NS, { action: "addon_enable", accept_charge: true, expected: expectedFor(sample) })).toEqual({ action: "addon_enable", state: "already_enabled" });
    const pending = server(withBilling({ item_present: true }));
    expect(await runBackend(pending.client, NS, { action: "addon_enable" })).toEqual({ action: "addon_enable", state: "in_progress" });
    const paused = server(withBilling({ item_present: true, paused: true }));
    expect(await runBackend(paused.client, NS, { action: "addon_enable" })).toEqual({ action: "addon_enable", state: "paused" });
    for (const s of [entitled, pending, paused]) expect(posts(s.calls)).toEqual([]);
  });

  it("test_DW_6_1_enable_when_not_available_throws_not_available_and_posts_nothing", async () => {
    const { client, calls } = server(base);
    await expect(runBackend(client, NS, { action: "addon_enable", accept_charge: true, expected: expectedFor(sample) })).rejects.toMatchObject({ code: "not_available", status: 404 });
    expect(posts(calls)).toEqual([]);
  });

  for (const [name, code] of [["free-tier", "upgrade_required"], ["no-consent", "consent_required"], ["not-launched", "not_available"]] as const) {
    it(`test_DW_6_1_enable_402_and_friends_${name}`, async () => {
      const { client } = server(offered, reply("addon.enable", name));
      await expect(runBackend(client, NS, { action: "addon_enable", accept_charge: true, expected: expectedFor(sample) })).rejects.toMatchObject({ code });
    });
  }

  it("a Stripe failure on enable says to re-check status and re-consent (billing context)", async () => {
    const { client } = server(offered, err(503, "unavailable", "Stripe down"));
    await expect(runBackend(client, NS, { action: "addon_enable", accept_charge: true, expected: expectedFor(sample) })).rejects.toThrow(/WITHOUT accept_charge/);
  });

  it("a conflict with a subscription schedule is reported (nothing written)", async () => {
    const { client } = server(offered, err(409, "conflict", "scheduled"));
    await expect(runBackend(client, NS, { action: "addon_enable", accept_charge: true, expected: expectedFor(sample) })).rejects.toThrow(/subscription schedule/);
  });

  it("addon_disable posts to /disable; a non-owner gets forbidden", async () => {
    const ok = server(offered);
    expect(await runBackend(ok.client, NS, { action: "addon_disable" })).toMatchObject({ action: "addon_disable", entitled: false });
    expect(posts(ok.calls)[0]!.path).toBe(`${ADDON}/disable`);
    const denied = makeClient(() => reply("addon.disable", "not-owner"));
    await expect(runBackend(denied.client, NS, { action: "addon_disable" })).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("owner role") });
  });

  it("an unknown namespace is not_found", async () => {
    const { client } = makeClient(() => reply("addon.status", "unknown-namespace"));
    await expect(runBackend(client, NS, { action: "addon_status" })).rejects.toBeInstanceOf(BackendError);
  });
});

// ─── backend_secret ──────────────────────────────────────────────────────────

describe("DW-6.1: runBackendSecret", () => {
  const SECRETS = `${BACKEND}/secrets`;

  it("list returns names and set_at only", async () => {
    const { client } = makeClient(() => reply("backend.secrets_list", "one-secret"));
    const r = await runBackendSecret(client, NS, { action: "list", site: SLUG });
    expect(r).toMatchObject({ action: "list", secrets: [{ name: "RESEND_API_KEY" }] });
  });

  it("set PUTs the value as the body to the encoded name and returns name + set_at only", async () => {
    const { client, calls } = makeClient(() => reply("backend.secret_set", "set"));
    const r = await runBackendSecret(client, NS, { action: "set", site: SLUG, name: "RESEND_API_KEY", value: "s3cr3t-value" });
    expect(r).toEqual({ action: "set", namespace: "ryan", site: SLUG, secret: { name: "RESEND_API_KEY", set_at: "2026-11-06T12:00:00.000Z" } });
    expect(calls[0]).toMatchObject({ method: "PUT", path: `${SECRETS}/RESEND_API_KEY`, body: { value: "s3cr3t-value" } });
    expect(JSON.stringify(r)).not.toContain("s3cr3t-value");
  });

  it("delete DELETEs the named secret", async () => {
    const { client, calls } = makeClient(() => reply("backend.secret_delete", "deleted"));
    expect(await runBackendSecret(client, NS, { action: "delete", site: SLUG, name: "RESEND_API_KEY" })).toMatchObject({ action: "delete", deleted: "RESEND_API_KEY" });
    expect(calls[0]).toMatchObject({ method: "DELETE", path: `${SECRETS}/RESEND_API_KEY` });
  });

  it("validates names and values locally, never quoting the value", async () => {
    const { client, calls } = makeClient(() => undefined);
    await expect(runBackendSecret(client, NS, { action: "set", site: SLUG, name: "bad-name", value: "x" })).rejects.toThrow(/Invalid secret name 'bad-name'/);
    await expect(runBackendSecret(client, NS, { action: "delete", site: SLUG, name: "9x" })).rejects.toThrow(/Invalid secret name/);
    await expect(runBackendSecret(client, NS, { action: "set", site: SLUG, name: "OK" })).rejects.toThrow("value is required when action is 'set'");
    await expect(runBackendSecret(client, NS, { action: "set", site: SLUG, value: "x" })).rejects.toThrow("name is required when action is 'set'");
    await expect(runBackendSecret(client, NS, { action: "delete", site: SLUG })).rejects.toThrow("name is required when action is 'delete'");
    await expect(runBackendSecret(client, NS, { action: "set", site: SLUG, name: "OK", value: "" })).rejects.toThrow(/1 to 5120 bytes \(got 0\)/);
    const big = "é".repeat(2561); // 5122 bytes
    const thrown = await runBackendSecret(client, NS, { action: "set", site: SLUG, name: "OK", value: big }).catch((e: Error) => e);
    expect((thrown as Error).message).toMatch(/\(got 5122\)/);
    expect((thrown as Error).message).not.toContain("é");
    expect(calls).toEqual([]);
  });

  it("accepts a value of exactly 5120 bytes", async () => {
    const { client } = makeClient(() => reply("backend.secret_set", "set"));
    await expect(runBackendSecret(client, NS, { action: "set", site: SLUG, name: "OK", value: "a".repeat(5120) })).resolves.toMatchObject({ action: "set" });
  });

  for (const [route, name, code] of [["backend.secret_set", "too-many", "backend_limit_exceeded"], ["backend.secret_set", "addon-off", "addon_not_enabled"], ["backend.secret_delete", "unknown", "not_found"], ["backend.secrets_list", "unknown-site", "not_found"]] as const) {
    it(`test_DW_6_1_secret_error_${route}_${name}`, async () => {
      const { client } = makeClient(() => reply(route, name));
      const args = route === "backend.secret_set" ? { action: "set" as const, name: "K", value: "v" } : route === "backend.secret_delete" ? { action: "delete" as const, name: "K" } : { action: "list" as const };
      await expect(runBackendSecret(client, NS, { site: SLUG, ...args })).rejects.toMatchObject({ code });
    });
  }

  it("test_DW_6_1_results_use_the_callers_secret_name, never a server field that equals the value", async () => {
    const VALUE = "RESEND_API_KEY_VALUE";
    const set = makeClient(() => jsonResponse(200, { name: VALUE, set_at: "2026-11-06T12:00:00.000Z" }));
    const r = await runBackendSecret(set.client, NS, { action: "set", site: SLUG, name: "RESEND_API_KEY", value: VALUE });
    expect(r).toMatchObject({ secret: { name: "RESEND_API_KEY" } });
    expect(JSON.stringify(r)).not.toContain(VALUE);
    const del = makeClient(() => jsonResponse(200, { deleted: VALUE }));
    expect(await runBackendSecret(del.client, NS, { action: "delete", site: SLUG, name: "RESEND_API_KEY" })).toMatchObject({ deleted: "RESEND_API_KEY" });
  });

  it("a server that echoes the value in an error cannot route it into the message", async () => {
    const { client } = makeClient(() => jsonResponse(400, { error: "bad value hunter2-value rejected", code: "invalid_request" }));
    const e = await runBackendSecret(client, NS, { action: "set", site: SLUG, name: "K", value: "hunter2-value" }).catch((x: Error) => x);
    expect((e as Error).message).not.toContain("hunter2-value");
    expect((e as Error).message).toContain("[redacted]");
  });
});

// ─── backend_logs ────────────────────────────────────────────────────────────

describe("DW-6.1: runBackendLogs", () => {
  it("sends ?limit only when given and returns the lines", async () => {
    const withLimit = makeClient(() => reply("backend.logs", "lines"));
    const r = await runBackendLogs(withLimit.client, NS, { site: SLUG, limit: 50 });
    expect(withLimit.calls[0]!.path).toBe(`${BACKEND}/logs?limit=50`);
    expect(r.logs.lines).toHaveLength(3);
    const without = makeClient(() => reply("backend.logs", "empty"));
    await runBackendLogs(without.client, NS, { site: SLUG });
    expect(without.calls[0]!.path).toBe(`${BACKEND}/logs`);
  });

  it("rejects an out-of-range or fractional limit locally", async () => {
    const { client, calls } = makeClient(() => undefined);
    for (const limit of [0, 101, 1.5, -1]) await expect(runBackendLogs(client, NS, { site: SLUG, limit })).rejects.toThrow(/limit must be a whole number from 1 to 100/);
    expect(calls).toEqual([]);
  });

  it("server errors: bad limit and unknown site", async () => {
    await expect(runBackendLogs(makeClient(() => reply("backend.logs", "bad-limit")).client, NS, { site: SLUG, limit: 5 })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(runBackendLogs(makeClient(() => err(404, "not_found")).client, NS, { site: "x" })).rejects.toMatchObject({ code: "not_found" });
  });
});
