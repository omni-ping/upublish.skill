/**
 * Add-on operations: the site data add-on (data*) and user backends (backend*).
 * Re-exported through core.ts.
 */

import { runData, runDataJwt } from "./site-data.ts";
import type { DataArgs, DataResult, DataJwtArgs, DataJwtResult } from "./site-data.ts";
import { runDataCollection } from "./site-data-collections.ts";
import type { DataCollectionArgs, DataCollectionResult } from "./site-data-collections.ts";
import { runDataRows } from "./site-data-rows.ts";
import type { DataRowsArgs, DataRowsResult } from "./site-data-rows.ts";
import { sanitizeErrors } from "./site-data-errors.ts";
import { runPublishBackend, runBackend, runBackendSecret, runBackendLogs } from "./backend.ts";
import type {
  PublishBackendArgs, PublishBackendResult, BackendArgs, BackendResult, BackendSecretArgs, BackendSecretResult,
  BackendLogsArgs, BackendLogsResult,
} from "./backend.ts";
import { withNamespace } from "./core-deps.ts";
import type { CoreDeps } from "./core-deps.ts";

// ─── Site data ────────────────────────────────────────────────────────────────

/**
 * Site data add-on: status, enable (consent-gated), disable, wipe.
 * `enable` returns the price instead of charging unless `accept_charge` is true.
 *
 * @throws Error "Not authenticated" if no credentials are stored.
 * @throws SiteDataError on an API failure, with an actionable message.
 */
export async function data(args: DataArgs, deps?: CoreDeps): Promise<DataResult> {
  return sanitizeErrors(async () => {
    return withNamespace(deps, args.namespace, (apiClient, ns) => runData(apiClient, ns, args));
  });
}

/** Site data collections: list, get, set (create or update), delete. Sites are named by slug. */
export async function dataCollection(args: DataCollectionArgs, deps?: CoreDeps): Promise<DataCollectionResult> {
  return sanitizeErrors(async () => {
    return withNamespace(deps, args.namespace, (apiClient, ns) => runDataCollection(apiClient, ns, args));
  });
}

/** Site data rows: list, export (streamed to a file), archive, delete, create, put, import. */
export async function dataRows(args: DataRowsArgs, deps?: CoreDeps): Promise<DataRowsResult> {
  return sanitizeErrors(async () => {
    return withNamespace(deps, args.namespace, (apiClient, ns) => runDataRows(apiClient, ns, args));
  });
}

/** Site data bring-your-own JWT issuer: set, clear. */
export async function dataJwt(args: DataJwtArgs, deps?: CoreDeps): Promise<DataJwtResult> {
  return sanitizeErrors(async () => {
    return withNamespace(deps, args.namespace, (apiClient, ns) => runDataJwt(apiClient, ns, args));
  });
}

// ─── User backends ────────────────────────────────────────────────────────────

/**
 * Bundles an entry file (or inline code) locally and deploys it as the backend of a site (`{site}/_api/*`).
 * A bundling failure is a result (`state: "bundle_failed"`), not a throw: nothing was uploaded.
 *
 * @throws Error "Not authenticated" if no credentials are stored.
 * @throws BackendError on an API failure, with an actionable message.
 */
export async function publishBackend(args: PublishBackendArgs, deps?: CoreDeps, opts?: { allowEntry?: boolean }): Promise<PublishBackendResult> {
  return sanitizeErrors(async () => {
    return withNamespace(deps, args.namespace, (apiClient, ns) => runPublishBackend(apiClient, ns, args, { allowEntry: opts?.allowEntry }));
  });
}

/** Backend operations: status, versions, rollback, enable, disable, access, and the add-on (consent-gated enable). */
export async function backend(args: BackendArgs, deps?: CoreDeps): Promise<BackendResult> {
  return sanitizeErrors(async () => {
    return withNamespace(deps, args.namespace, (apiClient, ns) => runBackend(apiClient, ns, args));
  });
}

/** Backend secrets: set, list names, delete. A value is sent once and never returned, logged or stored. */
export async function backendSecret(args: BackendSecretArgs, deps?: CoreDeps): Promise<BackendSecretResult> {
  return sanitizeErrors(async () => {
    return withNamespace(deps, args.namespace, (apiClient, ns) => runBackendSecret(apiClient, ns, args));
  });
}

/** The last log lines of a site's backend. */
export async function backendLogs(args: BackendLogsArgs, deps?: CoreDeps): Promise<BackendLogsResult> {
  return sanitizeErrors(async () => {
    return withNamespace(deps, args.namespace, (apiClient, ns) => runBackendLogs(apiClient, ns, args));
  });
}
