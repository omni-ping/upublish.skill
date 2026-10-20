/**
 * Out-of-date check for the local MCP server.
 *
 * Compares the running version against `plugin.json` on GitHub `main`, fetching
 * at most once per 24 h (result cached in ~/.upublish/update-check.json).
 *
 * Contract: `checkForUpdate` NEVER rejects and never throws. Offline, timeout,
 * non-200, malformed JSON, a non-semver remote version, or an unusable cache all
 * degrade to `{ status: "unknown" }` (no note). The remote document is untrusted:
 * only a strict `x.y.z` version string is ever accepted, so no raw remote text
 * can reach the note shown to the AI.
 *
 * This module deliberately does not call lib/log.ts (it writes to the real home
 * directory) and does not use the API-header fetch: the GitHub request carries
 * no X-Upublish-Client header.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchFn } from "./types.ts";

const REMOTE_URL =
  "https://raw.githubusercontent.com/omni-ping/upublish.skill/main/plugin.json";
const TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 3000;
const MAX_BODY_CHARS = 64 * 1024;
const SEMVER = /^\d+\.\d+\.\d+$/;

export type UpdateStatus =
  | { status: "behind"; latest: string }
  | { status: "current" }
  | { status: "unknown" };

export interface UpdateCheckDeps {
  /** Plain fetch (never the API-header fetch). Defaults to global fetch. */
  fetchFn?: FetchFn;
  /** Cache file. Defaults to update-check.json beside `credentialsPath`, else ~/.upublish/update-check.json. */
  cachePath?: string;
  /** Injected credentials file (tests): the cache is kept next to it, never in the real home dir. */
  credentialsPath?: string;
  /** Clock in ms since epoch. Defaults to Date.now. */
  now?: () => number;
  /** Fetch timeout in ms. Defaults to 3000. */
  timeoutMs?: number;
}

/** Numeric x.y.z compare: negative if a < b, 0 if equal, positive if a > b. Both must match SEMVER. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  }
  return 0;
}

/** Returns the cached latest version when the cache is valid and younger than 24 h, else null. */
function readFreshCache(cachePath: string, nowMs: number): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
      checkedAt?: unknown;
      latest?: unknown;
    };
    const { checkedAt, latest } = raw;
    if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) return null;
    if (typeof latest !== "string" || !SEMVER.test(latest)) return null;
    // Future-dated (clock skew) or older than TTL counts as stale.
    if (checkedAt > nowMs || nowMs - checkedAt >= TTL_MS) return null;
    return latest;
  } catch {
    return null; // missing / unreadable / corrupt: treat as a miss
  }
}

function writeCache(cachePath: string, checkedAt: number, latest: string): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ checkedAt, latest }));
  } catch {
    // unwritable cache must never fail the check
  }
}

/** Fetches the remote version; returns a validated x.y.z string or null. Never throws. */
async function fetchLatest(fetchFn: FetchFn, timeoutMs: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      const res = await fetchFn(REMOTE_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const text = await res.text();
      if (text.length > MAX_BODY_CHARS) return null;
      const version = (JSON.parse(text) as { version?: unknown } | null)?.version;
      return typeof version === "string" && SEMVER.test(version) ? version : null;
    })();
    // Stubs (and odd proxies) may ignore the abort signal: bound the wait ourselves.
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    work.catch(() => undefined); // avoid an unhandled rejection if the deadline wins
    return await Promise.race([work, deadline]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Checks whether `current` is behind the version on GitHub `main`.
 * Never rejects: every failure resolves to `{ status: "unknown" }`.
 */
export async function checkForUpdate(
  current: string,
  deps: UpdateCheckDeps = {},
): Promise<UpdateStatus> {
  try {
    if (!SEMVER.test(current)) return { status: "unknown" };
    const now = deps.now ?? Date.now;
    const cachePath =
      deps.cachePath ??
      path.join(deps.credentialsPath ? path.dirname(deps.credentialsPath) : path.join(os.homedir(), ".upublish"), "update-check.json");

    let latest = readFreshCache(cachePath, now());
    if (latest === null) {
      latest = await fetchLatest(deps.fetchFn ?? fetch, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      if (latest === null) return { status: "unknown" };
      writeCache(cachePath, now(), latest);
    }
    return compareSemver(latest, current) > 0 ? { status: "behind", latest } : { status: "current" };
  } catch {
    return { status: "unknown" };
  }
}

/** One-line note for the AI to relay. `latest` must be a validated x.y.z string. */
export function formatUpdateNote(current: string, latest: string): string {
  return (
    `Note: the upublish plugin is out of date (installed ${current}, latest ${latest}). ` +
    `Tell the user to update: in Claude Code run /plugin, open Marketplaces, select upublish.skill and ` +
    `choose Enable auto-update (or run /plugin update upublish@upublish.skill), then /reload-plugins; ` +
    `on other hosts (Codex, Gemini CLI, Antigravity CLI) update the upublish plugin/extension.`
  );
}
