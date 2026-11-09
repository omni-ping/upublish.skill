/**
 * Core member management logic.
 *
 * Returns structured data — formatting is the adapter's job.
 * Throws on API errors (propagated from ApiClient) and on unknown usernames.
 *
 * The backend's remove/role-change routes require `:userId`, but CLI/MCP users
 * think in usernames. Username→user_id resolution is done here via a prior
 * GET members call — this is an implementation detail callers never see.
 */

import { ApiError, type ApiClient } from "./api-client.ts";
import type { NamespaceRole } from "./types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A member entry as returned by the backend. */
export interface Member {
  /** The member's user ID. */
  user_id: string;
  /** The member's username. */
  username: string;
  /** The member's role in this namespace. */
  role: string;
}

export interface ListMembersResult {
  /** All members of the namespace (includes owner row). */
  members: Member[];
}

export interface AddMemberResult {
  /** The newly added member. */
  member: Member;
}

export interface RemoveMemberResult {
  /** Confirmation from the API. */
  ok: true;
}

export interface ChangeMemberRoleResult {
  /** The updated member record. */
  member: { user_id: string; role: string };
}

// Private response shapes from the backend
interface ListMembersResponse {
  members: Member[];
}

interface AddMemberResponse {
  member: Member;
}

interface RemoveMemberResponse {
  ok: true;
}

