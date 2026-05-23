# Plan: Remove CLI, MCP-only distribution
**Created:** 2026-05-22
**Status:** in-progress
**Started:** 2026-05-22 14:00
**Current Phase:** 1
**Complexity:** medium
**Workspace:** branch: feature/remove-cli-mcp-only
---
## Context

**Problem:** upublish ships a CLI adapter (`bin/upublish.ts`), npm package, Node shim, and install script that duplicate functionality already available through the MCP server. The CLI is a maintenance burden — every new feature must be wired in two places, version bumps miss files (`gemini-extension.json` stuck at 0.4.0), and the npm publish pipeline adds complexity. All three target platforms (Claude Code, Codex, Gemini CLI) support bundled MCP servers natively, making the CLI unnecessary.

**Constraints:**
- MCP server must gain `login` and `status` tools to replace CLI-only auth commands
- Login tool must open the browser AND always return the URL as text (user may want a different browser profile)
- All three platform manifests must work with bundled `dist/mcp.js` (no npm/npx)
- `open` dependency stays (needed for MCP login browser open)
- `citty` dependency goes (CLI framework, no longer needed)
- Existing lib/ tests must continue to pass — domain logic is untouched
- The error message "Run `upublish login`" in `lib/core.ts` must be updated since there's no CLI
- npm publishing is dropped entirely — GitHub-based plugin install is the only distribution channel

**Success criteria:**
- `bun test` passes with 0 failures
- MCP server exposes login, status, and all existing tools
- SKILL.md, GEMINI.md, and reference docs work without any CLI commands
- All platform manifests reference bundled MCP server (no npx)
- CLI files, npm publish infra, and stale artifacts are removed

---
## Implementation Phases

### Phase 1: Add MCP login + status tools
**Skills:** `code-foundations:build`

**Goal:** Add `login` and `status` tools to the MCP server so auth can happen entirely through MCP.

**Scope:**
- IN: Add `login` tool to `mcp/index.ts` — creates localhost callback server (Bun.serve), opens browser via `open`, waits for tokens, stores credentials. Always returns the auth URL in the response text alongside the "opening browser" message.
- IN: Add `status` tool to `mcp/index.ts` — calls `core.status()`, returns auth state.
- IN: Import `login`, `status`, and `open` in `mcp/index.ts`
- IN: Add `createCallbackServer` function to `mcp/index.ts` (port from `bin/upublish.ts` pattern). The `login` tool handler calls `core.login()` which accepts `LoginDeps` — inject `openBrowser` (via `open` package) and `startCallbackServer` (the local function) as deps. This is the existing DI pattern from `lib/auth.ts` — no new injection mechanism needed.
- IN: Add tests in `tests/mcp.test.ts` for login and status tools. For login: mock `core.login()` via a wrapper (the tool handler calls `core.login(loginDeps)` — test by injecting `CoreDeps` that provides a mock fetch, and verifying the tool response shape). For status: inject `CoreDeps` with mock credentials as existing tests do.
- IN: Update error message in `lib/core.ts:119` from `"Not authenticated. Run \`upublish login\` to sign in."` to `"Not authenticated. Use the login tool to sign in."`
- IN: Fix stale tool count assertions in `tests/mcp.test.ts` — `test_DW_2_1_server_registers_exactly_four_tools` (line 146) and `test_DW_2_1_creates_server_and_has_tools` (line 615) currently assert 4 tools but there are already 7 registered (passcode tools were added later). Update to count all tools including the 2 new ones (total: 9).
- IN: Rebuild `dist/mcp.js` after adding tools — `bun build mcp/index.ts --target=bun --outfile=dist/mcp.js`
- OUT: No changes to `lib/auth.ts` — the login orchestrator and callback server types are reused as-is

**Done when:**
- [ ] DW-1.1: MCP server exposes a `login` tool that opens browser and returns auth URL text
- [ ] DW-1.2: MCP server exposes a `status` tool that returns auth state
- [ ] DW-1.3: Login tool creates a localhost callback server, waits for OAuth tokens, stores credentials
- [ ] DW-1.4: Login tool response always includes the auth URL as text so user can open it manually
- [ ] DW-1.5: "Not authenticated" error message no longer references CLI commands
- [ ] DW-1.6: Tests for login and status tools pass in `tests/mcp.test.ts`
- [ ] DW-1.7: Tool count assertions in `tests/mcp.test.ts` are fixed (currently stale at 4, should be 9)
- [ ] DW-1.8: `dist/mcp.js` is rebuilt with login + status tools
- [ ] DW-1.9: `bun test` passes with 0 failures (all existing + new tests)

### Phase 2: Remove CLI + npm infra, update manifests and docs
**Skills:** `code-foundations:build`

**Goal:** Remove CLI adapter, npm publish infrastructure, and stale artifacts. Update all platform manifests, skill, and documentation to be MCP-only.

