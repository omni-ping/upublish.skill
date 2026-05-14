# Discovery + Design: Phase 1 - Update manifests, tests, install.sh, and setup skill

## Files Found
- `.claude-plugin/plugin.json` — exists, version 0.1.0, uses bun + mcp/index.ts
- `gemini-extension.json` — exists, version 0.1.0, uses bun + extensionPath/mcp/index.ts
- `.codex-plugin/plugin.json` — exists, version 0.1.0
- `.mcp.json` — exists, uses bun + mcp/index.ts (local dev, keep as-is)
- `tests/manifests.test.ts` — exists, 266 lines, tests expect bun+mcp/index.ts for claude-plugin
- `skills/upublish-setup/SKILL.md` — exists, covers Codex and Claude Code, missing Gemini
- `install.sh` — exists, uses git clone + bun install pattern
- `package.json` — version already 0.2.0

## Current State
All manifests are at version 0.1.0 while package.json is at 0.2.0. The claude-plugin and gemini-extension manifests reference the raw bun+mcp/index.ts MCP server, which only works in dev. The install.sh uses a heavyweight git clone + bun install approach. The setup skill lacks Gemini CLI instructions.

## Gaps
1. Version mismatch: manifests say 0.1.0, package.json says 0.2.0
2. MCP command mismatch: manifests use bun (dev-only), should use npx (published package)
3. install.sh is overly complex — should use npm install -g
4. Setup skill missing Gemini CLI platform detection
5. Tests expect old bun+mcp/index.ts pattern for claude-plugin

## Code Standards
No code-standards.md found.

## Test Infrastructure
- Bun test runner (`bun:test`)
- Tests in `tests/` directory, run with `bun test`
- Manifest tests use file reading helpers (`readJson`, `readText`, `fileExists`)
- DW-prefixed test names (e.g., `test_DW_4_1_...`)
- 176 tests across 12 files, all passing

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-1.1 | `.claude-plugin/plugin.json` MCP command is `npx` with args `["-y", "@omniping/upublish", "mcp"]`, version 0.2.0 | COVERED | test_DW_4_1_mcp_server_uses_npx, test_DW_4_1_version_is_0_2_0 |
| DW-1.2 | `gemini-extension.json` MCP command is `npx` with args, version 0.2.0, keeps cwd and contextFileName | COVERED | test_DW_4_4_uses_npx_command, test_DW_4_4_version_is_0_2_0 (existing tests cover cwd and contextFileName) |
| DW-1.3 | `.codex-plugin/plugin.json` version is 0.2.0 | COVERED | test_DW_4_2_version_is_0_2_0 |
| DW-1.4 | `.mcp.json` still uses bun mcp/index.ts | COVERED | test_DW_4_3_points_to_mcp_index_ts (existing, unchanged) |
| DW-1.5 | `tests/manifests.test.ts` updated for npx expectations | COVERED | The test file itself is the deliverable; running bun test validates it |
| DW-1.6 | `skills/upublish-setup/SKILL.md` detects Gemini CLI | COVERED | test_DW_4_5_setup_skill_references_gemini |
| DW-1.7 | `install.sh` uses npm install -g | COVERED | test_install_sh_uses_npm_install |
| DW-1.8 | bun test passes with 0 failures | COVERED | Running bun test at the end |

**All items COVERED:** YES

## Design Decisions
This is simple/mechanical work: update JSON values, rewrite a shell script, add a section to a markdown file, and update test expectations. No non-trivial interfaces or module design. A brief note suffices.

- Manifests: direct JSON field changes (command, args, version)
- install.sh: simplify to npm install -g pattern, remove bun/git/wrapper complexity
- SKILL.md: add Gemini section following the existing Codex/Claude Code pattern
- Tests: update expectations to check for npx command and @omniping/upublish in args

## Prerequisites
- [x] Required files exist
- [x] Dependencies available (bun test runner)
- [x] package.json already at 0.2.0

## Recommendation
BUILD — straightforward updates to 7 files with test validation.
