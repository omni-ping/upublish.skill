# Plan: Unify manifests to use npx
**Created:** 2026-05-13
**Status:** ready
**Complexity:** simple
---
## Context
All three platform manifests (`.claude-plugin/plugin.json`, `.mcp.json`, `gemini-extension.json`) reference the raw source MCP server via `bun mcp/index.ts`. This doesn't work after install because dependencies aren't available. The setup skill already uses the correct command (`npx -y @omniping/upublish mcp`) but the manifests don't match. Versions are also stale at 0.1.0 vs the published 0.2.0.

## Constraints
- All manifests must use `npx -y @omniping/upublish mcp` for the MCP server command
- Gemini extension must keep `${extensionPath}` for `cwd` (Gemini variable expansion)
- `.mcp.json` is used for local dev — keep it pointing to `bun mcp/index.ts` so devs can run from source
- Versions in manifests must match `package.json` version (0.2.0)
- Existing tests in `tests/manifests.test.ts` must be updated to match new expectations
- Setup skill must add Gemini CLI detection and registration
- `install.sh` should use `npm install -g @omniping/upublish` instead of git clone + bun
---
## Implementation Phases

### Phase 1: Update manifests, tests, install.sh, and setup skill
**Model:** sonnet

**Goal:** All platform manifests use npx for MCP, versions are consistent, tests pass, setup skill handles all three platforms, install.sh simplified.

**Scope:**
- IN: Update `.claude-plugin/plugin.json` — change MCP command to `npx` with args `["-y", "@omniping/upublish", "mcp"]`, bump version to 0.2.0, remove `cwd`. Update `gemini-extension.json` — change MCP command to `npx` with args `["-y", "@omniping/upublish", "mcp"]`, keep `cwd` with `${extensionPath}`, bump version to 0.2.0. Update `.codex-plugin/plugin.json` — bump version to 0.2.0. Leave `.mcp.json` as-is (local dev). Update `tests/manifests.test.ts` — tests should expect npx command for claude-plugin and gemini-extension, and still expect bun+mcp/index.ts for `.mcp.json` (local dev). Update `skills/upublish-setup/SKILL.md` — add Gemini CLI detection alongside Codex and Claude Code. Simplify `install.sh` to use `npm install -g @omniping/upublish`.
- OUT: Changing core library code. npm publish. Changing GEMINI.md or SKILL.md content beyond setup.

**Done when:**
- [ ] DW-1.1: `.claude-plugin/plugin.json` MCP command is `npx` with args `["-y", "@omniping/upublish", "mcp"]`, version 0.2.0
- [ ] DW-1.2: `gemini-extension.json` MCP command is `npx` with args `["-y", "@omniping/upublish", "mcp"]`, version 0.2.0, keeps `cwd` and `contextFileName`
- [ ] DW-1.3: `.codex-plugin/plugin.json` version is 0.2.0
- [ ] DW-1.4: `.mcp.json` still uses `bun mcp/index.ts` (local dev unchanged)
- [ ] DW-1.5: `tests/manifests.test.ts` updated — claude-plugin and gemini tests expect npx command, .mcp.json test expects bun (local dev)
- [ ] DW-1.6: `skills/upublish-setup/SKILL.md` detects Gemini CLI and registers MCP via `gemini extensions install` or manual `~/.gemini/settings.json` config
- [ ] DW-1.7: `install.sh` uses `npm install -g @omniping/upublish` instead of git clone + bun
- [ ] DW-1.8: `bun test` passes with 0 failures

---
## Test Coverage
**Level:** 100%
## Test Plan
- [ ] Unit: claude-plugin manifest has npx command and version 0.2.0
- [ ] Unit: gemini-extension manifest has npx command, cwd, contextFileName, version 0.2.0
- [ ] Unit: codex-plugin manifest has version 0.2.0
- [ ] Unit: .mcp.json still uses bun for local dev
- [ ] Unit: no absolute paths in any manifest
- [ ] Unit: setup skill references all three platforms
- [ ] Unit: install.sh contains npm install command
---
## Execution Log
_To be filled during /code-foundations:building_
