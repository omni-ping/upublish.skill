/** Minimum Bun the skill supports; mirrors `engines.bun` in package.json and `.bun-version`. */
export const MIN_BUN_VERSION = "1.4.4";

/** Parses the leading `major.minor.patch` of a version string; a pre-release/build suffix is ignored. */
function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Returns a one-line warning when the running Bun is older than MIN_BUN_VERSION, else null.
 * Fails quiet: an undefined (non-Bun host) or unparseable version yields null, never a note.
 * Pre-release strings compare as their base version (`1.4.4-canary.1` counts as 1.4.4).
 */
export function checkBunRuntime(version: string | undefined): string | null {
  const have = version === undefined ? null : parseVersion(version);
  const min = parseVersion(MIN_BUN_VERSION);
  if (!have || !min) return null;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== min[i]) {
      return have[i] > min[i]
        ? null
        : `Note: this upublish server is running on Bun ${version}, older than the required ${MIN_BUN_VERSION}. Run \`bun upgrade\` and restart your AI tool.`;
    }
  }
  return null;
}
