# Discovery + Design: Phase 2 - CLI hello subcommand

## Files Found
- bin/upublish.ts -- CLI entry point with 8 subcommands (login, status, publish, list, delete, generate, configure, mcp)
- tests/cli.test.ts -- 32 existing tests, including configure tests from phase 1
- lib/core.ts -- has `status()` returning `StatusResult` (authenticated/username or unauthenticated)

## Current State
Phase 1 complete. `configure` subcommand exists and follows the pattern:
1. `ConfigureArgs` + `ConfigureCommandDeps` interfaces
2. Exported `runConfigureCommand(args, deps)` function
3. citty `defineCommand` wires to runner
4. Registered in main `subCommands`

The `status` subcommand already demonstrates the auth-check pattern: it calls `coreStatus()` and branches on `result.authenticated`. The `hello` command will reuse this exact pattern with different output.

All 179 tests pass across 11 files.

## Gaps
- No `hello` subcommand exists yet
- No "coming soon" messaging pattern exists (all current commands do real work)
- Otherwise trivial -- follows established pattern exactly

## Code Standards
No code-standards.md found. Conventions from codebase:
- TypeScript with Bun runtime, citty CLI framework
- bun:test with describe/test/expect/mock/spyOn
- Deps injection for testability
- ANSI helpers (green, red, bold) for CLI output
- Each subcommand: Args interface + Deps interface + run*Command function + citty defineCommand

## Test Infrastructure
- Framework: bun:test
- Pattern: spyOn console.log and process.exit, call run*Command with mock deps, assert on captured output
- Shared beforeEach/afterEach for log/exit spies at file level in tests/cli.test.ts

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-2.1 | `upublish hello` checks auth and prints welcome message with username | COVERED | test_DW_2_1_hello_authenticated_prints_welcome_with_username |
| DW-2.2 | If not authenticated, directs user to `upublish login` | COVERED | test_DW_2_2_hello_unauthenticated_directs_to_login |
| DW-2.3 | `runHelloCommand` exported and testable with injected deps | COVERED | test_DW_2_3_hello_exported_with_injectable_deps |
| DW-2.4 | Tests pass for authenticated and unauthenticated paths | COVERED | All DW-2.1 through DW-2.3 tests passing together |

**All items COVERED:** YES

## Design Decisions

Trivial addition -- single approach, follows existing `status` subcommand pattern exactly.

### Interface

```typescript
interface HelloArgs {}  // no args needed

interface HelloCommandDeps {
  statusFn?: () => Promise<StatusResult>;
}
```

The `statusFn` dep mirrors how `runStatusCommand` injects `coreStatus`. The `hello` command calls `statusFn()`, branches on authenticated/unauthenticated, prints appropriate message. No args needed (no --json flag since this is an interactive greeting).

### Output design

Authenticated: welcome message with username + "MBTI flow coming soon" teaser.
Unauthenticated: directs user to run `upublish login`. Exits with code 1 to match status command convention.

## Prerequisites
- [x] Required files exist (bin/upublish.ts, tests/cli.test.ts, lib/core.ts)
- [x] Dependencies available (citty, bun:test)
- [x] Phase 1 complete, all 179 tests pass

## Recommendation
BUILD -- trivial addition following established patterns. No blockers.
