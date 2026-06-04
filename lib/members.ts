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

import type { ApiClient } from "./api-client.ts";
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
