/**
 * User backends: every operation behind the `publish_backend`, `backend`,
 * `backend_secret` and `backend_logs` tools.
 *
 *   publish_backend  bundle an entry file (or inline code) locally, deploy it next to a site
 *   backend          status | versions | rollback | enable | disable | access | delete |
 *                    addon_status | addon_enable | addon_disable
 *   backend_secret   set | list | delete   (names only ever come back)
 *   backend_logs     the last N log lines
 *
 * Each function takes an authenticated ApiClient and a resolved Namespace
 * (core.ts wires both); API failures throw `BackendError`, bundling failures
 * are RESULTS (nothing was sent, the author fixes the code and retries).
 *
 * Paid action. Enabling the add-on charges, so `addon_enable` never charges on
 * its own, and consent is bound to what the user was shown: every enable
 * re-reads the status, derives an `expected` {would_charge, converts, interval,
 * prices} from it, and only POSTs when the caller passes `accept_charge: true`
 * together with an `expected` equal to the freshly derived one. A price,
 * interval or conversion that changed since the consent was shown yields a new
 * consent instead of a charge. Consent is required on EVERY enable, even when
 * the server reports no charge: nothing here ever enables silently.
 *
 * Secrets. A secret value exists in this process only as the body of one PUT.
 * It is never put in a result, a log line or an error message: the whole `set`
 * runs inside `withRedaction`, so every error that escapes it is redacted
 * against the raw, trimmed, per-line, JSON-, control- and \uXXXX-escaped
 * spellings (not against deliberate re-encodings such as base64). Results use
 * the caller's own secret name, never a server-supplied field.
 */

import type { ApiClient } from "./api-client.ts";
import { BackendError, guard, redactValues, withRedaction } from "./backend-errors.ts";
import { bundleBackend, type BundleResult } from "./backend-bundle.ts";
import {
  BACKEND_LIMITS, BINDING_NAME_RE, parseAddonStatus, parseBackendStatus, parseDeployResponse, parseDisableResponse,
  parseDeleteResponse, parseEnableResponse, parseLogs, parseRollbackResponse, parseSecretDelete, parseSecretList, parseSecretSet,
  parseVersionList,
  type BackendAccess, type BackendAddonStatus, type BackendDisableResponse, type BackendEnableResponse, type BackendLogs,
  type BackendSecret, type BackendStatus, type BackendVersion, type BillingInterval, type RollbackResponse,
} from "./backend-shape.ts";
import { listSites } from "./list.ts";
import { parseDataStatus } from "./site-data-shape.ts";
import { requireArg } from "./site-data-errors.ts";
import { safeText } from "./site-data-text.ts";
import type { Namespace } from "./types.ts";

// ─── Paths ───────────────────────────────────────────────────────────────────

const addonBase = (nsId: string): string => `/api/ns/${nsId}/backend-addon`;
const backendBase = (nsId: string, slug: string): string => `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}/backend`;

// ─── publish_backend ─────────────────────────────────────────────────────────

export interface PublishBackendArgs {
  /** Slug of the (already published) site the backend sits next to; `_root` for the address root site. */
  site: string;
  /** Path to the entry file (.ts/.js), bundled locally. Exactly one of `entry` / `code`. */
  entry?: string;
  /** Inline source (for hosted /mcp, which has no local files). Exactly one of `entry` / `code`. */
  code?: string;
  access?: BackendAccess;
  /** Plain-text vars (NOT secrets), versioned with the bundle. Omit to keep the live version's. */
  vars?: Record<string, string>;
  namespace?: string;
}

export type PublishBackendResult =
  | {
      action: "publish_backend"; state: "deployed"; namespace: string; site: string;
      /** `{site url}/_api/`, null when the site list could not be read. */
      url: string | null; version: number; access: BackendAccess; deployed_at: string; bundle_bytes: number;
      /** The server's hash and size of what it stored equal what was sent. */
      verified: boolean; var_names: string[]; warnings: string[];
    }
  | { action: "publish_backend"; state: "bundle_failed"; kind: Extract<BundleResult, { ok: false }>["kind"]; message: string };

