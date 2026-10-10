/**
 * Core gate management logic.
 *
 * Returns structured data — formatting is the adapter's job.
 * Throws on validation failures and API errors.
 *
 * Also exports a utility:
 *   formatGateFields()  — renders a gate's field objects as readable text
 */

import type { ApiClient } from "./api-client.ts";
import type { GateConfig, GateField, GateFieldType, GateSubmission } from "./types.ts";

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
}

export interface RemoveGateResult {
  /** Confirmation message from the API. */
  message: string;
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
}

interface RemoveGateResponse {
  message: string;
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
  return { gate: response.gate };
}

// ─── Remove ───────────────────────────────────────────────────────────────────

/**
 * Removes the form gate from a site.
 *
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID the site belongs to.
 * @param slug - The site slug.
 * @returns Confirmation message from the API.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function removeGate(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
): Promise<RemoveGateResult> {
  const response = await apiClient.delete<RemoveGateResponse>(
    `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/gate`,
  );
  return { message: response.message };
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
