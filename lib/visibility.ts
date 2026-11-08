/**
 * Site visibility switching (public <-> passcode).
 *
 * Returns structured data — formatting is the adapter's job.
 * Throws actionable Errors on refusals and API failures.
 *
 * Safety rules this module owns, so no caller has to remember them:
 *   - the current visibility is READ first and never guessed;
 *   - a site is never passcode-locked with zero passcodes (a new code is
 *     POSTed BEFORE the PATCH, and a passcode switch with no code is refused);
 *   - a half-done switch (code added, PATCH failed) is reported as exactly that.
 */

import type { ApiClient } from "./api-client.ts";
import { readSiteVisibility } from "./list.ts";
import { assertPasscodeInput, createPasscode, listPasscodes, normalizeLabel, withPaidPlanHint } from "./passcode.ts";
import type { SitePasscode } from "./passcode.ts";
import { asVisibility } from "./types.ts";
import type { Visibility } from "./types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/** The two states this module can SET. */
export type SettableVisibility = "public" | "passcode";

export interface SetVisibilityArgs {
  slug: string;
  visibility: SettableVisibility;
  /** Code to add (before switching). Only valid with visibility "passcode". */
  passcode?: string;
  /** Label for the added code. Defaults to "default". */
  label?: string;
}

export interface SetVisibilityResult {
  slug: string;
  /** Visibility after the call, as echoed by the server. */
  visibility: Visibility;
  /** Visibility before the call. */
  previous: Visibility;
  /** Passcodes enforced after the call (0 whenever the site is not passcode-protected). */
  activePasscodes: number;
  /** The passcode newly added by this call, when `passcode` was supplied and was not already present. */
  addedPasscode?: SitePasscode;
  /** The entry the site already had, when the supplied `passcode` was already present (nothing was added). */
  existingPasscode?: SitePasscode;
}

interface PatchVisibilityResponse {
  site?: { visibility?: unknown };
}

// ─── Set ─────────────────────────────────────────────────────────────────────

/**
 * Switches a site between public and passcode-protected.
 *
 * Order for `passcode`: read site -> count codes -> POST new code (if given)
 * -> PATCH. The PATCH is last so the site is never passcode-locked with zero
 * codes. For `public` it is read -> PATCH.
 *
 * @throws Error if visibility is not public/passcode, or `passcode` accompanies "public".
 * @throws Error if the site can't be found/read (no mutation).
 * @throws Error if switching to passcode with zero codes and none supplied (no PATCH).
 * @throws Error naming the added code and the unchanged visibility if the PATCH fails after the POST.
 */
export async function setVisibility(
  apiClient: ApiClient,
  nsId: string,
  args: SetVisibilityArgs,
): Promise<SetVisibilityResult> {
  const { slug, visibility, passcode } = args;
  const label = normalizeLabel(args.label);

  if (visibility !== "public" && visibility !== "passcode") {
    throw new Error(`visibility must be "public" or "passcode" (got "${String(visibility)}")`);
  }
  if (passcode !== undefined) {
    if (visibility !== "passcode") {
      throw new Error(`passcode can only be supplied with visibility "passcode"; "public" would ignore it.`);
    }
    assertPasscodeInput(passcode, label);
  }

  const previous = await readSiteVisibility(apiClient, nsId, slug);
  const base = `/api/ns/${nsId}/sites/${encodeURIComponent(slug)}`;

  let existing = 0;
  if (visibility === "passcode") {
    existing = (await listPasscodes(apiClient, nsId, slug)).passcodes.length;
    if (passcode === undefined && existing === 0) {
      throw new Error(
        `Site "${slug}" has no passcodes, so switching it to passcode protection would lock everyone out. ` +
        `Pass passcode: "<code>" to add one in the same call. Visibility is unchanged (${previous.toUpperCase()}).`,
      );
    }
  }

  const posted = passcode !== undefined ? await createPasscode(apiClient, nsId, slug, passcode, label) : undefined;
  // `existed` means the code was already counted in `existing`; nothing new was added.
  const added = posted && !posted.existed ? posted.passcode : undefined;
  const already = posted?.existed ? posted.passcode : undefined;

  let response: PatchVisibilityResponse;
  try {
    response = await apiClient.patch<PatchVisibilityResponse>(`${base}/visibility`, { visibility });
  } catch (err) {
    const reason = (withPaidPlanHint(err) as Error).message;
    throw new Error(
      (added ? `Passcode "${added.label}" (id ${added.id}) WAS added to "${slug}", but ` : ``) +
      `setting visibility to ${visibility.toUpperCase()} failed: ${reason}. ` +
      `Site "${slug}" is still ${previous.toUpperCase()}.`,
      { cause: err },
    );
  }

  // Trust the server's echo over our request; refuse to report a state it didn't apply.
  const echoed = asVisibility(response?.site?.visibility);
  if (echoed !== undefined && echoed !== visibility) {
    throw new Error(
      `The server reports "${slug}" is ${echoed.toUpperCase()}, not ${visibility.toUpperCase()}. ` +
      `Check the site's visibility before relying on it.`,
    );
  }

  return {
    slug,
    visibility: echoed ?? visibility,
    previous,
    activePasscodes: visibility === "passcode" ? existing + (added ? 1 : 0) : 0,
    ...(added ? { addedPasscode: added } : {}),
    ...(already ? { existingPasscode: already } : {}),
  };
}