/** Var names that look like credentials: vars are plain text and versioned, secrets are not. */
const SECRETISH_NAME_RE = /secret|token|password|passwd|credential|private|api_?key|(^|_)key$/i;

/** Checks `vars` against the contract limits so a bad set fails before bundling. Names are not sensitive; values are never echoed. */
function validateVars(vars: Record<string, string>): void {
  const names = Object.keys(vars);
  if (names.length > BACKEND_LIMITS.varsPerBackend) {
    throw new Error(`Too many vars (${names.length}); a backend holds at most ${BACKEND_LIMITS.varsPerBackend}.`);
  }
  for (const name of names) {
    if (!BINDING_NAME_RE.test(name)) {
      throw new Error(`Invalid var name '${safeText(name)}': use letters, digits and underscores, not starting with a digit, up to ${BACKEND_LIMITS.bindingNameLength} characters.`);
    }
    if (new TextEncoder().encode(vars[name]!).length > BACKEND_LIMITS.bindingValueBytes) {
      throw new Error(`Var '${name}' is over ${BACKEND_LIMITS.bindingValueBytes} bytes.`);
    }
  }
}

/** The site's public URL for `/_api`, from the namespace's site list; null when it cannot be read. */
async function apiUrlFor(apiClient: ApiClient, nsId: string, slug: string): Promise<string | null> {
  try {
    const { sites } = await listSites(apiClient, nsId);
    const url = sites.find((s) => s.slug === slug)?.url;
    return url ? `${url.replace(/\/+$/, "")}/_api/` : null;
  } catch {
    return null;
  }
}

/**
 * Bundles and deploys a backend. Nothing is sent unless the bundle is valid.
 * `opts.allowEntry` (default false) lets `entry` name a file on THIS machine; only a local stdio server sets it.
 * @throws Error on bad arguments or a refused `entry`; BackendError on API failure.
 */
export async function runPublishBackend(
  apiClient: ApiClient, ns: Namespace, args: PublishBackendArgs, opts: { cwd?: string; allowEntry?: boolean } = {},
): Promise<PublishBackendResult> {
  const site = requireArg(args.site, "site", "publish_backend");
  if ((args.entry === undefined) === (args.code === undefined)) {
    throw new Error("Pass exactly one of 'entry' (a file path) or 'code' (inline source).");
  }
  if (args.entry !== undefined && opts.allowEntry !== true) {
    // A server-side host (the hosted /mcp router) has no files of the caller's: an `entry` path would name the
    // SERVER's files. Only a local stdio server opts in.
    throw new Error("'entry' is not available on this server: it cannot see your files. Pass the handler's source as 'code' (one self-contained module, no imports except cloudflare:*).");
  }
  if (args.vars) validateVars(args.vars);

  const bundle = await bundleBackend(args.entry !== undefined ? { entry: args.entry } : { code: args.code! }, opts);
  if (!bundle.ok) return { action: "publish_backend", state: "bundle_failed", kind: bundle.kind, message: bundle.message };

  const body = { source: bundle.source, ...(args.access ? { access: args.access } : {}), ...(args.vars ? { vars: args.vars } : {}) };
  const res = await guard("admin", async () => parseDeployResponse(await apiClient.post<unknown>(backendBase(ns.id, site), body)));

  const varNames = Object.keys(args.vars ?? {});
  const warnings = [...res.warnings];
  const credentialVars = varNames.filter((n) => SECRETISH_NAME_RE.test(n));
  if (credentialVars.length > 0) {
    warnings.push(`Var(s) ${credentialVars.join(", ")} look like credentials. Vars are plain text and kept in every archived version; store credentials with backend_secret instead.`);
  }
  return {
    action: "publish_backend", state: "deployed", namespace: ns.name, site, url: await apiUrlFor(apiClient, ns.id, site),
    version: res.version, access: res.access, deployed_at: res.deployed_at, bundle_bytes: res.bundle_bytes,
    verified: res.bundle_sha256 === bundle.sha256 && res.bundle_bytes === bundle.bytes, var_names: varNames, warnings,
  };
}

// ─── backend ─────────────────────────────────────────────────────────────────

