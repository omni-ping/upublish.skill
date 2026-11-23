/** Option and result types for `publish()` (the public contract of lib/publish.ts). */

import type { ApiClient } from "./api-client.ts";
import type { FetchFn, NamespaceRole, Site, Visibility } from "./types.ts";
import type { FilenameWarnings } from "./publish-files.ts";
import type { HashProgress } from "./publish-hash.ts";
import type { UploadProgress } from "./publish-upload.ts";

export interface PublishOpts {
  /** Authenticated API client. */
  apiClient: ApiClient;
  /** Namespace ID to publish the site into. */
  nsId: string;
  /** Path to the directory containing files to publish. */
  directory: string;
  /** URL-safe identifier for the site. */
  slug: string;
  /**
   * Optional multi-segment path prefix — the site publishes at
   * `{pathPrefix}/{slug}` (e.g. "2026/q3/code-report") instead of the
   * namespace root. OMITTING this field entirely produces a manifest
   * request body byte-identical to a pre-nested-path-publishing publish
   * (no `path_prefix` key at all). Explicit `null`/`""` also resolves to
   * "no prefix" server-side but DOES add the key to the request body.
   * Validated server-side (malformed → 400, reserved segment → 422,
   * shadows an existing site's address → 409); this client does not
   * replicate those rules — see {@link isValidSlug}'s doc comment for why.
   */
  pathPrefix?: string | null;
  /**
   * Optional human-readable title. When omitted, the manifest request still
   * carries a title — see {@link resolveDefaultTitle}: a normal slug sends
   * the slug itself; `_root` preserves `existingTitle` when it is meaningful,
   * else sends `namespaceName` — never the literal slug `"_root"`, so a
   * home-page publish neither invents a bad title nor clobbers a good one,
   * even against a backend that has not deployed the corresponding
   * server-side fix (which otherwise defaults an absent title to `?? slug`).
   */
  title?: string;
  /**
   * The resolved namespace's display name. Consulted only for a `_root`
   * publish with no explicit `title` and no usable `existingTitle` (see
   * {@link resolveDefaultTitle}) — normal-slug publishes never consult it.
   * `lib/core.ts`'s `publish()`, the only production caller of this
   * function, always supplies it: it resolves the full `Namespace` record
   * before calling here, and `Namespace.name` is a required string. Optional
   * here only so callers that invoke this module's `publish()` directly (as
   * some tests do, bypassing `core.ts`'s resolution) don't have to supply a
   * namespace they may not have looked up.
   */
  namespaceName?: string;
  /**
   * The `_root` site's currently-stored title, when known. Threaded through
   * so a `_root` publish with no explicit `title` preserves a title the user
   * set by hand instead of resetting it to `namespaceName` on every publish
   * (see {@link resolveDefaultTitle}) — normal-slug publishes never consult
   * it, and it is ignored entirely when an explicit `title` is given.
   *
   * - `undefined` — the caller didn't look it up (an ordinary non-`_root`
   *   publish never needs to; `lib/core.ts`'s `publish()` also skips the
   *   lookup whenever an explicit `title` is given, since it would be
   *   discarded anyway).
   * - `null` — the caller looked it up and found nothing usable: no existing
   *   `_root` site, or the lookup itself failed (network error, non-2xx) and
   *   degraded gracefully rather than failing the publish. Treated
   *   identically to a blank/sentinel title — {@link resolveDefaultTitle}
   *   falls back to `namespaceName`.
   * - a string — the stored title, passed through verbatim; {@link
   *   resolveDefaultTitle} decides whether it's meaningful enough to keep.
   */
  existingTitle?: string | null;
  /** Site visibility mode. */
  visibility?: Visibility;
  /** Passcode for passcode-protected sites. */
  passcode?: string;
  /**
   * Label for the initial passcode. Defaults to "default" when
   * visibility is "passcode" and no label is provided.
   */
  passcodeLabel?: string;
  /**
   * When true, creates a staging version instead of going live immediately.
   * The API returns a preview_url where the staging version can be reviewed.
   */
  preview?: boolean;
  /**
   * Verify-and-repair: sends `force: true` in the manifest (with real hashes) so the server
   * re-checks every stored file and presigns only those that are missing or corrupt.
   * Healthy files are never re-uploaded.
   */
  force?: boolean;
  /**
   * Per-site analytics opt-out (Phase 3). When false, the published site will
   * NOT get the analytics script injected at the edge. Omit to leave the default
   * (analytics ON — opt-out, not opt-in). Threaded into the manifest body.
   */
  analyticsEnabled?: boolean;
  /** Publish as a single-page app (unknown paths serve index.html). Sent in the manifest body; pass on EVERY publish of an SPA. */
  spa?: boolean;
  /** Skip the "no top-level index.html" pre-flight block. */
  allowNoIndex?: boolean;
  /** Skip the "looks like a project folder" pre-flight block. */
  allowProjectFiles?: boolean;
  /** Keep `*.map` source maps (excluded by default). */
  includeSourcemaps?: boolean;
  /**
   * The caller's role in the namespace. The plan-tier read (`GET /api/space`)
   * returns the caller's OWN space, so for a member namespace (admin/user) it
   * says nothing about the owner's plan and is skipped (neutral undo wording).
   */
  namespaceRole?: NamespaceRole;
  /**
   * Injectable fetch function for presigned R2 uploads.
   * Presigned URLs are self-authenticating — no Bearer token is needed.
   * Defaults to global fetch. Injected in tests to avoid real network calls.
   */
  fetchFn?: FetchFn;
  /**
   * Optional synchronous progress callback fired during the upload phase.
   * Must be synchronous and non-throwing — lib/ stays platform-agnostic and
   * does not depend on async notification machinery. The MCP adapter wraps an
   * async sendNotification behind this sync callback. Omitting it is a no-op.
   */
  onProgress?: (progress: UploadProgress) => void;
  /**
   * Optional synchronous progress callback fired during the hashing phase —
   * BEFORE the manifest/upload phase. Same contract as {@link onProgress}: must
   * be synchronous and non-throwing (lib/ stays platform-agnostic; the MCP
   * adapter wraps an async sendNotification behind it). Fires once at
   * `{0, total, 0, totalBytes}` after enumeration, then monotonically per
   * yield-batch, reaching the totals on the final report. Omitting it is a no-op
   * — publish behavior is byte-identical to pre-instrumentation.
   */
  onHashProgress?: (progress: HashProgress) => void;
}

