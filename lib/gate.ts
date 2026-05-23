/**
 * Core gate management logic.
 *
 * Returns structured data — formatting is the adapter's job.
 * Throws on validation failures and API errors.
 */

import type { ApiClient } from "./api-client.ts";
import type { GateConfig, GateSubmission } from "./types.ts";

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
 * @param apiClient - Authenticated API client.
 * @param nsId - The namespace ID the site belongs to.
 * @param slug - The site slug.
 * @param fields - Array of field types to collect from visitors.
 * @returns The updated gate configuration.
 * @throws Error if fields array is empty.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function setGate(
  apiClient: ApiClient,
  nsId: string,
  slug: string,
  fields: string[],
): Promise<SetGateResult> {
  if (!fields || fields.length === 0) {
    throw new Error("fields is required");
  }

  const response = await apiClient.put<SetGateResponse>(
    `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/gate`,
    { fields },
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