/**
 * What a user consents to when enabling: whether this enable charges, whether it
 * converts an existing Site data item, and the list prices at the billing
 * interval. `month_cents` / `year_cents` are ALWAYS the status list prices
 * (null when unpublished), so a change to either price alone invalidates a consent.
 */
export interface AddonExpectation {
  would_charge: boolean;
  converts_data_addon: boolean;
  interval: BillingInterval | null;
  /** The recurring price at `interval`; null when nothing is charged or the interval is unknown. */
  price_cents: number | null;
  month_cents: number | null;
  year_cents: number | null;
}

export type BackendAction =
  | "status" | "versions" | "rollback" | "enable" | "disable" | "access" | "delete" | "addon_status" | "addon_enable" | "addon_disable";

export interface BackendArgs {
  action: BackendAction;
  /** Site slug; required for status, versions, rollback, enable, disable and access. */
  site?: string;
  /** rollback: the archived version number to go live again. */
  version?: number;
  /** access: who may call `/_api`. */
  access?: BackendAccess;
  /** delete: must equal `site` exactly (type-to-confirm; DESTRUCTIVE). */
  confirm_site?: string;
  /** addon_enable: explicit user approval of the charge. Honoured only together with a matching `expected`. */
  accept_charge?: boolean;
  /**
   * addon_disable: keep Site data (default true: Backend goes off, Site data stays and is billed at the Site data price) or end
   * BOTH (false: Site data is removed too and its rows are deleted after 30 days). The user chooses; `false` is destructive.
   */
  keep_site_data?: boolean;
  /** addon_enable: the `expected` object a previous consent result printed, echoed back unchanged. */
  expected?: AddonExpectation;
  namespace?: string;
}

export type BackendResult =
  | { action: "status"; namespace: string; site: string; status: BackendStatus }
  | { action: "versions"; namespace: string; site: string; versions: BackendVersion[] }
  | { action: "rollback"; namespace: string; site: string; result: RollbackResponse }
  | { action: "enable" | "disable" | "access"; namespace: string; site: string; status: BackendStatus }
  | { action: "delete"; namespace: string; site: string }
  | { action: "addon_status"; available: false }
  | { action: "addon_status"; available: true; namespace: string; status: BackendAddonStatus }
  | {
      action: "addon_enable"; state: "consent_needed"; expected: AddonExpectation; status: BackendAddonStatus;
      /** True when the caller echoed an `expected` that no longer matches. */
      changed: boolean;
    }
  | { action: "addon_enable"; state: "already_enabled" | "in_progress" | "paused" | "expected_missing" }
  | { action: "addon_enable"; state: "enabled"; result: BackendEnableResponse }
  | ({
      action: "addon_disable";
      /** The Site data price that stays billed after a kept disable, when it could be read. */
      data_price?: { cents: number; interval: BillingInterval } | null;
    } & BackendDisableResponse);

/** The list price at the billing interval, only when this enable charges; null otherwise or when the interval is unknown. */
export function expectedFor(status: BackendAddonStatus): AddonExpectation {
  const { interval, would_charge, converts_data_addon } = status.billing;
  const price = interval === "month" ? status.price.month_cents : interval === "year" ? status.price.year_cents : null;
  return {
    would_charge, converts_data_addon, interval, price_cents: would_charge ? price : null,
    month_cents: status.price.month_cents, year_cents: status.price.year_cents,
  };
}

const sameExpectation = (a: AddonExpectation | undefined, b: AddonExpectation): boolean =>
  a !== undefined && a !== null && a.would_charge === b.would_charge && a.converts_data_addon === b.converts_data_addon &&
  a.interval === b.interval && a.price_cents === b.price_cents && a.month_cents === b.month_cents && a.year_cents === b.year_cents;

const getAddonStatus = (apiClient: ApiClient, ns: Namespace): Promise<BackendAddonStatus> =>
  guard("member", async () => parseAddonStatus(await apiClient.get<unknown>(addonBase(ns.id))));