export interface PublishResult {
  /** Public URL where the site is live. */
  url: string;
  /** Preview URL for staging versions. Present only when preview=true was requested. */
  preview_url?: string;
  /** Full site object returned by the API. */
  site: Site;
  /** The version number this publish created (live, or staging for a preview). */
  version: number;
  /**
   * The manifest's `base_version`: the live version this publish replaced, or
   * null for a first publish. For a preview it refers to the staging/live base,
   * NOT a replaced live version, so renderers must key on `preview_url` first.
   */
  replacedVersion: number | null;
  /**
   * The caller's plan as far as undo is concerned: "free" (previous versions
   * can't be restored), "paid", or null when unknown (tier read skipped or
   * failed). Read only for a live republish.
   */
  planTier: "free" | "paid" | null;
  /** Suspicious files that were included but may not be site content. */
  warnings: string[];
  /**
   * Advisory, non-blocking warnings about filenames whose characters interact
   * badly with URLs — populated only when at least one file qualifies (absent on
   * a clean tree). This NEVER blocks a publish and NEVER renames a file.
   *
   * - `fragile`: filenames containing `#`, `?`, or a control char (`\x00`–`\x1f`,
   *   `\x7f`). These are URL delimiters/illegal and may not be reachable by URL.
   * - `fyi`: filenames containing a space or any non-ASCII codepoint. These serve
   *   fine (the worker decodes them); the note just flags that simple names are
   *   safest. A file qualifying as `fragile` is reported ONLY there (no double-count).
   */
  filenameWarnings?: FilenameWarnings;
  /** Files/directories that were excluded by default rules or .upublishignore. */
  excluded: string[];
  /**
   * Files that were uploaded to R2 via presigned URL.
   */
  uploadedFiles?: string[];
  /**
   * Files that were copied server-side from the previous version.
   * These files were unchanged and did not need to be re-uploaded.
   */
  skippedFiles?: string[];
  /** Present (true) only when the publish ran with `force`; `uploadedFiles` is then the re-uploaded (repaired) set and every file was verified. */
  forced?: boolean;
  /**
   * Present when this publish charged storage-pack blocks. The backend bills
   * recurring packs of `block_gb` GB at `price` USD per `interval`.
   * Absent on a normal within-cap publish.
   */
  storage_overage?: {
    charged: boolean;
    /** Block size in GB (always 10). */
    block_gb: number;
    /** Number of blocks charged to cover the overage. */
    blocks: number;
    /** USD price per block for this interval. */
    price: number;
    /** Billing interval matching the base subscription; null when the server could not tell (`price` is then the monthly figure). */
    interval: "month" | "year" | null;
  };
}
