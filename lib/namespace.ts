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
import type { Namespace } from "./types.ts";

// ─── Constants ─────────────────────────────────────────────────────────────────

/**
 * Default hosted platform domain a user's namespace is created on when no
 * custom domain is supplied. Mirrors the backend's DEFAULT_NAMESPACE_DOMAIN —
 * onboarding completion and `POST /api/ns` both treat this as the default
 * hosted domain. Note: users can also select pinn.sh as an alternative hosted
 * apex at signup/onboarding and when creating additional namespaces.
 */
const DEFAULT_NAMESPACE_DOMAIN = "upubli.sh";

/** Where free-tier users go to lift the root-namespace limit. */
const UPGRADE_URL = "https://upubli.sh/pricing";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SpaceResponse {
  space: {
    id: string;
    default_namespace_id: string | null;
    tier: string;
  };
}

interface NamespacesResponse {
  namespaces: Namespace[];
}

/** Backend response shape for POST /api/ns. */
interface CreateNamespaceResponse {
  namespace: Namespace;
}

/** Result of creating a namespace — the new id and the domain it lives on. */
export interface NamespaceCreateResult {
  /** The created namespace's ID. */
  namespace_id: string;
  /** The domain the namespace lives under (e.g. "upubli.sh"). */
  domain: string;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolves the namespace to use for site operations.
 *
 * @param apiClient - Authenticated API client.
 * @param namespaceName - Optional namespace name to look up. When omitted,
 *   the default namespace is resolved from GET /api/space.
 * @returns The resolved Namespace object (id, name, domain).
 * @throws Error if the named namespace does not exist.
 * @throws Error if no namespaces exist for the account.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function resolveNamespace(
  apiClient: ApiClient,
  namespaceName?: string,
): Promise<Namespace> {
  if (namespaceName !== undefined) {
    return resolveByName(apiClient, namespaceName);
  }

  return resolveDefault(apiClient);
}

/** Looks up a namespace by name from the namespaces list. */
async function resolveByName(
  apiClient: ApiClient,
  name: string,
): Promise<Namespace> {
  const { namespaces } = await apiClient.get<NamespacesResponse>("/api/ns");
  const found = namespaces.find((ns) => ns.name === name);

  if (!found) {
    throw namespaceNotFound(name, namespaces);
  }

  return found;
}

/**
 * Resolves a namespace by an ambiguous reference — a namespace **name** or its
 * **UUID** — from the namespaces list. Used by `rename`, whose `nsId` argument
 * may be either (the tool schema historically told users to paste a UUID, so
 * both must work). Name is tried first, then id; an unknown ref throws the same
 * actionable "not found / Available namespaces: …" error as `resolveByName`.
 *
 * @param apiClient - Authenticated API client.
 * @param ref - A namespace name or its UUID.
 * @returns The resolved Namespace object (id, name, domain).
 * @throws Error if no namespace matches the ref by name or id.
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function resolveNamespaceRef(
  apiClient: ApiClient,
  ref: string,
): Promise<Namespace> {
  const { namespaces } = await apiClient.get<NamespacesResponse>("/api/ns");
  const found =
    namespaces.find((ns) => ns.name === ref) ??
    namespaces.find((ns) => ns.id === ref);

  if (!found) {
    throw namespaceNotFound(ref, namespaces);
  }

  return found;
}

/**
 * Builds the actionable not-found error shared by `resolveByName` and
 * `resolveNamespaceRef`, so the message stays byte-identical across both
 * resolvers. Lists the available namespace names, or "(none)" when empty.
 */
function namespaceNotFound(ref: string, namespaces: Namespace[]): Error {
  return new Error(
    `Namespace '${ref}' not found. ` +
    `Available namespaces: ${namespaces.map((ns) => ns.name).join(", ") || "(none)"}`,
  );
}

/** Resolves the default namespace from GET /api/space. */
async function resolveDefault(apiClient: ApiClient): Promise<Namespace> {
  const { space } = await apiClient.get<SpaceResponse>("/api/space");
  const { namespaces } = await apiClient.get<NamespacesResponse>("/api/ns");

  if (namespaces.length === 0) {
    throw new Error(
      "No namespace found. Create a namespace at https://upubli.sh/dashboard first.",
    );
  }

  if (space.default_namespace_id) {
    const found = namespaces.find((ns) => ns.id === space.default_namespace_id);
    if (found) {
      return found;
    }
  }

  // No default set (or default not found) — fall back to first namespace
  return namespaces[0];
}

// ─── Creation ────────────────────────────────────────────────────────────────

/**
 * Creates a new root namespace via POST /api/ns and returns its id + domain.
 *
 * When `domain` is omitted the namespace is created on the hosted platform
 * domain (`upubli.sh`) — the common case for first-time and free-tier users.
 *
 * Errors surface as thrown Errors with actionable messages (matching every
 * other domain function, so the adapter just renders `err.message`):
 *   - 409 → the name is already taken on that domain
 *   - 400 → invalid name format
 *   - 422 → reserved / disallowed name
 *   - 403 (tier limit) → the message is enriched with the upgrade URL so the
 *          agent can tell the user exactly how to lift the limit
 *
 * @param apiClient - Authenticated API client.
 * @param name - The namespace name to create.
 * @param domain - Optional hosted/custom domain; defaults to "upubli.sh".
 * @returns The new namespace id and the domain it lives on.
 * @throws Error with an actionable message on any API failure.
 */
export async function namespaceCreate(
  apiClient: ApiClient,
  name: string,
  domain: string = DEFAULT_NAMESPACE_DOMAIN,
): Promise<NamespaceCreateResult> {
  let response: CreateNamespaceResponse;
  try {
    response = await apiClient.post<CreateNamespaceResponse>("/api/ns", { name, domain });
  } catch (err) {
    throw enrichNamespaceError(err as Error);
  }
  return {
    namespace_id: response.namespace.id,
    domain: response.namespace.domain,
  };
}

/**
 * Adds upgrade guidance to a tier-limit rejection. ApiClient collapses non-2xx
 * responses to `API error <status>: <backend message>`; the backend's 403
 * limit message already names the plan limit ("…allows N root namespace(s)"),
 * so we only need to append where to upgrade. All other errors pass through
 * unchanged — their backend text is already actionable.
 */
function enrichNamespaceError(err: Error): Error {
  const isTierLimit = /API error 403/.test(err.message) && /limit/i.test(err.message);
  if (isTierLimit) {
    return new Error(`${err.message} Upgrade at ${UPGRADE_URL} to create more namespaces.`);
  }
  return err;
}
