import { z } from "zod";
import { members } from "../../lib/core.ts";
import type { CoreDeps, Member, PendingInvite } from "../../lib/core.ts";
import { errResponse, guarded, okResponse, type ToolResponse } from "../tool-response.ts";
import type { ToolContext } from "../context.ts";

/** The validated arguments every members action reads (the tool's schema minus `action`). */
interface MembersArgs {
  username?: string;
  role?: "admin" | "user";
  invite_id?: string;
  namespace?: string;
}

const unexpected = (): ToolResponse => errResponse(new Error("Unexpected result"));

async function membersList({ namespace }: MembersArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  const result = await members({ action: "list", namespace }, coreDeps);
  if (result.action !== "list") return unexpected();
  if (result.members.length === 0) {
    return okResponse("No members found. The address owner has sole access.");
  }
  const lines = result.members.map((m: Member) => `  ${m.username} — ${m.role}`);
  return okResponse(`Members:\n${lines.join("\n")}`);
}

async function membersAdd({ username, role, namespace }: MembersArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  if (!username) return errResponse(new Error("username is required for the add action"));
  if (!role) return errResponse(new Error("role is required for the add action"));
  const result = await members({ action: "add", username, role, namespace }, coreDeps);
  if (result.action !== "add") return unexpected();
  return okResponse(`Added ${result.member.username} as ${result.member.role}`);
}

async function membersRemove({ username, namespace }: MembersArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  if (!username) return errResponse(new Error("username is required for the remove action"));
  const result = await members({ action: "remove", username, namespace }, coreDeps);
  if (result.action !== "remove") return unexpected();
  return okResponse(`Removed ${username} from address`);
}

async function membersRole({ username, role, namespace }: MembersArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  if (!username) return errResponse(new Error("username is required for the role action"));
  if (!role) return errResponse(new Error("role is required for the role action"));
  const result = await members({ action: "role", username, role, namespace }, coreDeps);
  if (result.action !== "role") return unexpected();
  return okResponse(`Changed ${username} role to ${result.member.role}`);
}

async function membersLeave({ namespace }: MembersArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  if (!namespace) {
    return errResponse(new Error("namespace is required for the leave action (name the address to leave)"));
  }
  const result = await members({ action: "leave", namespace }, coreDeps);
  if (result.action !== "leave") return unexpected();
  return okResponse(`You left ${result.address}. You no longer have access to it.`);
}

async function membersInvite({ role, namespace }: MembersArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  const inviteRole = role ?? "user";
  if (inviteRole !== "user" && inviteRole !== "admin") {
    return errResponse(new Error("An invite link can make someone a member ('user') or an 'admin', never an owner."));
  }
  const result = await members({ action: "invite", role: inviteRole, namespace }, coreDeps);
  if (result.action !== "invite") return unexpected();
  const isAdmin = result.invite.role === "admin";
  const lines = [
    `Invite link for ${result.address} (${isAdmin ? "Admin" : "Member"}):`,
    result.url,
    "",
    "This link works once and expires in 7 days.",
  ];
  if (isAdmin) {
    lines.push("Admin links give full control of this address's team to whoever opens them first.");
  }
  lines.push(
    "Share it only with the person you are inviting. They open it in a browser and sign in to join.",
    `Invite id: ${result.invite.id} (use action 'revoke' with this invite_id to cancel it).`,
  );
  return okResponse(lines.join("\n"));
}

async function membersInvites({ namespace }: MembersArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  const result = await members({ action: "invites", namespace }, coreDeps);
  if (result.action !== "invites") return unexpected();
  if (result.invites.length === 0) {
    return okResponse(`No pending invite links for ${result.address}.`);
  }
  // Whitelisted fields only: a listing never shows a link or token (they exist only at creation).
  const lines = result.invites.map((i: PendingInvite) => {
    const roleLabel = i.role === "admin" ? "Admin" : "Member";
    const by = i.created_by_username ?? "a deleted account";
    const paused = i.paused ? " — paused until the owner is on Max" : "";
    return `  ${i.id} — ${roleLabel}, created by ${by}, expires ${i.expires_at}${paused}`;
  });
  return okResponse(
    `Pending invite links for ${result.address}:\n${lines.join("\n")}\n` +
    "Links are shown only once, when created. To replace one, revoke it and create a new invite.",
  );
}

