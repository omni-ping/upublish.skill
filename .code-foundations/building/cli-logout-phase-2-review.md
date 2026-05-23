# Review: Phase 2 - Core + CLI + MCP logout

## Requirement Fulfillment

| DW-ID | Done-When Item | Status | Evidence |
|-------|----------------|--------|----------|
| DW-2.1 | `core.logout()` deletes `~/.upublish/credentials` and calls revoke endpoint | SATISFIED | lib/core.ts:229-267 implements logout() that reads token, calls `/auth/token/revoke`, deletes file with fs.unlinkSync(); test_DW_2_1_logout_deletes_file_and_calls_revoke verifies both operations |
| DW-2.2 | `core.logout()` succeeds even when server is unreachable (best-effort revoke) | SATISFIED | lib/core.ts:245-257 catches all revoke errors silently, continues to file deletion; test_DW_2_2_logout_succeeds_when_server_unreachable throws network error, expects { loggedOut: true }, file deleted |
| DW-2.3 | `core.logout()` returns `{ loggedOut: true }` on success, `{ loggedOut: false, error }` on failure | SATISFIED | lib/core.ts:87-89 exports LogoutResult discriminated union; lines 238, 242, 263, 266 return proper variants; tests verify both success and error shapes |
| DW-2.4 | `upublish logout` CLI command prints confirmation and exits 0 | SATISFIED | bin/upublish.ts:432-454 runLogoutCommand prints "Logged out." on success (line 443), returns normally (exit 0); test_DW_2_4_logout_command_exits_0_on_success expects exitCode undefined |
| DW-2.5 | MCP `logout` tool calls `core.logout()` and returns text result | SATISFIED | mcp/index.ts:243-263 registers logout tool, calls logout(coreDeps), returns okResponse() on success or ToolResponse with isError:true on failure; test_DW_2_5_mcp_logout_tool_returns_text_result verifies tool returns ToolResponse with text |
| DW-2.6 | Tests cover core logout (happy path, no credentials file, server unreachable) | SATISFIED | lib/core.test.ts has test_DW_2_1_logout_deletes_file_and_calls_revoke (happy path), test_DW_2_7_logout_no_credentials_file (no creds), test_DW_2_2_logout_succeeds_when_server_unreachable (unreachable server) |
| DW-2.7 | `core.logout()` with no credentials file returns `{ loggedOut: true }` (no-op success) | SATISFIED | lib/core.ts:241-243 returns { loggedOut: true } when refreshToken is null; test_DW_2_7_logout_no_credentials_file verifies no-op success case, confirms revoke is NOT called |

**All requirements met:** YES

## Test-DW Coverage

- [x] DW-2.1 covered by test_DW_2_1_logout_deletes_file_and_calls_revoke (core)
- [x] DW-2.2 covered by test_DW_2_2_logout_succeeds_when_server_unreachable (core)
- [x] DW-2.3 covered by test_DW_2_3_logout_returns_logged_out_true and test_DW_2_3_logout_returns_logged_out_false_on_delete_error (core)
- [x] DW-2.4 covered by test_DW_2_4_logout_command_prints_confirmation, test_DW_2_4_logout_command_exits_0_on_success, test_DW_2_4_logout_json_flag_outputs_json, test_DW_2_4_logout_failure_exits_1 (CLI)
- [x] DW-2.5 covered by test_DW_2_5_mcp_logout_tool_returns_text_result and test_DW_2_5_mcp_logout_tool_succeeds_when_already_logged_out (MCP)
- [x] DW-2.6 covered by core logout tests (happy path, no-op, unreachable server all present)
- [x] DW-2.7 covered by test_DW_2_7_logout_no_credentials_file (core)
- [x] No unplanned additions — all implementation directly addresses DW items
- [x] Test coverage matches plan level (100% — all paths covered)
- [x] CLI logout tests verify --json flag behavior (test_DW_2_4_logout_json_flag_outputs_json)

**Coverage verdict:** PASS

## Dead Code

No dead code found:
- No unreachable code after early returns (all control flow terminates cleanly)
- No unused imports (all imports from lib/core.ts are used)
- No console.log debug statements in lib/core.ts (only appropriate logging in bin/upublish.ts)
- No commented-out code blocks
- No empty catch blocks

## Correctness Dimensions

| Dimension | Status | Evidence |
|-----------|--------|----------|
| **Concurrency** | PASS | logout() is async and await-aware; no shared mutable state; each call reads credentials fresh from disk (no module-level cache); fetchFn injection supports test isolation |
| **Error Handling** | PASS | Defensive pattern: logout() never throws for expected failures (no credentials, file unreadable, revoke fails); returns { loggedOut: false, error } discriminant when file deletion fails; silently ignores revoke errors (best-effort). All error paths tested. |
| **Resources** | PASS | File handle cleanup: fs.unlinkSync is synchronous, no dangling handles; fetch aborts handled by fetchFn (test mocks); temp files in tests cleaned up in afterEach blocks; no resource leaks detected |
| **Boundaries** | PASS | Input validation: logout() accepts optional CoreDeps with credentialsPath and fetchFn, both type-checked; returns discriminated union LogoutResult (never null/undefined); credentials path validated by readCredentials() and fs operations; no silent failures on invalid paths |
| **Security** | PASS | Token handling: refresh token never logged or exposed; best-effort revoke prevents stranded tokens when offline; credentials file deleted even on server failure; no credentials in error messages; fs.unlinkSync respects file permissions (errors caught and returned) |

**All dimensions:** PASS

## Defensive Programming: PASS

