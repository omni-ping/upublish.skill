/**
 * Core diagram generation logic.
 *
 * Sends context text to the upubli.sh server-side skill engine, which generates
 * an Excalidraw diagram and publishes it as a static site.
 *
 * Returns structured data ({ url, slug }) — formatting is the adapter's job.
 * Throws on validation failures and API errors.
 */

import type { ApiClient } from "./api-client.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GenerateOpts {
  /** Authenticated API client. */
  apiClient: ApiClient;
  /** Text description or context to generate a diagram from. */
  context: string;
  /** Optional hint for diagram type. */
  diagramType?: "flowchart" | "sequence" | "architecture";
  /** Optional slug for the published site. */
  slug?: string;
}

export interface GenerateResult {
  /** Public URL of the published diagram. */
  url: string;
  /** Slug assigned to the generated site. */
  slug: string;
}

interface GenerateResponse {
  url: string;
  slug: string;
}

// ─── Generate ────────────────────────────────────────────────────────────────

/**
 * Generates a diagram from context text and publishes it.
 *
 * @param opts - Generation options including apiClient, context, etc.
 * @returns The published diagram URL and slug.
 * @throws Error if context is empty or whitespace-only.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function generate(opts: GenerateOpts): Promise<GenerateResult> {
  const { apiClient, context, diagramType, slug } = opts;

  if (!context || context.trim().length === 0) {
    throw new Error("context is required and cannot be empty");
  }

  const requestBody: Record<string, unknown> = { context };
  if (diagramType) requestBody.diagramType = diagramType;
  if (slug) requestBody.slug = slug;

  const result = await apiClient.post<GenerateResponse>(
    "/api/generate",
    requestBody,
  );

  return {
    url: result.url,
    slug: result.slug,
  };
}
