/**
 * Shared types for upublish lib/ modules.
 *
 * Inlined from @upublish/shared to avoid workspace dependency — the skill
 * repo must be self-contained for standalone installations.
 */

/** Site visibility mode. */
export type Visibility = "public" | "unlisted" | "passcode";

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

// ─── Gate types ───────────────────────────────────────────────────────────────

/** A field type collected by a form gate. */
export type GateFieldType = "email" | "name" | "company" | "phone" | "message";

/** Gate configuration for a site. */
export interface GateConfig {
  /** The site slug this gate belongs to. */
  slug: string;
  /** Fields collected by the gate form. */
  fields: GateFieldType[];
  /** ISO 8601 creation timestamp. */
  created_at: string;
  /** ISO 8601 last-update timestamp. */
  updated_at: string;
}

/** A visitor submission captured through a form gate. */
export interface GateSubmission {
  /** Unique submission ID. */
  id: string;
  /** ISO 8601 submission timestamp. */
  submitted_at: string;
  /** Key/value pairs of field data submitted by the visitor. */
  data: Record<string, string>;
}
