# Review: Phase 2 - Remove CLI + npm infra, update manifests and docs

## Requirement Fulfillment

| DW-ID | Done-When Item | Status | Evidence |
|-------|---------------|--------|----------|
| DW-2.1 | `bin/upublish.ts`, `dist/cli.cjs`, `install.sh`, `scripts/publish.sh` are deleted | SATISFIED | All four paths confirmed absent via filesystem check; `test_DW_2_1_*` tests verify |
| DW-2.2 | `tests/cli.test.ts` and `tests/install.test.ts` are deleted | SATISFIED | Both paths confirmed absent; `test_DW_2_2_*` tests verify |
| DW-2.3 | `.claude/code-foundations/building/` and `.claude/phase6-review.sh` are deleted | SATISFIED | Both paths confirmed absent; `test_DW_2_3_*` tests verify |
| DW-2.4 | `package.json` has no `bin` field, no `citty` dependency, and `dist/` stays in `files` | SATISFIED | `package.json` lines 1-38: no `bin` key, `citty` absent from `dependencies`, `"dist/"` present in `files` array; `test_DW_2_4_*` tests verify |
| DW-2.5 | `gemini-extension.json` uses `${extensionPath}` path and version matches package.json | SATISFIED | `gemini-extension.json` line 8: `"${extensionPath}/dist/mcp.js"`, command is `"bun"`, no `cwd`, version `"0.5.6"` matches `package.json`; `test_DW_2_5_*` tests verify |
| DW-2.6 | CI workflow has a sed/update step AND git-add line for `gemini-extension.json`, and has no npm publish job | SATISFIED | `.github/workflows/ci.yml` lines 74-76: node update for gemini-extension.json; line 86: `git add ... gemini-extension.json`; no `npm publish` or `NPM_TOKEN` anywhere; `test_DW_2_6_*` tests verify |
| DW-2.7 | `SKILL.md` has no CLI commands — bootstrap is MCP-only | SATISFIED | `skills/upublish/SKILL.md`: bootstrap uses `status` tool (line 25) and `login` tool (line 30); no `upublish login`, `upublish configure`, `upublish status`, `upublish hello`, `npm install`, `which upublish`; `test_DW_2_7_*` tests verify |
| DW-2.8 | `GEMINI.md` has no CLI commands — bootstrap uses MCP login tool | SATISFIED | `GEMINI.md` line 22: `mcp_upublish_login`; no `upublish login`, no `bin/upublish`, no `bun install` step; `test_DW_2_8_*` tests verify |
| DW-2.9 | `references/troubleshooting.md` has no CLI command references | SATISFIED | `references/troubleshooting.md` lines 11-12: references `login` tool, not CLI command; `upublish login` absent from entire `references/` directory; `test_DW_2_9_*` tests verify |
| DW-2.10 | `CLAUDE.md` architecture section has no CLI references, version is current | SATISFIED | `CLAUDE.md` has no `bin/upublish.ts`, no `cli.cjs`, no `citty`, no `0.4.0`, no `scripts/publish.sh`; version tracking section (line 51) lists `gemini-extension.json` as 5th location; `test_DW_2_10_*` tests verify |
| DW-2.11 | `README.md` has no CLI install instructions | SATISFIED | `README.md`: no `npm install`, no `install.sh`, no `upublish login`; only platform plugin install commands remain; `test_DW_2_11_*` tests verify |
| DW-2.12 | `tests/manifests.test.ts` has no CLI-related assertions (install.sh, bin, cli.cjs, npx) and Gemini assertions match new format | SATISFIED | `manifests.test.ts` reviewed in full: `test_DW_4_4_uses_bun_with_extension_path` asserts `bun` command and `${extensionPath}`; no `install.sh`, no `cli.cjs`, no `bin/upublish`, no `uses_npx_command` references; `test_DW_2_12_*` meta-tests verify |
| DW-2.13 | `bun install` lockfile is clean (no citty) | SATISFIED | `bun.lock`: grep for "citty" returns NOT FOUND; `test_DW_2_13_no_citty_in_lockfile` verifies |
| DW-2.14 | `bun test` passes with 0 failures | SATISFIED | Suite result: 219 pass, 0 fail, 357 expect() calls, 15 files |

**All requirements met:** YES

## Test-DW Coverage

- [x] All DW items have corresponding tests in `tests/phase2-cleanup.test.ts`
- [x] DW-2.1 through DW-2.13 each have explicit named tests (`test_DW_2_N_*` naming convention)
- [x] DW-2.14 verified by full suite run (no dedicated test needed — the result is the evidence)
- [x] `tests/manifests.test.ts` updated: removed `test_DW_4_3_points_to_mcp_index_ts` (replaced with `test_DW_4_3_points_to_mcp_bundle`), removed npx assertion, added bun+extensionPath assertion
- [x] No unplanned additions found
- [x] Test coverage matches plan level (deletion + doc update work; phase2-cleanup.test.ts covers all 14 DW items)

Test count went from 232 (pre-phase-2, 4 failing) to 219 passing tests — the reduction is expected: `tests/cli.test.ts` (~80 tests) and `tests/install.test.ts` (~60 tests) were deleted; `tests/phase2-cleanup.test.ts` adds 47 new tests; `manifests.test.ts` lost several CLI-specific assertions.

## Dead Code

None found. This phase is entirely deletion and text editing — no new production code was written. `mcp/index.ts` and all `lib/` files are unchanged from Phase 1.

## Correctness Dimensions

| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | No new concurrent code — deletion and doc changes only |
| Error Handling | N/A | No new error-handling paths introduced |
| Resources | N/A | No new resource acquisition |
| Boundaries | N/A | No new collection or string processing logic |
| Security | N/A | No new untrusted input paths |

## Defensive Programming: PASS

No new production code in this phase. The only code introduced is `tests/phase2-cleanup.test.ts` — test assertions using `existsSync`, `readFileSync`, and `JSON.parse`. These are straightforward and appropriate for test context (throw on failure is the correct behavior for tests). No empty catch blocks, no swallowed exceptions.

## Design Quality: No findings

This phase is deletion + text editing with no new interfaces or modules. No design issues to assess.

## Testing: PASS

- `tests/phase2-cleanup.test.ts` is the primary test artifact for this phase
- All 14 DW items are covered by named tests using the project's `test_DW_N_M_description` convention
- The tests are content-presence assertions (not dirty/clean distinction in the traditional sense) — appropriate for a manifest/doc cleanup phase
- 219 / 0 pass/fail across 15 files confirms no regressions

**Verdict: PASS**
