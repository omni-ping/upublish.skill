/**
 * Tests for lib/domain.ts — the custom-domains MCP tool's domain function.
 *
 * Mirrors lib/namespace.ts / lib/admin.ts exemplars: a single action-dispatch
 * fn taking an injectable ApiClient. Covers all four actions (add/status/list/
 * remove) plus the 403/429/409/502 error mappings, using a mocked ApiClient
 * (recordingFetch + real ApiClient + static token provider). No real network.
 *
 * DW-5.1 — add/status/list/remove hit the documented endpoints, deps-bag pattern.
 * DW-5.2 — all four actions + the four error mappings.
 * DW-5.3 — add(subdomain) ⇒ single CNAME (no apex A-record); add(apex) ⇒ A + CNAME.
 */
import { describe, it, expect } from "bun:test";
import { domain } from "./domain.ts";
import { ApiClient } from "./api-client.ts";

const BASE_URL = "https://api.example.com";
const staticTokenProvider = async () => "test-token";

/** Records method/url/body across a flow; replays the queued routes in order. */
function recordingFetch(routes: Array<{ status: number; body: unknown }>): {
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; method: string; body: unknown }>;
} {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let i = 0;
  const fetchFn = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    const route = routes[Math.min(i, routes.length - 1)];
    i += 1;
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchFn, calls };
}

function client(routes: Array<{ status: number; body: unknown }>) {
  const rec = recordingFetch(routes);
  return { api: new ApiClient(BASE_URL, staticTokenProvider, rec.fetchFn), calls: rec.calls };
}

const APEX_DNS = {
  apex: { type: "A", hostname: "example.com", value: "37.16.9.151" },
  www: { type: "CNAME", hostname: "www.example.com", value: "custom.upubli.sh" },
};
const SUBDOMAIN_DNS = {
  cname: { type: "CNAME", hostname: "blog.example.com", value: "custom.upubli.sh" },
};

function addResponse(hostname: string, dns: unknown) {
  return {
    domain: { id: "dom-1", hostname, verified: false },
    namespace: { id: "ns-1", name: hostname, domain: hostname, paused_at: "2026-06-13T00:00:00Z" },
    a_record_ip: "37.16.9.151",
    dns_instructions: dns,
  };
}

// ─── action: add ──────────────────────────────────────────────────────────────

describe("domain — add", () => {
  it("test_add_posts_hostname", async () => {
    const { api, calls } = client([{ status: 201, body: addResponse("example.com", APEX_DNS) }]);

    const result = await domain(api, { action: "add", hostname: "example.com" });

    const post = calls.find((c) => c.method === "POST");
    expect(post).toBeDefined();
    expect(post!.url).toBe(`${BASE_URL}/api/domains`);
    expect(post!.body).toEqual({ hostname: "example.com" });
    expect(result.action).toBe("add");
    if (result.action !== "add") throw new Error("narrow");
    expect(result.hostname).toBe("example.com");
    // Note about the pro/max + becomes-its-own-namespace fact is carried.
    expect(result.note.toLowerCase()).toContain("namespace");
    expect(result.note.toLowerCase()).toMatch(/pro|max/);
  });

  it("test_add_apex_a_and_cname", async () => {
    const { api } = client([{ status: 201, body: addResponse("example.com", APEX_DNS) }]);

    const result = await domain(api, { action: "add", hostname: "example.com" });
    if (result.action !== "add") throw new Error("narrow");

    // Apex ⇒ exactly two records: A @ → 37.16.9.151 and CNAME www → custom.upubli.sh.
    const types = result.records.map((r) => r.type);
    expect(types).toContain("A");
    expect(types).toContain("CNAME");
    const a = result.records.find((r) => r.type === "A");
    expect(a!.value).toBe("37.16.9.151");
    const cname = result.records.find((r) => r.type === "CNAME");
    expect(cname!.value).toBe("custom.upubli.sh");
  });

  it("test_add_subdomain_single_cname", async () => {
    const { api } = client([{ status: 201, body: addResponse("blog.example.com", SUBDOMAIN_DNS) }]);

    const result = await domain(api, { action: "add", hostname: "blog.example.com" });
    if (result.action !== "add") throw new Error("narrow");

    // Subdomain ⇒ a SINGLE CNAME. No apex A-record, no 37.16.9.151 echoed.
    expect(result.records.length).toBe(1);
    expect(result.records[0].type).toBe("CNAME");
    expect(result.records[0].value).toBe("custom.upubli.sh");
    expect(result.records.some((r) => r.type === "A")).toBe(false);
    expect(JSON.stringify(result.records)).not.toContain("37.16.9.151");
  });
});

