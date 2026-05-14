# Review: Phase 1 - CLI `configure` subcommand

## Requirement Fulfillment

| DW-ID | Done-When Item | Status | Evidence |
|-------|---------------|--------|----------|
| DW-1.1 | `upublish configure --platform claude` runs `claude plugin install omni-ping/upublish.skill` | SATISFIED | `bin/upublish.ts:381` — `PLATFORM_COMMANDS.claude = { command: "claude", args: ["plugin", "install", "omni-ping/upublish.skill"] }`; `runConfigureCommand` calls `execFn(platformEntry.command, platformEntry.args)` at line 419 |
| DW-1.2 | `upublish configure --platform gemini` runs appropriate gemini extension install | SATISFIED | `bin/upublish.ts:382` — `PLATFORM_COMMANDS.gemini = { command: "gemini", args: ["extensions", "install", "omni-ping/upublish.skill"] }` |
| DW-1.3 | `upublish configure --platform codex` runs appropriate codex plugin install | SATISFIED | `bin/upublish.ts:383` — `PLATFORM_COMMANDS.codex = { command: "npx", args: ["skills", "add", "omni-ping/upublish.skill", "-g", "--agent", "codex"] }` |
| DW-1.4 | `runConfigureCommand` exported and testable with injected deps (child process calls mockable) | SATISFIED | `bin/upublish.ts:403` — `export async function runConfigureCommand(args: ConfigureArgs, deps: ConfigureCommandDeps = {})`, `execFn` defaults to `defaultExecFn`, tests inject mock at `tests/cli.test.ts:475` |
| DW-1.5 | Invalid platform flag prints error with valid options | SATISFIED | `bin/upublish.ts:410-414` — checks `!platformEntry`, logs `Unknown platform: "${args.platform}"` and `Valid platforms: ${VALID_PLATFORMS.join(", ")}`, calls `process.exit(1)` |
| DW-1.6 | Tests pass for all three platform paths + invalid platform error case | SATISFIED | `bun test` output: 32 pass, 0 fail; tests `test_DW_1_1` through `test_DW_1_5` present and passing in `tests/cli.test.ts:474-578` |

**All requirements met:** YES

## Test-DW Coverage

- [x] All DW items have corresponding tests
- [x] Test names reference DW-IDs (`test_DW_1_1_configure_claude_runs_plugin_install`, etc.)
- [x] No unplanned additions (7 configure tests: DW-1.1, DW-1.2, DW-1.3, DW-1.4, DW-1.5, and two for DW-1.6 — success message + nonzero-exit error path)
- [x] Test coverage matches plan level (plan requires 100%; all configure paths covered)

DW-1.6 gets two tests — `test_DW_1_6_configure_prints_success_message` and `test_DW_1_6_configure_nonzero_exit_reports_error`. The second covers the exit-code failure path of `runConfigureCommand`, which is good additional coverage beyond the minimal DW statement. No deviation from design.

## Dead Code

None found. `defaultExecFn` (line 392) is the real production path when no dep is injected — it is not dead. `VALID_PLATFORMS` (line 386) is used in the error message at line 413. All imports are used.

## Correctness Dimensions

| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | No shared mutable state; each command invocation is independent |
| Error Handling | PASS | Invalid platform exits with message and code 1 (line 410-414); nonzero child-process exit code detected and reported (line 421-425); error messages include the failing platform name and the manual fallback command |
| Resources | PASS | `defaultExecFn` uses `Bun.spawn` and awaits `proc.exited` — Bun manages process lifecycle; no file handles or connections opened by configure |
| Boundaries | PASS | Platform string is validated against the `PLATFORM_COMMANDS` map before use; empty string would produce the same "unknown platform" error path; no numeric or collection boundaries apply |
| Security | PASS | `PLATFORM_COMMANDS` is a static constant map — user-supplied platform string is used only as a lookup key, never interpolated into a shell command string. `execFn` receives `command` and `args` as separate array arguments to `Bun.spawn`, avoiding shell injection entirely (line 394: `Bun.spawn([command, ...args], ...)`) |

## Defensive Programming: PASS

Crisis triage:
1. External input validated at boundaries — platform string looked up in `PLATFORM_COMMANDS`; miss → error + exit(1). PASS.
2. Return values checked — `execFn` return value's `exitCode` is checked explicitly at line 421. PASS.
3. Error paths tested — `test_DW_1_5` covers invalid platform; `test_DW_1_6_configure_nonzero_exit_reports_error` covers failed child process. PASS.
4. Assertions on invariants — no assertions used; not needed for this straightforward dispatch logic.
5. Resources released on all paths — no resources to release; Bun subprocess is fire-and-await. PASS.

## Design Quality

No significant findings. Observations:

- `PLATFORM_COMMANDS` as a `Record<string, { command, args }>` is the right shape — declarative, easy to extend with a fourth platform.
- `VALID_PLATFORMS = Object.keys(PLATFORM_COMMANDS)` is derived automatically so the error message stays in sync with the map. Good.
- `defaultExecFn` is unexported (private to the module) — appropriate since it is an implementation detail; tests never need it directly.
- `configureCmd` citty definition correctly marks `platform` as `required: true`, matching the runtime validation that would catch missing flags before reaching `runConfigureCommand`.
- Minor: the `configure` subcommand is registered in the main command's `subCommands` at line 556 but there is no `hello` key yet (Phase 2). Correct scope boundary observed.

No unknown unknowns, no pass-through methods, no layer without added value.

## Testing: PASS

7 tests for configure; 25 pre-existing tests for other subcommands (32 total, all passing).

Configure dirty:clean ratio — happy paths: DW-1.1, DW-1.2, DW-1.3 (3 clean). Error/edge paths: DW-1.5 (invalid platform), DW-1.6-nonzero-exit (failed install), DW-1.4 (structural/injection proof), DW-1.6-success (success message assertion) — 4 tests that are error or edge-covering. Ratio approximately 4:3, which is acceptable for a command with exactly one decision point (platform map lookup) and one error propagation point (exit code check). The two key error paths are both tested.

No gaps: all three platform values are tested individually with exact arg verification using `toEqual`, not just contains-checks. Invalid platform asserts that `execFn` was not called, proving the guard fires before spawning.

## Issues

None.

**Verdict: PASS**
