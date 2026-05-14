# Discovery + Design: Phase 1 - CLI configure subcommand

## Files Found
- bin/upublish.ts — CLI entry point with 7 existing subcommands (login, status, publish, list, delete, generate, mcp)
- tests/cli.test.ts — 25 existing tests covering all subcommands via injectable deps pattern
- package.json — version 0.3.0, citty dependency present
- README.md — documents install commands for claude, gemini, codex

## Current State
The CLI follows a consistent pattern:
1. Interface for args (e.g. `LoginArgs`) and deps (e.g. `LoginCommandDeps`)
2. Exported `run*Command(args, deps)` function that uses deps with defaults
3. citty `defineCommand` wires args to the runner
4. Subcommands registered in main command's `subCommands` object

All 172 existing tests pass. No `configure` subcommand exists yet.

## Gaps
- No `configure` subcommand — must be created from scratch
- No child process execution pattern exists in the codebase (all existing commands call core functions). `configure` needs to run shell commands, which is a new dep type.
- The README shows `claude plugin install omni-ping/upublish.claude` (the `.claude` repo), but the plan says `omni-ping/upublish.skill`. Using the plan's value since `configure` is about installing this skill package.

## Code Standards
No code-standards.md found. Conventions derived from codebase:
- TypeScript with Bun runtime
- citty for CLI framework
- bun:test for testing (describe/test/expect/mock/spyOn)
- Deps injection pattern for testability
- ANSI helpers (green, red, bold) for CLI output
- Each subcommand: Args interface + Deps interface + run*Command function + citty defineCommand

## Test Infrastructure
- Framework: bun:test
- Pattern: spyOn console.log and process.exit, call run*Command with mock deps, assert on captured output
- Shared beforeEach/afterEach for log/exit spies in tests/cli.test.ts
- All tests in a single file for CLI adapter tests

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-1.1 | `upublish configure --platform claude` runs `claude plugin install omni-ping/upublish.skill` | COVERED | test_DW_1_1_configure_claude_runs_plugin_install |
| DW-1.2 | `upublish configure --platform gemini` runs appropriate gemini extension install | COVERED | test_DW_1_2_configure_gemini_runs_extension_install |
| DW-1.3 | `upublish configure --platform codex` runs appropriate codex plugin install | COVERED | test_DW_1_3_configure_codex_runs_skills_add |
| DW-1.4 | `runConfigureCommand` exported and testable with injected deps | COVERED | test_DW_1_4_configure_exported_with_injectable_deps |
| DW-1.5 | Invalid platform flag prints error with valid options | COVERED | test_DW_1_5_configure_invalid_platform_prints_error |
| DW-1.6 | Tests pass for all three platform paths + invalid platform error case | COVERED | All DW-1.1 through DW-1.5 tests passing together |

**All items COVERED:** YES

## Design Decisions

### How to run the platform install command

**Option A: Bun.spawn with injected execFn dep**
- Inject an `execFn` dep that wraps `Bun.spawn` (uses `spawnSync`/`spawn` with array args — no shell injection risk)
- Simple interface: `execFn(command: string, args: string[]) => Promise<{ exitCode: number }>`
- Tests mock `execFn` to verify the correct command+args without actually running anything
- Matches the existing deps injection pattern exactly
- Uses array-based args (not string concatenation) so there is no shell interpretation

**Option B: Platform strategy objects**
- Each platform is an object with `{ name, command, args }` and a generic executor
- More structured but over-engineered for 3 static entries

**Option C: Core function in lib/core.ts**
- Move the logic to core like other commands
- But `configure` doesn't need auth/API — it just runs a shell command. Doesn't fit the core pattern.

**Chosen: Option A** — simplest, matches existing CLI dep injection pattern. The command stays in bin/upublish.ts alongside other subcommands. A platform map (Record of platform to command+args) keeps the data declarative. The `execFn` dep makes it fully testable. Uses Bun.spawn with array args for safe process execution.

### Interface design

```typescript
interface ConfigureArgs {
  platform: string;
}

interface ConfigureCommandDeps {
  execFn?: (command: string, args: string[]) => Promise<{ exitCode: number }>;
}
```

The `execFn` default will use `Bun.spawn` with `stdio: "inherit"` so the platform installer's output streams to the terminal. Tests mock `execFn` and verify the command+args passed.

Following existing pattern: use console.log directly (tests already spy on it). Only inject `execFn` to keep deps bag minimal and consistent.

### Platform command map

```
claude -> command: "claude", args: ["plugin", "install", "omni-ping/upublish.skill"]
gemini -> command: "gemini", args: ["extensions", "install", "omni-ping/upublish.skill"]  
codex  -> command: "npx", args: ["skills", "add", "omni-ping/upublish.skill", "-g", "--agent", "codex"]
```

## Prerequisites
- [x] Required files exist (bin/upublish.ts, tests/cli.test.ts)
- [x] Dependencies available (citty, bun:test)
- [x] All existing tests pass (172/172)

## Recommendation
BUILD — straightforward addition following established patterns. No blockers.
