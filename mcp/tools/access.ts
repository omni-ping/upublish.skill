import { z } from "zod";
import {
  addPasscode,
  existingPasscodeMessage,
  setVisibility,
  listPasscodes,
  revokePasscode,
  gate,
  formatGateFields,
} from "../../lib/core.ts";
import type { CoreDeps, GateFieldType, GateSubmission } from "../../lib/core.ts";
import { siteNamespaceField } from "../fields.ts";
import { errResponse, guarded, okResponse, type ToolResponse } from "../tool-response.ts";
import type { ToolContext } from "../context.ts";

export function registerPasscodeAdd(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
    "passcode_add",
    {
      title: "Add Passcode",
      description:
        "Adds a passcode to a site that is ALREADY passcode-protected on upubli.sh. " +
        "Each passcode can have a label for identification (e.g. 'Client A'); it defaults to 'default' when omitted. " +
        "This does NOT make a site private: on a public or gated site the tool refuses " +
        "(nothing is added) because the passcode would not be enforced. To make a public " +
        "site private, use the `visibility` tool with visibility 'passcode' and a passcode.",
      inputSchema: {
        slug: z
          .string()
          .describe("The URL-safe identifier of the site to add a passcode to."),
        code: z
          .string()
          .describe("The passcode string that visitors will use to access the site."),
        label: z
          .string()
          .optional()
          .describe(
            "Human-readable label for this passcode (e.g. 'Client A', 'Team B'). " +
            "Used to identify and revoke specific passcodes. Defaults to 'default' when omitted or blank.",
          ),
        namespace: siteNamespaceField,
      },
    },
    guarded(async ({ slug, code, label, namespace }) => {
      const result = await addPasscode(
        slug,
        code,
        label,
        namespace,
        coreDeps,
      );
      if (result.existed) return okResponse(existingPasscodeMessage(result.passcode));
      return okResponse(
        `Passcode added to ${slug}\n` +
        `ID:    ${result.passcode.id}\n` +
        `Label: ${result.passcode.label}`,
      );
    }),
  );
}

export function registerVisibility(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
    "visibility",
    {
      title: "Set Site Visibility",
      description:
        "Switches a site on upubli.sh between PUBLIC (anyone with the link) and PASSCODE (visitors need a code). " +
        "This is the only tool that changes a site's visibility.\n\n" +
        "Side effects:\n" +
        "  - 'passcode' needs at least one passcode. Pass `passcode` to add one in the same call: the code is " +
        "added FIRST, then visibility is changed, so the site is never locked with zero codes. With no `passcode` " +
        "and no existing codes the call is refused and nothing changes. Passcode protection needs a paid plan.\n" +
        "  - 'public' makes the site visible to everyone. Stored passcodes are kept but not enforced while public.\n" +
        "  - On a form-gated site, either switch succeeds but the form gate stops being enforced; its settings " +
        "and submissions remain until you run `gate` with action 'remove'.\n" +
        "  - If the code is added but the switch then fails, the error says the code was added and what the " +
        "visibility still is.",
      inputSchema: {
        slug: z.string().describe("The URL-safe identifier of the site."),
        visibility: z
          .enum(["public", "passcode"])
          .describe("The visibility to switch to: 'public' or 'passcode'."),
        passcode: z
          .string()
          .optional()
          .describe(
            "A passcode to add before switching to 'passcode' (min 4 characters). " +
            "Required when the site has no passcodes yet. Not allowed with 'public'.",
          ),
        label: z
          .string()
          .optional()
          .describe("Label for the added passcode (e.g. 'Client A'). Defaults to 'default'."),
        namespace: siteNamespaceField,
      },
    },
    guarded(async ({ slug, visibility, passcode, label, namespace }) => {
      const r = await setVisibility(
        {
          slug,
          visibility,
          passcode,
          label,
          namespace,
        },
        coreDeps,
      );
      const lines = [
        `Visibility of "${r.slug}" is now ${r.visibility.toUpperCase()} (was ${r.previous.toUpperCase()}).` +
          (r.visibility === "passcode" ? ` Active passcodes: ${r.activePasscodes}.` : ""),
      ];
      if (r.addedPasscode) lines.push(`Added passcode "${r.addedPasscode.label}" (id ${r.addedPasscode.id}).`);
      if (r.existingPasscode) lines.push(existingPasscodeMessage(r.existingPasscode));
      if (r.visibility === "public") {
        lines.push("Anyone with the link can now view it. Stored passcodes are kept but not enforced while public.");
      }
      if (r.previous === "gated") {
        lines.push(
          "The form gate is no longer enforced, but its settings and submissions remain. " +
          "Run `gate` with action 'remove' (and visibility_after) to clear them.",
        );
      }
      return okResponse(lines.join("\n"));
    }),
  );
}

