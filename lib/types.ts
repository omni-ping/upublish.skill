/**
 * Shared types for upublish lib/ modules.
 *
 * Inlined from @upublish/shared to avoid workspace dependency — the skill
 * repo must be self-contained for standalone installations.
 */

/** Site visibility mode. */
export type Visibility = "public" | "unlisted" | "passcode" | "signed" | "identity";

/** A published site on upubli.sh. */
export interface Site {
  id: string;
  user_id: string;
  slug: string;
  title: string;
  created_at: string;
  updated_at: string;
  file_count: number;
  total_size: number;
  visibility: Visibility;
  passcode_hash: string | null;
  /** Production URL — present on list responses. */
  url?: string;
}

/** Fetch function signature for dependency injection. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Returns a valid Bearer token, refreshing if needed. */
export type TokenProvider = () => Promise<string>;
