import { z } from "zod";
import { namespaceCreate, OverageApprovalError, packChargeLine, packApprovalPriceLine, domain, rename } from "../../lib/core.ts";
import type { CoreDeps } from "../../lib/core.ts";
import { errResponse, guarded, okResponse, type ToolResponse } from "../tool-response.ts";
import type { ToolContext } from "../context.ts";

const unexpected = (): ToolResponse => errResponse(new Error("Unexpected result"));

// ─── namespace_create ─────────────────────────────────────────────────────────

/** 402 needs_overage_approval: the approval URL and pack price for the agent to forward. */
function overageApprovalResponse(err: OverageApprovalError): ToolResponse {
  return {
    content: [
      {
        type: "text" as const,
        text: [
          `Address pack approval required. ${packApprovalPriceLine(err)}`,
          `To authorize this charge, open the approval page:`,
          `  ${err.approval_url}`,
          ``,
          `Once approved, retry this tool — no extra flag needed.`,
        ].join("\n"),
      },
    ],
    isError: true,
  };
}

export function registerNamespaceCreate(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
    "namespace_create",
    {
      title: "Create Address",
      description:
        "Creates a new address (your URL prefix) on a hosted platform domain. " +
        "You can choose between upubli.sh or pinn.sh (both available to all users). " +
        "Sites publish under an address at `name.{domain}/slug/`. " +
        "Your first address is chosen during sign-in onboarding; use this tool " +
        "to add more. Address count is tier-limited — the free plan allows one; " +
        "a tier-limit error includes the upgrade link.",
      inputSchema: {
        name: z
          .string()
          .describe("The address name (3-63 chars, lowercase letters, numbers, hyphens)."),
        domain: z
          .string()
          .optional()
          .describe("Optional hosted domain (upubli.sh or pinn.sh) or custom domain. Defaults to upubli.sh."),
      },
    },
    // Not guarded(): the catch has a second branch (OverageApprovalError) before the generic errResponse.
    async (args) => {
      try {
        const result = await namespaceCreate(args.name, args.domain, coreDeps);
        const lines = [`Address created.`, `ID: ${result.namespace_id}`, `Domain: ${result.domain}`];
        if (result.overage?.charged === true) {
          // Interval-aware pack copy from server values only (lib/billing-text.ts).
          lines.push(``, packChargeLine(result.overage));
        }
        return okResponse(lines.join("\n"));
      } catch (err) {
        // Never send accept_overage — that flag is reserved for explicit human consent on a surface we control.
        if (err instanceof OverageApprovalError) return overageApprovalResponse(err);
        return errResponse(err);
      }
    },
  );
}

// ─── domain ───────────────────────────────────────────────────────────────────

/** The validated arguments every domain action reads (the tool's schema minus `action`). */
interface DomainArgs {
  hostname?: string;
  id?: string;
}

async function domainAdd({ hostname }: DomainArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  if (!hostname) return errResponse(new Error("hostname is required when action is 'add'"));
  const result = await domain({ action: "add", hostname }, coreDeps);
  if (result.action !== "add") return unexpected();
  const records = result.records.map((r) => `  ${r.type}  name: ${r.name}  value: ${r.value}`).join("\n");
  return okResponse(
    `Connected "${result.hostname}" (id: ${result.namespace.id}).\n\n` +
    `Add these DNS record(s) at your registrar:\n${records}\n\n` +
    `${result.note}`,
  );
}

async function domainStatus({ id }: DomainArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  if (!id) return errResponse(new Error("id is required when action is 'status'"));
  const result = await domain({ action: "status", id }, coreDeps);
  if (result.action !== "status") return unexpected();
  const state = result.active ? "ACTIVE" : "PENDING";
  const errLine = result.validationErrors ? `\nValidation errors: ${result.validationErrors}` : "";
  return okResponse(
    `Custom domain "${result.hostname}" is ${state}.` +
    (result.active
      ? " It's live — publish to it like any address."
      : " DNS is still propagating, or the record(s) need a fix. Re-check shortly.") +
    errLine,
  );
}

async function domainRemove({ id }: DomainArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  if (!id) return errResponse(new Error("id is required when action is 'remove'"));
  const result = await domain({ action: "remove", id }, coreDeps);
  if (result.action !== "remove") return unexpected();
  return okResponse(result.message);
}

async function domainList(_args: DomainArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  const result = await domain({ action: "list" }, coreDeps);
  if (result.action !== "list") return unexpected();
  if (result.domains.length === 0) {
    return okResponse("No custom domains connected. Use the 'add' action to connect one.");
  }
  const lines = result.domains.map((d) => `  ${d.hostname} — ${d.verified ? "active" : "pending"} (id: ${d.id})`);
  return okResponse(`Custom domains (${result.domains.length}):\n${lines.join("\n")}`);
}

/** One handler per `domain` action; the tool's `action` enum is exactly these keys. */
const DOMAIN_ACTIONS: Record<
  "add" | "status" | "list" | "remove",
  (args: DomainArgs, coreDeps: CoreDeps) => Promise<ToolResponse>
> = { add: domainAdd, status: domainStatus, list: domainList, remove: domainRemove };

