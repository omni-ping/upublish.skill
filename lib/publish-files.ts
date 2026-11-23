/**
 * Local file enumeration for publish: slug validation, default/secret/.upublishignore
 * exclusion, the wrong-folder preflight, filename advisories, and the stat-only walk.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

/**
 * One enumerated file, pre-hash: where it lives and its `statSync` size.
 *
 * Produced by {@link listFiles} (a stat-only walk — no content is read). `size`
 * here is the DENOMINATOR ESTIMATE for a hashing progress bar; the AUTHORITATIVE
 * byte count is the size returned later by the hash (the bytes actually streamed),
 * which is what {@link CollectedFile.size} carries.
 */
export interface FileEntry {
  /** Path relative to the walk root (the map key in the hashed result). */
  relPath: string;
  /** Absolute path to the file on disk. */
  fullPath: string;
  /** `statSync` byte size — denominator estimate only, not the hashed size. */
  size: number;
}

/** Result of enumerating a directory with {@link listFiles} (no hashing). */
export interface ListFilesResult {
  /** Publishable files in walk order, each with its stat size. */
  files: FileEntry[];
  /** Files/directories excluded by default rules or .upublishignore. */
  excluded: string[];
  /** Suspicious files included that may not be site content. */
  warnings: string[];
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Returns true if the slug matches the upubli.sh slug rules.
 *
 * Mirrors the server's `isValidSlug` exactly (1-255 chars, lowercase
 * alphanumerics and hyphens, must start/end with an alphanumeric — a
 * single-character slug is valid via the regex's optional middle group).
 * Bounds and pattern MUST stay byte-identical to the server: a narrower
 * client rule silently rejects addresses the server would accept (the bug
 * this function used to have — 3-63 chars against the server's 1-255).
 */
export function isValidSlug(slug: string): boolean {
  if (slug.length < 1 || slug.length > 255) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug);
}

// ─── File Exclusion ──────────────────────────────────────────────────────────

const EXCLUDED_DIRS = new Set([".git", "node_modules", ".svn", ".hg"]);
const EXCLUDED_FILES = new Set([".DS_Store", "Thumbs.db", ".upublishignore"]);

// Credential/secret material that is never site content. Deliberately no opt-in
// (source maps below are the only exception). Matched case-insensitively.
const SECRET_DIRS = new Set([".ssh", ".aws"]);
const SECRET_FILES = new Set([".envrc", ".npmrc", ".netrc", ".pypirc", "credentials.json"]);
const SECRET_PREFIXES = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "secrets."];
const SECRET_SUFFIXES = [".p12", ".pfx"];

function isSecretName(name: string, isDir: boolean): boolean {
  const n = name.toLowerCase();
  if (isDir) return SECRET_DIRS.has(n);
  return (
    SECRET_FILES.has(n) ||
    SECRET_PREFIXES.some((p) => n.startsWith(p)) ||
    SECRET_SUFFIXES.some((x) => n.endsWith(x))
  );
}

function isDefaultExcluded(name: string, isDir: boolean, includeSourcemaps = false): boolean {
  if (isDir) return EXCLUDED_DIRS.has(name) || isSecretName(name, true);
  // A `.git` FILE is a worktree/submodule `gitdir:` pointer; never site content.
  if (name === ".git" || EXCLUDED_FILES.has(name)) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (name.endsWith(".pem") || name.endsWith(".key")) return true;
  if (isSecretName(name, false)) return true;
  return !includeSourcemaps && name.toLowerCase().endsWith(".map");
}

// ─── Pre-flight guard (wrong-folder detection) ──────────────────────────────

/** Top-level names that mark a directory as a project/repo root rather than a built site. */
const REPO_SIGNAL_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "go.sum",
  "Dockerfile",
]);
const BUILD_DIRS = ["dist", "build", "out", "public", "_site"];

/**
 * Throws before anything is hashed or uploaded when `directory` looks like the
 * wrong folder: two or more top-level repo signals (unless `allowProjectFiles`),
 * or no top-level `index.html` (unless `allowNoIndex`). Both messages name any
 * build dir that does contain an `index.html`. `files`/`excluded` are the
 * {@link listFiles} output; `.git/` (or a `.git` pointer file) is default-excluded so it is read from `excluded`.
 */
