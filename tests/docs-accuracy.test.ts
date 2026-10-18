/**
 * Tests for documentation accuracy after Phase 5 corrections.
 *
 * DW-5.3: Docs state 10 MB free / 1 GB paid; no "25 MB" claims remain.
 * DW-6.2: Site data docs: every doc surface lists the four tools and routes to
 *         references/site-data.md; the guide matches the frozen contract; the
 *         tool count in CLAUDE.md matches what the server registers.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../mcp/index.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readDoc(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf-8");
}

// ─── DW-5.3: No "25 MB" claims remain ────────────────────────────────────────

describe("DW-5.3: docs accuracy — no stale 25 MB claims", () => {
  test("test_DW_5_3_publishing_md_no_25mb_claim", () => {
    const content = readDoc("references/publishing.md");
    expect(content).not.toMatch(/\b25\s*MB\b/i);
  });

  test("test_DW_5_3_taxonomy_md_no_25mb_claim", () => {
    const content = readDoc("references/content-types/taxonomy.md");
    expect(content).not.toMatch(/\b25\s*MB\b/i);
  });

  // ─── DW-5.3: Correct tier limits stated ────────────────────────────────────

  test("test_DW_5_3_publishing_md_states_10mb_free", () => {
    const content = readDoc("references/publishing.md");
    expect(content).toMatch(/10\s*MB/i);
  });

  test("test_DW_5_3_publishing_md_states_1gb_paid", () => {
    const content = readDoc("references/publishing.md");
    expect(content).toMatch(/1\s*GB/i);
  });
});

// ─── DW-6.2: site data docs ──────────────────────────────────────────────────

const SITE_DATA_TOOLS = ["data", "data_collection", "data_rows", "data_jwt"] as const;

function registeredToolNames(): string[] {
  const saved = process.env.UPUBLISH_ADMIN;
  delete process.env.UPUBLISH_ADMIN;
  try {
    const server = createServer({ credentialsPath: "/nonexistent" }) as unknown as { _registeredTools: Record<string, unknown> };
    return Object.keys(server._registeredTools);
  } finally {
    if (saved !== undefined) process.env.UPUBLISH_ADMIN = saved;
  }
}

describe("DW-6.2: every doc surface lists the site data tools and routes to the guide", () => {
  test("test_DW_6_2_site_data_tools_are_registered", () => {
    const names = registeredToolNames();
    for (const t of SITE_DATA_TOOLS) expect(names).toContain(t);
  });

  test("test_DW_6_2_skill_md_lists_tools_and_routes_to_guide", () => {
    const skill = readDoc("skills/upublish/SKILL.md");
    for (const t of SITE_DATA_TOOLS) expect(skill).toContain(`\`mcp_upublish_${t}\``);
    expect(skill).toContain("../../references/site-data.md");
  });

  test("test_DW_6_2_gemini_md_lists_tools_and_routes_to_guide", () => {
    const gemini = readDoc("GEMINI.md");
    for (const t of SITE_DATA_TOOLS) expect(gemini).toContain(`\`mcp_upublish_${t}\``);
    expect(gemini).toContain("`references/site-data.md`");
  });

  test("test_DW_6_2_claude_md_lists_tools_and_mentions_guide", () => {
    const claude = readDoc("CLAUDE.md");
    expect(claude).toMatch(/data \(status\/enable\/disable\/wipe\)/);
    expect(claude).toMatch(/data_collection \(list\/get\/set\/delete\)/);
    expect(claude).toMatch(/data_rows \(list\/export\/archive\/delete\/create\/put\/import\)/);
    expect(claude).toMatch(/data_jwt \(set\/clear\)/);
    expect(claude).toContain("references/site-data.md");
  });

  test("test_DW_6_2_claude_md_always_on_tool_count_matches_the_server", () => {
    const claude = readDoc("CLAUDE.md");
    const documented = Number(/registers (\d+) always-on tools/.exec(claude)?.[1]);
    expect(documented).toBe(registeredToolNames().length);
  });

  test("test_DW_6_2_guide_tells_ai_to_copy_the_author_line_not_the_label", () => {
    const guide = readDoc("references/site-data.md");
    expect(guide).toContain("the `author:` line `list` prints");
    expect(guide).toContain("`label:` line is display-only");
  });

  test("test_DW_6_3_guide_covers_not_charged_enable_reply", () => {
    expect(readDoc("references/site-data.md")).toContain("will not be charged");
  });

  test("test_DW_6_2_vendored_fixtures_readme_names_source_and_commit", () => {
    const readme = readDoc("tests/fixtures/site-data/README.md");
    expect(readme).toContain("a07b0a4");
    expect(readme).toContain("docs/site-data/fixtures/");
    expect(readme).toMatch(/read-only snapshot/i);
  });
});

describe("DW-6.2: references/site-data.md matches the frozen contract", () => {
  const guide = readDoc("references/site-data.md");

  // code -> status, copied from the contract's section 6 (errors.ts) for the codes visitor code can see.
  const VISITOR_ERRORS: Record<string, number> = {
    invalid_request: 400, invalid_token: 401, forbidden: 403, csrf_blocked: 403, data_unavailable: 403,
    not_found: 404, method_not_allowed: 405, exists: 409, identity_limit_reached: 409, collection_full: 409,
    site_moved: 410, row_too_large: 413, rate_limited: 429, overloaded: 503, data_plane_disabled: 503, unavailable: 503,
  };

  for (const [code, status] of Object.entries(VISITOR_ERRORS)) {
    test(`test_DW_6_2_guide_error_table_${code}_${status}`, () => {
      expect(guide).toMatch(new RegExp(`\\| \`${code}\` \\| ${status} \\|`));
    });
  }

  test("test_DW_6_2_guide_names_owner_side_codes_as_tool_errors", () => {
    for (const c of ["unauthenticated", "not_available", "upgrade_required", "no_subscription", "consent_required", "addon_not_enabled", "collection_exists", "collection_not_found", "limit_exceeded", "admin_channel_failed", "conflict"]) {
      expect(guide).toContain(`\`${c}\``);
    }
  });

  test("test_DW_6_2_guide_routes_and_methods", () => {
    for (const r of [
      "GET /_data/_me", "GET /_data/{collection}`", "POST /_data/{collection}`", "GET /_data/{collection}/{id}`",
      "PUT /_data/{collection}/{id}`", "DELETE /_data/{collection}/{id}`",
    ]) expect(guide).toContain(r);
    expect(guide).toContain("/{slug}/_data/{collection}");
    expect(guide).toContain("For the `_root` site it is `/_data/{collection}`");
  });

  test("test_DW_6_2_guide_request_rules", () => {
    expect(guide).toContain('credentials: "same-origin"');
    expect(guide).toContain("Content-Type: application/json");
    expect(guide).toContain("**directly**");
    expect(guide).toMatch(/DELETE has \*\*no body\*\*/);
    expect(guide).toMatch(/must send `Origin`/);
    expect(guide).toContain("no CORS");
    expect(guide).toContain("Cache-Control: no-store");
    expect(guide).toContain("Authorization: Bearer");
  });

  test("test_DW_6_2_guide_limits", () => {
    expect(guide).toContain("10,000");
    expect(guide).toContain("16,384");
    expect(guide).toContain("65,536");
    expect(guide).toContain("100,000");
    expect(guide).toMatch(/60 per identity/);
    expect(guide).toContain("(default 50)");
    expect(guide).toContain("500 rows per call");
    expect(guide).toContain("8,192 bytes");
    expect(guide).toContain("Up to 20 collections");
  });

  test("test_DW_6_2_guide_presets_identities_and_wire_shapes", () => {
    for (const p of ["append-only", "own-rows", "inbox", "owner-only"]) expect(guide).toContain(`\`${p}\``);
    for (const w of ["VisitorRow", "next_cursor", "mine", "admin_claims", "__Host-upublish_did", "enter the passcode again", "iss|sub", "identityKey"]) {
      expect(guide).toContain(w);
    }
  });

  test("test_DW_6_2_guide_covers_client_patterns", () => {
    expect(guide).toContain("PUT /{collection}/{id}");
    expect(guide).toMatch(/Offline queue/);
    expect(guide).toContain('addEventListener("online"');
    expect(guide).toContain("Retry-After");
    expect(guide).toMatch(/Worked example: a one-vote poll/);
  });

  test("test_DW_6_3_guide_reserves_data_at_any_depth_and_scopes_inbox_idempotency_to_same_author", () => {
    expect(guide).toContain("at any depth");
    expect(guide).toContain("assets/_data/");
    expect(guide).toMatch(/identical-body PUT is a harmless 200 only for the same author/);
    expect(guide).toMatch(/different author gets 409 `exists`/);
    expect(guide).not.toMatch(/in `append-only` and `inbox` an identical body returns 200/);
  });

  test("test_DW_6_3_guide_lists_conflict_and_enable_disable_503_unavailable_as_owner_side", () => {
    expect(guide).toMatch(/`conflict` \(409:[^)]*rule[^)]*active rows/);
    expect(guide).toMatch(/`enable` and `disable` can also fail with 503 `unavailable`[^.]*may not have taken effect/);
    expect(guide).toMatch(/check `data` `status`, then retry/);
    expect(guide).toMatch(/will not charge again if the add-on is already on/);
    expect(guide).not.toMatch(/nothing changed|never charges twice/i);
  });

  test("test_DW_6_2_guide_import_skips_by_key_not_id", () => {
    expect(guide).toMatch(/key already exists are skipped[^;]*`\(author, id\)`[^;]*`own-rows`/);
    expect(guide).not.toContain("existing ids");
  });

  test("test_DW_6_2_guide_consent_and_dark_launch_instructions", () => {
    expect(guide).toMatch(/not available for this account/);
    expect(guide).toMatch(/Do not offer or advertise it/);
    expect(guide).toContain("accept_charge: true");
    expect(guide).toMatch(/get a clear yes/);
    expect(guide).toContain("`_data` directory");
  });

  test("test_DW_6_2_guide_only_references_tools_that_exist", () => {
    const names = registeredToolNames();
    const mentioned = [...guide.matchAll(/`((?:data|data_collection|data_rows|data_jwt|passcode_add|upgrade|publish))`/g)].map((m) => m[1]!);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const t of mentioned) expect(names).toContain(t);
  });

  test("test_DW_6_2_guide_code_blocks_are_valid_javascript", () => {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (body: string) => unknown;
    const blocks = [...guide.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    for (const code of blocks) {
      // Only syntax is checked (the function is constructed, never called). Comment-only blocks are fine.
      expect(() => new AsyncFunction(code)).not.toThrow();
    }
  });
});

