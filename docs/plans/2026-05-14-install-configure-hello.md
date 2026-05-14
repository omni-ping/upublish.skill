# Plan: upublish configure + hello + bootstrap skill

**Created:** 2026-05-14
**Status:** in-progress
**Started:** 2026-05-14
**Current Phase:** 1
**Complexity:** simple

---

## Context

The `/upublish` skill needs to be a single entry point that handles the full lifecycle: auth, CLI install, platform plugin installation, and onboarding. The CLI is the product — auth, publish, list, delete, configure, hello. MCP is a thin wrapper that calls the same core functions without a shell hop. Skills/plugins teach the LLM how to use either interface.

`configure` installs the platform's native plugin (e.g. `claude plugin install omni-ping/upublish.skill`) — no manual config file writing. The platform manages MCP config, skills, and updates from there.

## Constraints

- Follow existing CLI patterns: citty subcommands, exported `run*Command` functions, injectable deps
- `configure` runs the platform's native plugin install command (claude/gemini/codex)
- `configure` does not require authentication
- `hello` is a stub for now — prints welcome + tells user MBTI flow coming soon
- Root SKILL.md becomes the bootstrap: CLI install -> configure -> auth -> reload -> go
- Skills should instruct LLM to try MCP tools first, fall back to CLI if MCP fails
- No changes to existing subcommands (publish, list, delete, generate, mcp, login, status)
- Tests written and passing before moving to next phase

---

## Implementation Phases

### Phase 1: CLI `configure` subcommand
**Skills:** `code-foundations:building`

**Goal:** Add `upublish configure --platform <claude|gemini|codex>` that runs the platform's native plugin install command.

**Scope:**
- IN: `configure` subcommand in bin/upublish.ts, runs platform-specific plugin install command via child process
- OUT: auto-detection of platform (explicit flag for now), version checking, auth check, manual config file writing

**Done when:**
- [ ] DW-1.1: `upublish configure --platform claude` runs `claude plugin install omni-ping/upublish.skill`
- [ ] DW-1.2: `upublish configure --platform gemini` runs appropriate gemini extension install
- [ ] DW-1.3: `upublish configure --platform codex` runs appropriate codex plugin install
- [ ] DW-1.4: `runConfigureCommand` exported and testable with injected deps (child process calls mockable)
- [ ] DW-1.5: Invalid platform flag prints error with valid options
- [ ] DW-1.6: Tests pass for all three platform paths + invalid platform error case

### Phase 2: CLI `hello` subcommand
**Skills:** `code-foundations:building`

**Goal:** Add `upublish hello` as an onboarding entry point that confirms setup is working.

**Scope:**
- IN: `hello` subcommand, checks auth status, prints welcome with username
- OUT: MBTI quiz content (future work)

**Done when:**
- [ ] DW-2.1: `upublish hello` checks auth and prints welcome message with username
- [ ] DW-2.2: If not authenticated, directs user to `upublish login`
- [ ] DW-2.3: `runHelloCommand` exported and testable with injected deps
- [ ] DW-2.4: Tests pass for authenticated and unauthenticated paths

### Phase 3: Rewrite root SKILL.md as bootstrap
**Skills:** `oberskills:skill-craft`

**Goal:** Single `/upublish` skill that handles the full flow: install CLI -> configure -> auth -> reload -> route to action. Instructs LLM to try MCP tools first, fall back to CLI commands if MCP fails.

**Scope:**
- IN: Root SKILL.md rewrite, integrate `configure` and `hello` into the flow, MCP-first with CLI fallback
- OUT: Changes to references/ content, `skills/upublish-setup/` removed (consolidated into root skill)

**Done when:**
- [ ] DW-3.1: Root SKILL.md checks for CLI (`which upublish`), installs via npm if missing
- [ ] DW-3.2: Root SKILL.md runs `upublish configure --platform <detected>` if plugin not installed
- [ ] DW-3.3: Root SKILL.md checks auth (`upublish status`), runs `upublish login` if needed
- [ ] DW-3.4: Root SKILL.md tells LLM to restart session after configure
- [ ] DW-3.5: Post-setup, routes to publish/list/delete/manage/hello based on user intent
- [ ] DW-3.6: Root SKILL.md instructs LLM to use MCP tools first, fall back to CLI on failure
- [ ] DW-3.7: Root SKILL.md references `upublish configure` and `upublish hello` in its flow

---

## Test Coverage

**Level:** 100%

## Test Plan

- [ ] [Phase 1] `runConfigureCommand` with each platform flag invokes correct install command
- [ ] [Phase 1] `runConfigureCommand` with invalid platform errors gracefully
- [ ] [Phase 2] `runHelloCommand` with valid auth prints welcome
- [ ] [Phase 2] `runHelloCommand` without auth directs to login
- [ ] [Phase 1+2] Existing tests still pass (no regressions)

---

## Execution Log

_To be filled during /code-foundations:building_
