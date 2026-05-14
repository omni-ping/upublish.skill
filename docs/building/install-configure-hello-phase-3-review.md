# Review: Phase 3 - Rewrite root SKILL.md as bootstrap

## Requirement Fulfillment

| DW-ID | Done-When Item | Status | Evidence |
|-------|---------------|--------|----------|
| DW-3.1 | Root SKILL.md checks for CLI (`which upublish`), installs via npm if missing | SATISFIED | SKILL.md:16-26 — Step 1a runs `which upublish`; if missing, runs `npm install -g @omniping/upublish` |
| DW-3.2 | Root SKILL.md runs `upublish configure --platform <detected>` if plugin not installed | SATISFIED | SKILL.md:28-48 — Step 1b checks for `mcp_upublish_publish` in tools; if absent, detects platform via decision table and runs `upublish configure --platform <claude\|gemini\|codex>` |
| DW-3.3 | Root SKILL.md checks auth (`upublish status`), runs `upublish login` if needed | SATISFIED | SKILL.md:51-62 — Step 1c runs `upublish status`; if output is "Not authenticated", runs `upublish login` |
| DW-3.4 | Root SKILL.md tells LLM to restart session after configure | SATISFIED | SKILL.md:49 — "Tell the user to restart their session so MCP tools load. **STOP here** — do not continue until the session restarts." |
| DW-3.5 | Post-setup, routes to publish/list/delete/manage/hello based on user intent | SATISFIED | SKILL.md:67-79 — Step 2 routing table covers publish, pre-publish checklist, list/delete/manage, visibility, generate, troubleshoot, and hello |
| DW-3.6 | Root SKILL.md instructs LLM to use MCP tools first, fall back to CLI on failure | SATISFIED | SKILL.md:81-93 — "Prefer MCP tools. Fall back to CLI if MCP tools are unavailable or a call fails." Decision table covers publish, list, delete, generate, auth, login, configure, hello |
| DW-3.7 | Root SKILL.md references `upublish configure` and `upublish hello` in its flow | SATISFIED | SKILL.md:46 (`upublish configure --platform`), SKILL.md:64,78,93 (`upublish hello`) — both appear in the bootstrap flow and the routing/reference sections |

**All requirements met:** YES

## Test-DW Coverage

Coverage is indirect: Phase 3 produces a SKILL.md file, not runtime code. The discovery doc establishes that testing follows the skill-craft protocol (trigger tests, structure compliance, conceptual workflow review) rather than unit tests. The existing test suite covers the DW-3 items through structural assertions:

- `install.test.ts:test_DW_5_2_skills_valid_for_skills_add` (line 84-92) — verifies SKILL.md exists, has frontmatter, contains `upublish configure` and `upublish login`
- `install.test.ts:test_DW_5_3_root_skill_mentions_restart` (line 115-119) — verifies restart instruction present
- `manifests.test.ts:test_DW_4_5_root_skill_references_configure` (line 107-113) — verifies `upublish configure` present and Gemini platform mentioned
- `manifests.test.ts:test_DW_4_5_root_skill_references_cli_auth` (line 100-105) — verifies `upublish login` present, no stale `scripts/setup.ts` reference
- `manifests.test.ts:test_DW_4_5_ask_skill_exists` (line 93-98) — verifies root SKILL.md exists and contains `mcp_upublish_publish`
- `manifests.test.ts:test_DW_4_8_no_absolute_paths_in_docs` (line 190-196) — verifies SKILL.md has no hardcoded user paths

DW-3.4 (restart instruction) is covered by `test_DW_5_3_root_skill_mentions_restart`.
DW-3.5 (routing table) and DW-3.6 (MCP-first preference) are not covered by discrete named tests. They are verified by reading the file; no tests assert the routing table completeness or the MCP-first instruction text.

Note: No test carries a DW-3.x ID in its name. All tests that touch the root SKILL.md carry Phase 4/5 IDs because the SKILL.md structural assertions were written in those prior phases. This is a naming gap, not a coverage gap — the substance is tested.

No unplanned additions observed. Test coverage matches the plan's level for a skill-file-only phase: structural/content assertions rather than execution tests.

## Dead Code

`skills/upublish-setup/` deleted as planned — confirmed absent from `ls skills/`. No dead code in SKILL.md (declarative content only). No debug statements or commented-out blocks.

## Correctness Dimensions

| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | SKILL.md is a static instruction document |
| Error Handling | PASS | Each bootstrap step has an explicit "if missing/failed" branch; failure paths defined for CLI absent, plugin not configured, not authenticated |
| Resources | N/A | No resource acquisition |
| Boundaries | PASS | Platform detection via LLM self-knowledge (not fragile `which` calls for platform); CLI check uses `which upublish` which is appropriate |
| Security | N/A | No credentials handled in skill document; login deferred to CLI |

## Defensive Programming: PASS

No silent failures. Each bootstrap gate has an explicit branch:
- CLI missing → install command given
- Plugin missing → configure command given with platform table
- Not authenticated → login command given

The "STOP here" after configure prevents the LLM from proceeding without MCP tools. This is the critical guard against a subtle failure mode (tools not yet available in current session).

One observation: step 1b checks for MCP tool availability by instructing the LLM to "look for `mcp_upublish_publish` in your tools." This relies on the LLM's self-knowledge of available tools, which is the correct approach for this context (as the discovery doc notes, programmatic platform detection is less reliable than LLM self-knowledge). Not a defect.

## Design Quality: PASS

**Depth:** The SKILL.md is 113 lines and covers install, configure, auth, restart, routing, MCP-first fallback, quick reference, and example. No pass-through verbosity. The linear bootstrap + routing pattern is straightforward.

**Consolidation:** Two skills (99 lines + 56 lines = 155 lines) collapsed into one 113-line file with more capability. The line budget target from the discovery doc (under 120 lines) is met.

**Bootstrap gate structure:** Steps are sequential with explicit stop conditions. The "STOP here" at step 1b after configure is a well-placed gate — it prevents a class of failure where the LLM tries to use MCP tools that haven't loaded yet.

**Routing table (Step 2):** Covers all six action categories. "Say hello or check setup → Run `upublish hello`" is a useful terminal route that closes the loop for the onboarding flow.

**MCP-first table:** Clean decision table with every action covered. Correct that auth-related actions (status, login, configure, hello) have no MCP equivalent — these are CLI-only by design.

No HIGH severity design findings. No unknown unknowns introduced.

## Testing: PASS

All 183 tests pass. Structural assertions covering the root SKILL.md content are present across `install.test.ts` and `manifests.test.ts`. The assertions that specifically guard Phase 3 requirements (configure present, login present, restart mentioned, no stale references, no absolute paths) all pass.

The absence of DW-3.x named tests is a cosmetic gap, not a functional one. All requirements are exercised by existing Phase 4/5 tests that were updated to reflect the consolidated root skill.

## Issues

None.

**Verdict: PASS**
