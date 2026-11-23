/**
 * Access operations: passcodes, visibility, gate and members. Re-exported
 * through core.ts.
 */

import { setVisibility as domainSetVisibility } from "./visibility.ts";
import type { SetVisibilityResult } from "./visibility.ts";
import {
  addPasscode as domainAddPasscode,
  listPasscodes as domainListPasscodes,
  revokePasscode as domainRevokePasscode,
} from "./passcode.ts";
import type {
  AddPasscodeResult,
  ListPasscodesResult,
  RevokePasscodeResult,
} from "./passcode.ts";
import {
  getGate as domainGetGate,
  setGate as domainSetGate,
  removeGate as domainRemoveGate,
  getSubmissions as domainGetSubmissions,
  clearSubmissions as domainClearSubmissions,
} from "./gate.ts";
import type {
  GetGateResult,
  SetGateResult,
  RemoveGateResult,
  GateRemoveVisibility,
  GetSubmissionsResult,
  ClearSubmissionsResult,
} from "./gate.ts";
import {
  listMembers as domainListMembers,
  addMember as domainAddMember,
  removeMember as domainRemoveMember,
  changeMemberRole as domainChangeMemberRole,
  leaveMember as domainLeaveMember,
  createInvite as domainCreateInvite,
  listInvites as domainListInvites,
  revokeInvite as domainRevokeInvite,
} from "./members.ts";
import type {
  ListMembersResult,
  AddMemberResult,
  RemoveMemberResult,
  ChangeMemberRoleResult,
  InviteRole,
  CreateInviteResult,
  ListInvitesResult,
  RevokeInviteResult,
} from "./members.ts";
import type { GateFieldType } from "./types.ts";
import { withNamespace } from "./core-deps.ts";
import type { CoreDeps } from "./core-deps.ts";

/**
 * Adds a passcode to a passcode-protected site. Refuses (no POST) when the site
 * is public/gated — use setVisibility to make it private.
 * Throws "Not authenticated" if no credentials are stored.
 *
 * @param slug - The site slug.
 * @param code - The passcode string.
 * @param label - Optional label for the passcode; omitted/blank defaults to "default".
 * @param namespaceName - Optional namespace name. Defaults to the user's default namespace.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function addPasscode(
  slug: string,
  code: string,
  label?: string,
  namespaceName?: string,
  deps?: CoreDeps,
): Promise<AddPasscodeResult> {
  return withNamespace(deps, namespaceName, async (apiClient, ns) => {
    return domainAddPasscode(apiClient, ns.id, slug, code, label);
  });
}

/**
 * Switches a site between public and passcode-protected (see lib/visibility.ts).
 * With `passcode`, the code is added BEFORE the switch so the site is never
 * passcode-locked with zero codes. Throws "Not authenticated" if no credentials.
 *
 * @param args - slug, target visibility, optional passcode/label/namespace.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function setVisibility(
  args: { slug: string; visibility: "public" | "passcode"; passcode?: string; label?: string; namespace?: string },
  deps?: CoreDeps,
): Promise<SetVisibilityResult> {
  return withNamespace(deps, args.namespace, async (apiClient, ns) => {
    return domainSetVisibility(apiClient, ns.id, args);
  });
}

/**
 * Lists all passcodes for a site.
 * Throws "Not authenticated" if no credentials are stored.
 *
 * @param slug - The site slug.
 * @param namespaceName - Optional namespace name. Defaults to the user's default namespace.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function listPasscodes(
  slug: string,
  namespaceName?: string,
  deps?: CoreDeps,
): Promise<ListPasscodesResult> {
  return withNamespace(deps, namespaceName, async (apiClient, ns) => {
    return domainListPasscodes(apiClient, ns.id, slug);
  });
}

/**
 * Revokes a passcode by ID, or by label (resolved via list).
 * Throws "Not authenticated" if no credentials are stored.
 * Throws if the label does not match any passcode.
 *
 * @param slug - The site slug.
 * @param id - The passcode ID to revoke. Takes precedence over label.
 * @param label - The passcode label to revoke (resolved to ID via list). Used only when id is omitted.
 * @param namespaceName - Optional namespace name. Defaults to the user's default namespace.
 * @param deps - Optional CoreDeps for test injection.
 */
export async function revokePasscode(
  slug: string,
  opts: { id?: string; label?: string },
  namespaceName?: string,
  deps?: CoreDeps,
): Promise<RevokePasscodeResult> {
  return withNamespace(deps, namespaceName, async (apiClient, ns) => {

    if (opts.id) {
      return domainRevokePasscode(apiClient, ns.id, slug, opts.id);
    }

    if (opts.label) {
      // Resolve label to ID
      const { passcodes } = await domainListPasscodes(apiClient, ns.id, slug);
      const found = passcodes.find((p) => p.label === opts.label);
      if (!found) {
        const available = passcodes.map((p) => `"${p.label}"`).join(", ") || "(none)";
        throw new Error(
          `No passcode with label "${opts.label}" found. Available labels: ${available}`,
        );
      }
      return domainRevokePasscode(apiClient, ns.id, slug, found.id);
    }

    throw new Error("Either id or label must be provided to revoke a passcode.");
  });
}

// ─── Gate ─────────────────────────────────────────────────────────────────────

/**
 * Discriminated union of arguments for the gate() dispatch function.
 * The `action` field determines which domain operation is invoked.
 *
 * `set` takes field *types*; setGate turns each into the `{ type, required }`
 * object the API requires. The union is closed to the four types the backend
 * accepts, so an unsupported type fails to compile instead of 400ing at runtime.
 */