Crisis triage results:
- Empty catch blocks: None (revoke catch is intentional best-effort pattern, logged as "Silently ignore network errors")
- Swallowed exceptions: None (revoke error catch is justified; all other errors propagate to result.error discriminant)
- Unvalidated external input: None (logout takes no args; CoreDeps injected, not user input)
- Broad exception types: Catch-all in revoke is intentional (network errors can be numerous); all file operations catch Error specifically
- Silent failures: None (revoke is documented as best-effort; file deletion failure returns error discriminant)
- Garbage-in patterns: None (fresh credential read on each call; fs operations validate file existence)

**Verdict:** No defensive violations. Best-effort revoke is intentional and documented.

## Design Quality: PASS

Findings:
- **Depth > Length**: logout() is 38 lines with clear purpose (revoke + delete). Core function depth is appropriate — no deeply nested logic, control flow is linear (read token → optional early return → revoke attempt → delete → return). MCP and CLI adapters are thin wrappers calling core. GOOD.
- **Unknown unknowns**: None identified. Logout operation is straightforward: read credentials, call revoke (best-effort), delete file. Edge cases (no creds, offline, permission denied) all covered in tests.
- **Pass-through methods**: No pass-through methods. CLI runLogoutCommand calls core.logout() directly (correct). MCP logout tool calls core.logout() directly (correct). No unnecessary wrappers.
- **Together/apart**: Revoke and file deletion are logically together (both part of logout). Separation of concerns is clean: core handles business logic (credentials + revoke), CLI handles user feedback (print + exit codes), MCP handles protocol (ToolResponse).
- **Architecture**: Hexagonal design maintained — adapters import only from lib/core.ts (verified by grep). Core re-exports LogoutResult for adapter use. No adapter knowledge of auth, API, or file I/O details.

**Verdict:** No design issues. Clean separation, appropriate depth, no over-engineering.

## Testing: PASS

- **Coverage**: All code paths tested:
  - Core: 5 tests (happy path, no creds, server unreachable, file delete error, revoke called with correct token)
  - CLI: 5 tests (success print, exit 0, json flag, failure exit 1, exported with deps)
  - MCP: 2 tests (tool returns text, already logged out no-op)
  - Total: 12 logout-specific tests
- **Dirty:Clean ratio**: Tests are clean — all use mocks (mockFetch, mock()) and temp files cleaned in afterEach. No real network calls or disk I/O side effects. Total test suite: 204 tests pass in 120ms (all green).
- **Test pattern**: Consistent with existing code:
  - writeTempCredentials() helper for setup
  - mockFetch() for network injection
  - spyOn(console.log) for output verification in CLI tests
  - getTools() helper for MCP tool extraction
  - Proper cleanup in afterEach / finally blocks

**Verdict:** Test coverage is comprehensive and clean. 100% path coverage for logout with appropriate mocking strategy.

## Architecture Compliance

Hexagonal architecture verified:
- **bin/upublish.ts imports**: `lib/core.ts`, `citty`, `open`, `node:*` only — no auth.ts, api-client.ts, or other internal modules
- **mcp/index.ts imports**: `lib/core.ts`, `@modelcontextprotocol`, `zod` only — no auth.ts, api-client.ts
- **Core re-exports**: LogoutResult, LoginDeps, LoginResult, PublishResult, ListResult, DeleteResult, Visibility, Site available to adapters
- **No adapter knowledge**: CLI and MCP never construct ApiClient, never read credentials directly, never import token providers

**Verdict:** Hexagonal architecture maintained without violations.

## Code Quality Observations

Positive findings:
- **Best-effort pattern**: Revoke error handling is idiomatic (fail-open pattern documented in comments, justifies silent catch)
- **Discriminated unions**: LogoutResult uses TypeScript union types correctly (loggedOut boolean discriminates branches)
- **Dep injection**: CoreDeps properly threaded through all functions; tests override credentialsPath and fetchFn successfully
- **Fresh credential reads**: logout() calls readCredentials() directly (not via cached token provider); eliminates stale-state bugs
- **Error messages**: Non-sensitive (no token exposure in error text)
- **Symmetry**: logout() mirrors status() pattern (both read credentials fresh, both handle missing creds gracefully, both return discriminated result)

No quality issues found.

## Integration with Existing Code

- LogoutResult type mirrors StatusResult pattern (discriminated union with boolean + optional error)
- logout() function placement in core.ts alongside list, publish, deleteOp, login, status (logical grouping)
- CoreDeps interface unchanged — logout() uses existing credentialsPath and fetchFn fields
- CLI subcommand follows runLoginCommand/runPublishCommand pattern (injectable deps, color output, json flag)
- MCP tool follows publish/list/delete pattern (async handler, okResponse/errResponse helpers, no auth in adapter)

No breaking changes. Consistent with existing design patterns.

## Issues (if FAIL)

None. All requirements satisfied, all tests pass, no correctness violations, no dead code, architecture maintained.

---

## Self-Check Before Verdict

- [x] Every DW item from dispatch prompt is in the Requirement Fulfillment table (7 items present)
- [x] No DW items silently omitted (counts match)
- [x] Every SATISFIED item has concrete evidence (file:line references for all)
- [x] Verdict matches the rules (no blocker items, all dimensions pass, test coverage complete)
- [x] Test suite passes (204 tests, 0 fail)

---

**Verdict: PASS**

Phase 2 implementation is complete and correct. All done-when items are satisfied with evidence. Test coverage is comprehensive (12 logout-specific tests + 204 total). Code quality is high — no dead code, no defensive violations, hexagonal architecture maintained, design patterns consistent with existing code. All correctness dimensions pass. Ready for merge.
