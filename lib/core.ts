/**
 * Core module — all user-facing operations with internal credential/API wiring.
 *
 * Each function reads credentials fresh from disk on every call (no module-level
 * cache), creates a token provider and ApiClient, then delegates to the domain
 * function. Callers never construct ApiClient or read credentials directly.
 *
 * Exports:
 *   list()      — fetch all published sites
 *   publish()   — package and upload a directory
 *   deleteOp()  — delete a site by slug
 *   listSiteVersions()  — list a site's deploy versions
 *   deleteSiteVersion() — delete one archived version (returns freed bytes + usage)
 *   login()     — run the OAuth flow and store credentials
 *   status()    — check authentication state against the API
 *   logout()    — revoke refresh token server-side and delete local credentials
 *   data(), dataCollection(), dataRows(), dataJwt() — site data add-on (lib/site-data*.ts)
 *   publishBackend(), backend(), backendSecret(), backendLogs() — user backends (lib/backend*.ts)
 *
 * All functions accept an optional CoreDeps for test injection:
 *   credentialsPath  — override credentials file location
 *   fetchFn          — override HTTP fetch (avoids real network calls in tests)
 */


export { checkForUpdate, formatUpdateNote } from "./update-check.ts";
export { checkBunRuntime, MIN_BUN_VERSION } from "./runtime-check.ts";
export { listTemplates, createFromTemplate } from "./templates.ts";
export { log } from "./log.ts";

// ─── Re-exports for adapters ──────────────────────────────────────────────────

// Adapters import only from core.ts — re-export types they need so they
// don't have to reach into lib/auth.ts or other submodules.
export type { LoginDeps, LoginResult, CallbackServer } from "./auth.ts";
export type { PublishResult, UploadProgress, HashProgress, FilenameWarnings } from "./publish.ts";
export { StorageApprovalError, renderFilenameWarning, renderReplaceLine } from "./publish.ts";
export type { DeleteResult } from "./delete.ts";
export type { PromoteResult } from "./promote.ts";
export type { ListVersionsResult, DeleteVersionResult, RestoreVersionResult, SetVersionsLimitResult, SiteVersion } from "./versions.ts";
export type { SetAnalyticsResult } from "./analytics.ts";
export { existingPasscodeMessage } from "./passcode.ts";
export type { AddPasscodeResult, ListPasscodesResult, RevokePasscodeResult } from "./passcode.ts";
export type { SetVisibilityResult } from "./visibility.ts";
export { formatGateFields } from "./gate.ts";
export type { Member, PendingInvite } from "./members.ts";
export type { QrCodeArgs, QrCodeResult } from "./qrcode.ts";
export type { ExportArgs, ExportResult } from "./site-export.ts";
export { formatExportResult } from "./site-export.ts";
export type { Site, GateConfig, GateFieldType, GateSubmission, TokenProvider } from "./types.ts";
export type { NamespaceCreateResult } from "./namespace.ts";
export { OverageApprovalError } from "./namespace.ts";
export { storageChargeLine, storageApprovalPriceLine, packChargeLine, packApprovalPriceLine } from "./billing-text.ts";
export type { CustomDomain, DnsRecord } from "./domain.ts";
export type { UpgradeArgs, UpgradeResult } from "./upgrade.ts";
export { appendUpgradeHint } from "./upgrade.ts";
export { displayMsg } from "./display-msg.ts";
export type {
  DataArgs, DataResult, DataJwtArgs, DataJwtResult,
} from "./site-data.ts";
export type { DataCollectionArgs, DataCollectionResult } from "./site-data-collections.ts";
export type { DataRowsArgs, DataRowsResult } from "./site-data-rows.ts";
export { formatDataResult, formatCollectionResult, formatRowsResult, formatJwtResult } from "./site-data-format.ts";
export { SiteDataError } from "./site-data-errors.ts";
export { JWT_ALGORITHMS, SITE_DATA_LIMITS } from "./site-data-types.ts";
export type {
  PublishBackendArgs, PublishBackendResult, BackendArgs, BackendResult, BackendSecretArgs, BackendSecretResult,
  BackendLogsArgs, BackendLogsResult,
} from "./backend.ts";
export { formatPublishBackend, formatBackendResult, formatBackendSecret, formatBackendLogs } from "./backend-format.ts";
export { BACKEND_LIMITS, BACKEND_ACCESS, BINDING_NAME_RE } from "./backend-shape.ts";
export type {
  AdminUserArgs,
  AdminSiteArgs,
  AdminStorageArgs,
  AdminDomainsArgs,
  AdminUserSummary,
  AdminUserInspect,
  AdminStatusResult,
  AdminRoleResult,
  AdminSiteBlockResult,
  AdminStats,
  AdminSweepReport,
  AdminResyncReport,
  AdminDomain,
} from "./admin.ts";

// ─── Operations, split by job ─────────────────────────────────────────────────

export type { CoreDeps } from "./core-deps.ts";
export {
  list, publish, deleteOp, promote, listSiteVersions, deleteSiteVersion,
  restoreSiteVersion, setSiteVersionsLimit, analytics, qrCode, exportSite, rename,
} from "./core-sites.ts";
export type { PublishArgs, ListResult, RenameArgs, RenameResult } from "./core-sites.ts";
export { addPasscode, setVisibility, listPasscodes, revokePasscode, gate, members } from "./core-access.ts";
export type { GateArgs, GateResult, MembersArgs, MembersResult } from "./core-access.ts";
export {
  data, dataCollection, dataRows, dataJwt, publishBackend, backend, backendSecret, backendLogs,
} from "./core-addons.ts";
export {
  adminUser, adminSite, adminStats, adminStorage, adminDomains,
  namespaceCreate, domain, upgrade, login, status, logout,
} from "./core-account.ts";
export type { StatusResult, LogoutResult } from "./core-account.ts";
