# Discovery + Design: Phase 2 - Core + CLI + MCP logout

## Files Found
- `/Users/r/repos/upublish.skill/lib/core.ts` — exists, 211 lines
- `/Users/r/repos/upublish.skill/lib/core.test.ts` — exists, 431 lines, 77 tests passing
- `/Users/r/repos/upublish.skill/lib/auth.ts` — exists, has `readCredentials`, `defaultCredentialsPath`, `saveCredentials`
- `/Users/r/repos/upublish.skill/bin/upublish.ts` — exists, 541 lines, citty-based subcommands
- `/Users/r/repos/upublish.skill/mcp/index.ts` — exists, 265 lines, McpServer with publish/list/delete tools

## Current State
- `core.ts` exports: `list`, `publish`, `deleteOp`, `login`, `status` — no `logout`
- `auth.ts` has `readCredentials` and `saveCredentials` but no `deleteCredentials`
- `bin/upublish.ts` has login, publish, list, delete, status, configure, hello, mcp — no logout
- `mcp/index.ts` registers publish, list, delete tools — no logout tool
- 77 unit tests all pass, no existing logout tests
- No `docs/code-standards.md` found — applying conventions observed in existing code

## Code Standards (derived from codebase)
- TypeScript strict mode, Bun runtime
- Core functions: accept optional `CoreDeps`, return structured results (never throw for expected failures)
- CLI runner pattern: `runXCommand(args, deps)` where deps has optional fn overrides for testability
- MCP tool pattern: `okResponse(text)` / `errResponse(err)`, catch all errors, return ToolResponse
- File deletion: use `fs.unlinkSync` (sync, matches existing `fs.existsSync`/`readFileSync` pattern in auth.ts)
- Test pattern: Bun test runner, `describe`/`it`/`expect`, tmp files in afterEach cleanup

## Test Infrastructure
- Bun test runner, `bun test lib/` for unit tests
- `writeTempCredentials(token)` helper in core.test.ts for creating test cred files
- `mockFetch(status, body)` helper for simple responses
- `afterEach` cleanup pattern with `tmpFiles` array
- Tests import directly from `./core.ts` — no subprocess spawning

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-2.1 | `core.logout()` deletes `~/.upublish/credentials` and calls revoke endpoint | COVERED | `test_DW_2_1_logout_deletes_file_and_calls_revoke` |
| DW-2.2 | `core.logout()` succeeds even when server is unreachable (best-effort revoke) | COVERED | `test_DW_2_2_logout_succeeds_when_server_unreachable` |
| DW-2.3 | `core.logout()` returns `{ loggedOut: true }` on success, `{ loggedOut: false, error }` on failure | COVERED | `test_DW_2_3_logout_returns_logged_out_true`, `test_DW_2_3_logout_returns_logged_out_false_on_delete_error` |
| DW-2.4 | `upublish logout` CLI command prints confirmation and exits 0 | COVERED | `test_DW_2_4_run_logout_command_prints_confirmation` |
| DW-2.5 | MCP `logout` tool calls `core.logout()` and returns text result | COVERED | `test_DW_2_5_mcp_logout_tool_returns_text_result` |
| DW-2.6 | Tests cover core logout (happy path, no credentials file, server unreachable) | COVERED | `test_DW_2_1_logout_deletes_file_and_calls_revoke`, `test_DW_2_7_logout_no_credentials_file`, `test_DW_2_2_logout_succeeds_when_server_unreachable` |
| DW-2.7 | `core.logout()` with no credentials file returns `{ loggedOut: true }` (no-op success) | COVERED | `test_DW_2_7_logout_no_credentials_file` |

**All items COVERED:** YES

## Design Decisions

### LogoutResult type
`{ loggedOut: true } | { loggedOut: false; error: string }` — mirrors StatusResult discriminated union pattern.

### Revoke call approach
`logout()` does NOT use `buildApiClient()` — that helper throws when not authenticated. Instead it reads the refresh token directly (like `status()`) and calls the revoke endpoint with a plain fetch (no token provider needed — revoke takes the refresh token directly in the body). This is simpler and correct.

### File deletion
Use `fs.unlinkSync` wrapped in try/catch. If file does not exist, that is a no-op success. If file cannot be deleted (permissions), return `{ loggedOut: false, error }`.

### Best-effort revoke ordering
1. Read credentials (if no file → return `{ loggedOut: true }` immediately)
2. Call revoke endpoint (fire-and-forget, catch all errors silently)
3. Delete credentials file (if this fails → return `{ loggedOut: false, error }`)
4. Return `{ loggedOut: true }`

This ensures the local file is always deleted even when the server is unreachable. The file deletion is the meaningful local-state operation; revoke is best-effort cleanup.

### CoreDeps extension
No new fields needed. `CoreDeps` already has `credentialsPath` and `fetchFn`, both of which `logout()` needs.

### CLI runner pattern
`runLogoutCommand(args: LogoutArgs, deps: LogoutCommandDeps)` — consistent with other runners. `LogoutArgs = { json: boolean }`. `LogoutCommandDeps = { logoutFn?: () => Promise<LogoutResult> }`.

### MCP tool
No input schema parameters (logout takes no arguments). Returns success text or error text.

## Prerequisites
- [x] `lib/auth.ts` exports `readCredentials` and `defaultCredentialsPath` (needed by logout)
- [x] `lib/core.ts` already imports both
- [x] Backend revoke endpoint exists (`POST /auth/token/revoke`) — completed in Phase 1
- [x] `CoreDeps` already has all needed fields
- [x] Test infrastructure (helpers, cleanup pattern) established in core.test.ts

## Recommendation
BUILD — all prerequisites met, no gaps, clear implementation path.
