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
import { ApiError } from "./api-client.ts";
import type { Namespace } from "./types.ts";
import { UPGRADE_HINT } from "./upgrade.ts";

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

/** Fallback approval URL when the 402 body omits it. */
const APPROVAL_URL_FALLBACK = "https://upubli.sh/profile/settings?overage_request=1";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Thrown when the API returns 402 `needs_overage_approval`. Carries the
 * structured fields from the backend response so the adapter can surface the
 * approval URL and pack pricing without reformatting the generic error message.
 *
 * `approval_url` is defensively defaulted to the canonical fallback when the
 * backend body is malformed or missing it — the caller always receives a usable
 * approval URL even on a partial/unexpected body.
 *
 * `price`, `pack_size`, and `interval` are nullable: when the body omits them,
 * the adapter renders pack-language copy without hardcoded price literals.
 */
export class OverageApprovalError extends Error {
  constructor(
    public readonly approval_url: string,
    /** USD price for one pack, or null when absent from the 402 body. */
    public readonly price: number | null,
    /** Number of address slots per pack, or null when absent from the 402 body. */
    public readonly pack_size: number | null,
    /** Billing interval of the base subscription, or null when unknown/absent. */
    public readonly interval: "month" | "year" | null,
    message: string,
  ) {
    super(message);
    this.name = "OverageApprovalError";
  }
}

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
  /**
   * Present on a consented over-cap create (201 with overage charged).
   * `pack_size` is the number of address slots per pack (always 5).
   * `interval` is the billing interval matching the base subscription.
   * `price` is the USD cost per pack (1 monthly, 10 annual).
   */
  overage?: { charged: boolean; price: number; pack_size: number; interval: "month" | "year" };
}

/** Result of creating a namespace — the new id and the domain it lives on. */
export interface NamespaceCreateResult {
  /** The created namespace's ID. */
  namespace_id: string;
  /** The domain the namespace lives under (e.g. "upubli.sh"). */
  domain: string;
  /**
   * Present when this create charged an address-pack overage. The backend bills
   * recurring packs of `pack_size` address slots at `price` USD per `interval`.
   * Absent on a normal within-cap create.
   */
  overage?: { charged: boolean; price: number; pack_size: number; interval: "month" | "year" };
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
  const result: NamespaceCreateResult = {
    namespace_id: response.namespace.id,
    domain: response.namespace.domain,
  };
  // Thread the overage field through when the backend signals a charged pack create.
  if (response.overage?.charged === true) {
    result.overage = {
      charged: true,
      price: response.overage.price,
      pack_size: response.overage.pack_size,
      interval: response.overage.interval,
    };
  }
  return result;
}

/**
 * Enriches API errors with actionable guidance at the namespace barricade.
 *
 * - 402 `needs_overage_approval`: converts to `OverageApprovalError` carrying
 *   the approval URL, pack price, pack size, and billing interval from the body.
 *   All fields are defensively narrowed — a malformed or partial body still
 *   produces a usable error with the canonical fallback URL and pack wording
 *   (no hardcoded `$0.20` price literal).
 * - 403 tier-limit: appends the upgrade URL (existing behavior, free users).
 * - All other errors: pass through unchanged — backend text is already actionable.
 */
function enrichNamespaceError(err: Error): Error {
  // 402: needs overage approval — preserve structured fields for the adapter.
  if (err instanceof ApiError && err.status === 402) {
    const body = err.rawBodyData as Record<string, unknown> | null;
    const code = typeof body?.code === "string" ? body.code : "";
    if (code === "needs_overage_approval" || /needs_overage_approval/i.test(err.message)) {
      const approvalUrl =
        typeof body?.approval_url === "string" && body.approval_url
          ? body.approval_url
          : APPROVAL_URL_FALLBACK;
      // All pack fields are nullable — a missing/malformed body must not
      // produce a hardcoded price literal. The adapter renders pack copy.
      const price =
        typeof body?.price === "number" && isFinite(body.price) ? body.price : null;
      const pack_size =
        typeof body?.pack_size === "number" && Number.isInteger(body.pack_size) && body.pack_size > 0
          ? body.pack_size
          : null;
      const rawInterval = body?.interval;
      const interval: "month" | "year" | null =
        rawInterval === "month" || rawInterval === "year" ? rawInterval : null;
      return new OverageApprovalError(
        approvalUrl,
        price,
        pack_size,
        interval,
        `Address pack approval required. Approve at ${approvalUrl}`,
      );
    }
    // 402 with an unexpected code — fall through to pass-through below.
  }

  // 403 tier-limit: append the upgrade URL AND the `upgrade`-tool hint so the
  // agent can either point the user at pricing or open checkout directly.
  // Exclude the 1 TiB `hard_max` ceiling (carries `code: "hard_max"`) — an
  // upgrade cannot lift it, so neither hint applies there.
  const code =
    err instanceof ApiError && err.rawBodyData && typeof err.rawBodyData === "object"
      ? (err.rawBodyData as Record<string, unknown>).code
      : undefined;
  const isHardMax = code === "hard_max";
  const isTierLimit =
    !isHardMax && /API error 403/.test(err.message) && /limit/i.test(err.message);
  if (isTierLimit) {
    return new Error(
      `${err.message} Upgrade at ${UPGRADE_URL} to create more namespaces. ${UPGRADE_HINT}`,
    );
  }

  return err;
}