/** The Site data add-on's price at the subscription's interval, or null if it cannot be read (never throws: it only decorates text). */
async function readSiteDataPrice(apiClient: ApiClient, ns: Namespace): Promise<{ cents: number; interval: BillingInterval } | null> {
  try {
    const status = parseDataStatus(await apiClient.get<unknown>(`/api/ns/${ns.id}/data`));
    const { interval } = status.billing;
    const cents = interval === "month" ? status.price.month_cents : interval === "year" ? status.price.year_cents : null;
    return interval !== null && cents !== null ? { cents, interval } : null;
  } catch {
    return null;
  }
}

async function addonEnable(apiClient: ApiClient, ns: Namespace, acceptCharge: boolean, given: AddonExpectation | undefined): Promise<BackendResult> {
  // Read first: never POST (and so never risk a second charge) when already on or pending.
  const status = await getAddonStatus(apiClient, ns);
  if (!status.available) throw new BackendError("not_available", 404, "The Backend add-on is not available for this account. [not_available]");
  if (status.entitled) return { action: "addon_enable", state: "already_enabled" };
  if (status.billing.paused === true) return { action: "addon_enable", state: "paused" };
  if (status.billing.item_present) return { action: "addon_enable", state: "in_progress" };

  const expected = expectedFor(status);
  const consent = (changed: boolean): BackendResult => ({ action: "addon_enable", state: "consent_needed", expected, status, changed });
  if (!acceptCharge) return consent(false);
  if (given === undefined) return { action: "addon_enable", state: "expected_missing" };
  if (!sameExpectation(given, expected)) return consent(true);

  const result = await guard(
    "owner",
    async () => parseEnableResponse(await apiClient.post<unknown>(`${addonBase(ns.id)}/enable`, { accept_charge: true })),
    { context: "billing_enable" },
  );
  return { action: "addon_enable", state: "enabled", result };
}

/**
 * Runs one `backend` action.
 * @throws BackendError on API failure; Error when a required argument is missing.
 */
export async function runBackend(apiClient: ApiClient, ns: Namespace, args: BackendArgs): Promise<BackendResult> {
  switch (args.action) {
    case "addon_status": {
      const status = await getAddonStatus(apiClient, ns);
      return status.available ? { action: "addon_status", available: true, namespace: ns.name, status } : { action: "addon_status", available: false };
    }
    case "addon_enable":
      return addonEnable(apiClient, ns, args.accept_charge === true, args.expected);
    case "addon_disable": {
      // Always explicit: the server's default (keep) is the same, but a sent value is a choice, never a guess.
      const keep = args.keep_site_data ?? true;
      const res = await guard("owner", async () => parseDisableResponse(await apiClient.post<unknown>(`${addonBase(ns.id)}/disable`, { keep_site_data: keep })), { context: "billing_disable" });
      // What stays billed is the Site data price; best-effort read so the text can state it (a failed read only drops the amount).
      const dataPrice = res.site_data_kept === true ? await readSiteDataPrice(apiClient, ns) : null;
      return { action: "addon_disable", ...res, data_price: dataPrice };
    }
  }

  const site = requireArg(args.site, "site", args.action);
  const base = backendBase(ns.id, site);
  const patch = (body: { access?: BackendAccess; disabled?: boolean }) =>
    guard("admin", async () => parseBackendStatus(await apiClient.patch<unknown>(base, body)));
  switch (args.action) {
    case "status":
      return { action: "status", namespace: ns.name, site, status: await guard("admin", async () => parseBackendStatus(await apiClient.get<unknown>(base))) };
    case "versions":
      return { action: "versions", namespace: ns.name, site, versions: await guard("admin", async () => parseVersionList(await apiClient.get<unknown>(`${base}/versions`))) };
    case "rollback": {
      const version = requireArg(args.version, "version", "rollback");
      const result = await guard("admin", async () => parseRollbackResponse(await apiClient.post<unknown>(`${base}/rollback`, { version })));
      return { action: "rollback", namespace: ns.name, site, result };
    }
    case "enable":
      return { action: "enable", namespace: ns.name, site, status: await patch({ disabled: false }) };
    case "disable":
      return { action: "disable", namespace: ns.name, site, status: await patch({ disabled: true }) };
    case "access":
      return { action: "access", namespace: ns.name, site, status: await patch({ access: requireArg(args.access, "access", "access") }) };
    case "delete": {
      const confirm = requireArg(args.confirm_site, "confirm_site", "delete");
      if (confirm !== site) throw new Error(`confirm_site '${safeText(confirm)}' does not match the site '${safeText(site)}'. Nothing was deleted.`);
      await guard("admin", async () => parseDeleteResponse(await apiClient.delete<unknown>(base)));
      return { action: "delete", namespace: ns.name, site };
    }
  }
}