export type GateArgs =
  | { action: "get"; slug: string; namespace?: string }
  | { action: "set"; slug: string; fields: GateFieldType[]; namespace?: string }
  | { action: "remove"; slug: string; visibilityAfter: GateRemoveVisibility; namespace?: string }
  | { action: "submissions"; slug: string; namespace?: string }
  | { action: "clear"; slug: string; namespace?: string };

/**
 * Discriminated union of results returned by gate().
 * The `action` field identifies which operation produced this result.
 */
export type GateResult =
  | ({ action: "get" } & GetGateResult)
  | ({ action: "set" } & SetGateResult)
  | ({ action: "remove" } & RemoveGateResult)
  | ({ action: "submissions" } & GetSubmissionsResult)
  | ({ action: "clear" } & ClearSubmissionsResult);

/**
 * Single dispatch function for all gate operations.
 * Dispatches to the appropriate domain function based on the `action` field.
 *
 * @param args - Discriminated union of gate arguments (action + slug + optional params).
 * @param deps - Optional CoreDeps for test injection.
 * @returns Discriminated result carrying the action field for easy narrowing.
 * @throws Error if not authenticated.
 * @throws Error on API failure.
 */
export async function gate(args: GateArgs, deps?: CoreDeps): Promise<GateResult> {
  return withNamespace(deps, args.namespace, async (apiClient, ns) => {

    switch (args.action) {
      case "get": {
        const result = await domainGetGate(apiClient, ns.id, args.slug);
        return { action: "get", ...result };
      }
      case "set": {
        const result = await domainSetGate(apiClient, ns.id, args.slug, args.fields);
        return { action: "set", ...result };
      }
      case "remove": {
        const result = await domainRemoveGate(apiClient, ns.id, args.slug, args.visibilityAfter);
        return { action: "remove", ...result };
      }
      case "submissions": {
        const result = await domainGetSubmissions(apiClient, ns.id, args.slug);
        return { action: "submissions", ...result };
      }
      case "clear": {
        const result = await domainClearSubmissions(apiClient, ns.id, args.slug);
        return { action: "clear", ...result };
      }
    }
  });
}

// ─── Members ──────────────────────────────────────────────────────────────────

/**
 * Discriminated union of arguments for the members() dispatch function.
 * The `action` field determines which domain operation is invoked.
 */
export type MembersArgs =
  | { action: "list"; namespace?: string }
  | { action: "add"; username: string; role: "admin" | "user"; namespace?: string }
  | { action: "remove"; username: string; namespace?: string }
  | { action: "role"; username: string; role: "admin" | "user"; namespace?: string }
  | { action: "leave"; namespace?: string }
  | { action: "invite"; role?: InviteRole; namespace?: string }
  | { action: "invites"; namespace?: string }
  | { action: "revoke"; invite_id: string; namespace?: string };

/**
 * Discriminated union of results returned by members().
 * The `action` field identifies which operation produced this result.
 */
export type MembersResult =
  | ({ action: "list" } & ListMembersResult)
  | ({ action: "add" } & AddMemberResult)
  | ({ action: "remove" } & RemoveMemberResult)
  | ({ action: "role" } & ChangeMemberRoleResult)
  | ({ action: "leave"; address: string } & RemoveMemberResult)
  | ({ action: "invite"; address: string } & CreateInviteResult)
  | ({ action: "invites"; address: string } & ListInvitesResult)
  | ({ action: "revoke"; address: string } & RevokeInviteResult);

/**
 * Single dispatch function for all member management operations.
 * Dispatches to the appropriate domain function based on the `action` field.
 *
 * The `namespace` field controls which namespace is targeted. When omitted,
 * the default namespace is resolved from GET /api/space.
 *
 * For `remove` and `role` actions, the username is resolved to a user_id
 * internally by the domain function — callers always think in usernames.
 *
 * @param args - Discriminated union of member arguments.
 * @param deps - Optional CoreDeps for test injection.
 * @returns Discriminated result carrying the action field for easy narrowing.
 * @throws Error if not authenticated.
 * @throws Error on API failure (propagated from ApiClient).
 * @throws Error if a username cannot be resolved for remove/role actions.
 */
export async function members(args: MembersArgs, deps?: CoreDeps): Promise<MembersResult> {
  return withNamespace(deps, args.namespace, async (apiClient, ns) => {

    switch (args.action) {
      case "list": {
        const result = await domainListMembers(apiClient, ns.id);
        return { action: "list", ...result };
      }
      case "add": {
        const result = await domainAddMember(apiClient, ns.id, args.username, args.role);
        return { action: "add", ...result };
      }
      case "remove": {
        const result = await domainRemoveMember(apiClient, ns.id, args.username);
        return { action: "remove", ...result };
      }
      case "role": {
        const result = await domainChangeMemberRole(apiClient, ns.id, args.username, args.role);
        return { action: "role", ...result };
      }
      case "leave": {
        const result = await domainLeaveMember(apiClient, ns.id);
        return { action: "leave", address: ns.name, ...result };
      }
      case "invite": {
        const result = await domainCreateInvite(apiClient, ns.id, args.role ?? "user");
        return { action: "invite", address: ns.name, ...result };
      }
      case "invites": {
        const result = await domainListInvites(apiClient, ns.id);
        return { action: "invites", address: ns.name, ...result };
      }
      case "revoke": {
        const result = await domainRevokeInvite(apiClient, ns.id, args.invite_id);
        return { action: "revoke", address: ns.name, ...result };
      }
    }
  });
}
