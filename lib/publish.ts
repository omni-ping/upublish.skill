/**
 * Core publish logic — packages a local directory into a zip archive and
 * uploads it to the upubli.sh API.
 *
 * Returns structured data ({ url, site, warnings, excluded }) — formatting
 * is the adapter's job. Throws on validation failures and API errors.
 */

import { zipSync } from "fflate";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import type { ApiClient } from "./api-client.ts";
import type { Site, Visibility } from "./types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PublishOpts {
  /** Authenticated API client. */
  apiClient: ApiClient;
  /** Namespace ID to publish the site into. */
  nsId: string;
  /** Path to the directory containing files to publish. */
  directory: string;
  /** URL-safe identifier for the site. */
  slug: string;
  /** Optional human-readable title (defaults to slug). */
  title?: string;
  /** Site visibility mode. */
  visibility?: Visibility;
  /** Passcode for passcode-protected sites. */
  passcode?: string;
  /**
   * Label for the initial passcode. Defaults to "default" when
   * visibility is "passcode" and no label is provided.
   */
  passcodeLabel?: string;
}

export interface PublishResult {
  /** Public URL where the site is live. */
  url: string;
  /** Full site object returned by the API. */
  site: Site;
  /** Suspicious files that were included but may not be site content. */
  warnings: string[];
  /** Files/directories that were excluded by default rules or .upublishignore. */
  excluded: string[];
}

interface PublishResponse {
  site: Site;
  url: string;
}

export interface BuildResult {
  zipBytes: Uint8Array;
  fileCount: number;
  excluded: string[];
  warnings: string[];
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** Returns true if the slug matches the upubli.sh slug rules. */
export function isValidSlug(slug: string): boolean {
  if (slug.length < 3 || slug.length > 63) return false;
  return (
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) || /^[a-z0-9]{3}$/.test(slug)
  );
}

// ─── File Exclusion ──────────────────────────────────────────────────────────

const EXCLUDED_DIRS = new Set([".git", "node_modules", ".svn", ".hg"]);
const EXCLUDED_FILES = new Set([".DS_Store", "Thumbs.db", ".upublishignore"]);

function isDefaultExcluded(name: string, isDir: boolean): boolean {
  if (isDir) return EXCLUDED_DIRS.has(name);
  if (EXCLUDED_FILES.has(name)) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (name.endsWith(".pem") || name.endsWith(".key")) return true;
  return false;
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

// ─── Zip Building ────────────────────────────────────────────────────────────

interface CollectState {
  fileMap: Record<string, Uint8Array>;
  excluded: string[];
  warnings: string[];
}

/** Recursively collects files, applying exclusion rules and flagging suspicious files. */
function collectFiles(
  rootDir: string,
  currentDir: string,
  state: CollectState,
  ignorePatterns: string[],
): void {
  const entries = readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    const relPath = relative(rootDir, fullPath);

    if (isDefaultExcluded(entry.name, entry.isDirectory())) {
      state.excluded.push(entry.isDirectory() ? `${relPath}/` : relPath);
      continue;
    }

    if (matchesIgnore(relPath, entry.name, ignorePatterns)) {
      state.excluded.push(entry.isDirectory() ? `${relPath}/` : relPath);
      continue;
    }

    if (entry.isDirectory()) {
      collectFiles(rootDir, fullPath, state, ignorePatterns);
    } else if (entry.isFile()) {
      if (isSuspicious(entry.name)) {
        state.warnings.push(relPath);
      }
      const data = readFileSync(fullPath);
      state.fileMap[relPath] = new Uint8Array(data);
    }
  }
}

/**
 * Recursively reads files in a directory and packs them into a zip archive.
 * Applies default exclusion rules and .upublishignore patterns.
 * Returns the zip bytes along with metadata about excluded and suspicious files.
 */
export function buildZipFromDirectory(dirPath: string): BuildResult {
  let ignorePatterns: string[] = [];
  const ignoreFile = join(dirPath, ".upublishignore");
  try {
    if (existsSync(ignoreFile)) {
      ignorePatterns = parseIgnoreFile(readFileSync(ignoreFile, "utf-8"));
    }
  } catch {
    // No readable .upublishignore — use defaults only
  }

  const state: CollectState = { fileMap: {}, excluded: [], warnings: [] };
  collectFiles(dirPath, dirPath, state, ignorePatterns);

  const fileCount = Object.keys(state.fileMap).length;
  if (fileCount === 0) {
    return {
      zipBytes: new Uint8Array(0),
      fileCount: 0,
      excluded: state.excluded,
      warnings: state.warnings,
    };
  }

  return {
    zipBytes: zipSync(state.fileMap),
    fileCount,
    excluded: state.excluded,
    warnings: state.warnings,
  };
}

// ─── Publish ─────────────────────────────────────────────────────────────────

/**
 * Packages a directory into a zip and uploads it to the upubli.sh API.
 *
 * @param opts - Publish options including apiClient, directory, slug, etc.
 * @returns The published site URL, site object, and any warnings.
 * @throws Error on validation failure (bad directory, invalid slug, empty dir).
 * @throws Error on API failure (propagated from ApiClient).
 */
export async function publish(opts: PublishOpts): Promise<PublishResult> {
  const { apiClient, nsId, directory, slug, title, visibility, passcode, passcodeLabel } = opts;

  // Validate directory exists and is a directory
  try {
    const stat = statSync(directory);
    if (!stat.isDirectory()) {
      throw new Error(`'${directory}' is not a directory`);
    }
  } catch (err) {
    if ((err as Error).message.includes("not a directory")) {
      throw err;
    }
    throw new Error(`Directory '${directory}' does not exist`);
  }

  // _root is a reserved system slug that bypasses normal format validation —
  // it publishes at the namespace/domain root (e.g. vibeandscribe.xyz/).
  if (slug !== "_root" && !isValidSlug(slug)) {
    throw new Error(
      "Invalid slug. Must be 3-63 characters: lowercase letters, " +
        "numbers, and hyphens, starting and ending with a letter or number.",
    );
  }

  // Build zip archive (applies exclusion rules)
  const build = buildZipFromDirectory(directory);

  if (build.zipBytes.byteLength === 0) {
    throw new Error("Directory is empty — no files to publish");
  }

  // Validate passcode requirement
  if (visibility === "passcode" && !passcode) {
    throw new Error("passcode is required when visibility is 'passcode'");
  }

  // Upload via multipart form POST
  const formData = new FormData();
  formData.set("slug", slug);
  formData.set("title", title ?? slug);
  formData.set(
    "archive",
    new Blob([build.zipBytes], { type: "application/zip" }),
    "site.zip",
  );
  if (visibility) formData.set("visibility", visibility);
  if (passcode) formData.set("passcode", passcode);
  if (visibility === "passcode" && passcode) {
    formData.set("passcode_label", passcodeLabel ?? "default");
  }

  const result = await apiClient.postForm<PublishResponse>(
    `/api/ns/${nsId}/sites`,
    formData,
  );

  return {
    url: result.url,
    site: result.site,
    warnings: build.warnings,
    excluded: build.excluded,
  };
}