async function membersRevoke({ invite_id, namespace }: MembersArgs, coreDeps: CoreDeps): Promise<ToolResponse> {
  if (!invite_id || invite_id.trim() === "") {
    return errResponse(new Error("invite_id is required for the revoke action (use action 'invites' to see the pending ones)"));
  }
  const result = await members({ action: "revoke", invite_id, namespace }, coreDeps);
  if (result.action !== "revoke") return unexpected();
  return okResponse(`Revoked invite ${invite_id.trim()} on ${result.address}. That link no longer works.`);
}

/** One renderer per `members` action; the tool's `action` enum is exactly these keys. */
const MEMBERS_ACTIONS: Record<
  "list" | "add" | "remove" | "role" | "leave" | "invite" | "invites" | "revoke",
  (args: MembersArgs, coreDeps: CoreDeps) => Promise<ToolResponse>
> = {
  list: membersList,
  add: membersAdd,
  remove: membersRemove,
  role: membersRole,
  leave: membersLeave,
  invite: membersInvite,
  invites: membersInvites,
  revoke: membersRevoke,
};

export function registerMembers(ctx: ToolContext): void {
  const { coreDeps } = ctx;
  ctx.server.registerTool(
    "members",
    {
      title: "Address Members",
      description:
        "Manages members of a shared address on upubli.sh. " +
        "Owners and admins can add, remove, and change member roles, and create, list and revoke invite links. " +
        "Any member can list the current member roster.\n\n" +
        "Actions:\n" +
        "  list   — List all members and their roles\n" +
        "  add    — Add a user by username with a given role (admin|user)\n" +
        "  remove — Remove a member by username\n" +
        "  role   — Change a member's role (admin|user)\n" +
        "  leave  — Leave the address yourself (any non-owner member; no username needed)\n" +
        "  invite — Create a single-use invite link (role user by default, or admin) for someone without an account on this address; " +
        "it works once and expires in 7 days. The person opens it in a browser and signs in to join (there is no claim action here)\n" +
        "  invites — List pending invite links (id, role, who created them, expiry). Links themselves are shown only once, at creation\n" +
        "  revoke — Revoke a pending invite link by its invite_id",
      inputSchema: {
        action: z
          .enum(["list", "add", "remove", "role", "leave", "invite", "invites", "revoke"])
          .describe(
            "The member operation to perform: " +
            "'list' to show all members, 'add' to grant access, " +
            "'remove' to revoke access, 'role' to change a member's role, " +
            "'leave' to leave the address yourself, 'invite' to create an invite link, " +
            "'invites' to list pending invite links, 'revoke' to revoke one by invite_id.",
          ),
        username: z
          .string()
          .optional()
          .describe(
            "The username to add, remove, or change role for. " +
            "Required for add, remove, and role actions.",
          ),
        role: z
          .enum(["admin", "user"])
          .optional()
          .describe(
            "The role to assign. Required for add and role actions; optional for invite (defaults to 'user'). " +
            "'admin' can manage members; 'user' can publish and gate only. Invite links can never grant owner.",
          ),
        invite_id: z
          .string()
          .optional()
          .describe("The id of the pending invite to revoke (from action 'invites'). Required for the revoke action."),
        namespace: z
          .string()
          .optional()
          .describe(
            "Address name to manage members for. When omitted, the default address is used. " +
            "Required for the leave action.",
          ),
      },
    },
    guarded(async ({ action, ...args }) => MEMBERS_ACTIONS[action](args, coreDeps)),
  );
}