export function preflightCheck(
  files: FileEntry[],
  excluded: string[],
  opts: { allowNoIndex?: boolean; allowProjectFiles?: boolean },
): void {
  const paths = files.map((f) => f.relPath.split(sep).join("/"));
  const topLevel = new Set(paths.map((p) => p.split("/")[0]!));
  const buildDirs = BUILD_DIRS.filter((d) => paths.includes(`${d}/index.html`));
  const hint = buildDirs.length > 0 ? ` Found ${buildDirs.map((d) => `'${d}/'`).join(", ")} with an index.html, which is probably what you want to publish.` : "";

  const signals = [
    ...[...topLevel].filter((n) => REPO_SIGNAL_FILES.has(n)),
    ...(topLevel.has("src") && paths.some((p) => p.startsWith("src/")) ? ["src/"] : []),
    ...(excluded.includes(".git/") ? [".git/"] : excluded.includes(".git") ? [".git"] : []),
  ];
  if (signals.length >= 2 && !opts.allowProjectFiles) {
    throw new Error(
      `This looks like a project folder, not a built site (found ${signals.join(", ")}). Publishing it would upload source files.${hint} ` +
        `Publish the build output directory instead, or pass allow_project_files: true if you really mean to publish this folder.`,
    );
  }
  if (!paths.includes("index.html") && !opts.allowNoIndex) {
    throw new Error(
      `No index.html at the top level of the folder, so the site would have no home page.${hint} ` +
        `Publish the folder that contains index.html, or pass allow_no_index: true to publish anyway.`,
    );
  }
}

const SUSPICIOUS_NAMES = new Set([
  "nginx.conf",
  "apache.conf",
  ".htaccess",
  "Makefile",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "package.json",
  "package-lock.json",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
]);

function isSuspicious(name: string): boolean {
  if (SUSPICIOUS_NAMES.has(name)) return true;
  if (name.endsWith(".sh")) return true;
  return false;
}

// ─── Special-character filename classifier (publish-time advisory) ─────────────

/**
 * Two buckets of filenames whose characters interact badly with URLs. Advisory
 * only — see {@link classifyFilenames}.
 */
export interface FilenameWarnings {
  /**
   * Filenames containing `#`, `?`, or a control char (`\x00`–`\x1f` / `\x7f`).
   * URL delimiters/illegal — may not be reachable by URL at all.
   */
  fragile: string[];
  /**
   * Filenames containing a space or any non-ASCII codepoint (> 127). These serve
   * fine now; the note only flags that simple names are safest.
   */
  fyi: string[];
  /**
   * Paths with any `_data` segment at any depth (any case; a file named exactly
   * `_data` counts too), present only when non-empty. The site data add-on
   * answers every `_data` path segment under a site address as JSON, never
   * static, so these files would be shadowed and never served. Warn-only:
   * they are still published.
   */
  reserved?: string[];
  /**
   * Paths with any `_api` segment at any depth (any case; a file named exactly
   * `_api` counts too), present only when non-empty. `{site}/_api/*` belongs to
   * the site's backend (user backends), so these files would be shadowed and
   * never served. Warn-only: they are still published.
   */
  reservedApi?: string[];
}

/** Max filenames listed per bucket before the message summarizes the remainder. */
const FILENAME_WARNING_LIST_CAP = 10;

/**
 * Pure classifier over publishable paths → `{ fragile, fyi }`.
 *
 * Looks at each path's BASENAME (segment after the last `/`) so path separators
 * and directory names are never themselves flagged, but reports the FULL path so
 * the user can locate the file. `fragile` wins over `fyi` — a name in both sets
 * is reported once, in `fragile` only (no double-count). Never mutates its input.
 *
 * @param paths - Relative manifest paths (filesystem-derived; treated as external input).
 * @returns The two buckets; either may be empty.
 */
export function classifyFilenames(paths: string[]): FilenameWarnings {
  const fragile: string[] = [];
  const fyi: string[] = [];
  // Independent of the fragile/fyi buckets: a reserved path may also be listed in one of them.
  const reserved = paths.filter((p) => p.split("/").some((seg) => seg.toLowerCase() === "_data"));
  const reservedApi = paths.filter((p) => p.split("/").some((seg) => seg.toLowerCase() === "_api"));

  for (const path of paths) {
    // Classify by the basename — `/` separators and dir names never qualify.
    const slash = path.lastIndexOf("/");
    const name = slash === -1 ? path : path.slice(slash + 1);

    let isFragile = false;
    let isFyi = false;
    // Codepoint iteration so astral/multi-byte unicode counts correctly.
    for (const ch of name) {
      const cp = ch.codePointAt(0)!;
      if (ch === "#" || ch === "?" || cp <= 0x1f || cp === 0x7f) {
        isFragile = true;
        break; // fragile is the strongest signal — stop scanning this name
      }
      if (ch === " " || cp > 0x7f) {
        isFyi = true;
        // keep scanning: a later fragile char must still take precedence
      }
    }

    // Precedence: fragile wins; a name in both sets is reported once, in fragile.
    if (isFragile) fragile.push(path);
    else if (isFyi) fyi.push(path);
  }

  return {
    fragile, fyi, ...(reserved.length > 0 ? { reserved } : {}), ...(reservedApi.length > 0 ? { reservedApi } : {}),
  };
}

/**
 * Renders the {@link FilenameWarnings} buckets into the publish output text.
 * Returns "" when both buckets are empty so callers can concatenate it
 * unconditionally. Caps each bucket's listed names at
 * {@link FILENAME_WARNING_LIST_CAP}, summarizing the remainder.
 *
 * Wording is deliberately honest: fragile = "may not be reachable by URL";
 * fyi = "served fine — simple names are safest" (NOT "broken").
 */