// ─── backend_secret ──────────────────────────────────────────────────────────

export interface BackendSecretArgs {
  action: "set" | "list" | "delete";
  site: string;
  /** set / delete: the secret's name (letters, digits, underscores). */
  name?: string;
  /** set: the value. Sent once, never echoed, logged or stored locally. */
  value?: string;
  namespace?: string;
}

export type BackendSecretResult =
  | { action: "set"; namespace: string; site: string; secret: BackendSecret }
  | { action: "list"; namespace: string; site: string; secrets: BackendSecret[] }
  | { action: "delete"; namespace: string; site: string; deleted: string };

const checkSecretName = (name: string): string => {
  if (!BINDING_NAME_RE.test(name)) {
    throw new Error(`Invalid secret name '${safeText(name)}': use letters, digits and underscores, not starting with a digit, up to ${BACKEND_LIMITS.bindingNameLength} characters.`);
  }
  return name;
};

/**
 * Runs one `backend_secret` action. The result and every error carry names only.
 * @throws BackendError on API failure; Error on bad arguments (never quoting the value).
 */
export async function runBackendSecret(apiClient: ApiClient, ns: Namespace, args: BackendSecretArgs): Promise<BackendSecretResult> {
  const base = `${backendBase(ns.id, args.site)}/secrets`;
  const where = { namespace: ns.name, site: args.site };
  switch (args.action) {
    case "list":
      return { action: "list", ...where, secrets: await guard("admin", async () => parseSecretList(await apiClient.get<unknown>(base))) };
    case "delete": {
      const name = checkSecretName(requireArg(args.name, "name", "delete"));
      await guard("admin", async () => parseSecretDelete(await apiClient.delete<unknown>(`${base}/${encodeURIComponent(name)}`)));
      return { action: "delete", ...where, deleted: name };
    }
    case "set": {
      const value = args.value;
      return withRedaction(value === undefined ? [] : [value], async () => {
        const name = checkSecretName(requireArg(args.name, "name", "set"));
        const secret = requireArg(value, "value", "set");
        const size = new TextEncoder().encode(secret).length;
        if (size < 1 || size > BACKEND_LIMITS.bindingValueBytes) {
          throw new Error(`The secret value must be 1 to ${BACKEND_LIMITS.bindingValueBytes} bytes (got ${size}).`);
        }
        const res = await guard("admin", async () => parseSecretSet(await apiClient.put<unknown>(`${base}/${encodeURIComponent(name)}`, { value: secret }, { sensitive: true })), { redact: [secret] });
        // The name is the caller's own; a server-supplied field is never echoed (set_at is redacted in case).
        return { action: "set" as const, ...where, secret: { name, set_at: redactValues(res.set_at, [secret]) } };
      });
    }
  }
}

// ─── backend_logs ────────────────────────────────────────────────────────────

export interface BackendLogsArgs { site: string; /** 1..100; omitted = the newest 100. */ limit?: number; namespace?: string }
export interface BackendLogsResult { namespace: string; site: string; logs: BackendLogs }

/**
 * Fetches the last log lines of a site's backend (no visitor IPs or headers; the server strips them).
 * @throws BackendError on API failure; Error when `limit` is out of range.
 */
export async function runBackendLogs(apiClient: ApiClient, ns: Namespace, args: BackendLogsArgs): Promise<BackendLogsResult> {
  const { limit } = args;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > BACKEND_LIMITS.logLines)) {
    throw new Error(`limit must be a whole number from 1 to ${BACKEND_LIMITS.logLines}.`);
  }
  const query = limit === undefined ? "" : `?limit=${limit}`;
  const logs = await guard("admin", async () => parseLogs(await apiClient.get<unknown>(`${backendBase(ns.id, args.site)}/logs${query}`)));
  return { namespace: ns.name, site: args.site, logs };
}
