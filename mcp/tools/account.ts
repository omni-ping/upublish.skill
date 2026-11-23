import { z } from "zod";
import { login, status, logout, upgrade, listTemplates, createFromTemplate } from "../../lib/core.ts";
import { createCallbackServer } from "../callback-server.ts";
import { errResponse, okResponse, type ToolResponse } from "../tool-response.ts";
import type { ToolContext } from "../context.ts";

function templateList(): ToolResponse {
  const r = listTemplates();
  if (!r.success) return errResponse(new Error(r.error));
  return okResponse(
    `Starter templates (create one with template action:"create", name, directory):\n` +
      r.templates.map((t) => `- ${t.name}: ${t.title}. ${t.description}`).join("\n"),
  );
}

function templateCreate(args: { name?: string; directory?: string; allow_non_empty?: boolean }): ToolResponse {
  const r = createFromTemplate({
    name: args.name,
    directory: args.directory,
    allowNonEmpty: args.allow_non_empty === true,
  });
  if (!r.success) return errResponse(new Error(r.error));
  const hrefs = r.placeholderHrefs.length
    ? r.placeholderHrefs.map((h) => `- ${h.file}: ${h.hint}`).join("\n")
    : "- none";
  return okResponse(
    `Created the "${r.name}" template in ${r.directory}` +
      (r.realDirectory !== r.directory ? ` (really ${r.realDirectory})` : "") +
      `\nFiles: ${r.files.join(", ")}\n\n` +
      `Placeholders to replace:\n${r.placeholders.map((p) => `- ${p.token}: ${p.hint}`).join("\n")}\n\n` +
      `Links with href "#" to point at a real address (data-placeholder-href says what goes there):\n${hrefs}\n\n` +
      `Next: replace every [[...]] and every data-placeholder-href \`#\`, show the user, then publish this folder (${r.directory}).`,
  );
}

export function registerTemplate(ctx: ToolContext): void {
  ctx.local.registerTool(
    "template",
    {
      title: "Starter Template",
      description:
        "Starts a site from a starter template, written to a local folder for you to fill in and then publish. " +
        "action \"list\" shows the templates (portfolio, landing page, resume, docs, coming soon, link in bio). " +
        "action \"create\" copies one into `directory` (a new or empty folder); it never overwrites: a non-empty " +
        "folder is refused unless allow_non_empty is true, and even then any name clash fails before anything is " +
        "written. The result lists every [[...]] placeholder and every link whose href is # (data-placeholder-href " +
        "says what goes there). Replace them all with the user's content, show the user, then publish the folder.",
      inputSchema: {
        action: z.enum(["list", "create"]).describe("list the templates, or create one in a folder."),
        name: z.string().optional().describe("Template name from list (required for create), e.g. \"portfolio\"."),
        directory: z
          .string()
          .optional()
          .describe("Folder to create the site in (required for create). Absolute or relative to the current working directory; created if missing."),
        allow_non_empty: z
          .boolean()
          .optional()
          .describe("Add the template to a folder that already has files. Any file name clash is still refused, with nothing written."),
      },
    },
    async ({ action, ...args }) => (action === "list" ? templateList() : templateCreate(args)),
  );
}

export function registerLogout(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.local.registerTool(
    "logout",
    {
      title: "Logout",
      description:
        "Signs out of upubli.sh by revoking the refresh token server-side and " +
        "deleting local credentials. Safe to call even when not logged in or " +
        "when the server is unreachable (local credentials are always cleared).",
      inputSchema: {},
    },
    async () => {
      const result = await logout(coreDeps);
      if (result.loggedOut) {
        return okResponse("Logged out successfully. Local credentials have been removed.");
      }
      return {
        content: [{ type: "text" as const, text: `Logout failed: ${result.error}` }],
        isError: true,
      };
    },
  );
}