export function registerPasscodeList(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
    "passcode_list",
    {
      title: "List Passcodes",
      description:
        "Lists all passcodes for a passcode-protected site on upubli.sh. " +
        "Shows each passcode's ID, label, and creation date.",
      inputSchema: {
        slug: z
          .string()
          .describe("The URL-safe identifier of the site to list passcodes for."),
        namespace: siteNamespaceField,
      },
    },
    guarded(async ({ slug, namespace }) => {
      const result = await listPasscodes(
        slug,
        namespace,
        coreDeps,
      );

      if (result.passcodes.length === 0) {
        return okResponse(`No passcodes found for site '${slug}'.`);
      }

      const lines = result.passcodes.map((pc) => {
        const created = new Date(pc.created_at).toLocaleDateString();
        return `  ID: ${pc.id}\n  Label: ${pc.label}\n  Created: ${created}`;
      });

      return okResponse(
        `Passcodes for ${slug} (${result.passcodes.length}):\n\n` +
        lines.join("\n\n"),
      );
    }),
  );
}

export function registerPasscodeRevoke(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
    "passcode_revoke",
    {
      title: "Revoke Passcode",
      description:
        "Revokes (removes) a passcode from a passcode-protected site on upubli.sh. " +
        "Specify either the passcode ID or its label. " +
        "Use the passcode_list tool to find available IDs and labels.",
      inputSchema: {
        slug: z
          .string()
          .describe("The URL-safe identifier of the site to revoke a passcode from."),
        id: z
          .string()
          .optional()
          .describe("The passcode ID to revoke. Takes precedence over label."),
        label: z
          .string()
          .optional()
          .describe(
            "The passcode label to revoke (resolved to ID via list). " +
            "Used only when id is not provided.",
          ),
        namespace: siteNamespaceField,
      },
    },
    guarded(async ({ slug, id, label, namespace }) => {
      const result = await revokePasscode(
        slug,
        { id, label },
        namespace,
        coreDeps,
      );
      const identifier = id ? `id=${id}` : `label="${label}"`;
      return okResponse(
        `Passcode revoked from ${slug} (${identifier})\n${result.message}`,
      );
    }),
  );
}

/** The validated arguments every gate action reads (the tool's schema minus `action`). */
interface GateArgs {
  slug: string;
  fields?: GateFieldType[];
  visibility_after?: "public" | "passcode";
  namespace?: string;
}

async function gateSet({ slug, fields, namespace }: GateArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  if (!fields || fields.length === 0) {
    return errResponse(new Error("fields is required when action is 'set'"));
  }
  const result = await gate({ action: "set", slug, fields, namespace }, coreDeps);
  if (result.action !== "set") return errResponse(new Error("Unexpected result"));
  const fieldsList = formatGateFields(result.gate.fields);
  const replaced =
    result.previous_visibility === "passcode"
      ? `\nWarning: passcode protection replaced by form gate (was: passcode)`
      : "";
  return okResponse(`Gate set for '${slug}'\nFields: ${fieldsList}${replaced}`);
}

async function gateGet({ slug, namespace }: GateArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  const result = await gate({ action: "get", slug, namespace }, coreDeps);
  if (result.action !== "get") return errResponse(new Error("Unexpected result"));
  const fieldsList = formatGateFields(result.gate.fields);
  return okResponse(
    `Gate for '${slug}'\nFields: ${fieldsList}\nSubmissions: ${result.submission_count}`,
  );
}

