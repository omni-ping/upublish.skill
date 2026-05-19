/**
 * Core passcode management logic.
 *
 * Returns structured data — formatting is the adapter's job.
 * Throws on validation failures and API errors.
 */

import type { ApiClient } from "./api-client.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A passcode record for a passcode-protected site. */
export interface SitePasscode {
  /** Unique passcode ID. */
  id: string;
  /** Human-readable label (e.g. "Client A", "default"). */
  label: string;
  /** ISO 8601 creation timestamp. */
  created_at: string;
}

export interface AddPasscodeResult {
  /** The newly created passcode record. */
  passcode: SitePasscode;
}

export interface ListPasscodesResult {
  /** Array of passcodes for the site. Empty array if none exist. */
  passcodes: SitePasscode[];
}

export interface RevokePasscodeResult {
  /** Confirmation message from the API. */
  message: string;
}

interface AddPasscodeResponse {
  id: string;
  label: string;
  created_at: string;
}

interface ListPasscodesResponse {
  passcodes: SitePasscode[];
}

interface RevokePasscodeResponse {
  message: string;
}

// ─── Add ─────────────────────────────────────────────────────────────────────

/**
 * Adds a passcode to a passcode-protected site.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID the site belongs to.
 * @param slug - The site slug.
 * @param code - The passcode string.
 * @param label - Human-readable label for the passcode.
 * @returns The newly created passcode record.
 * @throws Error if code or label is empty.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function addPasscode(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
  code: string,
  label: string,
): Promise<AddPasscodeResult> {
  if (!code || code.trim().length === 0) {
    throw new Error("code is required");
  }
  if (!label || label.trim().length === 0) {
    throw new Error("label is required");
  }

  const result = await apiClient.post<AddPasscodeResponse>(
    `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/passcodes`,
    { code, label },
  );

  return {
    passcode: {
      id: result.id,
      label: result.label,
      created_at: result.created_at,
    },
  };
}

// ─── List ─────────────────────────────────────────────────────────────────────

/**
 * Lists all passcodes for a site.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID the site belongs to.
 * @param slug - The site slug.
 * @returns Object containing an array of passcode records.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function listPasscodes(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
): Promise<ListPasscodesResult> {
  const response = await apiClient.get<ListPasscodesResponse>(
    `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/passcodes`,
  );
  return { passcodes: response.passcodes };
}

// ─── Revoke ───────────────────────────────────────────────────────────────────

/**
 * Revokes a passcode by ID.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID the site belongs to.
 * @param slug - The site slug.
 * @param id - The passcode ID to revoke.
 * @returns Object containing the API confirmation message.
 * @throws Error if id is empty.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function revokePasscode(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
  id: string,
): Promise<RevokePasscodeResult> {
  if (!id || id.trim().length === 0) {
    throw new Error("id is required");
  }

  const result = await apiClient.delete<RevokePasscodeResponse>(
    `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/passcodes/${encodeURIComponent(id)}`,
  );

  return { message: result.message };
}