export function registerDomain(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
    "domain",
    {
      title: "Custom Domain",
      description:
        "Connect, check, list, or remove a custom domain on upubli.sh (pro/max). " +
        "A custom domain becomes its own address — sites then serve at " +
        "`yourname.com/slug/` instead of `you.upubli.sh/slug/`.\n\n" +
        "Actions:\n" +
        "  add    — Connect a domain you own. Enter the ROOT (example.com), not " +
        "www.example.com; a subdomain (blog.example.com) works too. Returns the " +
        "DNS record(s) to add at your registrar — only the human can create DNS.\n" +
        "  status — Check whether a connected domain is live yet (pending vs active, " +
        "plus any validation errors like CAA).\n" +
        "  list   — List the account's custom domains.\n" +
        "  remove — Disconnect a custom domain by id.",
      inputSchema: {
        action: z
          .enum(["add", "status", "list", "remove"])
          .describe(
            "The domain operation: 'add' to connect a hostname, 'status' to check " +
            "if it's live, 'list' to see all custom domains, 'remove' to disconnect.",
          ),
        hostname: z
          .string()
          .optional()
          .describe(
            "The domain to connect. Required when action is 'add'. Use the root " +
            "(example.com), not www.example.com; a subdomain (blog.example.com) is fine.",
          ),
        id: z
          .string()
          .optional()
          .describe(
            "The custom-domain id. Required for 'status' and 'remove'. Use 'list' to find ids.",
          ),
      },
    },
    guarded(async ({ action, ...args }) => DOMAIN_ACTIONS[action](args, coreDeps)),
  );
}

// ─── rename ───────────────────────────────────────────────────────────────────

const RENAME_INPUT = {
  nsId: z
    .string()
    .describe("The address name (e.g. 'ryan') or its UUID. Use the status or list tool to see your addresses."),
  site: z
    .string()
    .optional()
    .describe(
      "Slug of the site to rename. When provided, the site is renamed within the address. " +
      "When omitted, the address itself is renamed.",
    ),
  newName: z
    .string()
    .describe(
      "New name for the resource being renamed. When renaming a site, this is the " +
      "new slug (1-255 characters). When renaming the address, this is the new address " +
      "name (follows the address-name rules). In both cases: lowercase letters, numbers, " +
      "and hyphens only, starting and ending with a letter or number.",
    ),
  path_prefix: z
    .string()
    .nullable()
    .optional()
    .describe(
      "SITE renames only — set, change, or clear the site's nested path " +
      "prefix so it publishes at '{path_prefix}/{slug}' (e.g. " +
      "'2026/q3/code-report'). Omit to leave the current prefix " +
      "unchanged; pass an empty string or null to CLEAR the prefix " +
      "(move the site to the address root). Multiple slash-separated " +
      "segments are allowed. The server rejects a prefix that collides " +
      "with another site's address. Ignored when renaming an address.",
    ),
  redirect: z
    .enum(["off", "30d", "permanent"])
    .optional()
    .describe(
      "Redirect mode for old URLs. Defaults to '30d' (safest). " +
      "'off' — no redirect, old name released immediately. " +
      "'30d' — 301 redirect for 30 days. " +
      "'permanent' — permanent 301 redirect with no expiry.",
    ),
};

/** The "Redirect: …" line: the server's expiry when it sent one, else what the chosen mode implies. */
function redirectLine(expiresAt: string | null | undefined, redirect: "off" | "30d" | "permanent"): string {
  if (expiresAt) return `\nRedirect expires: ${expiresAt}`;
  return redirect === "off" ? "\nRedirect: none" : "\nRedirect: permanent";
}

export function registerRename(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
    "rename",
    {
      title: "Rename Site or Address",
      description:
        "Renames a site (slug) or an address on upubli.sh. " +
        "Provide `site` to rename a site within the address; omit `site` to rename the address itself. " +
        "Choose a redirect mode for old URLs: '30d' (default — safest, keeps old URLs working for 30 days), " +
        "'permanent' (301 redirect with no expiry), or 'off' (no redirect, old name released immediately). " +
        "Tier limits apply: Free accounts get one rename per resource lifetime; " +
        "Pro/Max accounts have a 30-day cooldown between renames of the same resource.",
      inputSchema: RENAME_INPUT,
    },
    guarded(async ({ nsId, site, newName, path_prefix, redirect }) => {
      if (!newName) return errResponse(new Error("newName is required"));
      if (!nsId) return errResponse(new Error("nsId is required"));

      // path_prefix: undefined ⇒ omit (keep prefix); null/"" ⇒ clear; string ⇒ set.
      // The distinction is preserved end-to-end so a client can clear a
      // prefix without accidentally clearing it on every unrelated rename.
      const result = await rename({ nsId, site, newName, pathPrefix: path_prefix, redirect }, coreDeps);
      if (!result.success) return errResponse(new Error(result.error));

      return okResponse(
        `Renamed ${site ? `site '${site}'` : "address"} to '${newName}'.\n` +
        `New URL: ${result.url}` +
        redirectLine(result.redirectExpiresAt, redirect ?? "30d"),
      );
    }),
  );
}
