# Discovery + Design: Phase 3 - Rewrite root SKILL.md as bootstrap

## Files Found
- skills/upublish/SKILL.md -- current root skill (56 lines), routes to reference files, defers setup to upublish-setup
- skills/upublish-setup/SKILL.md -- setup skill (99 lines), manual MCP config writing per platform
- references/publishing.md -- publishing workflow (52 lines)
- references/managing.md -- list/delete/update docs (28 lines)
- references/visibility.md -- public/unlisted/passcode docs (42 lines)
- references/generating.md -- diagram generation docs (51 lines)
- references/troubleshooting.md -- error resolution docs (42 lines)
- references/pre-publish-checklist.md -- pre-publish validation (85 lines)
- bin/upublish.ts -- CLI with configure and hello subcommands (Phase 1 + 2 output)

## Current State
Two separate skills exist:
1. **upublish** -- assumes MCP tools are already configured. If tools missing, tells user to run `/upublish-setup`. Routes to reference files for each action.
2. **upublish-setup** -- sequential checklist: install CLI, register MCP server (manual config file editing per platform), authenticate.

Phase 1 added `upublish configure --platform <claude|gemini|codex>` which replaces the manual MCP config writing in upublish-setup. Phase 2 added `upublish hello` which confirms setup is working.

The setup skill is now redundant -- `configure` handles plugin installation natively, and the root skill should handle the full bootstrap flow.

## Gaps
- Root SKILL.md does not check CLI installation or run configure
- Root SKILL.md defers to a separate setup skill instead of handling setup inline
- upublish-setup writes MCP config files manually -- replaced by `upublish configure` which uses platform-native plugin install
- No platform detection guidance exists in either skill
- No "restart session after configure" instruction exists
- No MCP-first/CLI-fallback pattern documented
- upublish-setup directory needs removal (consolidated into root)

## Code Standards
No code-standards.md found. This phase is pure skill/documentation work (SKILL.md rewrite), not code.

## Test Infrastructure
This phase produces a SKILL.md file, not code. Testing follows skill-craft protocol: trigger tests (does the description match user intents?), structure compliance (frontmatter, line count, content quality), and conceptual review of the workflow.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-3.1 | Root SKILL.md checks for CLI (`which upublish`), installs via npm if missing | COVERED | Verify SKILL.md contains `which upublish` check and `npm install -g @omniping/upublish` |
| DW-3.2 | Root SKILL.md runs `upublish configure --platform <detected>` if plugin not installed | COVERED | Verify SKILL.md references `upublish configure`, includes platform detection |
| DW-3.3 | Root SKILL.md checks auth (`upublish status`), runs `upublish login` if needed | COVERED | Verify SKILL.md contains `upublish status` check and `upublish login` fallback |
| DW-3.4 | Root SKILL.md tells LLM to restart session after configure | COVERED | Verify SKILL.md contains restart instruction after configure step |
| DW-3.5 | Post-setup, routes to publish/list/delete/manage/hello based on user intent | COVERED | Verify routing table with correct reference file paths |
| DW-3.6 | Root SKILL.md instructs LLM to use MCP tools first, fall back to CLI on failure | COVERED | Verify MCP-first/CLI-fallback instruction present |
| DW-3.7 | Root SKILL.md references `upublish configure` and `upublish hello` in its flow | COVERED | Verify both commands appear in the bootstrap flow |

**All items COVERED:** YES

## Design Decisions

### Approach: Bootstrap-first single SKILL.md

The new SKILL.md acts as a linear bootstrap then a router. Three phases a LLM walks through:

1. **Bootstrap** (steps 1-4) -- ensure CLI installed, plugin configured, auth valid. Each step is a gate: stop and fix before proceeding.
2. **Restart check** -- if `configure` just ran, tell user to restart session and STOP. MCP tools only load on session restart.
3. **Route** -- match user intent to action, prefer MCP tools, fall back to CLI.

This replaces the two-skill architecture (upublish + upublish-setup) with a single entry point that handles everything.

### Platform detection approach

The LLM knows what platform it runs on. Rather than programmatic detection, give the LLM a simple decision table:

| Signal | Platform |
|--------|----------|
| You have `claude` CLI tools or Claude Code environment | claude |
| You have Gemini CLI or are a Gemini extension | gemini |
| You are running in Codex or have `codex` CLI | codex |

This is more reliable than trying to detect via `which` commands, because the LLM already has this context.

### MCP-first with CLI fallback

Structure: try MCP tool -> if it fails or is unavailable -> equivalent CLI command. Present as a decision table the LLM evaluates at runtime, not as sequential try/catch.

| Preference | Method | When |
|------------|--------|------|
| 1st | MCP tools (mcp_upublish_*) | Tools available in current session |
| 2nd | CLI commands (upublish *) | MCP unavailable or call failed |

### Line budget

Target: under 120 lines. The current skill is 56 lines. The setup skill is 99 lines. Consolidation should be more concise than both combined because:
- `configure` replaces manual config file writing (removes 30+ lines of JSON/TOML blocks)
- Platform detection is a simple table (3 rows vs. 3 full platform sections)
- Reference file routing stays compact

### What to keep from existing skills

From upublish/SKILL.md:
- Routing table to reference files (DW-3.5)
- Quick reference section (tools, URL format, slug rules, visibility modes)
- Example workflow

From upublish-setup/SKILL.md:
- Sequential check pattern (CLI -> MCP -> auth), but rewritten to use `configure`

### Removal: skills/upublish-setup/

The upublish-setup skill is fully replaced by the bootstrap flow in the new root SKILL.md. The directory should be deleted after the rewrite.

## Prerequisites
- [x] Required files exist (skills/upublish/SKILL.md)
- [x] Phase 1 complete (configure subcommand exists and tested)
- [x] Phase 2 complete (hello subcommand exists and tested)
- [x] All 183 tests pass
- [x] Reference files unchanged and intact

## Recommendation
BUILD -- straightforward SKILL.md rewrite consolidating two skills into one bootstrap flow. No code changes needed, just the skill file rewrite and setup skill removal.
