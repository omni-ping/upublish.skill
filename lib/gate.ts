/**
 * Core gate management logic.
 *
 * Returns structured data — formatting is the adapter's job.
 * Throws on validation failures and API errors.
 *
 * Also exports a utility:
 *   formatGateFields()  — renders a gate's field objects as readable text
 */

import { ApiError } from "./api-client.ts";
import type { ApiClient } from "./api-client.ts";
import { asVisibility } from "./types.ts";
import type { GateConfig, GateField, GateFieldType, GateSubmission, Visibility } from "./types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GetGateResult {
  /** The gate configuration for the site. */
  gate: GateConfig;
  /** Total number of submissions captured through this gate. */
  submission_count: number;
}

export interface SetGateResult {
  /** The updated gate configuration. */
  gate: GateConfig;
  /**
   * The site's visibility BEFORE the gate was set. Absent when the server
   * predates the field. "passcode" means passcode protection was just replaced.
   */
  previous_visibility?: Visibility;
}

/** What `removeGate` can leave the site as. */
export type GateRemoveVisibility = "public" | "passcode";

export interface RemoveGateResult {
  /** Confirmation message from the API. */
  message: string;
  /** The site's visibility after removal, from the server's echo (public when an old server omits it). */
  visibility: Visibility;
}

export interface GetSubmissionsResult {
  /** Array of visitor submissions. */
  submissions: GateSubmission[];
}

export interface ClearSubmissionsResult {
  /** Confirmation message from the API. */
  message: string;
}

interface GetGateResponse {
  gate: GateConfig;
  submission_count: number;
}

interface SetGateResponse {
  gate: GateConfig;
  previous_visibility?: unknown;
}

interface RemoveGateResponse {
  message: string;
  visibility?: unknown;
}

interface GetSubmissionsResponse {
  submissions: GateSubmission[];
}

interface ClearSubmissionsResponse {
  message: string;
}

// ─── Get ──────────────────────────────────────────────────────────────────────

/**
 * Gets the gate configuration and submission count for a site.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID the site belongs to.
 * @param slug - The site slug.
 * @returns Gate config and submission count.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function getGate(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
): Promise<GetGateResult> {
  const response = await apiClient.get<GetGateResponse>(
    `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/gate`,
  );
  return { gate: response.gate, submission_count: response.submission_count };
}

// ─── Set ──────────────────────────────────────────────────────────────────────

/**
 * Creates or updates the form gate for a site.
 *
 * The API takes field *objects*, not field-type strings: the request body is
 * `{ fields: [{ type, required }, ...] }` and a bare string element is rejected
 * with "each field must be an object". This function accepts the field types
 * and builds those objects, defaulting every field to `required: true` —
 * matching how every gate written before this surface existed was stored, so a
 * re-save never silently makes a live form's fields optional.
 *
 * Per-field `required` control is deliberately not offered here; the MCP tool's
 * argument shape is a list of field types.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID the site belongs to.
 * @param slug - The site slug.
 * @param fields - Field types to collect from visitors; each is sent as required.
 * @returns The updated gate configuration.
 * @throws Error if fields array is empty (no request is issued).
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function setGate(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
  fields: GateFieldType[],
): Promise<SetGateResult> {
  if (!fields || fields.length === 0) {
    throw new Error("fields is required");
  }

  const body: { fields: GateField[] } = {
    fields: fields.map((type) => ({ type, required: true })),
  };

  const response = await apiClient.put<SetGateResponse>(
    `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/gate`,
    body,
  );
  return { gate: response.gate, previous_visibility: asVisibility(response.previous_visibility) };
}

// ─── Remove ───────────────────────────────────────────────────────────────────

/**
 * Removes the form gate and sets what the site becomes, atomically on the server.
 *
 * Removing a gate used to silently make the site public. The caller must now
 * say what the site should be afterwards; the result reports what the server
 * says it IS, never what we asked for.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID the site belongs to.
 * @param slug - The site slug.
 * @param visibilityAfter - "public" or "passcode" (passcode needs >= 1 passcode).
 * @returns Confirmation message and the resulting visibility.
 * @throws Error if visibilityAfter is not public/passcode (no request is issued).
 * @throws Error if "passcode" was requested but the server did not keep it (site is now PUBLIC).
 * @throws Error with guidance on 409 no_passcodes (the gate is left in place).
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function removeGate(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
  visibilityAfter: GateRemoveVisibility,
): Promise<RemoveGateResult> {
  if (visibilityAfter !== "public" && visibilityAfter !== "passcode") {
    throw new Error(`visibility_after must be "public" or "passcode" (got "${String(visibilityAfter)}")`);
  }

  let response: RemoveGateResponse;
  try {
    response = await apiClient.delete<RemoveGateResponse>(
      `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/gate?visibility=${visibilityAfter}`,
    );
  } catch (err) {
    const body = err instanceof ApiError ? (err.rawBodyData as { code?: unknown } | null) : null;
    if (err instanceof ApiError && err.status === 409 && body?.code === "no_passcodes") {
      throw new Error(
        `Site "${slug}" has no passcodes, so it cannot stay passcode-protected after the gate is removed. ` +
        `The gate was NOT removed. Run visibility(slug, "passcode", passcode: "<code>") first ` +
        `(it works on a gated site), then retry with visibility_after "passcode" — or use visibility_after "public".`,
        { cause: err },
      );
    }
    throw err;
  }

  // An old server ignores ?visibility= and always reverts to public.
  const visibility = asVisibility(response.visibility) ?? "public";
  if (visibilityAfter === "passcode" && visibility !== "passcode") {
    throw new Error(
      `The server did not keep passcode protection — "${slug}" is now PUBLIC. Run visibility(slug, "passcode") now.`,
    );
  }
  return { message: response.message, visibility };
}

// ─── Get Submissions ──────────────────────────────────────────────────────────

/**
 * Lists visitor submissions captured by the gate.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID the site belongs to.
 * @param slug - The site slug.
 * @returns Array of gate submissions.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function getSubmissions(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
): Promise<GetSubmissionsResult> {
  const response = await apiClient.get<GetSubmissionsResponse>(
    `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/gate/submissions`,
  );
  return { submissions: response.submissions };
}

// ─── Clear Submissions ────────────────────────────────────────────────────────

/**
 * Clears all visitor submissions for a site's gate.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID the site belongs to.
 * @param slug - The site slug.
 * @returns Confirmation message from the API.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function clearSubmissions(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
): Promise<ClearSubmissionsResult> {
  const response = await apiClient.delete<ClearSubmissionsResponse>(
    `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/gate/submissions`,
  );
  return { message: response.message };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Renders a gate's fields as readable text for an adapter to display.
 *
 * A gate's fields are objects, so joining them directly yields "[object Object]".
 * Fields the visitor may skip are marked, because a gate configured on the web
 * dashboard can carry optional fields and `gate get` is the only way to see them.
 *
 * The optional marker keys on `required === false` rather than falsiness, so a
 * response that omits the property is never mislabelled as optional.
 *
 * @param fields - The gate's fields, in configured order.
 * @returns Comma-separated field types, or "(none)" when there are none.
 */
export function formatGateFields(fields: GateField[]): string {
  if (fields.length === 0) return "(none)";
  return fields
    .map((f) => (f.required === false ? `${f.type} (optional)` : f.type))
    .join(", ");
}