**Scope:**
- IN: Delete files: `bin/upublish.ts`, `dist/cli.cjs`, `install.sh`, `scripts/publish.sh`, `tests/cli.test.ts`, `tests/install.test.ts`
- IN: Delete stale artifacts: `.claude/code-foundations/building/` (entire directory), `.claude/phase6-review.sh`
- IN: Update `package.json` — remove `bin` field, remove `citty` from dependencies, update `files` list to remove CLI entries (`bin/`, `dist/`, `install.sh`) but keep MCP/skill/plugin entries (`mcp/`, `lib/`, `skills/`, `references/`, `.claude-plugin/`, `.codex-plugin/`, `.mcp.json`, `GEMINI.md`, `gemini-extension.json`). Note: `dist/` stays in files since `dist/mcp.js` is the bundled MCP server.
- IN: Run `bun install` to update lockfile after removing `citty`
- IN: Update `gemini-extension.json` — change mcpServers command from `npx` to `bun`, args to `["run", "${extensionPath}/dist/mcp.js"]`, remove `cwd` field, fix version to match package.json
- IN: Update `.github/workflows/ci.yml` — remove npm publish job, add `gemini-extension.json` to version bump step (both the sed/node update AND the `git add` commit line)
- IN: Rewrite `skills/upublish/SKILL.md` — remove CLI bootstrap (which/npm install/configure/status/hello), simplify to MCP-only: check MCP tools available → call `status` tool → `login` if needed → route to action. Remove "MCP tools vs CLI commands" table and all CLI fallback references.
- IN: Rewrite `GEMINI.md` — remove CLI bootstrap (`bin/upublish.ts login`, `upublish login`), update to use MCP login tool. Remove `bun install` step (not needed for bundled MCP). Update available tools list to include login, status, passcode tools.
- IN: Update `references/troubleshooting.md` — replace `upublish login` CLI references with MCP tool references. Audit all other `references/*.md` for CLI command references and fix any found.
- IN: Update `CLAUDE.md` — remove `bin/upublish.ts` from architecture section, remove CLI-related descriptions, fix version reference from `0.4.0` to current, update version tracking section to mention `gemini-extension.json` as a file that needs version sync, remove npm publish mention.
- IN: Update `README.md` — remove CLI install references (npm install, install.sh), keep plugin install instructions for all 3 platforms.
- IN: Update `tests/manifests.test.ts`:
  - Remove `test_DW_4_4_uses_npx_command` (asserts Gemini uses npx — will conflict with new `${extensionPath}` path)
  - Remove entire `DW-5.1 install.sh` describe block (tests install.sh existence and structure)
  - Remove `DW-5.2` tests that reference install.sh
  - Remove `DW-5.5` tests about npm bin entry, node shim, cli.cjs
  - Remove `DW-5.6` manual checklist test that checks bin/upublish.ts exists
  - Keep plugin manifest assertions (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`)
  - Keep MCP config assertions (`.mcp.json`)
  - Update Gemini manifest assertions to match new format
- IN: Update `CHANGELOG.md` — add entry for this release covering CLI removal and MCP login/status addition
- OUT: No changes to `lib/` domain logic (error message already fixed in Phase 1)
- OUT: Do not backfill changelog for 0.5.0–0.5.6 — just add the new entry

**Done when:**
- [ ] DW-2.1: `bin/upublish.ts`, `dist/cli.cjs`, `install.sh`, `scripts/publish.sh` are deleted
- [ ] DW-2.2: `tests/cli.test.ts` and `tests/install.test.ts` are deleted
- [ ] DW-2.3: `.claude/code-foundations/building/` and `.claude/phase6-review.sh` are deleted
- [ ] DW-2.4: `package.json` has no `bin` field, no `citty` dependency, and `dist/` stays in `files`
- [ ] DW-2.5: `gemini-extension.json` uses `${extensionPath}` path and version matches package.json
- [ ] DW-2.6: CI workflow has a sed/update step AND git-add line for `gemini-extension.json`, and has no npm publish job
- [ ] DW-2.7: `SKILL.md` has no CLI commands — bootstrap is MCP-only
- [ ] DW-2.8: `GEMINI.md` has no CLI commands — bootstrap uses MCP login tool
- [ ] DW-2.9: `references/troubleshooting.md` has no CLI command references
- [ ] DW-2.10: `CLAUDE.md` architecture section has no CLI references, version is current
- [ ] DW-2.11: `README.md` has no CLI install instructions
- [ ] DW-2.12: `tests/manifests.test.ts` has no CLI-related assertions (install.sh, bin, cli.cjs, npx) and Gemini assertions match new format
- [ ] DW-2.13: `bun install` lockfile is clean (no citty)
- [ ] DW-2.14: `bun test` passes with 0 failures

---
## Test Coverage
**Level:** 100% for new MCP tools; existing lib/ tests untouched

## Test Plan
- [ ] MCP login tool: verify tool is registered, verify response shape includes auth URL text
- [ ] MCP status tool: test authenticated state (mock credentials + fetch), test unauthenticated state (empty credentials)
- [ ] Tool count assertion updated to 9 (publish, list, delete, passcode_add, passcode_list, passcode_revoke, logout, login, status)
- [ ] Existing `bun test lib/` passes unchanged
- [ ] `tests/mcp.test.ts` passes with new + updated tests
- [ ] `tests/manifests.test.ts` passes after CLI assertions removed and Gemini assertions updated

---
## Execution Log

### Phase 1: Add MCP login + status tools (Gate: Full)
- [x] BUILD: Discovery + design + TDD implementation complete
- [x] REVIEW: Verification passed (DW-1.1 through DW-1.8 SATISFIED; DW-1.9 pre-existing failures in manifests.test.ts/install.test.ts — not regressions, Phase 2 scope)
- [x] Committed
Commit: 18ba3e7
Summary: Added login and status tools to MCP server. Login opens browser + returns auth URL. Status checks auth state. Updated error message to remove CLI reference. Fixed stale tool count assertions (4→9). Rebuilt dist/mcp.js.
