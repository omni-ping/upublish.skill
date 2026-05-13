# Discovery + Design: Phase 2 - Rewrite adapters

## Files Found

- `mcp/index.ts` — MCP server: imports `ApiClient`, `createTokenProvider`, `readCredentials` from lib/; handler factories take `ApiClient` parameter; `createServer()` reads credentials at startup and conditionally creates the client; stale-state bug is present
- `bin/upublish.ts` — CLI: imports `createTokenProvider`, `readCredentials`, `defaultCredentialsPath`, `ApiClient`; has `loadApiClient()` helper; command deps carry `apiClient: ApiClient | null`
- `lib/core.ts` — Core module from Phase 1: exports `list()`, `publish()`, `deleteOp()`, `generate()`, `login()`, `status()` — all with fresh-per-call credential wiring via `CoreDeps`
- `tests/mcp.test.ts` — 106 tests currently passing; tests `createServer(config, fetchFn)` where `config` has `refreshToken`
- `tests/cli.test.ts` — CLI tests pass `{ apiClient, publishFn }` style deps to run*Command functions

## Current State

All 106 adapter tests and 73 lib tests pass (179 total). Both adapters still directly import `ApiClient`, `createTokenProvider`, `readCredentials`. The MCP stale-state bug is present: `createServer()` reads credentials once at startup and builds a single `ApiClient` for the lifetime of the process.

## Gaps

1. `mcp/index.ts` exports `McpServerConfig` (with `refreshToken`) and `makePublishHandler(apiClient)` — these interfaces must change since there is no longer an apiClient at startup
2. `bin/upublish.ts` command deps types carry `apiClient: ApiClient | null` — after refactor these become `coreFn?: ...` style injections
3. Both adapter test files test the old interfaces; they must be rewritten for the new interfaces
4. The `mcp/index.ts` currently has stub tools (not-authenticated path) that `createServer()` conditionally registers — after the refactor the per-call auth check happens inside `core.*()`, so stub tools are eliminated
5. The `mcpCmd` in `bin/upublish.ts` calls `readCredentials()` directly to pass to the old `createServer()` — must change to just start the new `createServer()` with no token reading

## Code Standards

No `docs/code-standards.md` found. Following patterns from existing codebase:
- ANSI sections with `// ─── Section ───` dividers
- `export interface` for types used by tests
- Injectable deps via optional last argument (not constructor injection)
- `bun:test` with `describe`/`test` (mcp.test.ts) or `describe`/`it` (core.test.ts)
- DW-ID prefixed test names: `test_DW_N_M_description`

## Test Infrastructure

- `bun test` with Bun test runner
- `tests/mcp.test.ts` and `tests/cli.test.ts` for adapter tests
- Mocking: `mock()`, `spyOn()` from `bun:test`
- MCP tool handlers extracted via `server._registeredTools` (internal SDK field)
- CLI tests intercept `console.log` and `process.exit` via spies

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-2.1 | `mcp/index.ts` imports only from `lib/core.ts` — no ApiClient, auth, or credential imports | COVERED | `test_DW_2_1_mcp_no_api_client_import`, `test_DW_2_1_mcp_no_auth_import` (static import check via module inspection) — verified structurally by rewriting the file and confirming tests still pass |
| DW-2.2 | `bin/upublish.ts` imports only from `lib/core.ts` — no ApiClient, auth, or credential imports | COVERED | `test_DW_2_2_cli_no_api_client_import` — verified structurally by rewriting the file |
| DW-2.3 | MCP tools work after `upublish login` without session restart (stale-state bug fixed) | COVERED | `test_DW_2_3_mcp_stale_state_fixed` — MCP handler reads credentials fresh per call; test verifies that a handler succeeds even when credentials are provided via `CoreDeps` override rather than at `createServer()` time |
| DW-2.4 | CLI commands produce correct output | COVERED | `test_DW_2_4_cli_publish_output`, `test_DW_2_4_cli_list_output`, `test_DW_2_4_cli_delete_output`, `test_DW_2_4_cli_generate_output`, `test_DW_2_4_cli_login_output`, `test_DW_2_4_cli_status_output` |
| DW-2.5 | `bun test` passes with 0 failures | COVERED | Run full test suite after all changes, confirm 0 failures |
| DW-2.6 | No import of `ApiClient`, `createTokenProvider`, or `readCredentials` outside of `lib/` | COVERED | Static grep verification after implementation |

