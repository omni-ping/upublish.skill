/**
 * Core passcode management logic.
 *
 * Returns structured data — formatting is the adapter's job.
 * Throws on validation failures and API errors.
 */

import { ApiError } from "./api-client.ts";
import type { ApiClient } from "./api-client.ts";
import { readSiteVisibility } from "./list.ts";
import type { Visibility } from "./types.ts";
import { UPGRADE_HINT } from "./upgrade.ts";

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
 * Appends the `upgrade` hint to a free-tier "requires a paid plan" 403.
 * The passcode routes' tier 403 carries only `{ error }` (no limit/usage), so
 * the generic tier-limit discriminator in upgrade.ts does not match it.
 * Any other error is returned untouched.
 */
export function withPaidPlanHint(err: unknown): unknown {
  if (!(err instanceof ApiError) || err.status !== 403) return err;
  if (!/paid plan/i.test(err.message)) return err;
  return new ApiError(err.status, err.rawBodyData, `${err.message} ${UPGRADE_HINT}`);
}

/** Validates passcode inputs before any request is issued. */
export function assertPasscodeInput(code: string, label: string): void {
  if (!code || code.trim().length === 0) {
    throw new Error("code is required");
  }
  if (!label || label.trim().length === 0) {
    throw new Error("label is required");
  }
}

/**
 * Raw passcode POST — NO visibility check. Internal building block: the public
 * `addPasscode` guards it, and `setVisibility` calls it directly because it
 * adds the code BEFORE flipping the site to passcode.
 *
 * @throws Error if code or label is empty, or on API failure (free-tier 403 carries the upgrade hint).
 */
export async function createPasscode(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
  code: string,
  label: string,
): Promise<AddPasscodeResult> {
  assertPasscodeInput(code, label);

  let result: AddPasscodeResponse;
  try {
    result = await apiClient.post<AddPasscodeResponse>(
      `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/passcodes`,
      { code, label },
    );
  } catch (err) {
    throw withPaidPlanHint(err);
  }

  return {
    passcode: {
      id: result.id,
      label: result.label,
      created_at: result.created_at,
    },
  };
}

/** Why a passcode cannot protect a site in the given (non-passcode) state. */
function passcodeRefusal(slug: string, visibility: Visibility): string {
  if (visibility === "public") {
    return (
      `Site "${slug}" is PUBLIC — adding a passcode does not protect it. ` +
      `To make it private, call visibility(slug, "passcode", passcode: "<code>").`
    );
  }
  if (visibility === "gated") {
    return (
      `Site "${slug}" is GATED — the form gate replaces passcodes, so a passcode would not be enforced. ` +
      `To switch it to passcode protection, call visibility(slug, "passcode", passcode: "<code>"); ` +
      `the form gate's settings and submissions remain until you run gate remove.`
    );
  }
  return (
    `Site "${slug}" is ${visibility.toUpperCase()} — passcodes only apply to passcode-protected sites. ` +
    `To switch it, call visibility(slug, "passcode", passcode: "<code>").`
  );
}

/**
 * Adds a passcode to a passcode-protected site.
 *
 * Refuses (no POST) unless the site is currently `passcode`: a passcode on a
 * public or gated site is never enforced, and reporting success would let the
 * caller believe the site is private.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID the site belongs to.
 * @param slug - The site slug.
 * @param code - The passcode string.
 * @param label - Human-readable label for the passcode.
 * @returns The newly created passcode record.
 * @throws Error if code or label is empty.
 * @throws Error if the site is not passcode-protected or its visibility can't be read.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function addPasscode(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
  code: string,
  label: string,
): Promise<AddPasscodeResult> {
  assertPasscodeInput(code, label);
  const visibility = await readSiteVisibility(apiClient, nsId, slug);
  if (visibility !== "passcode") {
    throw new Error(passcodeRefusal(slug, visibility));
  }
  return createPasscode(apiClient, nsId, slug, code, label);
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