export function registerLogin(ctx: ToolContext): void {
  const { coreDeps, openBrowser } = ctx;
  ctx.local.registerTool(
    "login",
    {
      title: "Login",
      description:
        "Authenticates with upubli.sh. " +
        "Opens a browser sign-in page where you choose a provider and waits for the OAuth callback. " +
        "The auth URL is always included in the response so you can open " +
        "it in a different browser profile if needed.",
      inputSchema: {},
    },
    async () => {
      let capturedAuthUrl = "";

      try {
        const result = await login(
          {
            apiBaseUrl: process.env.UPUBLISH_API_URL ?? "https://api.upubli.sh",
            siteBaseUrl: (process.env.UPUBLISH_SITE_URL ?? "https://upubli.sh").replace(/\/$/, ""),
            openBrowser: async (url: string) => {
              capturedAuthUrl = url;
              await openBrowser(url);
            },
            startCallbackServer: createCallbackServer,
            log: () => {},
          },
          coreDeps,
        );

        const lines = [
          `Authenticated as: ${result.username}`,
          `Credentials stored at: ${result.credentialsFilePath}`,
        ];
        if (capturedAuthUrl) {
          lines.push("", `Auth URL: ${capturedAuthUrl}`);
        }
        return okResponse(lines.join("\n"));
      } catch (err) {
        const lines = [(err as Error).message];
        if (capturedAuthUrl) {
          lines.push("", `Auth URL (open manually if needed): ${capturedAuthUrl}`);
        }
        return errResponse(new Error(lines.join("\n")));
      }
    },
  );
}

export function registerUpgrade(ctx: ToolContext): void {
  const { coreDeps, openBrowser } = ctx;
  ctx.local.registerTool(
    "upgrade",
    {
      title: "Upgrade Plan",
      description:
        "Opens the Stripe Checkout page for a paid plan (pro or max) in your browser " +
        "so the user can enter payment and upgrade their upubli.sh account. " +
        "Use this when an agent hits a free-tier wall (file-size or storage tier limit) " +
        "and the user wants more capacity. Card entry is browser-only by design — this " +
        "tool only opens the right page, it cannot complete payment. The checkout URL is " +
        "always included in the response so it can be opened manually (e.g. headless envs). " +
        "Defaults to the pro plan billed monthly.",
      inputSchema: {
        plan: z
          .enum(["pro", "max"])
          .optional()
          .describe("Which paid plan to check out. Defaults to 'pro'."),
        interval: z
          .enum(["month", "year"])
          .optional()
          .describe("Billing interval. Defaults to 'month'."),
      },
    },
    async (args) => {
      // Mirror the login tool: capture the URL the moment the opener is invoked
      // so it survives an open() rejection (headless / no DISPLAY) — DW-2.3.
      let capturedUrl = "";

      const result = await upgrade(
        async (url: string) => {
          capturedUrl = url;
          await openBrowser(url);
        },
        { plan: args.plan, interval: args.interval },
        coreDeps,
      );

      if (result.ok) {
        return okResponse(
          [
            `Opening the checkout page in your browser to upgrade.`,
            `Enter your payment details there to complete the upgrade.`,
            ``,
            `Checkout URL: ${result.url}`,
          ].join("\n"),
        );
      }

      // Failure: always echo the URL when we have one (browser failed to open
      // after a successful checkout) so headless users can open it manually.
      const url = result.url ?? capturedUrl;
      const lines = [result.error];
      if (url) {
        lines.push("", `Checkout URL (open manually if needed): ${url}`);
      }
      return errResponse(new Error(lines.join("\n")));
    },
  );
}

export function registerStatus(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
    "status",
    {
      title: "Auth Status",
      description:
        "Checks whether you are currently authenticated with upubli.sh. " +
        "Returns your username and available addresses (with domains) if authenticated, " +
        "or a not-authenticated message.",
      inputSchema: {},
    },
    async () => {
      const result = await status(coreDeps);

      if (result.authenticated) {
        const lines = [`Authenticated as: ${result.username}`];

        if (result.namespaces.length > 0) {
          lines.push("", "Addresses:");
          for (const ns of result.namespaces) {
            // Show role marker for shared namespaces (admin/user). Owner is the
            // default state — no marker for clean output.
            const roleMarker = ns.role && ns.role !== "owner" ? ` [${ns.role}]` : "";
            lines.push(`  ${ns.name} (${ns.domain})${roleMarker}`);
          }
        }

        return okResponse(lines.join("\n"));
      }

      const msg = result.error
        ? `Not authenticated. ${result.error}`
        : "Not authenticated. Use the login tool to sign in.";
      return okResponse(msg);
    },
  );
}
