/**
 * Tests for documentation accuracy after Phase 5 corrections.
 *
 * DW-5.3: Docs state 10 MB free / 1 GB paid; no "25 MB" claims remain.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
