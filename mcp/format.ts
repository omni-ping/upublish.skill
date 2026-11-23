import type { Site, SiteVersion } from "../lib/core.ts";

/** Formats bytes into a human-readable string (B / KB / MB / GB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Formats a single site version as a one-line entry: number, status, live
 * marker, and — when the backend supplies them — the metadata a user needs to
 * pick a version to restore (created date, file count, size).
 */
export function formatVersionEntry(version: SiteVersion): string {
  const liveMarker = version.is_live ? " (LIVE)" : "";
  const meta: string[] = [];
  if (version.created_at) meta.push(new Date(version.created_at).toLocaleString());
  if (typeof version.file_count === "number") meta.push(`${version.file_count} files`);
  if (typeof version.total_size === "number") meta.push(formatBytes(version.total_size));
  const metaSuffix = meta.length > 0 ? `\n    ${meta.join(" · ")}` : "";
  return `v${version.version_number} — ${version.status}${liveMarker}${metaSuffix}`;
}

/**
 * Formats the storage-usage object echoed by a version delete into a readable
 * line. Renders used/limit as a "X of Y" byte figure when both are present,
 * otherwise falls back to whatever numeric fields the API returned.
 */
export function formatUsage(usage: Record<string, number | undefined>): string {
  if (typeof usage.used_bytes === "number" && typeof usage.limit_bytes === "number") {
    return `${formatBytes(usage.used_bytes)} of ${formatBytes(usage.limit_bytes)}`;
  }
  if (typeof usage.used_bytes === "number") {
    return formatBytes(usage.used_bytes);
  }
  const parts = Object.entries(usage)
    .filter(([, value]) => typeof value === "number")
    .map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join(", ") : "(unavailable)";
}

/** Formats a single site as a human-readable block with labeled fields. */
export function formatSiteEntry(site: Site): string {
  const size = formatBytes(site.total_size);
  const updated = new Date(site.updated_at).toLocaleDateString();
  const visibility =
    site.visibility !== "public" ? `\nVisibility: ${site.visibility}` : "";

  return (
    `Title: ${site.title}\n` +
    `Slug: ${site.slug}\n` +
    `URL: ${site.url ?? `(URL unavailable — check slug: ${site.slug})`}\n` +
    `Files: ${site.file_count} (${size})\n` +
    `Updated: ${updated}` +
    visibility
  );
}
