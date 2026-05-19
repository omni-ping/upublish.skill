/**
 * Core publish logic — packages a local directory into a zip archive and
 * uploads it to the upubli.sh API.
 *
 * Returns structured data ({ url, site }) — formatting is the adapter's job.
 * Throws on validation failures and API errors.
 */

import { zipSync } from "fflate";
import { readdirSync, readFileSync, statSync } from "fs";
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
}

interface PublishResponse {
  site: Site;
  url: string;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** Returns true if the slug matches the upubli.sh slug rules. */
export function isValidSlug(slug: string): boolean {
  if (slug.length < 3 || slug.length > 63) return false;
  return (
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) || /^[a-z0-9]{3}$/.test(slug)
  );
}

// ─── Zip Building ────────────────────────────────────────────────────────────

/**
 * Recursively reads all files in a directory and packs them into a zip archive.
 * Returns the raw zip bytes. Returns empty Uint8Array for empty directories.
 */
export function buildZipFromDirectory(dirPath: string): Uint8Array {
  const fileMap: Record<string, Uint8Array> = {};
  collectFiles(dirPath, dirPath, fileMap);

  if (Object.keys(fileMap).length === 0) {
    return new Uint8Array(0);
  }

  return zipSync(fileMap);
}

/** Recursively collects files into a fflate-compatible map of { relPath: bytes }. */
function collectFiles(
  rootDir: string,
  currentDir: string,
  fileMap: Record<string, Uint8Array>,
): void {
  const entries = readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);

    if (entry.isDirectory()) {
      collectFiles(rootDir, fullPath, fileMap);
    } else if (entry.isFile()) {
      const relPath = relative(rootDir, fullPath);
      const data = readFileSync(fullPath);
      fileMap[relPath] = new Uint8Array(data);
    }
  }
}

// ─── Publish ─────────────────────────────────────────────────────────────────

/**
 * Packages a directory into a zip and uploads it to the upubli.sh API.
 *
 * @param opts - Publish options including apiClient, directory, slug, etc.
 * @returns The published site URL and site object.
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

  // Validate slug format
  if (!isValidSlug(slug)) {
    throw new Error(
      "Invalid slug. Must be 3-63 characters: lowercase letters, " +
        "numbers, and hyphens, starting and ending with a letter or number.",
    );
  }

  // Build zip archive
  const zipBytes = buildZipFromDirectory(directory);

  if (zipBytes.byteLength === 0) {
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
    new Blob([zipBytes], { type: "application/zip" }),
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
  };
}
