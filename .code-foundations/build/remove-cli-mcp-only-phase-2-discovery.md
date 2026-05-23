# Discovery + Design: Phase 2 - Remove CLI + npm infra, update manifests and docs

## Files Found
- `bin/upublish.ts` — exists, 23KB CLI adapter (to delete)
- `dist/cli.cjs` — exists, 1.5KB Node shim (to delete)
- `install.sh` — exists, 2.2KB install script (to delete)
- `scripts/publish.sh` — exists, 591B npm publish script (to delete)
- `tests/cli.test.ts` — exists, 21KB CLI tests (to delete)
- `tests/install.test.ts` — exists, 12KB install tests (to delete)
- `.claude/code-foundations/building/` — exists, 2 files (to delete)
- `.claude/phase6-review.sh` — exists, 2.8KB (to delete)
- `package.json` — has `bin` field, `citty` dep, `install.sh` in files (to update)
- `gemini-extension.json` — version 0.4.0, uses npx, has cwd (to update)
- `.github/workflows/ci.yml` — has npm publish job, no gemini version bump (to update)
- `skills/upublish/SKILL.md` — full of CLI references (to rewrite)
- `GEMINI.md` — CLI bootstrap references (to rewrite)
- `references/troubleshooting.md` — `upublish login` CLI references (to update)
- `CLAUDE.md` — CLI in architecture, stale version 0.4.0 (to update)
- `README.md` — CLI install references (to update)
- `tests/manifests.test.ts` — CLI-related assertions to remove, Gemini assertions to update
- `CHANGELOG.md` — needs new entry

## Current State
Phase 1 complete (commit 18ba3e7). MCP server has login + status tools. Error message updated. 4 test failures pre-existing:
1. `test_DW_4_3_points_to_mcp_index_ts` — `.mcp.json` uses `dist/mcp.js` not `mcp/index.ts` (stale assertion)
2. `test_DW_4_4_version_matches_package_json` — gemini version 0.4.0 vs package 0.5.6
3. `test_DW_4_4_uses_npx_command` — gemini uses npx (will change to bun)
4. `test_DW_5_4_mcp_json_uses_bun_to_start_server` — .mcp.json uses `sh` not `bun` (install.test.ts, to be deleted)

232 pass, 4 fail currently.

## Gaps
1. Plan says remove `dist/` from `files` list but keep it since `dist/mcp.js` is the bundled MCP server. The dispatch prompt clarifies: `dist/` stays in `files`. Plan scope text is slightly contradictory — dispatch prompt overrides.
2. `tests/manifests.test.ts` has more tests to update than listed in plan:
   - `test_DW_4_3_points_to_mcp_index_ts` asserts args contain `mcp` AND `index.ts` — but .mcp.json uses `dist/mcp.js`. Need to fix this assertion to match reality.
   - `test_DW_4_5_root_skill_references_cli_auth` and `test_DW_4_5_root_skill_references_configure` assert CLI commands in SKILL.md — must be updated after rewrite.
   - `test_DW_4_6_references_cli_auth` asserts `upublish login` in GEMINI.md — must be updated after rewrite.
   - `test_DW_4_7_troubleshooting_uses_cli_auth` asserts `upublish login` in troubleshooting.md — must be updated.
   - `test_DW_4_9_server_entry_has_cwd` asserts Gemini has cwd with `${extensionPath}` — cwd is being removed per plan.
   - DW-1.7 install.sh describe block — entire block to remove (same as "DW-5.1" referenced in plan).
3. No `DW-5.x` tests found by that name in `tests/manifests.test.ts` — the plan references them but the actual file uses `DW-1.7` and `DW-4.x` numbering. The DW-1.7 block is the install.sh test block.

## Code Standards
Applied from `docs/code-standards.md`:
- Test naming: `test_DW_N_M_description`
- bun:test framework
- No `any` types
- `.ts` extension in imports

## Test Infrastructure
- Framework: `bun:test` with describe/test/expect
- Pattern: file-exists checks + content assertions for manifest/doc tests
- `readJson()`, `readText()`, `fileExists()` helpers in manifests.test.ts

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-2.1 | bin/upublish.ts, dist/cli.cjs, install.sh, scripts/publish.sh deleted | COVERED | test_DW_2_1_cli_files_deleted |
| DW-2.2 | tests/cli.test.ts and tests/install.test.ts deleted | COVERED | test_DW_2_2_cli_test_files_deleted |
| DW-2.3 | .claude/code-foundations/building/ and .claude/phase6-review.sh deleted | COVERED | test_DW_2_3_stale_artifacts_deleted |
| DW-2.4 | package.json no bin, no citty, dist/ in files | COVERED | test_DW_2_4_package_json_no_cli, test_DW_2_4_package_json_dist_in_files |
| DW-2.5 | gemini-extension.json uses ${extensionPath}, version matches | COVERED | test_DW_2_5_gemini_extension_path, test_DW_2_5_gemini_version_matches |
| DW-2.6 | CI has gemini version bump + git-add, no npm publish | COVERED | test_DW_2_6_ci_no_npm_publish, test_DW_2_6_ci_gemini_version_bump |
| DW-2.7 | SKILL.md no CLI commands, MCP-only bootstrap | COVERED | test_DW_2_7_skill_no_cli_commands, test_DW_2_7_skill_mcp_bootstrap |
| DW-2.8 | GEMINI.md no CLI commands, MCP login | COVERED | test_DW_2_8_gemini_no_cli_commands, test_DW_2_8_gemini_mcp_login |
| DW-2.9 | troubleshooting.md no CLI references | COVERED | test_DW_2_9_troubleshooting_no_cli |
| DW-2.10 | CLAUDE.md no CLI refs, version current | COVERED | test_DW_2_10_claude_md_no_cli, test_DW_2_10_claude_md_version |
| DW-2.11 | README.md no CLI install instructions | COVERED | test_DW_2_11_readme_no_cli_install |
| DW-2.12 | manifests.test.ts no CLI assertions, Gemini matches new format | COVERED | test_DW_2_12_manifests_no_cli_assertions (meta-verification via bun test pass) |
| DW-2.13 | bun install lockfile clean (no citty) | COVERED | test_DW_2_13_no_citty_in_lockfile |
| DW-2.14 | bun test passes with 0 failures | COVERED | Full test suite run at end |

**All items COVERED:** YES

## Design Decisions

This phase is primarily deletion + text editing. No new interfaces or modules. Approach is straightforward:

1. **Delete files first** — removes dead code before updating references
2. **Update package.json + bun install** — removes citty, updates files list
3. **Update gemini-extension.json** — fix version, use bun + extensionPath
4. **Update CI** — add gemini version bump, remove npm publish
5. **Rewrite docs** — SKILL.md, GEMINI.md, troubleshooting.md, CLAUDE.md, README.md
6. **Update manifests.test.ts** — remove CLI assertions, fix Gemini assertions, fix .mcp.json assertion
7. **Add CHANGELOG entry**
8. **Write DW tests** — new test file for phase 2 DW items
9. **Run full suite** — confirm 0 failures

## Prerequisites
- [x] Phase 1 complete (MCP login + status tools added)
- [x] Required files exist
- [x] Dependencies available

## Recommendation
BUILD — straightforward deletion and text update work. All DW items can be met.