async function gateRemove(
  { slug, visibility_after: after, namespace }: GateArgs,
  coreDeps: CoreDeps,
): Promise<ToolResponse> {
  if (after !== "public" && after !== "passcode") {
    return errResponse(
      new Error(
        `Nothing was changed. Removing a gate must say what the site becomes: call gate again with ` +
        `action "remove" and visibility_after "public" (visible to everyone) or "passcode" ` +
        `(stays private; needs at least one passcode).`,
      ),
    );
  }
  const result = await gate({ action: "remove", slug, visibilityAfter: after, namespace }, coreDeps);
  if (result.action !== "remove") return errResponse(new Error("Unexpected result"));
  return okResponse(
    `${result.message}\nSite is now ${result.visibility.toUpperCase()}.` +
    (result.visibility === "public" ? " Anyone with the link can view it." : ""),
  );
}

async function gateSubmissions({ slug, namespace }: GateArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  const result = await gate({ action: "submissions", slug, namespace }, coreDeps);
  if (result.action !== "submissions") return errResponse(new Error("Unexpected result"));
  const { submissions } = result;
  if (submissions.length === 0) {
    return okResponse(`No submissions found for gate on '${slug}'.`);
  }
  const lines = submissions.map((sub: GateSubmission) => {
    const date = new Date(sub.submitted_at).toLocaleDateString();
    const fields = Object.entries(sub.data)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
    return `Submitted: ${date}\n${fields}`;
  });
  return okResponse(
    `Gate submissions for '${slug}' (${submissions.length}):\n\n` +
    lines.join("\n\n"),
  );
}

async function gateClear({ slug, namespace }: GateArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  const result = await gate({ action: "clear", slug, namespace }, coreDeps);
  if (result.action !== "clear") return errResponse(new Error("Unexpected result"));
  return okResponse(result.message);
}

/** One handler per `gate` action; the tool's `action` enum is exactly these keys. */
const GATE_ACTIONS: Record<
  "set" | "get" | "remove" | "submissions" | "clear",
  (args: GateArgs, coreDeps: CoreDeps) => Promise<ToolResponse>
> = {
  set: gateSet,
  get: gateGet,
  remove: gateRemove,
  submissions: gateSubmissions,
  clear: gateClear,
};

export function registerGate(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
    "gate",
    {
      title: "Form Gate",
      description:
        "Manages a form gate for a site on upubli.sh. " +
        "A form gate prompts visitors to submit information (email, name, etc.) " +
        "before accessing the site. Use this tool to set up, inspect, remove, " +
        "view submissions from, or clear submissions for a gate.\n\n" +
        "Actions:\n" +
        "  set         — Create or update a form gate with the given fields. SIDE EFFECT: the site's " +
        "visibility becomes 'gated'; this REPLACES passcode protection (the result says so when it did)\n" +
        "  get         — Get the current gate config and submission count\n" +
        "  remove      — Remove the gate. REQUIRES visibility_after ('public' or 'passcode'): " +
        "without it nothing is changed. 'public' makes the site visible to everyone; 'passcode' keeps it " +
        "private and needs at least one passcode (the result states the resulting visibility)\n" +
        "  submissions — List visitor submissions captured by the gate\n" +
        "  clear       — Delete all submissions for a gate",
      inputSchema: {
        action: z
          .enum(["set", "get", "remove", "submissions", "clear"])
          .describe(
            "The gate operation to perform: " +
            "'set' to create/update, 'get' to retrieve config, " +
            "'remove' to delete the gate (needs visibility_after), 'submissions' to list visitor data, " +
            "'clear' to delete all submissions.",
          ),
        slug: z
          .string()
          .describe("The URL-safe identifier of the site."),
        fields: z
          .array(z.enum(["email", "name", "company", "phone"]))
          .optional()
          .describe(
            "Fields to collect from visitors. Required when action is 'set'. " +
            "Valid values: 'email', 'name', 'company', 'phone'. " +
            "Every field is set as required.",
          ),
        visibility_after: z
          .enum(["public", "passcode"])
          .optional()
          .describe(
            "Required when action is 'remove': what the site becomes once the gate is gone. " +
            "'public' = visible to everyone; 'passcode' = stays private (needs >= 1 passcode).",
          ),
        namespace: siteNamespaceField,
      },
    },
    guarded(async ({ action, ...args }) => GATE_ACTIONS[action](args, coreDeps)),
  );
}