describe("review R-3: guide retry prose is exact and consistent with the table and queue code", () => {
  const guide = readDoc("references/site-data.md");
  const prose = guide.split("\n").find((l) => l.startsWith("Treat a network failure"))!;
  const [retryable, permanent] = prose.split("Every other 4xx");
  // 4xx codes visitor code can see, from the contract's section 6.
  const CODES_4XX = [
    "invalid_request", "invalid_token", "forbidden", "csrf_blocked", "data_unavailable", "not_found", "method_not_allowed",
    "exists", "identity_limit_reached", "collection_full", "site_moved", "row_too_large", "rate_limited",
  ];

  test("test_R3_rate_limited_is_retryable_after_retry_after_not_permanent", () => {
    expect(prose).toBeDefined();
    expect(retryable).toContain("`rate_limited` (429");
    expect(retryable).toContain("Retry-After");
    expect(permanent).not.toContain("rate_limited");
  });

  test("test_R3_every_4xx_code_is_classified_exactly_once", () => {
    for (const c of CODES_4XX) {
      const inRetry = retryable!.includes(`\`${c}\``);
      const inPermanent = permanent!.includes(`\`${c}\``);
      expect(inRetry !== inPermanent, c).toBe(true);
    }
    // The queue code in the worked example retries exactly the codes the prose calls retryable.
    expect(guide).toContain('e.code === "invalid_token" || e.code === "data_unavailable"');
    expect(guide).toContain('e.code === "rate_limited"');
  });
});
