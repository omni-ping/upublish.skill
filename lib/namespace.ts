/**
 * Namespace resolution — resolves the target namespace ID for site operations.
 *
 * The resolution strategy:
 *   - If a namespace name is provided: list all namespaces, match by name.
 *   - If no name provided: call GET /api/space for default_namespace_id.
 *     If default is set, use it. If not, list namespaces and use the first.
 *
 * Throws if the named namespace does not exist or if no namespaces exist at all.
 */

import type { ApiClient } from "./api-client.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SpaceResponse {
  space: {
    id: string;
    default_namespace_id: string | null;
    tier: string;
  };
}

interface Namespace {
  id: string;
  name: string;
  domain: string;
}

interface NamespacesResponse {
  namespaces: Namespace[];
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolves the namespace ID to use for site operations.
 *
 * @param apiClient - Authenticated API client.
 * @param namespaceName - Optional namespace name to look up. When omitted,
 *   the default namespace is resolved from GET /api/space.
 * @returns The resolved namespace ID string.
 * @throws Error if the named namespace does not exist.
 * @throws Error if no namespaces exist for the account.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function resolveNamespace(
  apiClient: ApiClient,
  namespaceName?: string,
): Promise<string> {
  if (namespaceName !== undefined) {
    return resolveByName(apiClient, namespaceName);
  }

  return resolveDefault(apiClient);
}

/** Looks up a namespace by name from the namespaces list. */
async function resolveByName(
  apiClient: ApiClient,
  name: string,
): Promise<string> {
  const { namespaces } = await apiClient.get<NamespacesResponse>("/api/ns");
  const found = namespaces.find((ns) => ns.name === name);

  if (!found) {
    throw new Error(
      `Namespace '${name}' not found. ` +
      `Available namespaces: ${namespaces.map((ns) => ns.name).join(", ") || "(none)"}`,
    );
  }

  return found.id;
}

/** Resolves the default namespace from GET /api/space. */
async function resolveDefault(apiClient: ApiClient): Promise<string> {
  const { space } = await apiClient.get<SpaceResponse>("/api/space");

  if (space.default_namespace_id) {
    return space.default_namespace_id;
  }

  // No default set — fall back to first namespace in the list
  const { namespaces } = await apiClient.get<NamespacesResponse>("/api/ns");

  if (namespaces.length === 0) {
    throw new Error(
      "No namespace found. Create a namespace at https://upubli.sh/dashboard first.",
    );
  }

  return namespaces[0].id;
}