export function renderFilenameWarning(fw: FilenameWarnings | undefined): string {
  if (!fw) return "";
  const fragile = fw.fragile ?? [];
  const fyi = fw.fyi ?? [];
  const reserved = fw.reserved ?? [];
  const reservedApi = fw.reservedApi ?? [];
  if (fragile.length === 0 && fyi.length === 0 && reserved.length === 0 && reservedApi.length === 0) return "";

  // Cap the listed names so a large flagged tree stays readable; summarize the rest.
  const summarize = (names: string[]): string => {
    const shown = names.slice(0, FILENAME_WARNING_LIST_CAP).join(", ");
    const extra = names.length - FILENAME_WARNING_LIST_CAP;
    return extra > 0 ? `${shown}, …and ${extra} more` : shown;
  };

  let out = "";
  if (reserved.length > 0) {
    out +=
      `\nWarning: ${reserved.length} file(s) have a '_data' path segment (a '_data' directory at any depth is reserved): ${summarize(reserved)}` +
      `\n  '_data' is reserved for the site data add-on, so these files will NOT be served. Rename the '_data' directory.`;
  }
  if (reservedApi.length > 0) {
    out +=
      `\nWarning: ${reservedApi.length} file(s) have an '_api' path segment (an '_api' directory at any depth is reserved): ${summarize(reservedApi)}` +
      `\n  '_api' is reserved for the site's backend, so these files will NOT be served. Rename the '_api' directory.`;
  }
  if (fragile.length > 0) {
    out +=
      `\nWarning: ${fragile.length} file(s) have names that may not be reachable by URL ` +
      `(they contain '#', '?', or control characters): ${summarize(fragile)}` +
      `\n  Rename them with simple characters so their links work everywhere.`;
  }
  if (fyi.length > 0) {
    out +=
      `\nFYI: ${fyi.length} file(s) use spaces or non-ASCII characters: ${summarize(fyi)}` +
      `\n  These serve fine — simple names are safest.`;
  }
  return out;
}

// ─── .upublishignore ─────────────────────────────────────────────────────────

export function parseIgnoreFile(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function matchesIgnore(
  relPath: string,
  name: string,
  patterns: string[],
): boolean {
  for (const p of patterns) {
    if (p === name) return true;
    if (p.endsWith("/") && name === p.slice(0, -1)) return true;
    if (p.startsWith("*.") && name.endsWith(p.slice(1))) return true;
  }
  return false;
}

/**
 * Recursively walks `currentDir`, applying the default + .upublishignore
 * exclusion rules and flagging suspicious files. STAT-ONLY — it never opens or
 * reads file content; each kept file's `size` is its `statSync` size (the
 * progress denominator estimate, not the authoritative hashed size).
 */
function walkFiles(
  rootDir: string,
  currentDir: string,
  result: ListFilesResult,
  ignorePatterns: string[],
  includeSourcemaps: boolean,
): void {
  const entries = readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    const relPath = relative(rootDir, fullPath);

    if (isDefaultExcluded(entry.name, entry.isDirectory(), includeSourcemaps)) {
      result.excluded.push(entry.isDirectory() ? `${relPath}/` : relPath);
      continue;
    }

    if (matchesIgnore(relPath, entry.name, ignorePatterns)) {
      result.excluded.push(entry.isDirectory() ? `${relPath}/` : relPath);
      continue;
    }

    if (entry.isDirectory()) {
      walkFiles(rootDir, fullPath, result, ignorePatterns, includeSourcemaps);
    } else if (entry.isFile()) {
      if (isSuspicious(entry.name)) {
        result.warnings.push(relPath);
      }
      // stat-only: record where the file is and its size — no content is read.
      result.files.push({ relPath, fullPath, size: statSync(fullPath).size });
    }
  }
}

/**
 * Enumerates the publishable files under `dirPath` — applying the default and
 * .upublishignore exclusion rules and flagging suspicious files — WITHOUT
 * reading any file's content. This is the stat-only enumeration primitive both
 * hashing paths build on: the synchronous {@link collectFilesWithHashes} loop
 * and the async {@link hashFiles}.
 *
 * @param dirPath - Root directory to walk.
 * @param opts.includeSourcemaps - Keep `*.map` files (excluded by default).
 * @returns files (relPath, fullPath, stat size), excluded, warnings.
 */
export function listFiles(dirPath: string, opts?: { includeSourcemaps?: boolean }): ListFilesResult {
  let ignorePatterns: string[] = [];
  const ignoreFile = join(dirPath, ".upublishignore");
  try {
    if (existsSync(ignoreFile)) {
      ignorePatterns = parseIgnoreFile(readFileSync(ignoreFile, "utf-8"));
    }
  } catch {
    // No readable .upublishignore — use defaults only
  }

  const result: ListFilesResult = { files: [], excluded: [], warnings: [] };
  walkFiles(dirPath, dirPath, result, ignorePatterns, opts?.includeSourcemaps === true);
  return result;
}