// ─── action: status ─────────────────────────────────────────────────────────

describe("domain — status", () => {
  it("test_status_gets_by_id", async () => {
    const { api, calls } = client([
      { status: 200, body: { domain: { id: "dom-1", hostname: "example.com", verified: true, hostname_status: "active", ssl_status: "active", verified_at: "2026-06-13T00:00:00Z", error_message: null } } },
    ]);

    const result = await domain(api, { action: "status", id: "dom-1" });

    const get = calls.find((c) => c.method === "GET");
    expect(get!.url).toBe(`${BASE_URL}/api/domains/dom-1/status`);
    expect(result.action).toBe("status");
    if (result.action !== "status") throw new Error("narrow");
    expect(result.active).toBe(true);
  });

  it("test_status_pending_surfaces_validation_errors", async () => {
    const { api } = client([
      { status: 200, body: { domain: { id: "dom-1", hostname: "example.com", verified: false, hostname_status: "pending", ssl_status: "pending", verified_at: null, error_message: "caa_error: CAA record forbids issuance" } } },
    ]);

    const result = await domain(api, { action: "status", id: "dom-1" });
    if (result.action !== "status") throw new Error("narrow");
    expect(result.active).toBe(false);
    expect(result.validationErrors ?? "").toContain("CAA");
  });
});

// ─── action: list ────────────────────────────────────────────────────────────

describe("domain — list", () => {
  it("test_list_gets_domains", async () => {
    const { api, calls } = client([
      { status: 200, body: { domains: [{ id: "dom-1", hostname: "example.com", verified: true }, { id: "dom-2", hostname: "blog.example.com", verified: false }] } },
    ]);

    const result = await domain(api, { action: "list" });

    const get = calls.find((c) => c.method === "GET");
    expect(get!.url).toBe(`${BASE_URL}/api/domains`);
    if (result.action !== "list") throw new Error("narrow");
    expect(result.domains.length).toBe(2);
  });
});

// ─── action: remove ──────────────────────────────────────────────────────────

describe("domain — remove", () => {
  it("test_remove_deletes_by_id", async () => {
    const { api, calls } = client([{ status: 200, body: { message: "Domain 'example.com' deleted successfully" } }]);

    const result = await domain(api, { action: "remove", id: "dom-1" });

    const del = calls.find((c) => c.method === "DELETE");
    expect(del!.url).toBe(`${BASE_URL}/api/domains/dom-1`);
    if (result.action !== "remove") throw new Error("narrow");
    expect(result.message).toMatch(/deleted/i);
  });
});

// ─── error mappings (DW-5.2) ──────────────────────────────────────────────────

describe("domain — error mappings", () => {
  it("test_403_maps_to_tier_text", async () => {
    const { api } = client([{ status: 403, body: { error: "Custom domains require a paid plan." } }]);
    await expect(domain(api, { action: "add", hostname: "example.com" })).rejects.toThrow(/pro|max/i);
  });

  it("test_429_maps_to_quota_text", async () => {
    const { api } = client([{ status: 429, body: { error: "Custom hostname quota exceeded on Cloudflare." } }]);
    await expect(domain(api, { action: "add", hostname: "example.com" })).rejects.toThrow(/quota|try again/i);
  });

  it("test_409_maps_to_exists_text", async () => {
    const { api } = client([{ status: 409, body: { error: "Hostname already registered on Cloudflare." } }]);
    await expect(domain(api, { action: "add", hostname: "example.com" })).rejects.toThrow(/already/i);
  });

  it("test_502_maps_to_cf_down_text", async () => {
    const { api } = client([{ status: 502, body: { error: "Failed to contact Cloudflare API" } }]);
    await expect(domain(api, { action: "add", hostname: "example.com" })).rejects.toThrow(/cloudflare/i);
  });
});