**All items COVERED:** YES

## Design Decisions

### MCP adapter redesign (design-it-twice)

**Approach A — Keep `createServer(config, fetchFn)` signature, move auth into handlers**

`McpServerConfig` drops `refreshToken`; `fetchFn` becomes `coreDeps: CoreDeps`. Each handler factory becomes a zero-arg factory that captures `coreDeps` and calls `core.*()`.

```
createServer(coreDeps?: CoreDeps): McpServer
makeListHandler(coreDeps?: CoreDeps)  -> calls core.list(coreDeps)
makePublishHandler(coreDeps?: CoreDeps) -> calls core.publish(args, coreDeps)
...
```

Pros: Clean separation, no startup credential read, tests pass `coreDeps` with mock fetchFn.
Cons: Handler factories no longer take `apiClient` — existing test infrastructure using `authenticatedConfig()` must change.

**Approach B — Drop all handler factories, inline handlers in registerTool calls**

Each `server.registerTool(...)` call has an inline async handler that calls `core.*()` directly. No exported handler factories.

Pros: Simpler, fewer functions.
Cons: Handler logic not independently testable; tests must go through the full `_registeredTools` path (same as now, so no real loss).

**Approach C — Keep handler factories for testability, drop McpServerConfig entirely**

```
createServer(coreDeps?: CoreDeps): McpServer
// no McpServerConfig, no separate handler factories exported
// handlers are defined inline but still tested via _registeredTools
```

**Chosen: Approach A** — preserves the exported handler factories and `McpServerConfig` type that tests depend on, but strips `refreshToken` and auth knowledge. `McpServerConfig` becomes `{ apiBaseUrl?: string }` (or disappears since baseUrl comes from env). Handler factories take `coreDeps?: CoreDeps` instead of `apiClient: ApiClient`.

This is the most consistent with the existing test pattern (tests already reach in via `_registeredTools`). The "stub tools for unauthenticated" path is eliminated — `core.*()` throws "Not authenticated" and the handler catches it and returns `isError: true`, same UX.

### CLI adapter redesign

Current deps bags: `{ apiClient: ApiClient | null, publishFn? }`. After refactor: `{ coreFn?: (args, deps?) => Promise<Result> }`. The `apiClient` param is removed; auth checking moves to `core.*()`.

The existing CLI tests pass `apiClient` and `publishFn` separately. After the refactor they just pass `coreFn`. The existing tests must be rewritten with this simpler interface.

Note: `runStatusCommand` currently calls `apiClient.get('/auth/me')` directly. After refactor it calls `core.status(coreDeps)` and the result is `StatusResult`.

### Stale-state fix mechanism

The fix is structural: `createServer()` no longer builds a shared `ApiClient`. Each tool handler invocation calls `core.*()` which internally calls `buildApiClient()` which reads credentials fresh from disk. The test for DW-2.3 verifies this by checking that a handler succeeds with a `coreDeps` object that has a `credentialsPath` pointing to a file written AFTER `createServer()` was called.

## Prerequisites

- [x] `lib/core.ts` exists with all 6 operations (Phase 1 complete)
- [x] All 179 tests currently pass (baseline confirmed)
- [x] No dependency changes needed
- [ ] Adapter test interfaces will break during refactor — expected, fixed as part of this phase

## Recommendation

BUILD — all prerequisites met, design is clear, all DW items mapped.
