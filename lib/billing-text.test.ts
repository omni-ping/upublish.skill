/**
 * DW-7.1 / DW-7.4: the money wording of the publish, address and add-on tools.
 *
 * Unit tests for lib/billing-text.ts, then the same wording through the real
 * publish pipeline (finalize 403 account_past_due) and the MCP `publish` tool.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ACCOUNT_PAST_DUE_TEXT, accountPastDueMessage, addonChargeText, packApprovalPriceLine, packChargeLine, storageApprovalPriceLine, storageChargeLine,
} from "./billing-text.ts";
import { enrichPublishError } from "./publish.ts";
import { ApiError } from "./api-client.ts";
import { publish as corePublish, type CoreDeps } from "./core.ts";
import { createServer } from "../mcp/index.ts";

describe("DW-7.1: account_past_due text", () => {
  it("test_DW_7_1_the_sentence_is_the_websites_banner_sentence", () => {
    expect(ACCOUNT_PAST_DUE_TEXT).toBe("Payment failed — update your card. New publishes are paused.");
    expect(accountPastDueMessage()).toStartWith(ACCOUNT_PAST_DUE_TEXT);
    expect(accountPastDueMessage()).toContain("https://upubli.sh/profile/settings");
    expect(accountPastDueMessage()).toContain("Existing sites keep serving");
  });

  it("test_DW_7_1_enrichPublishError_maps_the_bare_403_body_and_leaves_other_403s_alone", () => {
    const pastDue = enrichPublishError(new ApiError(403, { error: "account_past_due" }, "API error 403: account_past_due"));
    expect(pastDue.message).toBe(accountPastDueMessage());

    const suspended = new ApiError(403, { error: "Account suspended" }, "API error 403: Account suspended");
    expect(enrichPublishError(suspended)).toBe(suspended);
    const noBody = new ApiError(403, null, "API error 403");
    expect(enrichPublishError(noBody)).toBe(noBody);
  });
});

// ─── The pipeline: finalize is where a past-due account is refused ───────────

const tmpFiles: string[] = [];
const tmpDirs: string[] = [];
afterEach(() => {
  for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true });
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function deps(finalize: { status: number; body: unknown }): CoreDeps {
  const creds = path.join(os.tmpdir(), `billing-text-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(creds, "refresh", { mode: 0o600 });
  tmpFiles.push(creds);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchFn: CoreDeps["fetchFn"] = async (url, init) => {
    const u = String(url);
    if (u.includes("/auth/token/refresh")) return json(200, { access_token: "a", expires_in: 3600 });
    if (u.includes("/api/space")) return json(200, { space: { id: "sp", default_namespace_id: "ns-1", tier: "pro" } });
    if (u.includes("/manifest")) return json(200, { needed: [], version: 2, session_id: "s", base_version: 1 });
    if (u.includes("/finalize")) return json(finalize.status, finalize.body);
    if (u.includes("/api/ns") && (!init?.method || init.method === "GET")) return json(200, { namespaces: [{ id: "ns-1", name: "alice", domain: "upubli.sh", role: "owner" }] });
    return json(500, { error: "unexpected" });
  };
  return { credentialsPath: creds, fetchFn };
}

function siteDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "billing-text-site-"));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Hi</h1>");
  return dir;
}

describe("DW-7.1: a past-due finalize reaches the user as the banner sentence", () => {
  const pastDue = { status: 403, body: { error: "account_past_due" } };

  it("test_DW_7_1_core_publish_rejects_with_the_sentence_not_the_raw_api_error", async () => {
    const err = await corePublish({ directory: siteDir(), slug: "my-site" }, deps(pastDue)).catch((e: unknown) => e);
    expect((err as Error).message).toBe(accountPastDueMessage());
    expect((err as Error).message).not.toContain("API error 403");
  });

  it("test_DW_7_1_mcp_publish_tool_prints_the_sentence_as_an_error", async () => {
    const tools = (createServer(deps(pastDue)) as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }> }> })._registeredTools;
    const r = await tools["publish"]!.handler({ directory: siteDir(), slug: "my-site" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Payment failed — update your card. New publishes are paused.");
  });
});

describe("DW-7.4: storage lines are totals, and null interval prints no unit", () => {
  it("test_DW_7_4_storage_total_is_per_block_times_blocks", () => {
    expect(storageChargeLine({ block_gb: 10, blocks: 3, price: 1, interval: "month" })).toBe(
      "+$3.00/mo ($1.00/mo each) added to your bill — 3 x 10GB storage blocks.",
    );
    expect(storageChargeLine({ block_gb: 10, blocks: 2, price: 10, interval: "year" })).toContain("+$20.00/yr ($10.00/yr each)");
  });

  it("test_DW_7_4_one_block_is_just_its_price", () => {
    expect(storageChargeLine({ block_gb: 10, blocks: 1, price: 1, interval: "month" })).toBe("+$1.00/mo added to your bill — 1 x 10GB storage block.");
  });

  it("test_DW_7_4_null_interval_prints_no_unit_and_says_so_success_line", () => {
    const line = storageChargeLine({ block_gb: 10, blocks: 2, price: 1, interval: null });
    expect(line).not.toContain("/mo");
    expect(line).not.toContain("/yr");
    expect(line).toContain("+$2.00 ($1.00 each)");
    expect(line).toContain("billing interval not reported");
  });

  it("test_DW_7_4_approval_line_leads_with_the_total_for_several_blocks", () => {
    expect(storageApprovalPriceLine({ price: 1, block_gb: 10, blocks_needed: 3, interval: "month" })).toBe(
      "Approving adds 3 x 10GB storage blocks at $3.00/mo ($1.00/mo each).",
    );
    expect(storageApprovalPriceLine({ price: 10, block_gb: 10, blocks_needed: 1, interval: "year" })).toBe("Approving adds a 10GB storage block at $10.00/yr.");
  });

  it("test_DW_7_4_null_interval_approval_line_prints_no_unit", () => {
    const line = storageApprovalPriceLine({ price: 1, block_gb: 10, blocks_needed: 2, interval: null });
    expect(line).not.toMatch(/\/(mo|yr)/);
    expect(line).toContain("billing interval not reported");
  });

  it("an omitted price falls back to pack language without a price literal", () => {
    expect(storageApprovalPriceLine({ price: null, block_gb: null, blocks_needed: null, interval: null })).toBe("Approving adds a storage block to your subscription.");
  });

  it("test_DW_7_4_pack_lines_null_interval_prints_no_unit", () => {
    expect(packChargeLine({ pack_size: 5, price: 1, interval: "month" })).toBe("+$1.00/mo added to your bill — a pack of 5 address slots.");
    expect(packChargeLine({ pack_size: 5, price: 10, interval: "year" })).toContain("$10.00/yr");
    const nul = packChargeLine({ pack_size: 5, price: 1, interval: null });
    expect(nul).not.toMatch(/\/(mo|yr)/);
    expect(packApprovalPriceLine({ price: 1, pack_size: 5, interval: null })).not.toMatch(/\/(mo|yr)/);
    expect(packApprovalPriceLine({ price: 1, pack_size: null, interval: "month" })).toBe("Adding this address requires a pack of 5 address slots at $1.00/mo.");
    expect(packApprovalPriceLine({ price: null, pack_size: null, interval: null })).toBe("Adding this address requires an address pack.");
  });
});

describe("DW-7.4: add-on charge text depends on basis", () => {
  it("test_DW_7_4_invoice_basis_is_prorated", () => {
    expect(addonChargeText({ interval: "month", price_cents: 140, basis: "invoice", recurring_cents: 300 })).toBe(
      "Charged $1.40 now (prorated, monthly plan). It then costs $3.00/month.",
    );
  });

  it("test_DW_7_4_list_price_basis_is_an_estimate_not_prorated", () => {
    const t = addonChargeText({ interval: "year", price_cents: 3000, basis: "list_price" });
    expect(t).toBe("Price: $30.00/year (list price). The exact prorated amount charged today is on your Stripe receipt.");
    expect(t).not.toMatch(/Charged \$|charged .* now|\(prorated/);
  });

  it("test_DW_7_4_no_basis_older_server_claims_nothing", () => {
    expect(addonChargeText({ interval: "month", price_cents: 140 })).toBe("Charged $1.40 (monthly plan).");
  });

  it("test_DW_7_4_zero_cents_is_no_charge_now_and_null_is_no_charge_made", () => {
    expect(addonChargeText({ interval: "month", price_cents: 0, basis: "invoice" })).toBe("No charge now.");
    expect(addonChargeText(null)).toBe("No charge was made.");
  });
});

describe("DW-7.4: the MCP publish tool prints the storage total and a unit-less null interval", () => {
  type Tools = Record<string, { handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }> }>;
  const run = async (manifest: Record<string, unknown>) => {
    const d = deps({ status: 200, body: { site: { id: "s", user_id: "u", slug: "my-site", title: "T", created_at: "x", updated_at: "x", file_count: 1, total_size: 11, visibility: "public", passcode_hash: null }, url: "https://alice.upubli.sh/my-site/" } });
    const base = d.fetchFn!;
    d.fetchFn = async (url, init) => (String(url).includes("/manifest") ? new Response(JSON.stringify({ needed: [], version: 2, session_id: "s", base_version: 1, ...manifest }), { status: 200, headers: { "Content-Type": "application/json" } }) : base(url, init));
    const tools = (createServer(d) as unknown as { _registeredTools: Tools })._registeredTools;
    return (await tools["publish"]!.handler({ directory: siteDir(), slug: "my-site" })).content[0]!.text;
  };

  it("test_DW_7_4_success_text_shows_the_total_for_several_blocks", async () => {
    const text = await run({ storage_overage: { charged: true, block_gb: 10, blocks: 3, price: 1, interval: "month" } });
    expect(text).toContain("+$3.00/mo ($1.00/mo each) added to your bill — 3 x 10GB storage blocks.");
  });

  it("test_DW_7_4_success_text_null_interval_has_no_unit", async () => {
    const text = await run({ storage_overage: { charged: true, block_gb: 10, blocks: 1, price: 1, interval: null } });
    expect(text).toContain("+$1.00 added to your bill (billing interval not reported)");
    expect(text).not.toContain("/mo");
  });
});

describe("DW-7.4: the 402 storage approval through the MCP tool", () => {
  type Tools = Record<string, { handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }> }>;
  const approval = async (body: Record<string, unknown>) => {
    const d = deps({ status: 200, body: {} });
    const base = d.fetchFn!;
    d.fetchFn = async (url, init) =>
      String(url).includes("/manifest")
        ? new Response(JSON.stringify({ code: "needs_storage_approval", approval_url: "https://upubli.sh/profile/settings?storage_overage_request=1", ...body }), { status: 402, headers: { "Content-Type": "application/json" } })
        : base(url, init);
    const tools = (createServer(d) as unknown as { _registeredTools: Tools })._registeredTools;
    return (await tools["publish"]!.handler({ directory: siteDir(), slug: "my-site" })).content[0]!.text;
  };

  it("test_DW_7_4_402_text_leads_with_the_total_and_names_the_new_approval_url", async () => {
    const text = await approval({ price: 1, block_gb: 10, blocks_needed: 3, interval: "month" });
    expect(text).toContain("Approving adds 3 x 10GB storage blocks at $3.00/mo ($1.00/mo each).");
    expect(text).toContain("storage_overage_request=1");
  });

  it("test_DW_7_4_402_null_interval_prints_no_unit", async () => {
    const text = await approval({ price: 1, block_gb: 10, blocks_needed: 1, interval: null });
    expect(text).toContain("Approving adds a 10GB storage block at $1.00 (billing interval not reported).");
    expect(text).not.toContain("/mo");
  });
});