interface ChangeMemberRoleResponse {
  member: { user_id: string; role: string };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolves a username to a user_id by calling GET /api/ns/:nsId/members.
 * Throws if the username is not found in the member list.
 */
async function resolveUserId(
  apiClient: ApiClient,
  nsId: string,
  username: string,
): Promise<string> {
  const { members } = await apiClient.get<ListMembersResponse>(`/api/ns/${nsId}/members`);
  const found = members.find((m) => m.username === username);
  if (!found) {
    throw new Error(`Member '${username}' not found in namespace`);
  }
  return found.user_id;
}

// ─── List ─────────────────────────────────────────────────────────────────────

/**
 * Lists all members of a namespace (includes the owner row).
 * Any member may call this; non-member callers receive 404 from the API.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID.
 * @returns Array of members with their user_id, username, and role.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function listMembers(
  apiClient: ApiClient,
  nsId: string,
): Promise<ListMembersResult> {
  const response = await apiClient.get<ListMembersResponse>(`/api/ns/${nsId}/members`);
  return { members: response.members };
}

// ─── Add ──────────────────────────────────────────────────────────────────────

/**
 * Adds a user (by username) to a namespace with the given role.
 * Requires owner or admin role on the namespace.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID.
 * @param username - The username to add.
 * @param role - The role to grant ('admin' or 'user').
 * @returns The newly created member record.
 * @throws Error on API failure (400 invalid body, 403 insufficient role,
 *   404 unknown username or non-member, 409 duplicate, 422 cap exceeded).
 */
export async function addMember(
  apiClient: ApiClient,
  nsId: string,
  username: string,
  role: "admin" | "user",
): Promise<AddMemberResult> {
  const response = await apiClient.post<AddMemberResponse>(
    `/api/ns/${nsId}/members`,
    { username, role },
  );
  return { member: response.member };
}

// ─── Remove ───────────────────────────────────────────────────────────────────

/**
 * Removes a member (by username) from a namespace.
 * Resolves username→user_id via GET members before calling DELETE.
 * Requires owner or admin role on the namespace.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID.
 * @param username - The username to remove.
 * @returns `{ ok: true }` on success.
 * @throws Error if the username is not found in the member list.
 * @throws Error on API failure (403 insufficient role, 400 owner target).
 */
export async function removeMember(
  apiClient: ApiClient,
  nsId: string,
  username: string,
): Promise<RemoveMemberResult> {
  const userId = await resolveUserId(apiClient, nsId, username);
  const response = await apiClient.delete<RemoveMemberResponse>(
    `/api/ns/${nsId}/members/${userId}`,
  );
  return { ok: response.ok };
}

// ─── Change Role ──────────────────────────────────────────────────────────────

/**
 * Changes a member's role (by username) within a namespace.
 * Resolves username→user_id via GET members before calling PATCH.
 * Requires owner or admin role on the namespace.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID.
 * @param username - The username whose role to change.
 * @param role - The new role ('admin' or 'user').
 * @returns The updated member record.
 * @throws Error if the username is not found in the member list.
 * @throws Error on API failure (403 insufficient role, 400 owner target).
 */
export async function changeMemberRole(
  apiClient: ApiClient,
  nsId: string,
  username: string,
  role: NamespaceRole,
): Promise<ChangeMemberRoleResult> {
  const userId = await resolveUserId(apiClient, nsId, username);
  const response = await apiClient.patch<ChangeMemberRoleResponse>(
    `/api/ns/${nsId}/members/${userId}`,
    { role },
  );
  return { member: response.member };
}

// ─── Leave ────────────────────────────────────────────────────────────────────

/**
 * The caller leaves a namespace via DELETE /api/ns/:nsId/members/me (no id lookup).
 * Plain-language errors for the two expected failures; anything else is rethrown.
 *
 * @throws Error if the caller owns the namespace (400 `owner_cannot_leave`).
 * @throws Error if the caller is not a member (404).
 */
export async function leaveMember(
  apiClient: ApiClient,
  nsId: string,
): Promise<RemoveMemberResult> {
  try {
    const response = await apiClient.delete<RemoveMemberResponse>(`/api/ns/${nsId}/members/me`);
    return { ok: response.ok };
  } catch (err) {
    if (err instanceof ApiError) {
      const code = (err.rawBodyData as { code?: unknown } | null)?.code;
      if (err.status === 400 && code === "owner_cannot_leave") {
        throw new Error(
          "You own this address, so you cannot leave it. You can delete the address from your upublish dashboard instead.",
          { cause: err },
        );
      }
      if (err.status === 404) {
        throw new Error("You are not a member of this address, so there is nothing to leave.", { cause: err });
      }
    }
    throw err;
  }
}

// ─── Invite links ─────────────────────────────────────────────────────────────

/** Roles an invite link may grant. `owner` is never grantable. */
export type InviteRole = "admin" | "user";

/** A created invite as returned to callers. The raw token is never kept — only the join URL. */
export interface CreatedInvite {
  id: string;
  role: InviteRole;
  created_at: string;
  expires_at: string;
}

export interface CreateInviteResult {
  invite: CreatedInvite;
  /** The single-use join URL. The only place a skill result ever carries the secret. */
  url: string;
}

/** A pending invite as listed. Deliberately carries no URL or token (the server never returns them after create). */
export interface PendingInvite {
  id: string;
  role: InviteRole;
  /** The inviter's username, or null when their account is gone. */
  created_by_username: string | null;
  created_at: string;
  expires_at: string;
  /** True while the address owner is not on the Max plan: the link cannot be used until they are. */
  paused: boolean;
}

export interface ListInvitesResult {
  invites: PendingInvite[];
}

export interface RevokeInviteResult {
  ok: true;
}

interface CreateInviteResponse {
  invite: CreatedInvite;
  token?: string;
  url: string;
}

interface ListInvitesResponse {
  invites: PendingInvite[];
}

type InviteOp = "create" | "list" | "revoke";

const INVITE_VERB: Record<InviteOp, string> = {
  create: "create the invite link",
  list: "list invite links",
  revoke: "revoke the invite link",
};

/**
 * Maps any failure of an invite call to a plain-language Error. The message is built only from
 * the status and code — never from response text — so no URL or token can ever be echoed.
 */
function inviteError(err: unknown, op: InviteOp): Error {
  if (!(err instanceof ApiError)) {
    // A transport failure (fetch's TypeError, or a Bun/Node system error carrying a `code`) may name the
    // request URL, so it is replaced. Anything else — e.g. "Not authenticated" or a token-refresh failure
    // from the token provider — passes through unchanged, like the other members actions (no URL in those).
    const isTransport =
      err instanceof TypeError || (err instanceof Error && typeof (err as { code?: unknown }).code === "string");
    if (isTransport || !(err instanceof Error)) {
      return new Error(`Could not ${INVITE_VERB[op]}: upublish could not be reached. Check your connection and try again.`);
    }
    return err;
  }
  const code = (err.rawBodyData as { code?: unknown } | null)?.code;
  const plain = (message: string) => new Error(message, { cause: err });
  switch (err.status) {
    case 400:
      return plain(
        `Could not ${INVITE_VERB[op]}: the request was not valid. An invite link can make someone a member ('user') or an 'admin'.`,
      );
    case 401:
      return plain("Your upublish sign-in has expired. Use the login tool, then try again.");
    case 403:
      if (code === "teams_unavailable") {
        return plain("Invite links need the address owner to be on the Max plan.");
      }
      if (code === "account_restricted") {
        return plain("Your account can't manage invite links right now.");
      }
      return plain("Only the owner or an admin of this address can manage invite links.");
    case 404:
      if (code === "invite_not_found") {
        return plain(
          "No pending invite with that id on this address. It may already have been used, revoked or expired. Use action 'invites' to see the pending ones.",
        );
      }
      return plain("This address was not found, or you are not a member of it.");
    case 422:
      return plain(
        "This address has no free seats: members plus pending invite links are at the plan limit. Revoke a pending invite or remove a member first.",
      );
    default:
      return plain(`Could not ${INVITE_VERB[op]} (upublish returned error ${err.status}). Please try again.`);
  }
}

/**
 * Creates a single-use, 7-day invite link for a namespace. Requires owner or admin.
 * `owner` (or any other value) is rejected before any request is made.
 *
 * @returns The invite metadata and its join URL. The raw token field is dropped.
 * @throws Error with a plain-language message on any failure (never echoing a URL or token).
 */
export async function createInvite(
  apiClient: ApiClient,
  nsId: string,
  role: InviteRole = "user",
): Promise<CreateInviteResult> {
  if (role !== "admin" && role !== "user") {
    throw new Error("An invite link can make someone a member ('user') or an 'admin', never an owner.");
  }
  let response: CreateInviteResponse;
  try {
    response = await apiClient.post<CreateInviteResponse>(`/api/ns/${nsId}/invites`, { role });
  } catch (err) {
    throw inviteError(err, "create");
  }
  if (!response?.invite || typeof response.url !== "string") {
    throw new Error("Could not create the invite link: upublish sent an unexpected reply. Please try again.");
  }
  const { id, role: grantedRole, created_at, expires_at } = response.invite;
  return { invite: { id, role: grantedRole, created_at, expires_at }, url: response.url };
}

/**
 * Lists a namespace's pending (unclaimed, unrevoked, unexpired) invites. Requires owner or admin.
 * Fields are whitelisted, so nothing beyond the documented ones (and never a URL or token) passes through.
 *
 * @throws Error with a plain-language message on any failure.
 */
export async function listInvites(apiClient: ApiClient, nsId: string): Promise<ListInvitesResult> {
  let response: ListInvitesResponse;
  try {
    response = await apiClient.get<ListInvitesResponse>(`/api/ns/${nsId}/invites`);
  } catch (err) {
    throw inviteError(err, "list");
  }
  const invites = (Array.isArray(response?.invites) ? response.invites : []).map((i) => ({
    id: i.id,
    role: i.role,
    created_by_username: i.created_by_username ?? null,
    created_at: i.created_at,
    expires_at: i.expires_at,
    paused: i.paused === true,
  }));
  return { invites };
}

/**
 * Revokes one pending invite of a namespace by its id. Requires owner or admin.
 *
 * @throws Error with a plain-language message on any failure (404 when the invite is not pending here).
 */
export async function revokeInvite(
  apiClient: ApiClient,
  nsId: string,
  inviteId: string,
): Promise<RevokeInviteResult> {
  if (typeof inviteId !== "string" || inviteId.trim() === "") {
    throw new Error("An invite id is required to revoke an invite link. Use action 'invites' to see the pending ones.");
  }
  try {
    await apiClient.delete<{ ok: true }>(`/api/ns/${nsId}/invites/${encodeURIComponent(inviteId.trim())}`);
  } catch (err) {
    throw inviteError(err, "revoke");
  }
  return { ok: true };
}
