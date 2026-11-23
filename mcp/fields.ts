/**
 * Zod input fields shared by several MCP tools. Each is emitted byte-identically
 * wherever it is used; fields with tool-specific wording stay inline in index.ts.
 * Zod schemas are immutable, so one instance is safe to share across tools.
 */
import { z } from "zod";
import { SITE_DATA_LIMITS } from "../lib/core.ts";

/** Optional address that a site belongs to. */
export const siteNamespaceField = z
  .string()
  .optional()
  .describe("Address name the site belongs to. When omitted, the default address is used.");

/** Optional address for the site data tools. */
export const namespaceField = z
  .string()
  .optional()
  .describe("Address name. When omitted, the default address is used.");

/** Required site slug. */
export const siteSlugField = z
  .string()
  .describe("The URL-safe identifier of the site. Use the `list` tool to find available slugs.");

// Mirrors the server's claim matcher (lib/site-data-types.ts ClaimMatcher).
export const claimMatcher = z.object({
  kind: z.enum(["passcode", "jwt"]),
  claims: z
    .record(z.string().min(1).max(SITE_DATA_LIMITS.maxClaimKeyLength), z.union([z.string().min(1).max(128), z.boolean()]))
    .refine((c) => Object.keys(c).length >= 1 && Object.keys(c).length <= SITE_DATA_LIMITS.maxClaimsPerMatcher, {
      message: `1 to ${SITE_DATA_LIMITS.maxClaimsPerMatcher} claims`,
    }),
});
export const claimMatchers = z.array(claimMatcher).max(SITE_DATA_LIMITS.maxClaimMatchers);
